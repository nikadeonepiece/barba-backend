import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { AuditoriaService } from '@app/common';
import { MotorCalculoService } from './motor-calculo.service';
import { BoletaPdfService } from './boleta-pdf.service';
import {
  CreatePlanillaDto, CreateEntradaDatoDto, GuardarTareoDto,
} from './dto/planilla.dto';

const num = (v: any): number => (v === null || v === undefined ? 0 : Number(v));
const r2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

@Injectable()
export class PlanillasService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private motor: MotorCalculoService,
    private boletaPdf: BoletaPdfService,
  ) {}

  // ==========================================================================
  // Cabecera
  // ==========================================================================
  async findAll(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;

    const where: string[] = ["p.estado_registro = 'ACTIVO'"];
    const params: any[] = [];

    if (query.id_empresa) { where.push('p.id_empresa = ?'); params.push(Number(query.id_empresa)); }
    if (query.anio) { where.push('p.anio = ?'); params.push(Number(query.anio)); }
    if (query.mes) { where.push('p.mes = ?'); params.push(Number(query.mes)); }
    if (query.estado) { where.push('p.estado = ?'); params.push(query.estado); }
    if (query.search) {
      where.push('(e.razon_social LIKE ? OR e.ruc LIKE ?)');
      params.push(`%${query.search}%`, `%${query.search}%`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT p.id_planilla, p.id_empresa, e.razon_social, e.ruc, p.anio, p.mes, p.tipo, p.estado,
                p.fecha_calculo, p.fecha_cierre, p.total_ingresos, p.total_descuentos,
                p.total_aportes, p.total_neto, p.total_trabajadores
         FROM planilla_planilla p
         JOIN empresa e ON e.id_empresa = p.id_empresa
         ${whereSql}
         ORDER BY p.anio DESC, p.mes DESC, e.razon_social
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM planilla_planilla p JOIN empresa e ON e.id_empresa = p.id_empresa ${whereSql}`,
        params,
      ),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  async findOne(id: number) {
    const [row] = await this.dataSource.query(
      `SELECT p.*, e.razon_social, e.ruc
       FROM planilla_planilla p
       JOIN empresa e ON e.id_empresa = p.id_empresa
       WHERE p.id_planilla = ? AND p.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('Planilla no encontrada');
    return row;
  }

  /** Abre el periodo. No calcula nada todavía: primero se cargan los datos. */
  async create(dto: CreatePlanillaDto, userId: number) {
    const [config] = await this.dataSource.query(
      `SELECT dias_mes, horas_jornada FROM planilla_empresa_config
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [dto.id_empresa],
    );
    if (!config) {
      throw new BadRequestException('Esta empresa no tiene configuración de planilla. Configúrala antes de abrir un periodo.');
    }

    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO planilla_planilla
          (id_empresa, anio, mes, tipo, estado, snap_dias_mes, snap_horas_jornada,
           observaciones, estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, 'BORRADOR', ?, ?, ?, 'ACTIVO', ?)`,
        [
          dto.id_empresa, dto.anio, dto.mes, dto.tipo ?? 'MENSUAL',
          config.dias_mes, config.horas_jornada,
          dto.observaciones?.trim() ?? null, userId,
        ],
      );
      const idNuevo = Number(res.insertId);
      await this.auditoriaService.registrar('planilla_planilla', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe una planilla abierta para esa empresa y periodo');
      }
      throw error;
    }
  }

  private async exigirBorrador(id: number) {
    const p = await this.findOne(id);
    if (p.estado === 'CERRADA') {
      throw new BadRequestException(
        'Esta planilla está cerrada: ya se declaró y no se puede modificar. Si hay un error, anúlala y abre una planilla adicional.',
      );
    }
    if (p.estado === 'ANULADA') throw new BadRequestException('Esta planilla está anulada');
    return p;
  }

  // ==========================================================================
  // Entrada de datos
  // ==========================================================================
  async findEntradas(idPlanilla: number, origen?: string) {
    await this.findOne(idPlanilla);
    const where: string[] = ["e.id_planilla = ?", "e.estado_registro = 'ACTIVO'"];
    const params: any[] = [idPlanilla];
    if (origen) { where.push('e.origen = ?'); params.push(origen); }

    return this.dataSource.query(
      `SELECT e.id_entrada, e.id_trabajador, e.id_concepto, e.origen, e.cantidad, e.porcentaje,
              e.monto, e.observacion,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
              t.numero_documento, c.codigo_plame, c.nombre AS nombre_concepto, c.tipo
       FROM planilla_entrada_dato e
       JOIN planilla_trabajador t ON t.id_trabajador = e.id_trabajador
       LEFT JOIN planilla_concepto c ON c.id_concepto = e.id_concepto
       WHERE ${where.join(' AND ')}
       ORDER BY t.apellido_paterno, e.origen`,
      params,
    );
  }

  async createEntrada(idPlanilla: number, dto: CreateEntradaDatoDto, userId: number) {
    await this.exigirBorrador(idPlanilla);

    if (dto.monto === undefined && dto.cantidad === undefined && dto.porcentaje === undefined) {
      throw new BadRequestException('Indica al menos un monto, una cantidad o un porcentaje');
    }

    const res: any = await this.dataSource.query(
      `INSERT INTO planilla_entrada_dato
        (id_planilla, id_trabajador, id_concepto, origen, cantidad, porcentaje, monto,
         observacion, estado_registro, id_usuario_crea)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
      [
        idPlanilla, dto.id_trabajador, dto.id_concepto ?? null, dto.origen,
        dto.cantidad ?? null, dto.porcentaje ?? null, dto.monto ?? null,
        dto.observacion?.trim() ?? null, userId,
      ],
    );
    return { id: Number(res.insertId) };
  }

  async removeEntrada(idPlanilla: number, idEntrada: number, userId: number) {
    await this.exigirBorrador(idPlanilla);
    const res: any = await this.dataSource.query(
      `UPDATE planilla_entrada_dato SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
       WHERE id_entrada = ? AND id_planilla = ? AND estado_registro = 'ACTIVO'`,
      [userId, idEntrada, idPlanilla],
    );
    if (res.affectedRows === 0) throw new NotFoundException('Entrada no encontrada');
    return { id: idEntrada };
  }

  // ==========================================================================
  // Tareo
  // ==========================================================================
  async findTareo(idPlanilla: number, idTrabajador?: number) {
    await this.findOne(idPlanilla);
    const where: string[] = ["t.id_planilla = ?", "t.estado_registro = 'ACTIVO'"];
    const params: any[] = [idPlanilla];
    if (idTrabajador) { where.push('t.id_trabajador = ?'); params.push(idTrabajador); }

    return this.dataSource.query(
      `SELECT t.id_tareo, t.id_trabajador, t.dia, t.fecha, t.id_marca,
              t.horas_extras_25, t.horas_extras_35, t.minutos_tardanza,
              m.codigo AS codigo_marca, m.color_hex
       FROM planilla_tareo t
       JOIN planilla_tareo_marca m ON m.id_marca = t.id_marca
       WHERE ${where.join(' AND ')}
       ORDER BY t.id_trabajador, t.dia`,
      params,
    );
  }

  /**
   * Guarda el tareo de un trabajador de un solo golpe.
   *
   * Reemplaza el mes entero en vez de hacer upsert día por día: el tareo se llena y
   * corrige como una grilla completa, y así un día borrado en la UI desaparece de
   * verdad en vez de quedar colgado con su valor viejo.
   */
  async guardarTareo(idPlanilla: number, dto: GuardarTareoDto, userId: number) {
    const planilla = await this.exigirBorrador(idPlanilla);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `DELETE FROM planilla_tareo WHERE id_planilla = ? AND id_trabajador = ?`,
        [idPlanilla, dto.id_trabajador],
      );

      const ultimoDia = new Date(planilla.anio, planilla.mes, 0).getDate();
      for (const d of dto.dias) {
        if (d.dia < 1 || d.dia > ultimoDia) {
          throw new BadRequestException(`El día ${d.dia} no existe en ${planilla.mes}/${planilla.anio}`);
        }
        const fecha = `${planilla.anio}-${String(planilla.mes).padStart(2, '0')}-${String(d.dia).padStart(2, '0')}`;
        await qr.query(
          `INSERT INTO planilla_tareo
            (id_planilla, id_trabajador, dia, fecha, id_marca,
             horas_extras_25, horas_extras_35, minutos_tardanza, estado_registro, id_usuario_crea)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
          [
            idPlanilla, dto.id_trabajador, d.dia, fecha, d.id_marca,
            d.horas_extras_25 ?? 0, d.horas_extras_35 ?? 0, d.minutos_tardanza ?? 0, userId,
          ],
        );
      }

      await qr.commitTransaction();
      return { id_trabajador: dto.id_trabajador, dias: dto.dias.length };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ==========================================================================
  // CÁLCULO — el botón "Procesar planilla"
  // ==========================================================================
  /**
   * Recalcula la planilla entera desde cero.
   *
   * Borra el resultado anterior y lo rehace: el input (entrada de datos y tareo) NO se
   * toca, así que se puede recalcular las veces que haga falta. Todo va en una
   * transacción — una planilla a medio calcular es peor que una sin calcular, porque
   * parece correcta.
   */
  async calcular(idPlanilla: number, userId: number) {
    const planilla = await this.exigirBorrador(idPlanilla);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const ctx = await this.motor.cargarContexto(qr, planilla.id_empresa, planilla.anio, planilla.mes);

      // Trabajadores con vínculo vigente en algún momento del periodo: incluye a los
      // que ingresaron o cesaron a mitad de mes, que igual cobran su parte.
      const trabajadores = await qr.query(
        `SELECT t.*, r.codigo AS codigo_regimen, r.factor_cts, r.factor_gratificacion,
                r.aplica_asignacion_familiar, r.aplica_essalud, r.pension_obligatoria
         FROM planilla_trabajador t
         JOIN planilla_regimen_laboral r ON r.id_regimen = t.id_regimen
         WHERE t.id_empresa = ? AND t.estado_registro = 'ACTIVO'
           AND t.fecha_ingreso <= ?
           AND (t.fecha_cese IS NULL OR t.fecha_cese >= ?)
         ORDER BY t.apellido_paterno, t.apellido_materno, t.nombres`,
        [planilla.id_empresa, ctx.fechaPeriodo, ctx.primerDia],
      );

      if (!trabajadores.length) {
        throw new BadRequestException(
          'No hay trabajadores con vínculo vigente en este periodo. Revisa el padrón: fechas de ingreso y cese.',
        );
      }

      // Se borra el resultado anterior, nunca el input.
      await qr.query(`DELETE FROM planilla_detalle WHERE id_planilla = ?`, [idPlanilla]);
      await qr.query(`DELETE FROM planilla_provision WHERE id_planilla = ?`, [idPlanilla]);

      let totIngresos = 0, totDescuentos = 0, totAportes = 0, totNeto = 0;

      for (const t of trabajadores) {
        t.__id_planilla = idPlanilla;
        const c = await this.motor.calcularTrabajador(qr, ctx, t);

        const resDet: any = await qr.query(
          `INSERT INTO planilla_detalle
            (id_planilla, id_trabajador, snap_id_regimen, snap_factor_cts, snap_factor_gratificacion,
             snap_sueldo_basico, snap_modalidad_pago, snap_regimen_pensionario, snap_id_afp, snap_id_afp_tasa, snap_tipo_comision_afp,
             dias_laborados, dias_no_laborados, dias_subsidiados, dias_faltas, dias_vacaciones,
             horas_extras_25, horas_extras_35,
             remuneracion_asegurable, base_renta_quinta, total_ingresos, total_descuentos,
             total_aportes_empleador, adelanto_quincena, neto_pagar, estado_registro)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO')`,
          [
            idPlanilla, t.id_trabajador, t.id_regimen, t.factor_cts, t.factor_gratificacion,
            // `snap_modalidad_pago` va junto al sueldo porque los dos solo tienen
            // sentido juntos: "1950.00" no significa nada sin saber si era del mes o
            // del día. Sin el snapshot, pasar a alguien de mensual a jornal cambiaría
            // en silencio la re-explicación de todas sus planillas anteriores.
            c.sueldoBasico, c.modalidad, t.regimen_pensionario, t.id_afp ?? null, t.__id_afp_tasa ?? null, t.tipo_comision_afp ?? null,
            c.dias.laborados, c.dias.faltas + c.dias.licenciaSinGoce, c.dias.subsidiados, c.dias.faltas, c.dias.vacaciones,
            c.dias.horasExtras25, c.dias.horasExtras35,
            c.remuneracionAsegurable, c.baseRentaQuinta, c.totalIngresos, c.totalDescuentos,
            c.totalAportes, c.adelanto, c.netoPagar,
          ],
        );
        const idDetalle = Number(resDet.insertId);

        for (const l of c.lineas) {
          await qr.query(
            `INSERT INTO planilla_detalle_concepto
              (id_detalle, id_concepto, codigo_plame, nombre_concepto, tipo,
               cantidad, base_calculo, porcentaje_aplicado, monto, orden_impresion, es_manual)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              idDetalle, l.id_concepto, l.codigo_plame, l.nombre_concepto, l.tipo,
              l.cantidad, l.base_calculo, l.porcentaje_aplicado, l.monto, l.orden_impresion, l.es_manual,
            ],
          );
        }

        // La base de las provisiones es la remuneración computable, que para el caso
        // corriente es la remuneración asegurable del mes.
        for (const p of this.motor.provisiones(t, c.remuneracionAsegurable)) {
          await qr.query(
            `INSERT INTO planilla_provision
              (id_planilla, id_trabajador, tipo, base_calculo, factor_mensual, monto_mes, estado_registro)
             VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO')`,
            [idPlanilla, t.id_trabajador, p.tipo, p.base_calculo, p.factor_mensual, p.monto_mes],
          );
        }

        totIngresos += c.totalIngresos;
        totDescuentos += c.totalDescuentos;
        totAportes += c.totalAportes;
        totNeto += c.netoPagar;
      }

      await qr.query(
        `UPDATE planilla_planilla
         SET estado = 'CALCULADA', fecha_calculo = NOW(),
             snap_rmv = ?, snap_uit = ?,
             total_ingresos = ?, total_descuentos = ?, total_aportes = ?, total_neto = ?,
             total_trabajadores = ?, id_usuario_mod = ?
         WHERE id_planilla = ?`,
        [
          ctx.parametros.get('RMV') ?? null, ctx.parametros.get('UIT') ?? null,
          r2(totIngresos), r2(totDescuentos), r2(totAportes), r2(totNeto),
          trabajadores.length, userId, idPlanilla,
        ],
      );

      await qr.commitTransaction();
      await this.auditoriaService.registrar('planilla_planilla', idPlanilla, 'ACTUALIZAR', userId, planilla, {
        accion: 'CALCULAR', trabajadores: trabajadores.length, total_neto: r2(totNeto),
      });

      return {
        id: idPlanilla,
        trabajadores: trabajadores.length,
        total_ingresos: r2(totIngresos),
        total_descuentos: r2(totDescuentos),
        total_aportes: r2(totAportes),
        total_neto: r2(totNeto),
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ==========================================================================
  // Resultado
  // ==========================================================================
  async findDetalle(idPlanilla: number) {
    await this.findOne(idPlanilla);
    return this.dataSource.query(
      `SELECT d.*, t.numero_documento,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
              t.cargo, r.nombre AS nombre_regimen, r.codigo AS codigo_regimen, a.nombre AS nombre_afp
       FROM planilla_detalle d
       JOIN planilla_trabajador t ON t.id_trabajador = d.id_trabajador
       JOIN planilla_regimen_laboral r ON r.id_regimen = d.snap_id_regimen
       LEFT JOIN planilla_afp a ON a.id_afp = d.snap_id_afp
       WHERE d.id_planilla = ? AND d.estado_registro = 'ACTIVO'
       ORDER BY t.apellido_paterno, t.apellido_materno, t.nombres`,
      [idPlanilla],
    );
  }

  /** La boleta de un trabajador: su desglose completo, agrupado por tipo. */
  async findBoleta(idPlanilla: number, idTrabajador: number) {
    const planilla = await this.findOne(idPlanilla);

    const [detalle] = await this.dataSource.query(
      `SELECT d.*, t.numero_documento, t.cargo, t.fecha_ingreso,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
              r.nombre AS nombre_regimen, a.nombre AS nombre_afp
       FROM planilla_detalle d
       JOIN planilla_trabajador t ON t.id_trabajador = d.id_trabajador
       JOIN planilla_regimen_laboral r ON r.id_regimen = d.snap_id_regimen
       LEFT JOIN planilla_afp a ON a.id_afp = d.snap_id_afp
       WHERE d.id_planilla = ? AND d.id_trabajador = ? AND d.estado_registro = 'ACTIVO'`,
      [idPlanilla, idTrabajador],
    );
    if (!detalle) throw new NotFoundException('Este trabajador no está en la planilla calculada');

    const conceptos = await this.dataSource.query(
      `SELECT codigo_plame, nombre_concepto, tipo, cantidad, base_calculo, porcentaje_aplicado, monto
       FROM planilla_detalle_concepto
       WHERE id_detalle = ? ORDER BY tipo, orden_impresion, codigo_plame`,
      [detalle.id_detalle],
    );

    return {
      planilla,
      detalle,
      ingresos: conceptos.filter((c: any) => c.tipo === 'INGRESO'),
      descuentos: conceptos.filter((c: any) => c.tipo === 'DESCUENTO'),
      aportes: conceptos.filter((c: any) => c.tipo === 'APORTE_EMPLEADOR'),
    };
  }

  /**
   * La misma boleta de `findBoleta`, pero impresa en PDF. El maquetado vive en
   * `BoletaPdfService` porque el portal cliente descarga exactamente este documento.
   */
  async exportarBoletaPdf(idPlanilla: number, idTrabajador: number, res: Response) {
    const boleta = await this.findBoleta(idPlanilla, idTrabajador);
    await this.boletaPdf.generar(boleta, res);
  }

  async findProvisiones(idPlanilla: number) {
    await this.findOne(idPlanilla);
    return this.dataSource.query(
      `SELECT p.*, CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
              t.numero_documento
       FROM planilla_provision p
       JOIN planilla_trabajador t ON t.id_trabajador = p.id_trabajador
       WHERE p.id_planilla = ? AND p.estado_registro = 'ACTIVO'
       ORDER BY t.apellido_paterno, p.tipo`,
      [idPlanilla],
    );
  }

  /** Resumen de tributos y aportes: lo que hay que pagar a SUNAT, AFP y EsSalud. */
  async findResumenTributos(idPlanilla: number) {
    await this.findOne(idPlanilla);
    return this.dataSource.query(
      `SELECT dc.codigo_plame, dc.nombre_concepto, dc.tipo,
              COUNT(*) AS trabajadores, SUM(dc.monto) AS total
       FROM planilla_detalle_concepto dc
       JOIN planilla_detalle d ON d.id_detalle = dc.id_detalle
       WHERE d.id_planilla = ? AND d.estado_registro = 'ACTIVO'
         AND dc.tipo IN ('DESCUENTO','APORTE_EMPLEADOR')
       GROUP BY dc.codigo_plame, dc.nombre_concepto, dc.tipo
       ORDER BY dc.tipo, dc.codigo_plame`,
      [idPlanilla],
    );
  }

  // ==========================================================================
  // Cierre y anulación
  // ==========================================================================
  async cerrar(idPlanilla: number, userId: number) {
    const p = await this.findOne(idPlanilla);
    if (p.estado !== 'CALCULADA') {
      throw new BadRequestException('Solo se puede cerrar una planilla ya calculada');
    }

    await this.dataSource.query(
      `UPDATE planilla_planilla SET estado = 'CERRADA', fecha_cierre = NOW(), id_usuario_mod = ?
       WHERE id_planilla = ? AND estado = 'CALCULADA'`,
      [userId, idPlanilla],
    );
    await this.auditoriaService.registrar('planilla_planilla', idPlanilla, 'ACTUALIZAR', userId, p, { accion: 'CERRAR' });
    return { id: idPlanilla };
  }

  async anular(idPlanilla: number, userId: number) {
    const p = await this.findOne(idPlanilla);
    if (p.estado === 'ANULADA') throw new BadRequestException('Esta planilla ya está anulada');

    await this.dataSource.query(
      `UPDATE planilla_planilla SET estado = 'ANULADA', id_usuario_mod = ? WHERE id_planilla = ?`,
      [userId, idPlanilla],
    );
    await this.auditoriaService.registrar('planilla_planilla', idPlanilla, 'ANULAR', userId, p, null);
    return { id: idPlanilla };
  }

  /** Reabre una planilla cerrada para corregirla. Queda registrado en auditoría. */
  async reabrir(idPlanilla: number, userId: number) {
    const p = await this.findOne(idPlanilla);
    if (p.estado !== 'CERRADA') throw new BadRequestException('Solo se puede reabrir una planilla cerrada');

    await this.dataSource.query(
      `UPDATE planilla_planilla SET estado = 'CALCULADA', fecha_cierre = NULL, id_usuario_mod = ?
       WHERE id_planilla = ?`,
      [userId, idPlanilla],
    );
    // 'ACTUALIZAR' y no 'REVERTIR': el ENUM de sis_auditoria en este proyecto solo
    // admite CREAR/ACTUALIZAR/ELIMINAR/ANULAR. El detalle de la acción va en los
    // valores nuevos, que es lo que después se lee en el historial.
    await this.auditoriaService.registrar('planilla_planilla', idPlanilla, 'ACTUALIZAR', userId, p, { accion: 'REABRIR' });
    return { id: idPlanilla };
  }
}
