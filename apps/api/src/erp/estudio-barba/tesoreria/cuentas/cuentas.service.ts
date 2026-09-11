import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { AuditoriaService, ExcelService } from '@app/common';
import { bloquearCuenta, recalcularSaldosCuenta, num } from '../movimientos/cuentas-saldos';
import { CreateCuentaDto, UpdateCuentaDto } from './dto/cuenta.dto';

const COLS_ORDER: Record<string, string> = {
  alias: 'c.alias',
  empresa: 'e.razon_social',
  banco: 'b.nombre',
  saldo: 'c.saldo_actual',
};

/**
 * Cuentas bancarias por empresa.
 *
 * Portado de `administracion/cuentas-banco` de Transportes Montero. Dos diferencias,
 * las dos porque la tabla de este ERP es más rica que la de allá:
 *
 * · **Lleva saldo.** `saldo_inicial` es la foto con la que la cuenta entra al sistema y
 *   `saldo_actual` lo mantiene el libro de movimientos. Editar el saldo inicial obliga
 *   a recalcular toda la cadena, y eso se hace acá dentro de la misma transacción.
 * · **Banco y moneda no son catálogos sueltos**: el banco sale de `planilla_banco` (el
 *   mismo que usa planilla para los abonos de haberes) y la moneda es un ENUM.
 */
@Injectable()
export class CuentasService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private readonly excelService: ExcelService,
  ) {}

  private readonly JOINS = `
    FROM tesoreria_cuenta c
    INNER JOIN empresa e ON e.id_empresa = c.id_empresa
    LEFT JOIN planilla_banco b ON b.id_banco = c.id_banco AND b.estado_registro = 'ACTIVO'
  `;

  private filtros(query: any) {
    const where: string[] = [`c.estado_registro = 'ACTIVO'`];
    const params: any[] = [];

    if (query.id_empresa) { where.push('c.id_empresa = ?'); params.push(Number(query.id_empresa)); }
    if (query.id_banco) { where.push('c.id_banco = ?'); params.push(Number(query.id_banco)); }
    if (query.tipo) { where.push('c.tipo = ?'); params.push(query.tipo); }
    if (query.moneda) { where.push('c.moneda = ?'); params.push(query.moneda); }

    if (query.search) {
      const like = `%${String(query.search).trim()}%`;
      where.push(`(c.alias LIKE ? OR c.numero_cuenta LIKE ? OR c.cci LIKE ? OR e.razon_social LIKE ? OR b.nombre LIKE ?)`);
      params.push(like, like, like, like, like);
    }

    return { whereSql: where.join(' AND '), params };
  }

  async findAll(query: any = {}, isExport = false) {
    const page = isExport ? 1 : Number(query.page) || 1;
    const limit = isExport ? 5000 : Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    const { whereSql, params } = this.filtros(query);

    const col = COLS_ORDER[query.sortCol] ?? 'e.razon_social';
    const dir = query.sortDir === 'DESC' ? 'DESC' : 'ASC';

    const sqlData = `
      SELECT c.id_cuenta, c.id_empresa, c.id_banco, c.tipo, c.moneda,
             c.numero_cuenta, c.cci, c.alias, c.saldo_inicial, c.saldo_actual, c.observaciones,
             e.razon_social AS nombre_empresa, e.ruc AS ruc_empresa,
             b.nombre AS nombre_banco, b.codigo_sunat,
             (SELECT COUNT(*) FROM tesoreria_movimiento m
               WHERE m.id_cuenta = c.id_cuenta AND m.estado = 'REGISTRADO' AND m.estado_registro = 'ACTIVO') AS total_movimientos
      ${this.JOINS}
      WHERE ${whereSql}
      ORDER BY ${col} ${dir}, c.alias ASC
      LIMIT ? OFFSET ?`;

    const aNumeros = (f: any) => ({
      ...f,
      saldo_inicial: num(f.saldo_inicial),
      saldo_actual: num(f.saldo_actual),
      total_movimientos: Number(f.total_movimientos),
    });

    if (isExport) {
      const filas = await this.dataSource.query(sqlData, [...params, limit, offset]);
      return filas.map(aNumeros);
    }

    const [data, [{ total }]] = await Promise.all([
      this.dataSource.query(sqlData, [...params, limit, offset]),
      this.dataSource.query(`SELECT COUNT(*) AS total ${this.JOINS} WHERE ${whereSql}`, params),
    ]);

    return { data: data.map(aNumeros), meta: { total: Number(total), page, limit } };
  }

  async findOne(id: number) {
    const [cuenta] = await this.dataSource.query(
      `SELECT c.*, e.razon_social AS nombre_empresa, b.nombre AS nombre_banco
       ${this.JOINS} WHERE c.id_cuenta = ? AND c.estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!cuenta) throw new NotFoundException('La cuenta no existe o fue dada de baja.');
    return { ...cuenta, saldo_inicial: num(cuenta.saldo_inicial), saldo_actual: num(cuenta.saldo_actual) };
  }

  /** El banco es opcional, pero si viene tiene que existir. */
  private async validarBanco(idBanco?: number) {
    if (!idBanco) return null;
    const [banco] = await this.dataSource.query(
      `SELECT id_banco FROM planilla_banco WHERE id_banco = ? AND estado_registro = 'ACTIVO'`,
      [idBanco],
    );
    if (!banco) throw new BadRequestException('El banco elegido no existe o fue dado de baja.');
    return Number(banco.id_banco);
  }

  async create(dto: CreateCuentaDto, userId: number) {
    const [empresa] = await this.dataSource.query(
      `SELECT id_empresa FROM empresa WHERE id_empresa = ? AND estado_registro = 'ACTIVO'`,
      [dto.id_empresa],
    );
    if (!empresa) throw new NotFoundException('La empresa seleccionada no existe o está dada de baja.');
    await this.validarBanco(dto.id_banco);

    const alias = dto.alias.trim();
    const saldoInicial = num(dto.saldo_inicial);

    // Dos cuentas con el mismo alias en la misma empresa son indistinguibles en el
    // desplegable de movimientos, que es donde más se usan.
    const [duplicado] = await this.dataSource.query(
      `SELECT id_cuenta FROM tesoreria_cuenta
        WHERE id_empresa = ? AND alias = ? AND estado_registro = 'ACTIVO'`,
      [dto.id_empresa, alias],
    );
    if (duplicado) throw new ConflictException('Esta empresa ya tiene una cuenta con ese alias.');

    const res: any = await this.dataSource.query(
      `INSERT INTO tesoreria_cuenta
        (id_empresa, id_banco, tipo, moneda, numero_cuenta, cci, alias,
         saldo_inicial, saldo_actual, observaciones, estado_registro, id_usuario_crea)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)`,
      [
        dto.id_empresa, dto.id_banco || null, dto.tipo, dto.moneda,
        dto.numero_cuenta?.trim() || null, dto.cci?.trim() || null, alias,
        // `saldo_actual` arranca igual al inicial: todavía no hay movimientos que lo
        // muevan, y dejarlo en 0 haría que la cuenta muestre menos plata de la que tiene.
        saldoInicial, saldoInicial,
        dto.observaciones?.trim() || null, userId,
      ],
    );
    const id = Number(res.insertId);

    await this.auditoriaService.registrar('tesoreria_cuenta', id, 'CREAR', userId, null, { ...dto, alias });
    return { id, mensaje: 'Cuenta registrada correctamente' };
  }

  /**
   * Editar una cuenta puede cambiar el `saldo_inicial`, y eso corre TODA la cadena de
   * saldos de sus movimientos. Por eso va en transacción y con la cuenta bloqueada, no
   * como un UPDATE suelto.
   */
  async update(id: number, dto: UpdateCuentaDto, userId: number) {
    const [actual] = await this.dataSource.query(
      `SELECT * FROM tesoreria_cuenta WHERE id_cuenta = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) throw new NotFoundException('La cuenta no existe o fue dada de baja.');
    await this.validarBanco(dto.id_banco);

    const alias = (dto.alias ?? actual.alias).trim();
    const idEmpresa = dto.id_empresa ?? actual.id_empresa;

    const [duplicado] = await this.dataSource.query(
      `SELECT id_cuenta FROM tesoreria_cuenta
        WHERE id_empresa = ? AND alias = ? AND id_cuenta <> ? AND estado_registro = 'ACTIVO'`,
      [idEmpresa, alias, id],
    );
    if (duplicado) throw new ConflictException('Esta empresa ya tiene otra cuenta con ese alias.');

    // Cambiar de empresa una cuenta que ya movió plata dejaría esos movimientos
    // apuntando a la empresa vieja por `tesoreria_movimiento.id_empresa`, y el estado
    // de cuenta de las dos empresas quedaría mal.
    if (Number(idEmpresa) !== Number(actual.id_empresa)) {
      const [mov] = await this.dataSource.query(
        `SELECT id_movimiento FROM tesoreria_movimiento
          WHERE id_cuenta = ? AND estado_registro = 'ACTIVO' LIMIT 1`,
        [id],
      );
      if (mov) {
        throw new ConflictException(
          'No se puede cambiar de empresa una cuenta que ya tiene movimientos. ' +
          'Creá la cuenta en la otra empresa y dejá esta como está: su historial pertenece a la empresa actual.',
        );
      }
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await bloquearCuenta(qr, id);

      const res: any = await qr.query(
        `UPDATE tesoreria_cuenta
            SET id_empresa = ?, id_banco = ?, tipo = ?, moneda = ?, numero_cuenta = ?, cci = ?,
                alias = ?, saldo_inicial = ?, observaciones = ?, id_usuario_mod = ?
          WHERE id_cuenta = ? AND estado_registro = 'ACTIVO'`,
        [
          idEmpresa, dto.id_banco ?? actual.id_banco, dto.tipo ?? actual.tipo, dto.moneda ?? actual.moneda,
          dto.numero_cuenta?.trim() ?? actual.numero_cuenta, dto.cci?.trim() ?? actual.cci, alias,
          dto.saldo_inicial !== undefined ? num(dto.saldo_inicial) : num(actual.saldo_inicial),
          dto.observaciones?.trim() ?? actual.observaciones, userId, id,
        ],
      );
      if (res.affectedRows === 0) throw new NotFoundException('La cuenta no existe o fue dada de baja.');

      // Recalcula siempre, no solo si cambió el saldo inicial: es barato y evita el
      // caso en que alguien corrige el inicial y la cadena queda desfasada sin aviso.
      const { saldo } = await recalcularSaldosCuenta(qr, id, userId);

      await this.auditoriaService.registrarConTransaccion(
        qr, 'tesoreria_cuenta', id, 'ACTUALIZAR', userId, actual, { ...dto, alias },
      );

      await qr.commitTransaction();
      return { saldo_actual: saldo, mensaje: 'Cuenta actualizada correctamente' };
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }
  }

  /**
   * Baja lógica, y solo si la cuenta nunca movió plata.
   *
   * Con movimientos vivos, darla de baja los dejaría colgando de una cuenta que ya no
   * se lista: invisibles en los filtros pero sumando en cualquier reporte que arranque
   * por el movimiento.
   */
  async remove(id: number, userId: number) {
    const [actual] = await this.dataSource.query(
      `SELECT * FROM tesoreria_cuenta WHERE id_cuenta = ? AND estado_registro = 'ACTIVO'`,
      [id],
    );
    if (!actual) throw new NotFoundException('La cuenta no existe o ya fue dada de baja.');

    const [mov] = await this.dataSource.query(
      `SELECT id_movimiento FROM tesoreria_movimiento
        WHERE id_cuenta = ? AND estado_registro = 'ACTIVO' LIMIT 1`,
      [id],
    );
    if (mov) {
      throw new ConflictException(
        'No se puede eliminar: la cuenta tiene movimientos registrados. ' +
        'Si ya no se usa, dejala sin movimientos nuevos — su historial tiene que seguir consultable.',
      );
    }

    const res: any = await this.dataSource.query(
      `UPDATE tesoreria_cuenta SET estado_registro = 'ELIMINADO', id_usuario_mod = ?
        WHERE id_cuenta = ? AND estado_registro = 'ACTIVO'`,
      [userId, id],
    );
    if (res.affectedRows === 0) throw new NotFoundException('La cuenta no existe o ya fue dada de baja.');

    await this.auditoriaService.registrar('tesoreria_cuenta', id, 'ELIMINAR', userId, actual, null);
    return { mensaje: 'Cuenta eliminada correctamente' };
  }

  // ── CATÁLOGOS Y EXPORTACIÓN ─────────────────────────────────────────────────

  async getCatalogos() {
    const bancos = await this.dataSource.query(
      `SELECT id_banco AS id, nombre, codigo_sunat FROM planilla_banco
        WHERE estado_registro = 'ACTIVO' ORDER BY nombre ASC`,
    );
    return { bancos };
  }

  async buscarEmpresas(search = '', exactId?: number) {
    const params: any[] = [`%${search}%`, `%${search}%`];
    let orderBy = 'ORDER BY e.razon_social ASC';
    if (exactId) {
      orderBy = 'ORDER BY CASE WHEN e.id_empresa = ? THEN 0 ELSE 1 END, e.razon_social ASC';
      params.push(exactId);
    }
    const data = await this.dataSource.query(
      `SELECT e.id_empresa AS id, e.razon_social AS nombre, e.ruc
         FROM empresa e
        WHERE e.estado_registro = 'ACTIVO' AND (e.razon_social LIKE ? OR e.ruc LIKE ?)
        ${orderBy} LIMIT 30`,
      params,
    );
    return { data };
  }

  async exportarExcel(query: any, res: Response) {
    const data = (await this.findAll(query, true)) as any[];
    const columnas = [
      { header: 'ID', key: 'id_cuenta', width: 8 },
      { header: 'EMPRESA', key: 'nombre_empresa', width: 38 },
      { header: 'RUC', key: 'ruc_empresa', width: 14 },
      { header: 'ALIAS', key: 'alias', width: 26 },
      { header: 'BANCO', key: 'nombre_banco', width: 24 },
      { header: 'TIPO', key: 'tipo', width: 14 },
      { header: 'MONEDA', key: 'moneda', width: 9 },
      { header: 'N° DE CUENTA', key: 'numero_cuenta', width: 24 },
      { header: 'CCI', key: 'cci', width: 24 },
      { header: 'SALDO INICIAL', key: 'saldo_inicial', width: 16 },
      { header: 'SALDO ACTUAL', key: 'saldo_actual', width: 16 },
      { header: 'MOVIMIENTOS', key: 'total_movimientos', width: 14 },
    ];
    await this.excelService.generarExcel(
      columnas, data, `Cuentas_${new Date().toISOString().split('T')[0]}`, 'Cuentas bancarias', res,
    );
  }
}
