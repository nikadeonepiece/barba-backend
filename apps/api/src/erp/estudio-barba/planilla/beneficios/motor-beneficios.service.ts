import { Injectable, BadRequestException } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { aFechaISO, aFechaLocal } from '../fecha.util';

/**
 * Motor de cálculo de beneficios sociales: CTS, gratificaciones, vacaciones truncas
 * y liquidación.
 *
 * Es el corazón del video ("Planilla de Sueldos, CTS y Gratificaciones — Régimen
 * General y MYPE"), y todo se apoya en dos piezas:
 *
 *   1. LA REMUNERACIÓN COMPUTABLE — qué se le suma al básico antes de calcular.
 *   2. EL TIEMPO COMPUTABLE — cuántos meses y días del semestre efectivamente cuentan.
 *
 * El factor del régimen (1.00 general / 0.50 pequeña empresa / 0.00 microempresa) se
 * lee de `planilla_regimen_laboral`, nunca se escribe acá: es lo que hace que la misma
 * fórmula sirva para los tres regímenes sin un solo `if`.
 */

const r2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v: any): number => (v === null || v === undefined ? 0 : Number(v));

export interface PeriodoBeneficio {
  desde: string;
  hasta: string;
  fechaPagoLegal: string | null;
}

@Injectable()
export class MotorBeneficiosService {
  /**
   * Periodos legales de cada beneficio.
   *
   * CTS: se deposita en mayo (por nov→abr) y noviembre (por may→oct), dentro de los
   * primeros 15 días del mes. Gratificación: julio (por ene→jun) y diciembre (por
   * jul→dic), a más tardar el 15.
   */
  periodoLegal(tipo: string, anio: number, semestre: number): PeriodoBeneficio {
    if (tipo === 'CTS') {
      return semestre === 1
        // Semestre nov (año anterior) → abr, se deposita hasta el 15 de mayo.
        ? { desde: `${anio - 1}-11-01`, hasta: `${anio}-04-30`, fechaPagoLegal: `${anio}-05-15` }
        : { desde: `${anio}-05-01`, hasta: `${anio}-10-31`, fechaPagoLegal: `${anio}-11-15` };
    }

    if (tipo === 'GRATIFICACION') {
      return semestre === 1
        ? { desde: `${anio}-01-01`, hasta: `${anio}-06-30`, fechaPagoLegal: `${anio}-07-15` }
        : { desde: `${anio}-07-01`, hasta: `${anio}-12-31`, fechaPagoLegal: `${anio}-12-15` };
    }

    // Vacaciones y liquidación no siguen semestre fijo: el periodo lo define el usuario.
    return { desde: `${anio}-01-01`, hasta: `${anio}-12-31`, fechaPagoLegal: null };
  }

  /**
   * Remuneración computable del trabajador para el periodo.
   *
   * Es básico + asignación familiar + el promedio de los conceptos VARIABLES, pero con
   * una regla que se olvida seguido: un concepto variable (horas extras, comisiones,
   * bonificaciones) solo entra si se percibió **3 o más meses** dentro del semestre, y
   * cuando entra se promedia dividiendo entre 6, no entre los meses en que se percibió.
   *
   * Los conceptos que entran salen de `base_cts` / `base_gratificacion` /
   * `base_vacaciones` en el catálogo — reglas del MTPE que define el estudio, no SUNAT.
   */
  async remuneracionComputable(
    qr: QueryRunner,
    tipo: string,
    trabajador: any,
    periodo: PeriodoBeneficio,
    rmv: number,
    pctAsignacionFamiliar: number,
  ) {
    const campoBase =
      tipo === 'CTS' ? 'base_cts' : tipo === 'GRATIFICACION' ? 'base_gratificacion' : 'base_vacaciones';

    // Básico vigente al cierre del periodo: es el que manda, no el promedio del semestre.
    const [rem] = await qr.query(
      `SELECT sueldo_basico FROM planilla_trabajador_remuneracion
       WHERE id_trabajador = ? AND estado_registro = 'ACTIVO' AND vigencia_desde <= ?
       ORDER BY vigencia_desde DESC LIMIT 1`,
      [trabajador.id_trabajador, periodo.hasta],
    );
    if (!rem) {
      throw new BadRequestException(
        `${trabajador.apellido_paterno} ${trabajador.nombres} no tiene sueldo registrado vigente al ${periodo.hasta}.`,
      );
    }
    const rcBasico = num(rem.sueldo_basico);

    const rcAsignacionFamiliar =
      trabajador.tiene_hijos_menores && trabajador.aplica_asignacion_familiar
        ? r2((rmv * pctAsignacionFamiliar) / 100)
        : 0;

    // Promedios de variables, sacados de las planillas ya calculadas del semestre.
    const variables = await qr.query(
      `SELECT c.codigo_plame, c.nombre,
              COUNT(DISTINCT CONCAT(p.anio, '-', p.mes)) AS meses,
              SUM(dc.monto) AS total
       FROM planilla_detalle_concepto dc
       JOIN planilla_detalle d ON d.id_detalle = dc.id_detalle
       JOIN planilla_planilla p ON p.id_planilla = d.id_planilla
       JOIN planilla_concepto c ON c.id_concepto = dc.id_concepto
       WHERE d.id_trabajador = ?
         AND p.estado IN ('CALCULADA','CERRADA') AND p.estado_registro = 'ACTIVO'
         AND DATE(CONCAT(p.anio, '-', LPAD(p.mes, 2, '0'), '-01')) BETWEEN DATE_FORMAT(?, '%Y-%m-01') AND ?
         AND c.${campoBase} = 1
         AND c.codigo_plame NOT IN ('0121', '0201')
         AND dc.tipo = 'INGRESO'
       GROUP BY c.codigo_plame, c.nombre`,
      [trabajador.id_trabajador, periodo.desde, periodo.hasta],
    );

    let promedioHorasExtras = 0;
    let promedioComisiones = 0;
    let promedioBonificaciones = 0;

    for (const v of variables) {
      // La regla de los 3 meses: menos que eso, el concepto no es "regular" y no entra.
      if (num(v.meses) < 3) continue;
      const promedio = r2(num(v.total) / 6);

      if (['0105', '0106', '0107'].includes(v.codigo_plame)) promedioHorasExtras += promedio;
      else if (['0103', '0104'].includes(v.codigo_plame)) promedioComisiones += promedio;
      else promedioBonificaciones += promedio;
    }

    // Solo CTS: se suma 1/6 de la gratificación del semestre anterior (D. Leg. 650).
    let rcSextoGratificacion = 0;
    if (tipo === 'CTS') {
      const [grati] = await qr.query(
        `SELECT bd.monto_beneficio
         FROM planilla_beneficio_detalle bd
         JOIN planilla_beneficio b ON b.id_beneficio = bd.id_beneficio
         WHERE bd.id_trabajador = ? AND b.tipo = 'GRATIFICACION'
           AND b.estado IN ('CALCULADO','CERRADO') AND b.estado_registro = 'ACTIVO'
           AND b.periodo_hasta < ?
         ORDER BY b.periodo_hasta DESC LIMIT 1`,
        [trabajador.id_trabajador, periodo.hasta],
      );
      if (grati) rcSextoGratificacion = r2(num(grati.monto_beneficio) / 6);
    }

    const total = r2(
      rcBasico + rcAsignacionFamiliar + promedioHorasExtras +
      promedioComisiones + promedioBonificaciones + rcSextoGratificacion,
    );

    return {
      rc_basico: rcBasico,
      rc_asignacion_familiar: rcAsignacionFamiliar,
      rc_promedio_horas_extras: r2(promedioHorasExtras),
      rc_promedio_comisiones: r2(promedioComisiones),
      rc_promedio_bonificaciones: r2(promedioBonificaciones),
      rc_sexto_gratificacion: rcSextoGratificacion,
      remuneracion_computable: total,
    };
  }

  /**
   * Tiempo computable: meses completos y días sueltos dentro del periodo.
   *
   * El cómputo arranca en el ingreso si el trabajador entró a mitad del semestre, y
   * termina en el cese si salió antes. Los días no computables (faltas injustificadas,
   * licencias sin goce, suspensiones perfectas) se restan: por eso alguien que faltó
   * un mes entero cobra menos CTS que un compañero con el mismo sueldo.
   */
  async tiempoComputable(qr: QueryRunner, trabajador: any, periodo: PeriodoBeneficio) {
    const inicioPeriodo = aFechaLocal(periodo.desde)!;
    const finPeriodo = aFechaLocal(periodo.hasta)!;
    const ingreso = aFechaLocal(trabajador.fecha_ingreso)!;
    const cese = aFechaLocal(trabajador.fecha_cese);

    const inicio = ingreso > inicioPeriodo ? ingreso : inicioPeriodo;
    const fin = cese && cese < finPeriodo ? cese : finPeriodo;

    if (fin < inicio) {
      return { meses: 0, dias: 0, diasNoComputables: 0, inicio: periodo.desde, fin: periodo.hasta };
    }

    // Meses completos y días sueltos.
    //
    // Se avanza mes a mes en vez de restar componentes de fecha, porque la resta
    // directa se equivoca en los bordes: de 01/05 al 31/10 la diferencia de meses da
    // 5 y la de días 31, que al normalizar se convierte en "6 meses y 1 día". Pero
    // ese periodo son exactamente 6 meses (mayo a octubre completos), y ese día de
    // más se paga: en CTS son ~S/10 por trabajador por semestre.
    //
    // Un mes está completo cuando desde el cursor cabe entero antes del fin: p. ej.
    // del 01/05 al 31/05. Al terminar, lo que quede entre el cursor y el fin son los
    // días sueltos.
    let meses = 0;
    const cursor = new Date(inicio.getTime());
    while (true) {
      const siguiente = new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate());
      const ultimoDiaDelMes = new Date(siguiente.getTime() - 86400000);
      if (ultimoDiaDelMes > fin) break;
      meses += 1;
      cursor.setTime(siguiente.getTime());
    }

    let dias = cursor > fin ? 0 : Math.floor((fin.getTime() - cursor.getTime()) / 86400000) + 1;
    if (dias >= 30) { meses += Math.floor(dias / 30); dias = dias % 30; }

    // Días que no suman: los que el tareo marcó como no computables para beneficios.
    const [noComp] = await qr.query(
      `SELECT COUNT(*) AS dias
       FROM planilla_tareo t
       JOIN planilla_tareo_marca m ON m.id_marca = t.id_marca
       JOIN planilla_planilla p ON p.id_planilla = t.id_planilla
       WHERE t.id_trabajador = ? AND t.estado_registro = 'ACTIVO'
         AND p.estado IN ('CALCULADA','CERRADA') AND p.estado_registro = 'ACTIVO'
         AND t.fecha BETWEEN ? AND ?
         AND m.es_computable_beneficios = 0`,
      [trabajador.id_trabajador, periodo.desde, periodo.hasta],
    );
    const diasNoComputables = num(noComp?.dias);

    // Se descuentan del total, convirtiendo a meses lo que corresponda.
    let totalDias = meses * 30 + dias - diasNoComputables;
    if (totalDias < 0) totalDias = 0;

    return {
      meses: Math.floor(totalDias / 30),
      dias: totalDias % 30,
      diasNoComputables,
      inicio: aFechaISO(inicio)!,
      fin: aFechaISO(fin)!,
    };
  }

  /**
   * CTS — D. Leg. 650.
   *
   *   monto = ((RC / 12) × meses + (RC / 12 / 30) × días) × factor del régimen
   *
   * El factor hace todo el trabajo: 1.00 en régimen general, 0.50 en pequeña empresa
   * (media CTS), 0.00 en microempresa (no le corresponde). Por eso no hay ningún `if`
   * de régimen en esta función.
   */
  calcularCts(remuneracionComputable: number, meses: number, dias: number, factorRegimen: number) {
    const porMes = remuneracionComputable / 12;
    const porDia = porMes / 30;
    const montoBase = r2(porMes * meses + porDia * dias);
    return {
      monto_base: montoBase,
      monto_beneficio: r2(montoBase * factorRegimen),
    };
  }

  /**
   * Gratificación — Ley 27735, con la bonificación extraordinaria de la Ley 30334.
   *
   *   grati = ((RC / 6) × meses + (RC / 6 / 30) × días) × factor del régimen
   *   bonificación = grati × 9%   (6.75% si el trabajador está en EPS)
   *
   * La bonificación no es un capricho: es el aporte a EsSalud que el empleador se
   * ahorra porque la Ley 30334 inafectó la gratificación, y que por ley se le entrega
   * al trabajador.
   */
  calcularGratificacion(
    remuneracionComputable: number,
    meses: number,
    dias: number,
    factorRegimen: number,
    pctBonificacion: number,
  ) {
    const porMes = remuneracionComputable / 6;
    const porDia = porMes / 30;
    const montoBase = r2(porMes * meses + porDia * dias);
    const montoBeneficio = r2(montoBase * factorRegimen);
    return {
      monto_base: montoBase,
      monto_beneficio: montoBeneficio,
      pct_bonificacion: pctBonificacion,
      monto_bonificacion: r2((montoBeneficio * pctBonificacion) / 100),
    };
  }

  /**
   * Vacaciones truncas: un sueldo por cada año, proporcional a lo devengado.
   *
   *   monto = (RC / 12) × meses + (RC / 360) × días
   *
   * No lleva el factor de CTS ni el de gratificación: TODOS los regímenes tienen
   * vacaciones (30 días el general, 15 la MYPE), lo que cambia son los días de
   * descanso, no el dinero del trunco.
   */
  calcularVacaciones(remuneracionComputable: number, meses: number, dias: number) {
    const monto = r2((remuneracionComputable / 12) * meses + (remuneracionComputable / 360) * dias);
    return { monto_base: monto, monto_beneficio: monto };
  }

  /**
   * Interés por pago fuera de plazo, con la TEA configurada.
   *
   * Se aplica solo si `fecha_pago_real` es posterior a la legal. Con TEA en 0 no se
   * calcula nada, que es el default: el estudio decide si cobra interés.
   */
  calcularInteres(monto: number, fechaPagoLegal: string | null, fechaPagoReal: string | null, tea: number) {
    if (!fechaPagoLegal || !fechaPagoReal || tea <= 0) return { dias_mora: 0, monto_interes: 0 };

    const legal = aFechaLocal(fechaPagoLegal)!;
    const real = aFechaLocal(fechaPagoReal)!;
    if (real <= legal) return { dias_mora: 0, monto_interes: 0 };

    const diasMora = Math.floor((real.getTime() - legal.getTime()) / 86400000);
    // Tasa diaria equivalente a la efectiva anual, capitalizando.
    const tasaDiaria = Math.pow(1 + tea / 100, 1 / 365) - 1;
    const interes = monto * (Math.pow(1 + tasaDiaria, diasMora) - 1);

    return { dias_mora: diasMora, monto_interes: r2(interes) };
  }
}
