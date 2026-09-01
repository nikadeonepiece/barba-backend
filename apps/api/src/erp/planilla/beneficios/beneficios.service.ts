import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import { MotorBeneficiosService } from './motor-beneficios.service';
import { CreateBeneficioDto, ActualizarPagoDto } from './dto/beneficio.dto';
import { aFechaISO } from '../fecha.util';

const r2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v: any): number => (v === null || v === undefined ? 0 : Number(v));

@Injectable()
export class BeneficiosService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private motor: MotorBeneficiosService,
  ) {}

  async findAll(query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;

    const where: string[] = ["b.estado_registro = 'ACTIVO'"];
    const params: any[] = [];

    if (query.id_empresa) { where.push('b.id_empresa = ?'); params.push(Number(query.id_empresa)); }
    if (query.tipo) { where.push('b.tipo = ?'); params.push(query.tipo); }
    if (query.anio) { where.push('b.anio = ?'); params.push(Number(query.anio)); }
    if (query.estado) { where.push('b.estado = ?'); params.push(query.estado); }
    if (query.search) {
      where.push('(e.razon_social LIKE ? OR e.ruc LIKE ?)');
      params.push(`%${query.search}%`, `%${query.search}%`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT b.id_beneficio, b.id_empresa, e.razon_social, e.ruc, b.tipo, b.anio, b.semestre,
                b.periodo_desde, b.periodo_hasta, b.fecha_pago_legal, b.fecha_pago_real, b.tea_interes,
                b.estado, b.fecha_calculo, b.total_monto, b.total_bonificacion, b.total_interes,
                b.total_pagar, b.total_trabajadores
         FROM planilla_beneficio b
         JOIN empresa e ON e.id_empresa = b.id_empresa
         ${whereSql}
         ORDER BY b.anio DESC, b.periodo_hasta DESC, e.razon_social
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM planilla_beneficio b JOIN empresa e ON e.id_empresa = b.id_empresa ${whereSql}`,
        params,
      ),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  async findOne(id: number) {
    const [row] = await this.dataSource.query(
      `SELECT b.*, e.razon_social, e.ruc
       FROM planilla_beneficio b
       JOIN empresa e ON e.id_empresa = b.id_empresa
       WHERE b.id_beneficio = ? AND b.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!row) throw new NotFoundException('Cálculo no encontrado');
    return row;
  }

  /**
   * Abre el cálculo. El periodo se propone según la ley (CTS: nov→abr / may→oct;
   * gratificación: ene→jun / jul→dic) pero se puede sobrescribir, que es lo que hace
   * falta en una liquidación por cese a mitad de semestre.
   */
  async create(dto: CreateBeneficioDto, userId: number) {
    const legal = this.motor.periodoLegal(dto.tipo, dto.anio, dto.semestre ?? 1);
    const desde = dto.periodo_desde ?? legal.desde;
    const hasta = dto.periodo_hasta ?? legal.hasta;

    if (new Date(hasta) < new Date(desde)) {
      throw new BadRequestException('El fin del periodo no puede ser anterior a su inicio');
    }

    try {
      const res: any = await this.dataSource.query(
        `INSERT INTO planilla_beneficio
          (id_empresa, tipo, periodo_desde, periodo_hasta, anio, semestre,
           fecha_pago_legal, fecha_pago_real, tea_interes, estado, observaciones,
           estado_registro, id_usuario_crea)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BORRADOR', ?, 'ACTIVO', ?)`,
        [
          dto.id_empresa, dto.tipo, desde, hasta, dto.anio, dto.semestre ?? null,
          dto.fecha_pago_legal ?? legal.fechaPagoLegal, dto.fecha_pago_real ?? null,
          dto.tea_interes ?? 0, dto.observaciones?.trim() ?? null, userId,
        ],
      );
      const idNuevo = Number(res.insertId);
      await this.auditoriaService.registrar('planilla_beneficio', idNuevo, 'CREAR', userId, null, dto);
      return { id: idNuevo };
    } catch (error: any) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('Ya existe un cálculo de ese tipo para esa empresa y periodo');
      }
      throw error;
    }
  }

  /**
   * Calcula el beneficio para todos los trabajadores con vínculo en el periodo.
   *
   * Recalcula desde cero dentro de una transacción, igual que la planilla mensual: un
   * cálculo a medias que parece completo es peor que ninguno.
   */
  async calcular(idBeneficio: number, userId: number) {
    const beneficio = await this.findOne(idBeneficio);
    if (beneficio.estado === 'CERRADO') {
      throw new BadRequestException('Este cálculo está cerrado. Reábrelo si necesitas corregirlo.');
    }
    if (beneficio.estado === 'ANULADO') throw new BadRequestException('Este cálculo está anulado');

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const periodo = {
        desde: aFechaISO(beneficio.periodo_desde)!,
        hasta: aFechaISO(beneficio.periodo_hasta)!,
        fechaPagoLegal: aFechaISO(beneficio.fecha_pago_legal),
      };

      const parametros = await this.parametrosVigentes(qr, periodo.hasta);
      const rmv = parametros.get('RMV') ?? 0;
      const pctAf = parametros.get('ASIGNACION_FAMILIAR_PCT') ?? 0;
      const pctBonifEssalud = parametros.get('BONIF_EXTRAORDINARIA_ESSALUD_PCT') ?? 0;
      const pctBonifEps = parametros.get('BONIF_EXTRAORDINARIA_EPS_PCT') ?? 0;

      // Trabajadores con vínculo en algún momento del periodo. Incluye a los cesados
      // dentro del semestre: justamente por eso existe el trunco.
      const trabajadores = await qr.query(
        `SELECT t.*, r.codigo AS codigo_regimen, r.factor_cts, r.factor_gratificacion,
                r.aplica_asignacion_familiar
         FROM planilla_trabajador t
         JOIN planilla_regimen_laboral r ON r.id_regimen = t.id_regimen
         WHERE t.id_empresa = ? AND t.estado_registro = 'ACTIVO'
           AND t.fecha_ingreso <= ?
           AND (t.fecha_cese IS NULL OR t.fecha_cese >= ?)
         ORDER BY t.apellido_paterno, t.apellido_materno, t.nombres`,
        [beneficio.id_empresa, periodo.hasta, periodo.desde],
      );

      if (!trabajadores.length) {
        throw new BadRequestException('No hay trabajadores con vínculo vigente en este periodo.');
      }

      await qr.query(`DELETE FROM planilla_beneficio_detalle WHERE id_beneficio = ?`, [idBeneficio]);

      let totMonto = 0, totBonif = 0, totInteres = 0, totPagar = 0, conMonto = 0;

      for (const t of trabajadores) {
        const rc = await this.motor.remuneracionComputable(qr, beneficio.tipo, t, periodo, rmv, pctAf);
        const tiempo = await this.motor.tiempoComputable(qr, t, periodo);

        const factor = beneficio.tipo === 'CTS' ? num(t.factor_cts) : num(t.factor_gratificacion);

        let calc: any;
        let pctBonif = 0;
        let montoBonif = 0;

        if (beneficio.tipo === 'CTS') {
          calc = this.motor.calcularCts(rc.remuneracion_computable, tiempo.meses, tiempo.dias, factor);
        } else if (beneficio.tipo === 'GRATIFICACION') {
          // 6.75% si el trabajador está en EPS (código 01 de la Tabla 32), 9% si no.
          pctBonif = t.cod_regimen_salud === '01' ? pctBonifEps : pctBonifEssalud;
          const g = this.motor.calcularGratificacion(rc.remuneracion_computable, tiempo.meses, tiempo.dias, factor, pctBonif);
          calc = g;
          montoBonif = g.monto_bonificacion;
        } else {
          calc = this.motor.calcularVacaciones(rc.remuneracion_computable, tiempo.meses, tiempo.dias);
        }

        const interes = this.motor.calcularInteres(
          calc.monto_beneficio + montoBonif,
          periodo.fechaPagoLegal,
          aFechaISO(beneficio.fecha_pago_real),
          num(beneficio.tea_interes),
        );

        const totalPagar = r2(calc.monto_beneficio + montoBonif + interes.monto_interes);

        await qr.query(
          `INSERT INTO planilla_beneficio_detalle
            (id_beneficio, id_trabajador, snap_id_regimen, snap_factor_regimen,
             rc_basico, rc_asignacion_familiar, rc_promedio_horas_extras, rc_promedio_comisiones,
             rc_promedio_bonificaciones, rc_sexto_gratificacion, remuneracion_computable,
             fecha_inicio_computo, fecha_fin_computo, meses_computables, dias_computables, dias_no_computables,
             monto_base, monto_beneficio, pct_bonificacion_extraordinaria, monto_bonificacion,
             dias_mora, monto_interes, total_pagar,
             id_banco_destino, cci_destino, estado_registro)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO')`,
          [
            idBeneficio, t.id_trabajador, t.id_regimen, factor,
            rc.rc_basico, rc.rc_asignacion_familiar, rc.rc_promedio_horas_extras, rc.rc_promedio_comisiones,
            rc.rc_promedio_bonificaciones, rc.rc_sexto_gratificacion, rc.remuneracion_computable,
            tiempo.inicio, tiempo.fin, tiempo.meses, tiempo.dias, tiempo.diasNoComputables,
            calc.monto_base, calc.monto_beneficio, pctBonif, montoBonif,
            interes.dias_mora, interes.monto_interes, totalPagar,
            beneficio.tipo === 'CTS' ? t.id_banco_cts ?? null : null,
            beneficio.tipo === 'CTS' ? t.cci_cts ?? null : null,
          ],
        );

        totMonto += calc.monto_beneficio;
        totBonif += montoBonif;
        totInteres += interes.monto_interes;
        totPagar += totalPagar;
        if (totalPagar > 0) conMonto++;
      }

      await qr.query(
        `UPDATE planilla_beneficio
         SET estado = 'CALCULADO', fecha_calculo = NOW(),
             snap_rmv = ?, snap_pct_bonif_essalud = ?, snap_pct_bonif_eps = ?,
             total_monto = ?, total_bonificacion = ?, total_interes = ?, total_pagar = ?,
             total_trabajadores = ?, id_usuario_mod = ?
         WHERE id_beneficio = ?`,
        [
          rmv, pctBonifEssalud, pctBonifEps,
          r2(totMonto), r2(totBonif), r2(totInteres), r2(totPagar),
          trabajadores.length, userId, idBeneficio,
        ],
      );

      await qr.commitTransaction();
      await this.auditoriaService.registrar('planilla_beneficio', idBeneficio, 'ACTUALIZAR', userId, beneficio, {
        accion: 'CALCULAR', trabajadores: trabajadores.length, total_pagar: r2(totPagar),
      });

      return {
        id: idBeneficio,
        trabajadores: trabajadores.length,
        con_monto: conMonto,
        total_monto: r2(totMonto),
        total_bonificacion: r2(totBonif),
        total_interes: r2(totInteres),
        total_pagar: r2(totPagar),
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  private async parametrosVigentes(qr: any, fecha: string): Promise<Map<string, number>> {
    const filas = await qr.query(
      `SELECT p1.codigo, p1.valor
       FROM planilla_parametro_laboral p1
       JOIN (
         SELECT codigo, MAX(vigencia_desde) AS maxv
         FROM planilla_parametro_laboral
         WHERE estado_registro = 'ACTIVO' AND vigencia_desde <= ?
           AND (vigencia_hasta IS NULL OR vigencia_hasta >= ?)
         GROUP BY codigo
       ) m ON m.codigo = p1.codigo AND m.maxv = p1.vigencia_desde
       WHERE p1.estado_registro = 'ACTIVO'`,
      [fecha, fecha],
    );
    const map = new Map<string, number>();
    filas.forEach((p: any) => map.set(p.codigo, num(p.valor)));
    return map;
  }

  async findDetalle(idBeneficio: number) {
    await this.findOne(idBeneficio);
    return this.dataSource.query(
      `SELECT bd.*, t.numero_documento,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
              t.fecha_ingreso, t.fecha_cese, t.cargo,
              r.nombre AS nombre_regimen, r.codigo AS codigo_regimen,
              bk.nombre AS nombre_banco
       FROM planilla_beneficio_detalle bd
       JOIN planilla_trabajador t ON t.id_trabajador = bd.id_trabajador
       JOIN planilla_regimen_laboral r ON r.id_regimen = bd.snap_id_regimen
       LEFT JOIN planilla_banco bk ON bk.id_banco = bd.id_banco_destino
       WHERE bd.id_beneficio = ? AND bd.estado_registro = 'ACTIVO'
       ORDER BY t.apellido_paterno, t.apellido_materno, t.nombres`,
      [idBeneficio],
    );
  }

  /** Boleta de depósito / liquidación de un trabajador, con la RC desglosada. */
  async findBoleta(idBeneficio: number, idTrabajador: number) {
    const beneficio = await this.findOne(idBeneficio);
    const [detalle] = await this.dataSource.query(
      `SELECT bd.*, t.numero_documento, t.fecha_ingreso, t.fecha_cese, t.cargo,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
              r.nombre AS nombre_regimen, bk.nombre AS nombre_banco
       FROM planilla_beneficio_detalle bd
       JOIN planilla_trabajador t ON t.id_trabajador = bd.id_trabajador
       JOIN planilla_regimen_laboral r ON r.id_regimen = bd.snap_id_regimen
       LEFT JOIN planilla_banco bk ON bk.id_banco = bd.id_banco_destino
       WHERE bd.id_beneficio = ? AND bd.id_trabajador = ? AND bd.estado_registro = 'ACTIVO'`,
      [idBeneficio, idTrabajador],
    );
    if (!detalle) throw new NotFoundException('Este trabajador no está en el cálculo');
    return { beneficio, detalle };
  }

  /** Cambia la fecha de pago real y la TEA, que es lo que gatilla el interés por mora. */
  async actualizarPago(idBeneficio: number, dto: ActualizarPagoDto, userId: number) {
    const b = await this.findOne(idBeneficio);
    if (b.estado === 'CERRADO') throw new BadRequestException('Este cálculo está cerrado');

    await this.dataSource.query(
      `UPDATE planilla_beneficio SET fecha_pago_real = ?, tea_interes = ?, id_usuario_mod = ?
       WHERE id_beneficio = ?`,
      [dto.fecha_pago_real ?? null, dto.tea_interes ?? 0, userId, idBeneficio],
    );
    await this.auditoriaService.registrar('planilla_beneficio', idBeneficio, 'ACTUALIZAR', userId, b, dto);
    return { id: idBeneficio, recalcular: true };
  }

  async cerrar(idBeneficio: number, userId: number) {
    const b = await this.findOne(idBeneficio);
    if (b.estado !== 'CALCULADO') throw new BadRequestException('Solo se puede cerrar un cálculo ya procesado');

    await this.dataSource.query(
      `UPDATE planilla_beneficio SET estado = 'CERRADO', id_usuario_mod = ? WHERE id_beneficio = ?`,
      [userId, idBeneficio],
    );
    await this.auditoriaService.registrar('planilla_beneficio', idBeneficio, 'ACTUALIZAR', userId, b, { accion: 'CERRAR' });
    return { id: idBeneficio };
  }

  async reabrir(idBeneficio: number, userId: number) {
    const b = await this.findOne(idBeneficio);
    if (b.estado !== 'CERRADO') throw new BadRequestException('Solo se puede reabrir un cálculo cerrado');

    await this.dataSource.query(
      `UPDATE planilla_beneficio SET estado = 'CALCULADO', id_usuario_mod = ? WHERE id_beneficio = ?`,
      [userId, idBeneficio],
    );
    await this.auditoriaService.registrar('planilla_beneficio', idBeneficio, 'ACTUALIZAR', userId, b, { accion: 'REABRIR' });
    return { id: idBeneficio };
  }

  async anular(idBeneficio: number, userId: number) {
    const b = await this.findOne(idBeneficio);
    if (b.estado === 'ANULADO') throw new BadRequestException('Este cálculo ya está anulado');

    await this.dataSource.query(
      `UPDATE planilla_beneficio SET estado = 'ANULADO', id_usuario_mod = ? WHERE id_beneficio = ?`,
      [userId, idBeneficio],
    );
    await this.auditoriaService.registrar('planilla_beneficio', idBeneficio, 'ANULAR', userId, b, null);
    return { id: idBeneficio };
  }
}
