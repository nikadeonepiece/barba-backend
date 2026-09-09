import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { cuentaParaSaldo, num } from '../../estudio-barba/tesoreria/cajas/cajas-saldos';
import { resolverEmpresaDelUsuario } from '../scope-empresa';

/**
 * Con alias porque las consultas de la caja unen `caja_chica` con
 * `caja_chica_movimiento`: las dos tienen `estado` y `estado_registro`, y sin el
 * prefijo MySQL corta con "Column 'estado' in field list is ambiguous".
 */
const CUENTA_PARA_SALDO = cuentaParaSaldo('m');

/** Meses de historia que dibujan las series. Seis entran en una tira sin scroll. */
const MESES_SERIE = 6;

/**
 * Ventana de aviso de contratos por vencer.
 *
 * 60 días y no 30: un contrato a plazo fijo se renueva ANTES del vencimiento y la
 * empresa necesita margen para avisarle al estudio. Con 30, el aviso llega cuando la
 * decisión ya está tomada.
 */
const DIAS_AVISO_CONTRATO = 60;

/** Cuántas categorías se dibujan antes de plegar la cola en "Otras". */
const TOP_CATEGORIAS = 6;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Tableros del PORTAL CLIENTE — la foto de la empresa y la de su caja chica.
 *
 * ── Qué es y qué NO es ──
 *
 * Es una pantalla de SOLO LECTURA que agrega lo que ya vive en los módulos del portal
 * (`personal`, `asistencia`, `planillas`, `cajas`). No calcula nada nuevo, no guarda
 * nada y no inventa un número que no esté ya en alguna de esas pantallas: si el neto
 * del tablero no coincide con el de `cliente/planillas`, es un bug del tablero.
 *
 * ── Por qué un service propio y no un método en cada módulo ──
 *
 * Un tablero hace UNA petición y trae ocho recortes. Repartirlo entre los services
 * existentes obligaría al frontend a disparar ocho llamadas y a que cada módulo exporte
 * un método que solo usa esta pantalla. Las consultas de acá son de solo lectura,
 * agregadas y sin paginar — otra forma de mirar, no otra fuente de verdad.
 *
 * ── El alcance ──
 *
 * Como todo `erp/clientes-planillas`, cada método arranca por
 * `resolverEmpresaDelUsuario()` y ese `id_empresa` entra en el WHERE de TODAS las
 * consultas, incluidas las que ya reciben un id por la URL. Ninguna recibe la empresa
 * por query ni por body: cambiar un número no puede mostrar la foto de otra empresa.
 */
@Injectable()
export class TableroClienteService {
  constructor(@InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource) {}

  // ==========================================================
  // TABLERO DE PLANILLA (módulo PLANILLAS_CLIENTE)
  // ==========================================================

  /**
   * Resumen de la empresa para el periodo pedido (por defecto, el mes en curso).
   *
   * Las nueve consultas van en un solo `Promise.all`: son independientes entre sí y en
   * serie el tablero tardaría la suma de todas.
   */
  async resumen(user: any, query: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);
    const { anio, mes } = this.periodoDeQuery(query);

    // Hasta qué día del mes se mide la asistencia. En el mes en curso, hasta HOY: con el
    // mes completo, un tablero abierto el día 3 mostraría 10% de avance y parecería que
    // la empresa va atrasada cuando no cargó nada porque el mes recién empieza.
    const hoy = new Date();
    const esMesEnCurso = anio === hoy.getFullYear() && mes === hoy.getMonth() + 1;
    const diasDelMes = new Date(anio, mes, 0).getDate();
    const diasConsiderados = esMesEnCurso ? Math.min(hoy.getDate(), diasDelMes) : diasDelMes;

    const primerDia = `${anio}-${pad(mes)}-01`;
    const ultimoDia = `${anio}-${pad(mes)}-${pad(diasConsiderados)}`;

    const [
      [empresa],
      [personal],
      porArea,
      porModalidad,
      [masa],
      asistenciaPorMarca,
      [coberturaAsistencia],
      seriePlanillas,
      contratosPorVencer,
    ] = await Promise.all([
      this.dataSource.query(
        `SELECT id_empresa, razon_social, ruc
         FROM empresa
         WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
        [idEmpresa],
      ),

      // Un solo escaneo del padrón para los cuatro contadores. Cuatro COUNT separados
      // leerían la misma tabla cuatro veces para responder lo mismo.
      this.dataSource.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN t.cod_situacion <> '00' AND t.fecha_cese IS NULL THEN 1 ELSE 0 END), 0) AS activos,
                COALESCE(SUM(CASE WHEN t.fecha_ingreso >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) THEN 1 ELSE 0 END), 0) AS ingresos_12m,
                COALESCE(SUM(CASE WHEN t.fecha_cese IS NOT NULL AND t.fecha_cese >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) THEN 1 ELSE 0 END), 0) AS ceses_12m
         FROM planilla_trabajador t
         WHERE t.id_empresa = ? AND t.estado_registro = 'ACTIVO'`,
        [idEmpresa],
      ),

      // "Sin área" en vez de dejar el vacío fuera: un padrón a medio clasificar es
      // justamente lo que la empresa tiene que ver, no lo que el tablero debe esconder.
      this.dataSource.query(
        `SELECT COALESCE(NULLIF(TRIM(t.area), ''), 'Sin área') AS area, COUNT(*) AS total
         FROM planilla_trabajador t
         WHERE t.id_empresa = ? AND t.estado_registro = 'ACTIVO'
           AND t.cod_situacion <> '00' AND t.fecha_cese IS NULL
         GROUP BY COALESCE(NULLIF(TRIM(t.area), ''), 'Sin área')
         ORDER BY total DESC, area ASC`,
        [idEmpresa],
      ),

      this.dataSource.query(
        `SELECT t.modalidad_pago, COUNT(*) AS total
         FROM planilla_trabajador t
         WHERE t.id_empresa = ? AND t.estado_registro = 'ACTIVO'
           AND t.cod_situacion <> '00' AND t.fecha_cese IS NULL
         GROUP BY t.modalidad_pago
         ORDER BY total DESC`,
        [idEmpresa],
      ),

      // Masa salarial VIGENTE: la suma de los básicos que rigen hoy, no lo que se pagó
      // el mes pasado (eso sale de la planilla cerrada). Misma subconsulta de "última
      // remuneración vigente" que usa `personal.service.ts`: si cambia una, cambian las
      // dos, o la ficha del trabajador y el tablero muestran sueldos distintos.
      this.dataSource.query(
        `SELECT COALESCE(SUM(rem.sueldo_basico), 0) AS masa_salarial,
                COALESCE(SUM(CASE WHEN rem.sueldo_basico IS NULL THEN 1 ELSE 0 END), 0) AS sin_sueldo
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
         WHERE t.id_empresa = ? AND t.estado_registro = 'ACTIVO'
           AND t.cod_situacion <> '00' AND t.fecha_cese IS NULL`,
        [idEmpresa],
      ),

      // Los `computa_*` viajan al frontend para que la barra sepa qué significa cada
      // marca sin repetir acá la leyenda del tareo.
      this.dataSource.query(
        `SELECT mk.id_marca, mk.codigo, mk.nombre, mk.color_hex,
                mk.computa_dia_laborado, mk.computa_falta, mk.computa_descanso,
                mk.computa_vacaciones, mk.computa_subsidio,
                COUNT(*) AS total
         FROM planilla_asistencia a
         JOIN planilla_tareo_marca mk ON mk.id_marca = a.id_marca
         WHERE a.id_empresa = ? AND a.anio = ? AND a.mes = ?
           AND a.estado_registro = 'ACTIVO' AND a.dia <= ?
         GROUP BY mk.id_marca, mk.codigo, mk.nombre, mk.color_hex,
                  mk.computa_dia_laborado, mk.computa_falta, mk.computa_descanso,
                  mk.computa_vacaciones, mk.computa_subsidio, mk.orden
         ORDER BY mk.orden ASC, mk.codigo ASC`,
        [idEmpresa, anio, mes, diasConsiderados],
      ),

      // Cuántos estuvieron en planilla ALGÚN día del mes: quien ingresó el 15 o cesó el
      // 10 igual tiene días que marcar. Con el padrón "activo hoy" a secas, el mes en
      // que alguien cesa la cobertura pasaría del 100%.
      this.dataSource.query(
        `SELECT COUNT(*) AS trabajadores_del_mes
         FROM planilla_trabajador t
         WHERE t.id_empresa = ? AND t.estado_registro = 'ACTIVO'
           AND t.fecha_ingreso <= ?
           AND (t.fecha_cese IS NULL OR t.fecha_cese >= ?)`,
        [idEmpresa, ultimoDia, primerDia],
      ),

      // Un periodo puede tener una MENSUAL y una ADICIONAL (una gratificación, por
      // ejemplo): se suman, porque lo que la empresa quiere ver es cuánto le costó ese
      // mes. `MAX(total_trabajadores)` y no la suma: es el mismo padrón contado dos
      // veces, no el doble de gente.
      this.dataSource.query(
        `SELECT p.anio, p.mes,
                COALESCE(SUM(p.total_ingresos), 0)     AS total_ingresos,
                COALESCE(SUM(p.total_descuentos), 0)   AS total_descuentos,
                COALESCE(SUM(p.total_neto), 0)         AS total_neto,
                COALESCE(MAX(p.total_trabajadores), 0) AS total_trabajadores,
                MAX(p.fecha_cierre) AS fecha_cierre
         FROM planilla_planilla p
         WHERE p.id_empresa = ? AND p.estado_registro = 'ACTIVO' AND p.estado = 'CERRADA'
         GROUP BY p.anio, p.mes
         ORDER BY p.anio DESC, p.mes DESC
         LIMIT ?`,
        [idEmpresa, MESES_SERIE],
      ),

      // `visible_cliente = 1` igual que en `personal.service.ts`: un contrato que el
      // estudio todavía no publicó no existe para el portal, tampoco como aviso.
      // `fecha_fin` es DATE, así que el `<=` no pierde el último día.
      this.dataSource.query(
        `SELECT c.id_contrato, c.tipo, c.fecha_fin,
                CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_completo,
                DATEDIFF(c.fecha_fin, CURDATE()) AS dias_restantes
         FROM planilla_contrato c
         JOIN planilla_trabajador t ON t.id_trabajador = c.id_trabajador
         WHERE c.id_empresa = ? AND c.estado_registro = 'ACTIVO' AND c.visible_cliente = 1
           AND t.estado_registro = 'ACTIVO' AND t.fecha_cese IS NULL
           AND c.fecha_fin IS NOT NULL
           AND c.fecha_fin >= CURDATE()
           AND c.fecha_fin <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
         ORDER BY c.fecha_fin ASC
         LIMIT 8`,
        [idEmpresa, DIAS_AVISO_CONTRATO],
      ),
    ]);

    if (!empresa) throw new NotFoundException('No se encontró la empresa asociada a tu usuario');

    // El driver devuelve DECIMAL y COUNT como string y los `tinyint(1)` como 0/1: sin
    // esta pasada, el frontend suma concatenando y los `@if` de las banderas dan true
    // con el string "0".
    const marcas = asistenciaPorMarca.map((m: any) => ({
      ...m,
      total: num(m.total),
      computa_dia_laborado: !!m.computa_dia_laborado,
      computa_falta: !!m.computa_falta,
      computa_descanso: !!m.computa_descanso,
      computa_vacaciones: !!m.computa_vacaciones,
      computa_subsidio: !!m.computa_subsidio,
    }));

    const diasMarcados = marcas.reduce((acc: number, m: any) => acc + m.total, 0);
    const trabajadoresDelMes = num(coberturaAsistencia?.trabajadores_del_mes);

    // Cobertura APROXIMADA, y así se rotula en pantalla: el denominador asume que todos
    // trabajan todos los días considerados y no descuenta a quien ingresó a mitad de
    // mes. Sirve para responder "¿voy al día con el tareo?", no para liquidar.
    const diasEsperados = trabajadoresDelMes * diasConsiderados;

    // La serie llega DESC (para que el LIMIT tome los últimos periodos) y se invierte:
    // un gráfico de evolución se lee de izquierda a derecha, del más viejo al más nuevo.
    const serie = seriePlanillas
      .map((p: any) => ({
        anio: Number(p.anio),
        mes: Number(p.mes),
        total_ingresos: num(p.total_ingresos),
        total_descuentos: num(p.total_descuentos),
        total_neto: num(p.total_neto),
        total_trabajadores: num(p.total_trabajadores),
        fecha_cierre: p.fecha_cierre,
      }))
      .reverse();

    return {
      empresa,
      periodo: {
        anio,
        mes,
        dias_del_mes: diasDelMes,
        dias_considerados: diasConsiderados,
        es_mes_en_curso: esMesEnCurso,
      },
      personal: {
        total: num(personal?.total),
        activos: num(personal?.activos),
        ingresos_12m: num(personal?.ingresos_12m),
        ceses_12m: num(personal?.ceses_12m),
        masa_salarial: num(masa?.masa_salarial),
        sin_sueldo: num(masa?.sin_sueldo),
        por_area: this.plegarCola(porArea, 'area'),
        por_modalidad: porModalidad.map((m: any) => ({
          modalidad_pago: m.modalidad_pago,
          total: num(m.total),
        })),
      },
      asistencia: {
        trabajadores_del_mes: trabajadoresDelMes,
        dias_marcados: diasMarcados,
        dias_esperados: diasEsperados,
        faltas: marcas.filter((m: any) => m.computa_falta).reduce((a: number, m: any) => a + m.total, 0),
        dias_laborados: marcas
          .filter((m: any) => m.computa_dia_laborado)
          .reduce((a: number, m: any) => a + m.total, 0),
        por_marca: marcas,
      },
      // `ultima` es el último elemento de la MISMA serie y no una consulta aparte: dos
      // queries para el mismo dato es cómo el número grande de arriba termina
      // contradiciendo a la barra de abajo.
      planillas: { ultima: serie.length ? serie[serie.length - 1] : null, serie },
      contratos_por_vencer: contratosPorVencer.map((c: any) => ({
        ...c,
        dias_restantes: num(c.dias_restantes),
      })),
    };
  }

  // ==========================================================
  // TABLERO DE CAJA CHICA (módulo CAJAS_CLIENTE)
  // ==========================================================

  /**
   * Resumen de UNA caja chica de la empresa.
   *
   * `id_caja` es opcional: sin él se elige la primera abierta (y si no hay ninguna, la
   * más reciente), que es lo que la empresa mira el 95% de las veces.
   */
  async resumenCaja(user: any, query: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    // El listado ya viene acotado por empresa, así que buscar el id pedido DENTRO de
    // esta lista ES la verificación de pertenencia: no hace falta —ni conviene— un
    // segundo WHERE por otro lado, que es el que después se olvida.
    const cajas = await this.dataSource.query(
      `SELECT cc.id_caja, cc.nombre, cc.estado, cc.fecha_apertura
       FROM caja_chica cc
       WHERE cc.id_empresa = ? AND cc.estado_registro = 'ACTIVO'
       ORDER BY cc.estado ASC, cc.fecha_apertura DESC`,
      [idEmpresa],
    );

    // Sin cajas no hay tablero que dibujar, y no es un error: la empresa todavía no
    // abrió ninguna. La pantalla muestra el estado vacío con el enlace para abrirla.
    if (cajas.length === 0) return { cajas: [], caja: null };

    let seleccionada = cajas[0];
    if (query?.id_caja !== undefined && query.id_caja !== '') {
      const idPedido = Number(query.id_caja);
      if (!idPedido || Number.isNaN(idPedido)) throw new BadRequestException('ID de caja inválido');

      const encontrada = cajas.find((c: any) => Number(c.id_caja) === idPedido);
      // 404 y no 403: para este usuario esa caja no existe, y decirle "existe pero es de
      // otra empresa" ya es filtrar información de otro cliente.
      if (!encontrada) throw new NotFoundException('Caja no encontrada');
      seleccionada = encontrada;
    }

    const idCaja = Number(seleccionada.id_caja);

    // Ventana de las series: los últimos MESES_SERIE meses, contando el actual. Se arma
    // en JS y viaja como parámetro para que la query quede plana y pueda usar el índice
    // (`idx_mov_caja_fecha`), en vez de envolver la columna en una función.
    const hoy = new Date();
    const inicioVentana = new Date(hoy.getFullYear(), hoy.getMonth() - (MESES_SERIE - 1), 1);
    const desde = `${inicioVentana.getFullYear()}-${pad(inicioVentana.getMonth() + 1)}-01`;
    const inicioMes = `${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}-01`;

    const [[caja], serieCruda, topConceptos, [sinComprobante], ultimos] = await Promise.all([
      this.dataSource.query(
        `SELECT cc.id_caja, cc.nombre, cc.responsable, cc.monto_inicial, cc.saldo_actual,
                cc.estado, cc.fecha_apertura, cc.fecha_cierre,
                COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND m.tipo = 'INGRESO' THEN m.monto ELSE 0 END), 0) AS total_ingresos,
                COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND m.tipo = 'EGRESO'  THEN m.monto ELSE 0 END), 0) AS total_egresos,
                COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND m.tipo = 'EGRESO'  AND m.fecha >= ? THEN m.monto ELSE 0 END), 0) AS egresos_mes,
                COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} AND m.tipo = 'INGRESO' AND m.fecha >= ? THEN m.monto ELSE 0 END), 0) AS ingresos_mes,
                COALESCE(SUM(CASE WHEN ${CUENTA_PARA_SALDO} THEN 1 ELSE 0 END), 0) AS total_movimientos
         FROM caja_chica cc
         LEFT JOIN caja_chica_movimiento m ON m.id_caja = cc.id_caja AND m.estado_registro = 'ACTIVO'
         WHERE cc.id_caja = ? AND cc.id_empresa = ? AND cc.estado_registro = 'ACTIVO'
         GROUP BY cc.id_caja, cc.nombre, cc.responsable, cc.monto_inicial, cc.saldo_actual,
                  cc.estado, cc.fecha_apertura, cc.fecha_cierre`,
        [inicioMes, inicioMes, idCaja, idEmpresa],
      ),

      this.dataSource.query(
        `SELECT YEAR(m.fecha) AS anio, MONTH(m.fecha) AS mes,
                COALESCE(SUM(CASE WHEN m.tipo = 'EGRESO'  THEN m.monto ELSE 0 END), 0) AS egresos,
                COALESCE(SUM(CASE WHEN m.tipo = 'INGRESO' THEN m.monto ELSE 0 END), 0) AS ingresos
         FROM caja_chica_movimiento m
         WHERE m.id_caja = ? AND ${CUENTA_PARA_SALDO} AND m.fecha >= ?
         GROUP BY YEAR(m.fecha), MONTH(m.fecha)
         ORDER BY anio ASC, mes ASC`,
        [idCaja, desde],
      ),

      this.dataSource.query(
        `SELECT COALESCE(c.nombre, 'Sin concepto') AS concepto,
                COALESCE(SUM(m.monto), 0) AS total,
                COUNT(*) AS movimientos
         FROM caja_chica_movimiento m
         LEFT JOIN caja_chica_concepto c ON c.id_caja_concepto = m.id_caja_concepto
         WHERE m.id_caja = ? AND ${CUENTA_PARA_SALDO} AND m.tipo = 'EGRESO' AND m.fecha >= ?
         GROUP BY COALESCE(c.nombre, 'Sin concepto')
         ORDER BY total DESC`,
        [idCaja, desde],
      ),

      // Un gasto sin comprobante no se sustenta ante SUNAT. Es el aviso más accionable
      // del tablero: se arregla subiendo el archivo desde la misma pantalla de la caja.
      this.dataSource.query(
        `SELECT COUNT(*) AS movimientos, COALESCE(SUM(m.monto), 0) AS total
         FROM caja_chica_movimiento m
         WHERE m.id_caja = ? AND ${CUENTA_PARA_SALDO} AND m.tipo = 'EGRESO'
           AND m.fecha >= ? AND m.ruta_comprobante IS NULL`,
        [idCaja, desde],
      ),

      this.dataSource.query(
        `SELECT m.id_movimiento, m.fecha, m.tipo, m.monto, m.descripcion,
                c.nombre AS concepto
         FROM caja_chica_movimiento m
         LEFT JOIN caja_chica_concepto c ON c.id_caja_concepto = m.id_caja_concepto
         WHERE m.id_caja = ? AND ${CUENTA_PARA_SALDO}
         ORDER BY m.fecha DESC, m.id_movimiento DESC
         LIMIT 6`,
        [idCaja],
      ),
    ]);

    if (!caja) throw new NotFoundException('Caja no encontrada');

    // La ventana se rellena mes por mes en JS: un mes sin movimientos NO viene en el
    // GROUP BY, y sin rellenarlo el gráfico saltearía la columna y mentiría sobre la
    // evolución (dos meses pegados que en realidad están separados por tres).
    const serie: any[] = [];
    for (let i = 0; i < MESES_SERIE; i++) {
      const d = new Date(inicioVentana.getFullYear(), inicioVentana.getMonth() + i, 1);
      const anioSerie = d.getFullYear();
      const mesSerie = d.getMonth() + 1;
      const fila = serieCruda.find(
        (f: any) => Number(f.anio) === anioSerie && Number(f.mes) === mesSerie,
      );
      serie.push({
        anio: anioSerie,
        mes: mesSerie,
        egresos: num(fila?.egresos),
        ingresos: num(fila?.ingresos),
      });
    }

    return {
      cajas: cajas.map((c: any) => ({ ...c, id_caja: Number(c.id_caja) })),
      caja: {
        ...caja,
        id_caja: Number(caja.id_caja),
        monto_inicial: num(caja.monto_inicial),
        saldo_actual: num(caja.saldo_actual),
        total_ingresos: num(caja.total_ingresos),
        total_egresos: num(caja.total_egresos),
        egresos_mes: num(caja.egresos_mes),
        ingresos_mes: num(caja.ingresos_mes),
        total_movimientos: num(caja.total_movimientos),
      },
      serie,
      top_conceptos: this.plegarCola(topConceptos, 'concepto'),
      sin_comprobante: {
        movimientos: num(sinComprobante?.movimientos),
        total: num(sinComprobante?.total),
      },
      ultimos_movimientos: ultimos.map((m: any) => ({ ...m, monto: num(m.monto) })),
      meses_serie: MESES_SERIE,
    };
  }

  // ==========================================================
  // AYUDANTES
  // ==========================================================

  /**
   * Periodo pedido, validado. Sin parámetros, el mes en curso.
   *
   * `@Query()` llega como string: `Number()` y no `parseInt()`, que aceptaría `'9abc'`
   * como 9 y dibujaría un tablero de setiembre sin que nadie lo haya pedido.
   */
  private periodoDeQuery(query: any): { anio: number; mes: number } {
    const hoy = new Date();
    if (
      query?.anio === undefined ||
      query?.mes === undefined ||
      query.anio === '' ||
      query.mes === ''
    ) {
      return { anio: hoy.getFullYear(), mes: hoy.getMonth() + 1 };
    }

    const anio = Number(query.anio);
    const mes = Number(query.mes);
    if (!anio || Number.isNaN(anio) || anio < 2000 || anio > 2100) {
      throw new BadRequestException('El año del periodo no es válido');
    }
    if (!mes || Number.isNaN(mes) || mes < 1 || mes > 12) {
      throw new BadRequestException('El mes del periodo no es válido');
    }
    return { anio, mes };
  }

  /**
   * Deja las primeras TOP_CATEGORIAS y pliega la cola en una fila "Otras".
   *
   * Se hace acá y no con un `LIMIT` en la query a propósito: con LIMIT la cola
   * desaparece y las partes dejan de sumar el total — el gráfico muestra 40 de 63
   * trabajadores sin decir dónde están los otros 23.
   */
  private plegarCola(filas: any[], claveEtiqueta: string) {
    const normalizadas = filas.map((f) => ({
      etiqueta: f[claveEtiqueta],
      valor: num(f.total),
      movimientos: f.movimientos !== undefined ? num(f.movimientos) : null,
    }));
    if (normalizadas.length <= TOP_CATEGORIAS) return normalizadas;

    const visibles = normalizadas.slice(0, TOP_CATEGORIAS - 1);
    const cola = normalizadas.slice(TOP_CATEGORIAS - 1);
    return [
      ...visibles,
      {
        etiqueta: `Otras (${cola.length})`,
        valor: cola.reduce((a, f) => a + f.valor, 0),
        movimientos: cola.reduce((a, f) => a + (f.movimientos ?? 0), 0) || null,
      },
    ];
  }
}
