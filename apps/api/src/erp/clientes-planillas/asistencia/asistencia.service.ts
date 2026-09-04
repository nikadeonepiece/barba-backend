import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditoriaService } from '@app/common';
import { resolverEmpresaDelUsuario } from '../scope-empresa';
import { GuardarAsistenciaDto, LlenarMesDto } from './dto/asistencia.dto';

const COLS_ORDER_ALLOWED = [
  'apellido_paterno',
  'cargo',
  'area',
  'fecha_ingreso',
];

/**
 * Asistencia — PORTAL CLIENTE. El único módulo del portal que ESCRIBE, junto con
 * `modalidad-pago`.
 *
 * ── Por qué el portal escribe acá ──
 *
 * Quién vino a trabajar el martes lo sabe la empresa, no el estudio. Hoy ese dato
 * viaja por WhatsApp a fin de mes y alguien lo teclea; acá se captura en origen, día
 * por día, y de paso queda el registro de control de asistencia que pide SUNAFIL.
 * Lo que el cliente puede tocar sigue siendo mínimo: marcar el día de su propia
 * gente. No calcula, no cierra, no toca un monto.
 *
 * ── El scope, igual que en todo el portal ──
 *
 * Cada método arranca por `resolverEmpresaDelUsuario()` y mete ese `id_empresa` en el
 * WHERE, incluidos los que ya reciben un `id_trabajador` por el body. Sin eso, mandar
 * el id de un trabajador ajeno le marcaría asistencia en la planilla de otra empresa
 * — que es bastante peor que leerla.
 */
@Injectable()
export class AsistenciaClienteService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private readonly auditoriaService: AuditoriaService,
  ) {}

  // ==========================================================================
  // Helpers de periodo
  // ==========================================================================

  /** Valida año/mes (llegan como string del query) y devuelve el periodo ya acotado. */
  private resolverPeriodo(anioRaw: any, mesRaw: any) {
    const hoy = new Date();
    const anio = Number(anioRaw) || hoy.getFullYear();
    const mes = Number(mesRaw) || hoy.getMonth() + 1;

    if (Number.isNaN(anio) || anio < 2000 || anio > 2100) {
      throw new BadRequestException('Año inválido');
    }
    if (Number.isNaN(mes) || mes < 1 || mes > 12) {
      throw new BadRequestException('Mes inválido');
    }

    // `new Date(anio, mes, 0)` es el día 0 del mes SIGUIENTE, o sea el último de este.
    // Resuelve febrero y los bisiestos sin una tabla de días por mes.
    const ultimoDia = new Date(anio, mes, 0).getDate();
    const mm = String(mes).padStart(2, '0');

    return {
      anio,
      mes,
      ultimoDia,
      primerDiaSql: `${anio}-${mm}-01`,
      ultimoDiaSql: `${anio}-${mm}-${String(ultimoDia).padStart(2, '0')}`,
    };
  }

  /**
   * ¿El periodo ya se declaró?
   *
   * Si el estudio cerró la planilla de ese mes, la asistencia que la alimentó no se
   * toca más: el PLAME ya se presentó con esos días y cambiarlos dejaría la base
   * diciendo una cosa y la declaración otra, sin que nadie se entere. Una planilla en
   * BORRADOR sí se puede seguir corrigiendo — todavía no salió a ningún lado.
   */
  private async periodoCerrado(
    idEmpresa: number,
    anio: number,
    mes: number,
  ): Promise<boolean> {
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*) AS cerradas FROM planilla_planilla
       WHERE id_empresa = ? AND anio = ? AND mes = ?
         AND estado = 'CERRADA' AND estado_registro = 'ACTIVO'`,
      [idEmpresa, anio, mes],
    );
    return Number(row?.cerradas) > 0;
  }

  private async exigirPeriodoEditable(
    idEmpresa: number,
    anio: number,
    mes: number,
  ) {
    if (await this.periodoCerrado(idEmpresa, anio, mes)) {
      throw new BadRequestException(
        'La planilla de este mes ya está cerrada y declarada, así que la asistencia quedó fija. Si hay un error, avisale al estudio: se corrige con una planilla adicional.',
      );
    }
  }

  /**
   * Hasta qué día se puede marcar en ESTE periodo: hoy si es el mes en curso, el
   * último día si el mes ya pasó, 0 si todavía no empezó.
   *
   * Marcar el futuro no es un dato, es una suposición: nadie sabe todavía si esa
   * persona va a venir el jueves que viene.
   */
  private diaTopeDelPeriodo(anio: number, mes: number): number {
    const hoy = new Date();
    const anioHoy = hoy.getFullYear();
    const mesHoy = hoy.getMonth() + 1;

    if (anio < anioHoy || (anio === anioHoy && mes < mesHoy))
      return new Date(anio, mes, 0).getDate();
    if (anio === anioHoy && mes === mesHoy) return hoy.getDate();
    return 0;
  }

  // ==========================================================================
  // Lectura
  // ==========================================================================

  /** Leyenda del tareo: qué se puede marcar, qué cuenta cada marca y de qué color se pinta. */
  async marcas() {
    return this.dataSource.query(
      `SELECT id_marca, codigo, nombre, color_hex,
              computa_dia_laborado, computa_falta, computa_feriado, computa_descanso,
              computa_subsidio, computa_vacaciones,
              computa_licencia_con_goce, computa_licencia_sin_goce
       FROM planilla_tareo_marca
       WHERE estado_registro = 'ACTIVO'
       ORDER BY orden ASC, codigo ASC`,
    );
  }

  /** Áreas del padrón de ESTA empresa — alimenta el filtro de la grilla. */
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
   * La grilla del mes: una fila por trabajador, con sus días ya marcados.
   *
   * Paginado como cualquier listado del proyecto, pero con un default más chico (15):
   * la grilla es ancha —hasta 31 columnas— y traer doscientos trabajadores de un saque
   * la vuelve inusable mucho antes de volverse lenta.
   */
  async periodo(user: any, query: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);
    const p = this.resolverPeriodo(query.anio, query.mes);

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 15;
    const offset = (page - 1) * limit;

    // `t.id_empresa = ?` es lo PRIMERO del WHERE y no sale de nada que haya mandado el
    // frontend. Los filtros de abajo solo pueden achicar el resultado, nunca ampliarlo.
    //
    // El vínculo se cruza contra el PERIODO, no contra hoy: quien cesó el 10 de marzo
    // tiene que aparecer en la grilla de marzo (trabajó nueve días y los cobra) y
    // desaparecer de la de abril.
    const where: string[] = [
      "t.estado_registro = 'ACTIVO'",
      't.id_empresa = ?',
      't.fecha_ingreso <= ?',
      '(t.fecha_cese IS NULL OR t.fecha_cese >= ?)',
    ];
    const params: any[] = [idEmpresa, p.ultimoDiaSql, p.primerDiaSql];

    if (query.search) {
      where.push(
        `(t.numero_documento LIKE ? OR CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) LIKE ? OR t.cargo LIKE ?)`,
      );
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }

    if (query.area) {
      where.push('t.area = ?');
      params.push(query.area);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sortCol = COLS_ORDER_ALLOWED.includes(query.sort)
      ? query.sort
      : 'apellido_paterno';
    const sortDir = query.dir === 'DESC' ? 'DESC' : 'ASC';

    const [trabajadores, [{ total }], cerrado] = await Promise.all([
      this.dataSource.query(
        `SELECT t.id_trabajador, t.numero_documento,
                CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_completo,
                t.cargo, t.area, t.fecha_ingreso, t.fecha_cese, t.modalidad_pago
         FROM planilla_trabajador t
         ${whereSql}
         ORDER BY t.${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM planilla_trabajador t ${whereSql}`,
        params,
      ),
      this.periodoCerrado(idEmpresa, p.anio, p.mes),
    ]);

    // Las marcas de TODA la página en una sola query, no una por trabajador: con
    // quince filas serían quince idas y vueltas a la base para dibujar una pantalla.
    // El `if` de arriba no es decorativo: `IN ()` con la lista vacía es un error de
    // sintaxis de MySQL, no una consulta que devuelve cero filas.
    const ids = trabajadores.map((t: any) => t.id_trabajador);
    let marcas: any[] = [];
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      marcas = await this.dataSource.query(
        `SELECT a.id_trabajador, a.dia, a.id_marca, a.observacion,
                m.codigo AS codigo_marca, m.color_hex
         FROM planilla_asistencia a
         JOIN planilla_tareo_marca m ON m.id_marca = a.id_marca
         WHERE a.id_empresa = ? AND a.anio = ? AND a.mes = ?
           AND a.estado_registro = 'ACTIVO'
           AND a.id_trabajador IN (${placeholders})`,
        [idEmpresa, p.anio, p.mes, ...ids],
      );
    }

    const porTrabajador = new Map<number, Record<number, any>>();
    for (const m of marcas) {
      const id = Number(m.id_trabajador);
      if (!porTrabajador.has(id)) porTrabajador.set(id, {});
      porTrabajador.get(id)![Number(m.dia)] = {
        id_marca: Number(m.id_marca),
        codigo: m.codigo_marca,
        color_hex: m.color_hex,
        observacion: m.observacion,
      };
    }

    const data = trabajadores.map((t: any) => ({
      ...t,
      dias: porTrabajador.get(Number(t.id_trabajador)) ?? {},
    }));

    return {
      data,
      meta: { total: Number(total), page, limit },
      periodo: {
        anio: p.anio,
        mes: p.mes,
        ultimo_dia: p.ultimoDia,
        cerrado,
        // Hasta qué día deja marcar la pantalla. El backend igual lo vuelve a validar
        // al guardar: el frontend puede mentir, y de hecho basta con abrir la consola.
        dia_tope: this.diaTopeDelPeriodo(p.anio, p.mes),
      },
    };
  }

  // ==========================================================================
  // Escritura
  // ==========================================================================

  /**
   * Guarda de una sola vez todos los trabajadores que el usuario tocó en la grilla.
   *
   * ── Por qué un lote y no una llamada por trabajador ──
   *
   * Es la regla del proyecto para acciones masivas, y acá se ve para qué sirve: con
   * una request por fila, si la séptima falla quedan seis meses guardados y catorce
   * sin guardar. La pantalla no tiene cómo decir cuáles y el usuario ve un error
   * genérico sin saber qué reintentar. En una transacción, o entra todo o no entra
   * nada, y lo que quedó en pantalla sigue siendo fiel a la base.
   *
   * ── Por qué se reemplaza el mes en vez de hacer upsert día por día ──
   *
   * Igual que `guardarTareo()` en la intranet: la grilla se llena y se corrige como un
   * bloque, así que un día que el usuario dejó en blanco tiene que DESAPARECER. Con un
   * upsert quedaría colgado con su valor anterior y nadie lo notaría.
   *
   * ── Por qué el DELETE es físico y no un `estado_registro = 'ELIMINADO'` ──
   *
   * Lo mismo que hace `planilla_tareo`, y por el mismo motivo: la unicidad es
   * `(id_trabajador, fecha)`, así que dejar la fila vieja como ELIMINADA haría que
   * volver a marcar ese día chocara contra el índice. Nada se pierde — la asistencia
   * es un input que se rehace, y quién la cambió queda en `sis_auditoria`.
   */
  async guardar(user: any, dto: GuardarAsistenciaDto, userId: number) {
    const idEmpresa = resolverEmpresaDelUsuario(user);
    const p = this.resolverPeriodo(dto.anio, dto.mes);

    await this.exigirPeriodoEditable(idEmpresa, p.anio, p.mes);

    const diaTope = this.diaTopeDelPeriodo(p.anio, p.mes);
    if (diaTope === 0) {
      throw new BadRequestException(
        'Ese mes todavía no empieza: no hay asistencia que marcar.',
      );
    }

    // TODO se valida ANTES de abrir la transacción. Entrar a la transacción para
    // tirarla en el tercer trabajador ocupa una conexión del pool al pedo, y el pool
    // de este hosting es chico.
    const marcasValidas = await this.marcasValidas();
    const idsPedidos = dto.trabajadores.map((t) => Number(t.id_trabajador));

    const repetido = idsPedidos.find((id, i) => idsPedidos.indexOf(id) !== i);
    if (repetido) {
      throw new BadRequestException(
        'Un mismo trabajador vino dos veces en el guardado. Recargá la página: la grilla quedó en un estado inconsistente.',
      );
    }

    // Una sola query para todos, no una por trabajador. El `id_empresa` en el WHERE es
    // el candado: sin él, mandar el id de un trabajador ajeno le marcaría asistencia.
    const placeholders = idsPedidos.map(() => '?').join(',');
    const propios = await this.dataSource.query(
      `SELECT id_trabajador, fecha_ingreso, fecha_cese,
              CONCAT_WS(' ', apellido_paterno, apellido_materno, nombres) AS nombre_completo
       FROM planilla_trabajador
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO'
         AND id_trabajador IN (${placeholders})`,
      [idEmpresa, ...idsPedidos],
    );
    const porId = new Map<number, any>(
      propios.map((t: any) => [Number(t.id_trabajador), t]),
    );

    for (const bloque of dto.trabajadores) {
      // Mismo mensaje para "no existe" y para "es de otra empresa": distinguirlos
      // convertiría el endpoint en un detector de qué IDs están ocupados en el padrón.
      const trabajador = porId.get(Number(bloque.id_trabajador));
      if (!trabajador) throw new NotFoundException('Trabajador no encontrado');

      const vistos = new Set<number>();
      for (const d of bloque.dias) {
        if (d.dia < 1 || d.dia > p.ultimoDia) {
          throw new BadRequestException(
            `El día ${d.dia} no existe en ${p.mes}/${p.anio}`,
          );
        }
        if (vistos.has(d.dia)) {
          throw new BadRequestException(
            `${trabajador.nombre_completo} tiene el día ${d.dia} marcado dos veces: cada día lleva una sola marca`,
          );
        }
        vistos.add(d.dia);

        if (!marcasValidas.has(Number(d.id_marca))) {
          throw new BadRequestException(
            'Una de las marcas elegidas ya no existe o fue dada de baja. Recargá la página para ver la leyenda al día.',
          );
        }
        if (d.dia > diaTope) {
          throw new BadRequestException(
            `Todavía no se puede marcar el día ${d.dia}: no ha llegado.`,
          );
        }
        this.exigirDiaDentroDelVinculo(trabajador, p.anio, p.mes, d.dia);
      }
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      let totalDias = 0;

      for (const bloque of dto.trabajadores) {
        const previo = await qr.query(
          `SELECT dia, id_marca FROM planilla_asistencia
           WHERE id_empresa = ? AND id_trabajador = ? AND anio = ? AND mes = ?`,
          [idEmpresa, bloque.id_trabajador, p.anio, p.mes],
        );

        await qr.query(
          `DELETE FROM planilla_asistencia
           WHERE id_empresa = ? AND id_trabajador = ? AND anio = ? AND mes = ?`,
          [idEmpresa, bloque.id_trabajador, p.anio, p.mes],
        );

        if (bloque.dias.length > 0) {
          // Un solo INSERT con N VALUES, no N INSERT en un loop: son hasta 31 días por
          // trabajador y el loop multiplicaría por 31 los viajes a la base.
          const valores = bloque.dias
            .map(() => `(?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`)
            .join(', ');
          const insertParams: any[] = [];
          for (const d of bloque.dias) {
            insertParams.push(
              idEmpresa,
              bloque.id_trabajador,
              p.anio,
              p.mes,
              d.dia,
              this.fechaDe(p.anio, p.mes, d.dia),
              d.id_marca,
              d.observacion?.trim() || null,
              userId,
            );
          }
          await qr.query(
            `INSERT INTO planilla_asistencia
              (id_empresa, id_trabajador, anio, mes, dia, fecha, id_marca, observacion,
               estado_registro, id_usuario_crea)
             VALUES ${valores}`,
            insertParams,
          );
          totalDias += bloque.dias.length;
        }

        // El id auditado es el del TRABAJADOR, no el de una fila: lo que cambió es su
        // mes completo, y apuntar a un `id_asistencia` que este mismo guardado acaba
        // de borrar no serviría para reconstruir nada.
        await this.auditoriaService.registrarConTransaccion(
          qr,
          'planilla_asistencia',
          bloque.id_trabajador,
          'ACTUALIZAR',
          userId,
          { anio: p.anio, mes: p.mes, dias: previo },
          { anio: p.anio, mes: p.mes, dias: bloque.dias },
        );
      }

      await qr.commitTransaction();
      return {
        trabajadores: dto.trabajadores.length,
        dias: totalDias,
        mensaje: `Asistencia guardada: ${totalDias} día(s) en ${dto.trabajadores.length} trabajador(es).`,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  /**
   * Rellena el mes con una misma marca — el botón "vinieron todos".
   *
   * Existe porque el caso normal es exactamente ese, y sin el atajo son 26 clicks por
   * persona: quinientos en una empresa de veinte. Una pantalla que cuesta eso no se
   * llena, y el dato vuelve a viajar por WhatsApp, que es lo que se quería evitar.
   *
   * Todo va en UNA transacción aunque toque a treinta trabajadores: dejar a la mitad
   * del personal con el mes lleno y a la otra mitad en blanco es peor que no haber
   * hecho nada, porque a simple vista parece que funcionó.
   */
  async llenarMes(user: any, dto: LlenarMesDto, userId: number) {
    const idEmpresa = resolverEmpresaDelUsuario(user);
    const p = this.resolverPeriodo(dto.anio, dto.mes);

    await this.exigirPeriodoEditable(idEmpresa, p.anio, p.mes);

    const marcasValidas = await this.marcasValidas();
    if (!marcasValidas.has(Number(dto.id_marca))) {
      throw new BadRequestException(
        'La marca elegida no existe o fue dada de baja. Recargá la página.',
      );
    }

    const diaTope = this.diaTopeDelPeriodo(p.anio, p.mes);
    if (diaTope === 0) {
      throw new BadRequestException(
        'Ese mes todavía no empieza: no hay asistencia que marcar.',
      );
    }

    const reemplazar = dto.modo === 'REEMPLAZAR';
    const incluirDomingos = dto.incluir_domingos === 'true';

    const where: string[] = [
      "t.estado_registro = 'ACTIVO'",
      't.id_empresa = ?',
      't.fecha_ingreso <= ?',
      '(t.fecha_cese IS NULL OR t.fecha_cese >= ?)',
    ];
    const params: any[] = [idEmpresa, p.ultimoDiaSql, p.primerDiaSql];

    if (dto.id_trabajador) {
      where.push('t.id_trabajador = ?');
      params.push(dto.id_trabajador);
    }

    const trabajadores = await this.dataSource.query(
      `SELECT t.id_trabajador, t.fecha_ingreso, t.fecha_cese
       FROM planilla_trabajador t
       WHERE ${where.join(' AND ')}`,
      params,
    );

    if (!trabajadores.length) {
      throw new NotFoundException(
        'No hay trabajadores con vínculo vigente en ese mes. Si diste de alta a alguien hace poco, pedile al estudio que confirme su fecha de ingreso.',
      );
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      let marcados = 0;

      for (const t of trabajadores) {
        if (reemplazar) {
          await qr.query(
            `DELETE FROM planilla_asistencia
             WHERE id_empresa = ? AND id_trabajador = ? AND anio = ? AND mes = ?`,
            [idEmpresa, t.id_trabajador, p.anio, p.mes],
          );
        }

        // Qué días ya tienen marca. En modo SOLO_VACIOS se respetan: quien ya cargó a
        // mano las faltas del mes no quiere que "vinieron todos" se las pise.
        const ocupados = new Set<number>(
          reemplazar
            ? []
            : (
                await qr.query(
                  `SELECT dia FROM planilla_asistencia
                   WHERE id_empresa = ? AND id_trabajador = ? AND anio = ? AND mes = ?`,
                  [idEmpresa, t.id_trabajador, p.anio, p.mes],
                )
              ).map((r: any) => Number(r.dia)),
        );

        const dias: number[] = [];
        for (let dia = 1; dia <= Math.min(p.ultimoDia, diaTope); dia++) {
          if (ocupados.has(dia)) continue;
          // getDay() 0 = domingo. Se saltea salvo pedido expreso: marcar el domingo
          // como "asistió" infla los días laborados y con eso el básico del mes.
          if (
            !incluirDomingos &&
            new Date(p.anio, p.mes - 1, dia).getDay() === 0
          )
            continue;
          if (!this.diaDentroDelVinculo(t, p.anio, p.mes, dia)) continue;
          dias.push(dia);
        }

        if (!dias.length) continue;

        const valores = dias
          .map(() => `(?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`)
          .join(', ');
        const insertParams: any[] = [];
        for (const dia of dias) {
          insertParams.push(
            idEmpresa,
            t.id_trabajador,
            p.anio,
            p.mes,
            dia,
            this.fechaDe(p.anio, p.mes, dia),
            dto.id_marca,
            userId,
          );
        }
        await qr.query(
          `INSERT INTO planilla_asistencia
            (id_empresa, id_trabajador, anio, mes, dia, fecha, id_marca,
             estado_registro, id_usuario_crea)
           VALUES ${valores}`,
          insertParams,
        );
        marcados += dias.length;
      }

      await this.auditoriaService.registrarConTransaccion(
        qr,
        'planilla_asistencia',
        dto.id_trabajador ?? idEmpresa,
        'ACTUALIZAR',
        userId,
        null,
        {
          anio: p.anio,
          mes: p.mes,
          id_marca: dto.id_marca,
          modo: dto.modo ?? 'SOLO_VACIOS',
          dias: marcados,
        },
      );

      await qr.commitTransaction();
      return {
        trabajadores: trabajadores.length,
        dias: marcados,
        mensaje: marcados
          ? `Se marcaron ${marcados} día(s) en ${trabajadores.length} trabajador(es).`
          : 'No quedaba ningún día por marcar con ese criterio.',
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ==========================================================================
  // Auxiliares
  // ==========================================================================

  /** IDs de marca activos. Sale de la tabla y no de una constante: el estudio agrega marcas sin desplegar. */
  private async marcasValidas(): Promise<Set<number>> {
    const filas = await this.dataSource.query(
      `SELECT id_marca FROM planilla_tareo_marca WHERE estado_registro = 'ACTIVO'`,
    );
    return new Set<number>(filas.map((f: any) => Number(f.id_marca)));
  }

  private fechaDe(anio: number, mes: number, dia: number): string {
    return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  }

  /** ¿Ese día cae dentro del vínculo laboral? Antes del ingreso o después del cese, no. */
  private diaDentroDelVinculo(
    trabajador: any,
    anio: number,
    mes: number,
    dia: number,
  ): boolean {
    const fecha = this.fechaDe(anio, mes, dia);
    const ingreso = this.aFechaSql(trabajador.fecha_ingreso);
    const cese = this.aFechaSql(trabajador.fecha_cese);

    if (ingreso && fecha < ingreso) return false;
    if (cese && fecha > cese) return false;
    return true;
  }

  private exigirDiaDentroDelVinculo(
    trabajador: any,
    anio: number,
    mes: number,
    dia: number,
  ) {
    if (!this.diaDentroDelVinculo(trabajador, anio, mes, dia)) {
      throw new BadRequestException(
        `El día ${dia} queda fuera del vínculo laboral de ${trabajador.nombre_completo ?? 'esa persona'} (ingreso o cese). Si la fecha está mal, pedile al estudio que la corrija en el padrón.`,
      );
    }
  }

  /**
   * `DATE` de MySQL llega como `Date` de JS por el driver, no como string. Comparar un
   * `Date` contra `'2026-09-01'` da siempre `false` y el filtro pasaría de largo SIN
   * dar ningún error, así que se normaliza a `YYYY-MM-DD`.
   *
   * Con los getters LOCALES, nunca `toISOString()`: eso convierte a UTC y con
   * `TZ=America/Lima` (−05:00) corre la fecha un día para atrás. Un ingreso del 1 de
   * marzo pasaría a leerse como 28 de febrero y el día 1 quedaría "fuera del vínculo".
   */
  private aFechaSql(valor: any): string | null {
    if (!valor) return null;
    if (typeof valor === 'string') return valor.slice(0, 10);
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
