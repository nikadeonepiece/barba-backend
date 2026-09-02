import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { BoletaPdfService } from '../../planilla/planillas/boleta-pdf.service';
import { resolverEmpresaDelUsuario } from '../scope-empresa';

/**
 * Estados de planilla que el cliente puede ver.
 *
 * ── Por qué solo CERRADA ──
 *
 * Una planilla en BORRADOR o CALCULADA se puede recalcular: el estudio todavía está
 * cargando horas extras, faltas o un descuento. Si el cliente pudiera bajar la boleta
 * en ese momento, se llevaría un PDF con montos que van a cambiar — y ese PDF ya se
 * lo entregó al trabajador. Una vez CERRADA la planilla queda congelada (es la que se
 * declaró en el PLAME), y recién ahí el documento es definitivo.
 *
 * ANULADA tampoco: es una corrida que se descartó.
 */
const ESTADOS_VISIBLES = ['CERRADA'];

/**
 * Planillas — lado CLIENTE (solo lectura).
 *
 * Espejo acotado de `planilla/planillas`. Cada consulta arranca por
 * `resolverEmpresaDelUsuario()` y mete ese `id_empresa` en el WHERE, incluso cuando ya
 * viene un id por la URL: sin eso, `/cliente/planillas/93` devolvería la planilla de
 * cualquier otra empresa (IDOR).
 */
@Injectable()
export class PlanillasClienteService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private boletaPdf: BoletaPdfService,
  ) {}

  async findAll(user: any, query: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const offset = (page - 1) * limit;

    const where: string[] = [
      "p.estado_registro = 'ACTIVO'",
      'p.id_empresa = ?',
      `p.estado IN (${ESTADOS_VISIBLES.map(() => '?').join(', ')})`,
    ];
    const params: any[] = [idEmpresa, ...ESTADOS_VISIBLES];

    if (query.anio) {
      where.push('p.anio = ?');
      params.push(Number(query.anio));
    }
    if (query.mes) {
      where.push('p.mes = ?');
      params.push(Number(query.mes));
    }
    if (query.tipo) {
      where.push('p.tipo = ?');
      params.push(query.tipo);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    // Sin ORDER BY dinámico a propósito: en una lista de periodos el orden útil es
    // siempre el mismo (lo más reciente arriba) y no hay nada que elegir.
    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT p.id_planilla, p.anio, p.mes, p.tipo, p.estado, p.fecha_cierre,
                p.fecha_pago_mes, p.total_trabajadores,
                p.total_ingresos, p.total_descuentos, p.total_neto
         FROM planilla_planilla p
         ${whereSql}
         ORDER BY p.anio DESC, p.mes DESC, p.tipo ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS total FROM planilla_planilla p ${whereSql}`, params),
    ]);

    return { data, meta: { total: Number(total), page, limit } };
  }

  /**
   * Cabecera de una planilla. Devuelve también lo que el PDF de la boleta necesita
   * (razón social, RUC y el snapshot de RMV/UIT/jornada del periodo).
   *
   * Es privado-con-scope: todos los métodos de abajo pasan por acá primero, así que
   * la verificación de pertenencia se escribe una sola vez.
   */
  private async cabeceraConScope(user: any, idPlanilla: number) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    const [row] = await this.dataSource.query(
      `SELECT p.*, e.razon_social, e.ruc
       FROM planilla_planilla p
       JOIN empresa e ON e.id_empresa = p.id_empresa
       WHERE p.id_planilla = ? AND p.id_empresa = ?
         AND p.estado_registro = 'ACTIVO'
         AND p.estado IN (${ESTADOS_VISIBLES.map(() => '?').join(', ')})`,
      [idPlanilla, idEmpresa, ...ESTADOS_VISIBLES],
    );

    // Mismo mensaje para "no existe", "es de otra empresa" y "todavía no está
    // cerrada". Distinguirlos le diría al cliente qué ids existen y en qué estado
    // está la planilla de un tercero.
    if (!row) throw new NotFoundException('Planilla no encontrada');
    return row;
  }

  async findOne(user: any, idPlanilla: number) {
    return this.cabeceraConScope(user, idPlanilla);
  }

  /** Quiénes entraron en esa planilla y cuánto cobró cada uno. */
  async findTrabajadores(user: any, idPlanilla: number) {
    await this.cabeceraConScope(user, idPlanilla);

    return this.dataSource.query(
      `SELECT d.id_detalle, d.id_trabajador, t.numero_documento, t.cargo,
              CONCAT_WS(' ', t.apellido_paterno, t.apellido_materno, t.nombres) AS nombre_trabajador,
              d.dias_laborados, d.total_ingresos, d.total_descuentos,
              d.adelanto_quincena, d.neto_pagar
       FROM planilla_detalle d
       JOIN planilla_trabajador t ON t.id_trabajador = d.id_trabajador
       WHERE d.id_planilla = ? AND d.estado_registro = 'ACTIVO'
       ORDER BY t.apellido_paterno, t.apellido_materno, t.nombres`,
      [idPlanilla],
    );
  }

  /**
   * La boleta armada: cabecera + desglose por tipo.
   *
   * Repite la forma de `PlanillasService.findBoleta` en vez de llamarlo porque aquel
   * método no filtra por empresa (su usuario es del estudio). El JOIN contra
   * `planilla_detalle` de ESTA planilla, ya verificada como propia, es lo que cierra
   * el alcance: un `id_trabajador` de otra empresa no tiene detalle acá y no devuelve
   * nada.
   */
  async findBoleta(user: any, idPlanilla: number, idTrabajador: number) {
    const planilla = await this.cabeceraConScope(user, idPlanilla);

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
    if (!detalle) throw new NotFoundException('Este trabajador no está en la planilla');

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
   * La misma boleta, en PDF. El maquetado sale de `BoletaPdfService`, compartido con
   * la intranet: el cliente y el estudio tienen que estar mirando exactamente el mismo
   * documento, y con dos plantillas separadas eso dura hasta el primer retoque.
   */
  async exportarBoletaPdf(user: any, idPlanilla: number, idTrabajador: number, res: Response) {
    const boleta = await this.findBoleta(user, idPlanilla, idTrabajador);
    await this.boletaPdf.generar(boleta, res);
  }

  /** Años con planilla cerrada — alimenta el filtro de periodo de la pantalla. */
  async anios(user: any) {
    const idEmpresa = resolverEmpresaDelUsuario(user);

    return this.dataSource.query(
      `SELECT DISTINCT anio FROM planilla_planilla
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO'
         AND estado IN (${ESTADOS_VISIBLES.map(() => '?').join(', ')})
       ORDER BY anio DESC`,
      [idEmpresa, ...ESTADOS_VISIBLES],
    );
  }
}
