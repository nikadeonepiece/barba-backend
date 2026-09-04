import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { aFechaLocal } from '../fecha.util';

/**
 * Motor de cálculo de la planilla mensual.
 *
 * REGLA QUE ORDENA TODO ESTE ARCHIVO: acá no hay ninguna cifra tributaria ni laboral
 * escrita a mano. Ni el 9% de EsSalud, ni el 13% de ONP, ni el 10% de asignación
 * familiar, ni los factores de MYPE. Todo se lee de la base:
 *
 *   - `planilla_parametro_laboral`  -> RMV, UIT, tasas de aportes (con vigencia por fecha)
 *   - `planilla_regimen_laboral`    -> factores de CTS y gratificación (MYPE vs. general)
 *   - `planilla_afp_tasa`           -> comisiones y prima vigentes AL PERIODO, no a hoy
 *   - `planilla_concepto`           -> a qué está afecto cada concepto (Tabla 22 de SUNAT)
 *   - `planilla_escala_renta_quinta`-> tramos del impuesto
 *
 * El motivo no es purismo: estas cifras cambian por norma varias veces al año. Escritas
 * en el código, cada cambio sería un despliegue y recalcular un periodo viejo daría un
 * número distinto al que se declaró. Leídas de la base con su vigencia, el sistema
 * puede re-explicar cualquier planilla años después.
 */

// Redondeo a 2 decimales evitando el arrastre binario de JS (0.1 + 0.2 !== 0.3).
const r2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// El driver de MySQL devuelve los DECIMAL como string. Operar sin convertir concatena.
const num = (v: any): number => (v === null || v === undefined ? 0 : Number(v));

interface ContextoCalculo {
  fechaPeriodo: string;        // último día del mes: define qué vigencias aplican
  primerDia: string;
  ultimoDia: string;
  anio: number;
  mes: number;
  diasMes: number;
  horasJornada: number;
  parametros: Map<string, number>;
  escalaRenta: any[];
  config: any;
  conceptos: Map<string, any>;  // por codigo_plame
}

@Injectable()
export class MotorCalculoService {
  constructor(@InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource) {}

  // ==========================================================================
  // Carga del contexto: todo lo que el cálculo necesita, una sola vez
  // ==========================================================================
  /**
   * Se carga TODO por adelantado y se pasa en un contexto en vez de consultar dentro
   * del loop de trabajadores: con 200 trabajadores, una consulta de parámetros por
   * cada uno serían 200 viajes a la base para leer siempre lo mismo.
   */
  async cargarContexto(qr: QueryRunner, idEmpresa: number, anio: number, mes: number): Promise<ContextoCalculo> {
    const ultimoDia = new Date(anio, mes, 0).getDate();
    const fechaPeriodo = `${anio}-${String(mes).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
    const primerDia = `${anio}-${String(mes).padStart(2, '0')}-01`;

    const [config] = await qr.query(
      `SELECT c.*, r.codigo AS codigo_regimen
       FROM planilla_empresa_config c
       LEFT JOIN planilla_regimen_laboral r ON r.id_regimen = c.id_regimen_default
       WHERE c.id_empresa = ? AND c.estado_registro = 'ACTIVO'`,
      [idEmpresa],
    );
    if (!config) {
      throw new BadRequestException(
        'Esta empresa no tiene configuración de planilla. Configúrala antes de calcular (jornada, régimen de salud, SCTR).',
      );
    }

    // Parámetros vigentes AL PERIODO, no a la fecha de hoy: recalcular marzo tiene que
    // usar la RMV de marzo aunque hoy sea diciembre y la RMV haya subido.
    const filasParam = await qr.query(
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
      [fechaPeriodo, fechaPeriodo],
    );
    const parametros = new Map<string, number>();
    filasParam.forEach((p: any) => parametros.set(p.codigo, num(p.valor)));

    for (const requerido of ['RMV', 'ESSALUD_PCT', 'ONP_PCT', 'ASIGNACION_FAMILIAR_PCT']) {
      if (!parametros.has(requerido)) {
        throw new BadRequestException(
          `Falta el parámetro "${requerido}" vigente al ${fechaPeriodo}. Revísalo en Configuración de Planilla → Parámetros.`,
        );
      }
    }

    const escalaRenta = await qr.query(
      `SELECT tramo, uit_desde, uit_hasta, tasa FROM planilla_escala_renta_quinta
       WHERE anio = ? AND estado_registro = 'ACTIVO' ORDER BY tramo`,
      [anio],
    );

    const filasConcepto = await qr.query(
      `SELECT id_concepto, codigo_plame, nombre, tipo, es_remunerativo, afecto_renta_quinta,
              afecto_essalud, afecto_sctr, afecto_senati, afecto_onp, afecto_afp,
              base_cts, base_gratificacion, base_vacaciones, orden_impresion
       FROM planilla_concepto WHERE estado_registro = 'ACTIVO'`,
    );
    const conceptos = new Map<string, any>();
    filasConcepto.forEach((c: any) => conceptos.set(c.codigo_plame, c));

    return {
      fechaPeriodo, primerDia, anio, mes,
      ultimoDia: fechaPeriodo,
      diasMes: num(config.dias_mes) || 30,
      horasJornada: num(config.horas_jornada) || 8,
      parametros, escalaRenta, config, conceptos,
    };
  }

  private concepto(ctx: ContextoCalculo, codigo: string) {
    const c = ctx.conceptos.get(codigo);
    if (!c) {
      throw new BadRequestException(
        `El concepto PLAME ${codigo} no está en el catálogo. Revisa Configuración de Planilla → Conceptos PLAME.`,
      );
    }
    return c;
  }

  // ==========================================================================
  // Cálculo de un trabajador
  // ==========================================================================
  async calcularTrabajador(qr: QueryRunner, ctx: ContextoCalculo, trabajador: any) {
    const lineas: any[] = [];

    // ---- Sueldo vigente al periodo ----
    const [rem] = await qr.query(
      `SELECT sueldo_basico FROM planilla_trabajador_remuneracion
       WHERE id_trabajador = ? AND estado_registro = 'ACTIVO' AND vigencia_desde <= ?
       ORDER BY vigencia_desde DESC LIMIT 1`,
      [trabajador.id_trabajador, ctx.fechaPeriodo],
    );
    if (!rem) {
      throw new BadRequestException(
        `${trabajador.apellido_paterno} ${trabajador.nombres} no tiene un sueldo registrado vigente al ${ctx.fechaPeriodo}.`,
      );
    }
    const sueldoBasico = num(rem.sueldo_basico);

    // ---- Días y horas del periodo ----
    const dias = await this.diasDelPeriodo(qr, ctx, trabajador);

    // ---- Cómo cobra: qué SIGNIFICA el sueldo básico ----
    // Sin esta línea el motor asume que todo el mundo es mensual, y a un obrero a
    // jornal de S/ 65 el día le liquidaría S/ 2.17 diarios (65/30). El error es de
    // treinta veces y pasa desapercibido, porque el número sale con dos decimales y
    // parece un cálculo. Se declara en el padrón (planilla_trabajador.modalidad_pago)
    // y la propia empresa lo mantiene desde el portal.
    const modalidad = trabajador.modalidad_pago || 'MENSUAL';
    const { valorDia, valorHora } = this.valorizarJornada(modalidad, sueldoBasico, ctx);

    // ---- INGRESOS ----
    // Básico proporcional a los días efectivamente remunerados. Un mes completo da
    // el sueldo entero; las faltas injustificadas lo reducen.
    // DESTAJO es la excepción: lo que cobra depende de cuánto produjo, y esa cantidad
    // no vive en el padrón. El motor NO inventa un básico — el monto lo carga el
    // estudio en "Entrada de datos" y entra más abajo con los conceptos manuales.
    // Emitir acá un 0121 en cero sería peor que no emitirlo: la boleta diría
    // "Remuneración básica: 0.00" y el trabajador leería que no le pagaron el trabajo.
    const diasRemunerados = dias.remunerados;
    if (modalidad !== 'DESTAJO') {
      const montoBasico = r2(valorDia * diasRemunerados);
      lineas.push(this.linea(ctx, '0121', montoBasico, { cantidad: diasRemunerados, base: sueldoBasico }));
    }

    // Asignación familiar: 10% de la RMV, y solo si el régimen del trabajador la
    // contempla (la microempresa no) y tiene hijos menores.
    if (trabajador.tiene_hijos_menores && trabajador.aplica_asignacion_familiar) {
      const rmv = ctx.parametros.get('RMV')!;
      const pct = ctx.parametros.get('ASIGNACION_FAMILIAR_PCT')!;
      const af = r2((rmv * pct) / 100);
      lineas.push(this.linea(ctx, '0201', af, { base: rmv, porcentaje: pct }));
    }

    // Horas extras: las 2 primeras del día con recargo del 25%, las siguientes 35%.
    // El tareo ya las separó; acá solo se valorizan.
    if (dias.horasExtras25 > 0) {
      const pct = ctx.parametros.get('HORA_EXTRA_25_PCT') ?? 25;
      const monto = r2(valorHora * (1 + pct / 100) * dias.horasExtras25);
      lineas.push(this.linea(ctx, '0105', monto, { cantidad: dias.horasExtras25, base: valorHora, porcentaje: pct }));
    }
    if (dias.horasExtras35 > 0) {
      const pct = ctx.parametros.get('HORA_EXTRA_35_PCT') ?? 35;
      const monto = r2(valorHora * (1 + pct / 100) * dias.horasExtras35);
      lineas.push(this.linea(ctx, '0106', monto, { cantidad: dias.horasExtras35, base: valorHora, porcentaje: pct }));
    }

    // Conceptos cargados a mano y conceptos fijos del trabajador.
    const manuales = await this.conceptosManuales(qr, ctx, trabajador, sueldoBasico);
    lineas.push(...manuales);

    // ---- BASES ----
    // La remuneración asegurable NO es "todos los ingresos": es solo lo que la Tabla 22
    // marca como remunerativo. Por eso la gratificación (inafecta por Ley 30334) no
    // paga AFP ni EsSalud, y el motor no necesita saberlo: lo lee de la fila.
    const ingresos = lineas.filter((l) => l.tipo === 'INGRESO');
    const remuneracionAsegurable = r2(
      ingresos.filter((l) => l.meta.es_remunerativo).reduce((s, l) => s + l.monto, 0),
    );
    const baseRentaQuinta = r2(
      ingresos.filter((l) => l.meta.afecto_renta_quinta).reduce((s, l) => s + l.monto, 0),
    );

    // ---- DESCUENTOS: sistema pensionario ----
    if (trabajador.regimen_pensionario === 'ONP') {
      const pct = ctx.parametros.get('ONP_PCT')!;
      lineas.push(this.linea(ctx, '0607', r2((remuneracionAsegurable * pct) / 100), {
        base: remuneracionAsegurable, porcentaje: pct,
      }));
    } else if (trabajador.regimen_pensionario === 'AFP') {
      const tasa = await this.tasaAfpVigente(qr, trabajador.id_afp, ctx.fechaPeriodo, trabajador);
      trabajador.__id_afp_tasa = tasa.id_afp_tasa;

      // Aporte obligatorio: va al fondo del trabajador.
      lineas.push(this.linea(ctx, '0608', r2((remuneracionAsegurable * num(tasa.pct_aporte_obligatorio)) / 100), {
        base: remuneracionAsegurable, porcentaje: num(tasa.pct_aporte_obligatorio),
      }));

      // Prima de seguro: se calcula sobre la remuneración TOPADA, no sobre el sueldo
      // completo. Sin el tope, a un sueldo alto se le descuenta de más.
      const tope = num(tasa.tope_remuneracion_asegurable);
      const baseP = tope > 0 ? Math.min(remuneracionAsegurable, tope) : remuneracionAsegurable;
      if (num(tasa.pct_prima_seguro) > 0) {
        lineas.push(this.linea(ctx, '0606', r2((baseP * num(tasa.pct_prima_seguro)) / 100), {
          base: baseP, porcentaje: num(tasa.pct_prima_seguro),
        }));
      }

      // Comisión: solo la de flujo se descuenta en planilla. La mixta sobre saldo la
      // cobra la AFP contra el fondo, no aparece en la boleta.
      const pctComision = trabajador.tipo_comision_afp === 'MIXTA'
        ? num(tasa.pct_comision_mixta_flujo)
        : num(tasa.pct_comision_flujo);
      if (pctComision > 0) {
        lineas.push(this.linea(ctx, '0601', r2((remuneracionAsegurable * pctComision) / 100), {
          base: remuneracionAsegurable, porcentaje: pctComision,
        }));
      }
    }

    // ---- DESCUENTOS: renta de quinta categoría ----
    const retencion = this.rentaQuinta(ctx, baseRentaQuinta, trabajador);
    if (retencion > 0) {
      lineas.push(this.linea(ctx, '0605', retencion, { base: baseRentaQuinta }));
    }

    // ---- APORTES DEL EMPLEADOR ----
    // EsSalud tiene base mínima: aunque el trabajador gane menos que la RMV (part-time,
    // mes incompleto), el aporte se calcula sobre la RMV.
    if (trabajador.aplica_essalud) {
      const rmv = ctx.parametros.get('RMV')!;
      const pctEss = ctx.parametros.get('ESSALUD_PCT')!;
      const baseEss = Math.max(remuneracionAsegurable, rmv);
      lineas.push(this.linea(ctx, '0804', r2((baseEss * pctEss) / 100), { base: baseEss, porcentaje: pctEss }));
    }

    if (trabajador.afecto_sctr && num(ctx.config.tasa_sctr_salud) > 0) {
      const t = num(ctx.config.tasa_sctr_salud);
      lineas.push(this.linea(ctx, '0806', r2((remuneracionAsegurable * t) / 100), { base: remuneracionAsegurable, porcentaje: t }));
    }
    if (trabajador.afecto_sctr && num(ctx.config.tasa_sctr_pension) > 0) {
      const t = num(ctx.config.tasa_sctr_pension);
      lineas.push(this.linea(ctx, '0805', r2((remuneracionAsegurable * t) / 100), { base: remuneracionAsegurable, porcentaje: t }));
    }
    if (ctx.config.afecto_senati) {
      const t = num(ctx.config.pct_senati);
      lineas.push(this.linea(ctx, '0807', r2((remuneracionAsegurable * t) / 100), { base: remuneracionAsegurable, porcentaje: t }));
    }

    // ---- TOTALES ----
    const totalIngresos = r2(lineas.filter((l) => l.tipo === 'INGRESO').reduce((s, l) => s + l.monto, 0));
    const totalDescuentos = r2(lineas.filter((l) => l.tipo === 'DESCUENTO').reduce((s, l) => s + l.monto, 0));
    const totalAportes = r2(lineas.filter((l) => l.tipo === 'APORTE_EMPLEADOR').reduce((s, l) => s + l.monto, 0));

    const adelanto = await this.adelantoQuincena(qr, ctx, trabajador, r2(totalIngresos - totalDescuentos));
    const netoPagar = r2(totalIngresos - totalDescuentos - adelanto);

    return {
      sueldoBasico, modalidad, dias, lineas,
      remuneracionAsegurable, baseRentaQuinta,
      totalIngresos, totalDescuentos, totalAportes,
      adelanto, netoPagar,
    };
  }

  // ==========================================================================
  // Piezas del cálculo
  // ==========================================================================
  private linea(ctx: ContextoCalculo, codigoPlame: string, monto: number, extra: any = {}) {
    const c = this.concepto(ctx, codigoPlame);
    return {
      id_concepto: c.id_concepto,
      codigo_plame: c.codigo_plame,
      nombre_concepto: c.nombre,
      tipo: c.tipo,
      cantidad: extra.cantidad ?? null,
      base_calculo: extra.base ?? null,
      porcentaje_aplicado: extra.porcentaje ?? null,
      monto: r2(monto),
      orden_impresion: c.orden_impresion,
      es_manual: extra.es_manual ? 1 : 0,
      meta: c,
    };
  }

  /**
   * Cuánto vale un día y una hora, según CÓMO cobra el trabajador.
   *
   * El sueldo básico es siempre el mismo número guardado; lo que cambia es qué
   * representa. Esta es la única función que lo sabe, y es a propósito: la pantalla
   * "Forma de cobro" del portal muestra la misma equivalencia, así que si la fórmula
   * se duplicara, el día que cambie una la pantalla seguiría prometiendo un valor que
   * la boleta ya no paga.
   *
   *   MENSUAL → el sueldo es del MES.  valor_dia = sueldo / dias_mes (30)
   *   JORNAL  → el sueldo es del DÍA.  valor_dia = sueldo, sin prorratear nada
   *   HORA    → el sueldo es de la HORA. valor_dia = sueldo × horas_jornada
   *   DESTAJO → no hay valor por tiempo. Devuelve 0 y quien llama no debe usarlo:
   *             `calcularTrabajador` ni siquiera emite el básico en ese caso.
   */
  private valorizarJornada(modalidad: string, sueldoBasico: number, ctx: ContextoCalculo) {
    switch (modalidad) {
      case 'JORNAL':
        return { valorDia: sueldoBasico, valorHora: sueldoBasico / ctx.horasJornada };
      case 'HORA':
        return { valorDia: sueldoBasico * ctx.horasJornada, valorHora: sueldoBasico };
      case 'DESTAJO':
        return { valorDia: 0, valorHora: 0 };
      case 'MENSUAL':
      default: {
        const valorDia = sueldoBasico / ctx.diasMes;
        return { valorDia, valorHora: valorDia / ctx.horasJornada };
      }
    }
  }

  /**
   * Días del periodo. Cuatro fuentes, en este orden:
   *
   *   1. `planilla_tareo` — lo que cargó el ESTUDIO en la planilla.
   *   2. `planilla_asistencia` — lo que marcó la EMPRESA en su portal.
   *   3. "Entrada de datos" — el resumen mensual cargado a mano.
   *   4. Mes completo.
   *
   * El orden es una regla de negocio, no una preferencia técnica. El tareo es el dato
   * más fino y el que SUNAFIL exige, así que cuando existe manda. La asistencia del
   * portal viene después porque el estudio tiene que poder CORREGIR al cliente sin
   * discutirle: le basta con cargar el tareo de esa persona y su versión gana, sin
   * borrarle ni pisarle lo que el cliente marcó — que sigue ahí, como constancia de lo
   * que la empresa declaró.
   *
   * Ojo con el fallback 4: "no hay ningún dato" y "vino todos los días" terminan en el
   * mismo número. Es el comportamiento que el módulo ya tenía y se conserva, pero es
   * la razón por la que la pantalla de asistencia avisa cuando el mes está en blanco.
   */
  private async diasDelPeriodo(qr: QueryRunner, ctx: ContextoCalculo, trabajador: any) {
    let filas = await qr.query(
      `SELECT m.computa_dia_laborado, m.computa_falta, m.computa_feriado, m.computa_descanso,
              m.computa_subsidio, m.computa_vacaciones, m.computa_licencia_con_goce,
              m.computa_licencia_sin_goce,
              COUNT(*) AS dias,
              SUM(t.horas_extras_25) AS he25, SUM(t.horas_extras_35) AS he35,
              SUM(t.minutos_tardanza) AS tardanza
       FROM planilla_tareo t
       JOIN planilla_tareo_marca m ON m.id_marca = t.id_marca
       WHERE t.id_planilla = ? AND t.id_trabajador = ? AND t.estado_registro = 'ACTIVO'
       GROUP BY m.id_marca, m.computa_dia_laborado, m.computa_falta, m.computa_feriado,
                m.computa_descanso, m.computa_subsidio, m.computa_vacaciones,
                m.computa_licencia_con_goce, m.computa_licencia_sin_goce`,
      [trabajador.__id_planilla, trabajador.id_trabajador],
    );

    // Asistencia del portal cliente. No tiene columnas de horas extras ni tardanza
    // (esa pantalla marca solo el día), así que se devuelven en cero de forma
    // explícita: si el trabajador hizo horas extras, se cargan en "Entrada de datos".
    if (filas.length === 0) {
      filas = await qr.query(
        `SELECT m.computa_dia_laborado, m.computa_falta, m.computa_feriado, m.computa_descanso,
                m.computa_subsidio, m.computa_vacaciones, m.computa_licencia_con_goce,
                m.computa_licencia_sin_goce,
                COUNT(*) AS dias,
                0 AS he25, 0 AS he35, 0 AS tardanza
         FROM planilla_asistencia a
         JOIN planilla_tareo_marca m ON m.id_marca = a.id_marca
         WHERE a.id_empresa = ? AND a.id_trabajador = ? AND a.anio = ? AND a.mes = ?
           AND a.estado_registro = 'ACTIVO'
         GROUP BY m.id_marca, m.computa_dia_laborado, m.computa_falta, m.computa_feriado,
                  m.computa_descanso, m.computa_subsidio, m.computa_vacaciones,
                  m.computa_licencia_con_goce, m.computa_licencia_sin_goce`,
        [trabajador.id_empresa, trabajador.id_trabajador, ctx.anio, ctx.mes],
      );
    }

    const acc = {
      laborados: 0, faltas: 0, feriados: 0, descanso: 0, subsidiados: 0,
      vacaciones: 0, licenciaConGoce: 0, licenciaSinGoce: 0,
      horasExtras25: 0, horasExtras35: 0, minutosTardanza: 0, remunerados: 0,
    };

    if (filas.length > 0) {
      for (const f of filas) {
        const d = num(f.dias);
        if (f.computa_dia_laborado) acc.laborados += d;
        if (f.computa_falta) acc.faltas += d;
        if (f.computa_feriado) acc.feriados += d;
        if (f.computa_descanso) acc.descanso += d;
        if (f.computa_subsidio) acc.subsidiados += d;
        if (f.computa_vacaciones) acc.vacaciones += d;
        if (f.computa_licencia_con_goce) acc.licenciaConGoce += d;
        if (f.computa_licencia_sin_goce) acc.licenciaSinGoce += d;
        acc.horasExtras25 += num(f.he25);
        acc.horasExtras35 += num(f.he35);
        acc.minutosTardanza += num(f.tardanza);
      }
      // El empleador paga los días laborados, el descanso semanal, los feriados, las
      // vacaciones y las licencias CON goce. No paga faltas, licencias sin goce ni
      // días subsidiados (esos los cubre EsSalud).
      acc.remunerados = acc.laborados + acc.descanso + acc.feriados + acc.vacaciones + acc.licenciaConGoce;
    } else {
      const [entradas] = await qr.query(
        `SELECT
           COALESCE(SUM(CASE WHEN origen = 'DIAS_NO_LABORADOS' THEN cantidad END), 0) AS no_laborados,
           COALESCE(SUM(CASE WHEN origen = 'VACACIONES' THEN cantidad END), 0) AS vacaciones,
           COALESCE(SUM(CASE WHEN origen = 'HORAS_EXTRAS' AND id_concepto = (SELECT id_concepto FROM planilla_concepto WHERE codigo_plame = '0105') THEN cantidad END), 0) AS he25,
           COALESCE(SUM(CASE WHEN origen = 'HORAS_EXTRAS' AND id_concepto = (SELECT id_concepto FROM planilla_concepto WHERE codigo_plame = '0106') THEN cantidad END), 0) AS he35
         FROM planilla_entrada_dato
         WHERE id_planilla = ? AND id_trabajador = ? AND estado_registro = 'ACTIVO'`,
        [trabajador.__id_planilla, trabajador.id_trabajador],
      );
      const noLaborados = num(entradas?.no_laborados);
      acc.faltas = noLaborados;
      acc.vacaciones = num(entradas?.vacaciones);
      acc.horasExtras25 = num(entradas?.he25);
      acc.horasExtras35 = num(entradas?.he35);
      acc.remunerados = Math.max(0, ctx.diasMes - noLaborados);
      acc.laborados = acc.remunerados - acc.vacaciones;
    }

    // Un trabajador que ingresó o cesó a mitad de mes solo cobra su parte.
    acc.remunerados = Math.min(acc.remunerados, this.diasDelVinculo(ctx, trabajador));
    return acc;
  }

  /** Días del mes en que el vínculo laboral estuvo vigente. */
  private diasDelVinculo(ctx: ContextoCalculo, trabajador: any): number {
    const inicioMes = aFechaLocal(ctx.primerDia)!;
    const finMes = aFechaLocal(ctx.fechaPeriodo)!;
    const ingreso = aFechaLocal(trabajador.fecha_ingreso)!;
    const cese = aFechaLocal(trabajador.fecha_cese);

    const desde = ingreso > inicioMes ? ingreso : inicioMes;
    const hasta = cese && cese < finMes ? cese : finMes;
    if (hasta < desde) return 0;

    const dias = Math.floor((hasta.getTime() - desde.getTime()) / 86400000) + 1;
    return Math.min(dias, ctx.diasMes);
  }

  /** Conceptos cargados a mano en "Entrada de datos" + conceptos fijos del trabajador. */
  private async conceptosManuales(qr: QueryRunner, ctx: ContextoCalculo, trabajador: any, sueldoBasico: number) {
    const lineas: any[] = [];

    const entradas = await qr.query(
      `SELECT e.id_concepto, e.cantidad, e.porcentaje, e.monto, c.codigo_plame
       FROM planilla_entrada_dato e
       JOIN planilla_concepto c ON c.id_concepto = e.id_concepto
       WHERE e.id_planilla = ? AND e.id_trabajador = ? AND e.estado_registro = 'ACTIVO'
         AND e.id_concepto IS NOT NULL
         AND e.origen IN ('INGRESO','DESCUENTO','VIDA_LEY_SCTR','RENTA_QUINTA','FERIADOS','IMPORTACION')`,
      [trabajador.__id_planilla, trabajador.id_trabajador],
    );
    for (const e of entradas) {
      const monto = e.monto !== null ? num(e.monto) : r2((sueldoBasico * num(e.porcentaje)) / 100);
      if (monto === 0) continue;
      lineas.push(this.linea(ctx, e.codigo_plame, monto, {
        cantidad: e.cantidad, porcentaje: e.porcentaje, es_manual: true,
      }));
    }

    const fijos = await qr.query(
      `SELECT cf.monto, cf.porcentaje, cf.saldo_pendiente, c.codigo_plame
       FROM planilla_trabajador_concepto_fijo cf
       JOIN planilla_concepto c ON c.id_concepto = cf.id_concepto
       WHERE cf.id_trabajador = ? AND cf.estado_registro = 'ACTIVO'
         AND cf.vigencia_desde <= ?
         AND (cf.vigencia_hasta IS NULL OR cf.vigencia_hasta >= ?)
         AND (cf.saldo_pendiente IS NULL OR cf.saldo_pendiente > 0)`,
      [trabajador.id_trabajador, ctx.fechaPeriodo, ctx.primerDia],
    );
    for (const f of fijos) {
      let monto = f.monto !== null ? num(f.monto) : r2((sueldoBasico * num(f.porcentaje)) / 100);
      // Un préstamo no puede descontar más de lo que queda debiendo.
      if (f.saldo_pendiente !== null) monto = Math.min(monto, num(f.saldo_pendiente));
      if (monto <= 0) continue;
      lineas.push(this.linea(ctx, f.codigo_plame, monto, { porcentaje: f.porcentaje }));
    }

    return lineas;
  }

  /**
   * Renta de quinta categoría, método de proyección anual de SUNAT.
   *
   * Se proyecta lo que el trabajador va a ganar en el año, se descuentan las 7 UIT de
   * deducción, se aplica la escala progresiva acumulativa y el impuesto resultante se
   * reparte entre los meses que faltan.
   *
   * Simplificación consciente de esta primera versión: proyecta a partir de la
   * remuneración del mes y no descuenta lo ya retenido en meses anteriores (para eso
   * hace falta leer las planillas previas cerradas). Sirve para el caso corriente de
   * sueldo estable; para sueldos variables hay que afinarlo con el acumulado real.
   */
  private rentaQuinta(ctx: ContextoCalculo, baseMes: number, trabajador: any): number {
    if (baseMes <= 0) return 0;
    if (!ctx.escalaRenta.length) return 0;

    const uit = ctx.parametros.get('UIT');
    if (!uit) return 0;

    const deduccionUit = ctx.parametros.get('DEDUCCION_RENTA_QUINTA_UIT') ?? 7;
    const mesesRestantes = 12 - ctx.mes + 1;

    // 12 sueldos + 2 gratificaciones, ajustadas por el factor del régimen (la
    // microempresa no las recibe, así que no proyectan renta).
    const factorGrati = num(trabajador.factor_gratificacion);
    const proyeccionAnual = baseMes * 12 + baseMes * 2 * factorGrati;

    const rentaNeta = proyeccionAnual - deduccionUit * uit;
    if (rentaNeta <= 0) return 0;

    // Escala progresiva ACUMULATIVA: cada tasa se aplica solo al exceso de su tramo.
    let impuesto = 0;
    for (const t of ctx.escalaRenta) {
      const desde = num(t.uit_desde) * uit;
      const hasta = t.uit_hasta === null ? Infinity : num(t.uit_hasta) * uit;
      if (rentaNeta <= desde) break;
      const tramo = Math.min(rentaNeta, hasta) - desde;
      impuesto += (tramo * num(t.tasa)) / 100;
    }

    if (impuesto <= 0) return 0;
    return r2(impuesto / mesesRestantes);
  }

  /** Tasa de la AFP vigente AL PERIODO. Sin esto el descuento previsional sale mal. */
  private async tasaAfpVigente(qr: QueryRunner, idAfp: number, fecha: string, trabajador: any) {
    if (!idAfp) {
      throw new BadRequestException(
        `${trabajador.apellido_paterno} ${trabajador.nombres} está afiliado a AFP pero no tiene una AFP asignada.`,
      );
    }
    const [tasa] = await qr.query(
      `SELECT * FROM planilla_afp_tasa
       WHERE id_afp = ? AND estado_registro = 'ACTIVO' AND vigencia_desde <= ?
         AND (vigencia_hasta IS NULL OR vigencia_hasta >= ?)
       ORDER BY vigencia_desde DESC LIMIT 1`,
      [idAfp, fecha, fecha],
    );
    if (!tasa) {
      throw new BadRequestException(
        `No hay tasas de AFP vigentes al ${fecha} para el afiliado ${trabajador.apellido_paterno} ${trabajador.nombres}. ` +
          'Cárgalas en Configuración de Planilla → AFP y tasas.',
      );
    }
    return tasa;
  }

  /** Adelanto de quincena: monto cargado a mano, o el % configurado en la empresa. */
  private async adelantoQuincena(qr: QueryRunner, ctx: ContextoCalculo, trabajador: any, netoEstimado: number): Promise<number> {
    const [fila] = await qr.query(
      `SELECT COALESCE(SUM(monto), 0) AS monto, MAX(porcentaje) AS porcentaje
       FROM planilla_entrada_dato
       WHERE id_planilla = ? AND id_trabajador = ? AND origen = 'ADELANTO_QUINCENA' AND estado_registro = 'ACTIVO'`,
      [trabajador.__id_planilla, trabajador.id_trabajador],
    );

    if (num(fila?.monto) > 0) return r2(num(fila.monto));
    if (num(fila?.porcentaje) > 0) return r2((netoEstimado * num(fila.porcentaje)) / 100);

    const pctEmpresa = num(ctx.config.pct_adelanto_quincena);
    if (pctEmpresa > 0) return r2((netoEstimado * pctEmpresa) / 100);
    return 0;
  }

  /**
   * Provisiones del mes: lo que la empresa devenga por CTS, vacaciones y gratificación
   * aunque todavía no lo pague. Los factores salen del régimen, así que en microempresa
   * (factor 0.00) simplemente no se provisiona nada.
   */
  provisiones(trabajador: any, remuneracionComputable: number) {
    const fCts = num(trabajador.factor_cts);
    const fGrati = num(trabajador.factor_gratificacion);
    const salida: any[] = [];

    if (fCts > 0) {
      const factor = fCts / 12;
      salida.push({ tipo: 'CTS', base_calculo: remuneracionComputable, factor_mensual: factor, monto_mes: r2(remuneracionComputable * factor) });
    }
    // Las vacaciones no dependen del factor de CTS ni de gratificación: todos los
    // regímenes las tienen (30 días el general, 15 la MYPE), y se devengan igual.
    salida.push({ tipo: 'VACACIONES', base_calculo: remuneracionComputable, factor_mensual: 1 / 12, monto_mes: r2(remuneracionComputable / 12) });

    if (fGrati > 0) {
      const factor = fGrati / 6;
      salida.push({ tipo: 'GRATIFICACION', base_calculo: remuneracionComputable, factor_mensual: factor, monto_mes: r2(remuneracionComputable * factor) });
    }
    return salida;
  }
}
