import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditoriaService } from '@app/common';
import { resolverEmpresaDelUsuario } from '../scope-empresa';
import { CambiarModalidadPagoDto } from './dto/modalidad-pago.dto';

const COLS_ORDER_ALLOWED = [
  'apellido_paterno',
  'cargo',
  'area',
  'modalidad_pago',
];

/** El sueldo llega como string del driver (`DECIMAL`); sin esto, las cuentas concatenan. */
const num = (v: any): number => (v === null || v === undefined ? 0 : Number(v));
const r2 = (n: number): number =>
  Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Forma de cobro — PORTAL CLIENTE.
 *
 * ── Qué se configura acá y qué NO ──
 *
 * El CUÁNTO ya está: es `planilla_trabajador_remuneracion.sueldo_basico`, y lo carga
 * el estudio. Lo que faltaba es el QUÉ SIGNIFICA ese número, que es lo que decide cómo
 * se convierte en el básico del mes:
 *
 *   MENSUAL → sueldo del mes.       valor_dia = sueldo / dias_mes
 *   JORNAL  → tarifa por día.       valor_dia = sueldo
 *   HORA    → tarifa por hora.      valor_dia = sueldo × horas_jornada
 *   DESTAJO → por unidad producida. No hay básico automático
 *
 * Sin este dato el motor no tiene más remedio que asumir MENSUAL, y a un obrero a
 * jornal de S/ 65 el día le liquidaría S/ 2.17 diarios (65/30) — un error de 30 veces
 * que además pasa desapercibido porque el número sale con dos decimales y parece un
 * cálculo.
 *
 * ── Por qué lo declara la empresa y no el estudio ──
 *
 * Es un hecho del contrato que la empresa conoce de primera mano. El estudio lo ve, lo
 * usa y puede corregirlo desde el padrón; el portal solo evita que el dato tenga que
 * pedirse por teléfono. Lo que el cliente NO puede tocar sigue siendo el monto.
 *
 * ── Por qué el pasado no cambia ──
 *
 * `planilla_detalle.snap_modalidad_pago` congela la modalidad usada en cada cálculo.
 * Pasar a alguien de mensual a jornal en septiembre no altera un solo número de las
 * planillas ya calculadas.
 */
@Injectable()
export class ModalidadPagoClienteService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private readonly auditoriaService: AuditoriaService,
  ) {}

  /**
   * Jornada de la empresa. Es lo que traduce la tarifa a un valor diario, así que la
   * pantalla lo necesita para poder explicar la elección en soles.
   *
   * Si la empresa todavía no tiene configuración laboral se cae a lo estándar (30 días
   * de mes, 8 horas de jornada) en vez de romper: el cliente no puede resolver eso
   * desde el portal y quedarse sin pantalla no lo ayuda. Es solo para la vista previa
   * — el cálculo real usa la config de verdad, y `PlanillasService.create()` ya se
   * niega a abrir un periodo si falta.
   */
  private async jornadaDeLaEmpresa(idEmpresa: number) {
    const [row] = await this.dataSource.query(
      `SELECT dias_mes, horas_jornada FROM planilla_empresa_config
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    return {
      dias_mes: num(row?.dias_mes) || 30,
      horas_jornada: num(row?.horas_jornada) || 8,
      configurada: !!row,
    };
  }

  /**
   * Listado del personal con su forma de cobro y lo que eso significa en soles.
   *
   * Muestra el valor diario y el horario ya resueltos y no solo la etiqueta: "JORNAL"
   * a secas no le dice a nadie si eligió bien, y "JORNAL · S/ 65.00 por día" sí.
   */
  async findAll(user: any, query: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    // `t.id_empresa = ?` primero y no derivado de nada que mande el frontend.
    const where: string[] = [
      "t.estado_registro = 'ACTIVO'",
      't.id_empresa = ?',
    ];
    const params: any[] = [idEmpresa];

    if (query.search) {
      where.push(
        `(t.numero_documento LIKE ? OR CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) LIKE ? OR t.cargo LIKE ?)`,
      );
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }

    // Por defecto solo el personal en actividad: configurarle la forma de cobro a
    // alguien que cesó hace dos años no sirve para nada y llena la lista.
    if (query.incluirCesados !== 'true') {
      where.push("t.cod_situacion <> '00' AND t.fecha_cese IS NULL");
    }

    if (query.area) {
      where.push('t.area = ?');
      params.push(query.area);
    }

    if (query.modalidad_pago) {
      where.push('t.modalidad_pago = ?');
      params.push(query.modalidad_pago);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort)
      ? query.sort
      : 'apellido_paterno';
    const sortDir = query.dir === 'DESC' ? 'DESC' : 'ASC';

    const [filas, [{ total }], jornada] = await Promise.all([
      this.dataSource.query(
        `SELECT t.id_trabajador, t.numero_documento,
                CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_completo,
                t.cargo, t.area, t.fecha_ingreso, t.fecha_cese, t.cod_situacion,
                t.modalidad_pago,
                rem.sueldo_basico, rem.moneda, rem.vigencia_desde AS sueldo_vigente_desde
         FROM planilla_trabajador t
         LEFT JOIN (
           SELECT x.id_trabajador, x.sueldo_basico, x.moneda, x.vigencia_desde
           FROM planilla_trabajador_remuneracion x
           JOIN (
             SELECT id_trabajador, MAX(vigencia_desde) AS maxv
             FROM planilla_trabajador_remuneracion
             WHERE estado_registro = 'ACTIVO' AND vigencia_desde <= CURDATE()
             GROUP BY id_trabajador
           ) m ON m.id_trabajador = x.id_trabajador AND m.maxv = x.vigencia_desde
           WHERE x.estado_registro = 'ACTIVO'
         ) rem ON rem.id_trabajador = t.id_trabajador
         ${whereSql}
         ORDER BY t.${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM planilla_trabajador t ${whereSql}`,
        params,
      ),
      this.jornadaDeLaEmpresa(idEmpresa),
    ]);

    const data = filas.map((f: any) => ({
      ...f,
      ...this.equivalencias(f.modalidad_pago, f.sueldo_basico, jornada),
    }));

    return { data, meta: { total: Number(total), page, limit }, jornada };
  }

  /**
   * Qué vale un día y una hora, según la modalidad.
   *
   * Se calcula en el backend y no en la template por una sola razón: es la MISMA
   * fórmula que aplica el motor al liquidar. Duplicarla en Angular garantiza que el
   * día que cambie una, la pantalla siga prometiendo un número que la boleta ya no
   * paga — y nadie se entera hasta que un trabajador reclama.
   */
  private equivalencias(
    modalidad: string,
    sueldoBasico: any,
    jornada: { dias_mes: number; horas_jornada: number },
  ) {
    // Un sueldo NULL no es cero: es que el estudio todavía no cargó su remuneración.
    // Devolver 0.00 haría que la pantalla afirme que esa persona no cobra.
    if (sueldoBasico === null || sueldoBasico === undefined) {
      return { valor_dia: null, valor_hora: null };
    }

    const sueldo = num(sueldoBasico);
    const diasMes = jornada.dias_mes || 30;
    const horas = jornada.horas_jornada || 8;

    switch (modalidad) {
      case 'JORNAL':
        return { valor_dia: r2(sueldo), valor_hora: r2(sueldo / horas) };
      case 'HORA':
        return { valor_dia: r2(sueldo * horas), valor_hora: r2(sueldo) };
      case 'DESTAJO':
        // No hay valor diario: lo que cobra depende de cuánto produjo, y esa cantidad
        // no vive en esta tabla. Devolver un número acá sería inventarlo.
        return { valor_dia: null, valor_hora: null };
      case 'MENSUAL':
      default:
        return {
          valor_dia: r2(sueldo / diasMes),
          valor_hora: r2(sueldo / diasMes / horas),
        };
    }
  }

  /** Áreas del padrón de ESTA empresa — alimenta el filtro. */
  async areas(user: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    return this.dataSource.query(
      `SELECT DISTINCT area FROM planilla_trabajador
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO'
         AND area IS NOT NULL AND area <> ''
       ORDER BY area ASC`,
      [idEmpresa],
    );
  }

  /**
   * Cambia la forma de cobro de UN trabajador.
   *
   * El `WHERE` lleva `id_empresa` además del id: sin eso, cambiar un número en la URL
   * pondría a jornal a un trabajador de otra empresa y su próxima planilla saldría
   * treinta veces más chica. El `affectedRows === 0` es lo que convierte ese WHERE en
   * un candado real y no en un filtro silencioso que devuelve 200 sin haber tocado
   * nada.
   *
   * No hay transacción: es un UPDATE de una columna en una tabla. La auditoría va con
   * `registrar()` (que traga su propio error) y no con `registrarConTransaccion()`,
   * porque no hay transacción que abortar y perder el cambio por un fallo del log de
   * auditoría sería peor que el fallo.
   */
  async cambiar(
    user: any,
    idTrabajador: number,
    dto: CambiarModalidadPagoDto,
    userId: number,
  ) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const id = Number(idTrabajador);
    if (!id || Number.isNaN(id)) throw new BadRequestException('ID inválido');

    const [previo] = await this.dataSource.query(
      `SELECT t.id_trabajador, t.modalidad_pago,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_completo,
              rem.sueldo_basico
       FROM planilla_trabajador t
       LEFT JOIN (
         SELECT x.id_trabajador, x.sueldo_basico
         FROM planilla_trabajador_remuneracion x
         JOIN (
           SELECT id_trabajador, MAX(vigencia_desde) AS maxv
           FROM planilla_trabajador_remuneracion
           WHERE estado_registro = 'ACTIVO' AND vigencia_desde <= CURDATE()
           GROUP BY id_trabajador
         ) m ON m.id_trabajador = x.id_trabajador AND m.maxv = x.vigencia_desde
         WHERE x.estado_registro = 'ACTIVO'
       ) rem ON rem.id_trabajador = t.id_trabajador
       WHERE t.id_trabajador = ? AND t.id_empresa = ? AND t.estado_registro = 'ACTIVO'`,
      [id, idEmpresa],
    );
    // Mismo mensaje para "no existe" y para "es de otra empresa": distinguirlos
    // convertiría el endpoint en un detector de qué IDs están ocupados.
    if (!previo) throw new NotFoundException('Trabajador no encontrado');

    // Un cambio de modalidad SIN sueldo cargado no se rechaza — es válido dejar la
    // forma de cobro lista antes de que el estudio cargue el monto. Pero se avisa,
    // porque el número que la pantalla va a mostrar sale vacío y sin explicación
    // parece un error de la aplicación.
    const sinSueldo =
      previo.sueldo_basico === null || previo.sueldo_basico === undefined;

    const res: any = await this.dataSource.query(
      `UPDATE planilla_trabajador
       SET modalidad_pago = ?, id_usuario_mod = ?
       WHERE id_trabajador = ? AND id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [dto.modalidad_pago, userId, id, idEmpresa],
    );
    if (res.affectedRows === 0)
      throw new NotFoundException('Trabajador no encontrado');

    await this.auditoriaService.registrar(
      'planilla_trabajador',
      id,
      'ACTUALIZAR',
      userId,
      { modalidad_pago: previo.modalidad_pago },
      { modalidad_pago: dto.modalidad_pago },
    );

    return {
      id_trabajador: id,
      modalidad_pago: dto.modalidad_pago,
      mensaje: sinSueldo
        ? `${previo.nombre_completo} queda como ${dto.modalidad_pago}. Ojo: todavía no tiene sueldo registrado — pedile al estudio que lo cargue.`
        : `${previo.nombre_completo} ahora cobra por ${dto.modalidad_pago.toLowerCase()}.`,
    };
  }
}
