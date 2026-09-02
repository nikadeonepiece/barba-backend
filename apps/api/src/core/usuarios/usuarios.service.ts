import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import * as bcrypt from 'bcrypt';
import { CreateUsuarioDto, UpdateUsuarioDto } from './dto/usuario.dto';
import { CambiarPasswordDto } from './dto/cambiar-password.dto';

@Injectable()
export class UsuariosService {
  constructor(@InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource, private auditoriaService: AuditoriaService) {}

  async findByEmail(correo: string) {
    const [data] = await this.dataSource.query(`CALL sis_usuario_obtener_por_correo(?)`, [correo]);
    return data && data.length > 0 ? data[0] : null;
  }

  async getRoles() {
    const [data] = await this.dataSource.query(`CALL sis_rol_listar()`);
    return { success: true, data };
  }

  /**
   * Empresas que se pueden asignar a un usuario del portal cliente. Alimenta el
   * ng-select de la pantalla de usuarios; pide `ver_usuario` como el resto de la
   * pantalla, no un permiso de catálogos.
   */
  async getEmpresas() {
    const data = await this.dataSource.query(
      `SELECT id_empresa, razon_social, ruc FROM empresa
       WHERE estado_registro = 'ACTIVO' AND estado_cliente = 'ACTIVO'
       ORDER BY razon_social ASC`,
    );
    return { success: true, data };
  }

  /**
   * Traduce el `id_empresa` que llegó del formulario a lo que se graba, y falla si no
   * corresponde. Es el único punto donde se acepta un id de empresa desde afuera: si
   * pasara uno inexistente o de una empresa dada de baja, el usuario quedaría con un
   * scope que no resuelve y el portal le respondería 403 sin explicar por qué.
   *
   * Recibe el `QueryRunner` en vez de abrir uno propio porque siempre se llama dentro
   * de la transacción de create/update (regla de transacciones anidadas de CLAUDE.md).
   */
  private async validarEmpresaDelUsuario(queryRunner: QueryRunner, idEmpresa?: number | null): Promise<number | null> {
    if (idEmpresa === null || idEmpresa === undefined) return null;

    const id = Number(idEmpresa);
    if (!id || Number.isNaN(id)) throw new BadRequestException('ID de empresa inválido');

    const [empresa] = await queryRunner.query(
      `SELECT id_empresa FROM empresa
       WHERE id_empresa = ? AND estado_registro = 'ACTIVO' AND estado_cliente = 'ACTIVO'`,
      [id],
    );
    if (!empresa) {
      throw new BadRequestException(
        'La empresa indicada no existe o ya no es cliente del estudio. Elegí una empresa activa, o dejá el campo vacío si el usuario es del estudio.',
      );
    }
    return id;
  }

  async create(dto: CreateUsuarioDto, userId: number) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const hashedPassword = await bcrypt.hash(dto.password, 10);

      // El 2º parámetro del SP era `p_id_cliente` y se mandaba NULL fijo porque no
      // se usaba. Ahora es `p_id_empresa` y SÍ se graba: con valor, el usuario queda
      // atado a esa empresa y entra al portal cliente viendo solo lo suyo; sin valor
      // (NULL), es personal del estudio y no tiene ese candado.
      const idEmpresa = await this.validarEmpresaDelUsuario(queryRunner, dto.id_empresa);

      const [[result]] = await queryRunner.query(
        `CALL sis_usuario_crear(?, ?, ?, ?, ?, ?)`,
        [dto.id_rol, idEmpresa, dto.nombres.trim().toUpperCase(), dto.apellidos.trim().toUpperCase(), dto.correo.trim().toLowerCase(), hashedPassword]
      );

      const idUsuarioNuevo = result.id_insertado;

      await this.auditoriaService.registrarConTransaccion(queryRunner, 'sis_usuario', idUsuarioNuevo, 'CREAR', userId, null, { correo: dto.correo, rol: dto.id_rol, id_empresa: idEmpresa });
      await queryRunner.commitTransaction();
      return { success: true, message: 'Usuario base registrado exitosamente', id: idUsuarioNuevo };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      if (error.message.includes('correo')) throw new ConflictException('El correo ya está en uso');
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findAll() {
    const [data] = await this.dataSource.query(`CALL sis_usuario_listar(NULL, 'ACTIVO')`);
    return { success: true, data };
  }

  async findOne(id: number) {
    const [data] = await this.dataSource.query(`CALL sis_usuario_obtener(?)`, [id]);
    if (!data || data.length === 0) throw new NotFoundException('Usuario no encontrado');
    return { success: true, data: data[0] };
  }

  async update(id: number, dto: UpdateUsuarioDto, userId: number) {
    const antiguo = await this.findOne(id);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const nombres = dto.nombres ? dto.nombres.trim().toUpperCase() : antiguo.data.nombres;
      const apellidos = dto.apellidos ? dto.apellidos.trim().toUpperCase() : antiguo.data.apellidos;
      const correo = dto.correo ? dto.correo.trim().toLowerCase() : antiguo.data.correo;

      // `id_empresa` se compara contra `undefined`, no con `||`: mandar `null` es la
      // forma de DESATAR a un usuario de su empresa (pasarlo a personal del estudio),
      // y con `||` ese null caería al valor anterior y el cambio se perdería en silencio.
      const idEmpresa = dto.id_empresa === undefined
        ? (antiguo.data.id_empresa ?? null)
        : await this.validarEmpresaDelUsuario(queryRunner, dto.id_empresa);

      // 🔥 FIX CRÍTICO APLICADO AQUÍ: El orden exacto de los parámetros para sis_usuario_actualizar
      await queryRunner.query(
        `CALL sis_usuario_actualizar(?, ?, ?, ?, ?, ?)`,
        [id, dto.id_rol || antiguo.data.id_rol, idEmpresa, nombres, apellidos, correo]
      );

      await this.auditoriaService.registrarConTransaccion(queryRunner, 'sis_usuario', id, 'ACTUALIZAR', userId, antiguo.data, { id_rol: dto.id_rol, id_empresa: idEmpresa, nombres, apellidos, correo });
      await queryRunner.commitTransaction();
      return { success: true, message: 'Usuario actualizado correctamente' };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      if (error.message?.includes('correo')) throw new ConflictException('El correo ya está en uso');
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async leerYMarcarPrimeraSesion(userId: number): Promise<boolean> {
    try {
      const [row] = await this.dataSource.query(`SELECT primera_sesion FROM sis_usuario WHERE id_usuario = ?`, [userId]);
      const esPrimera = row?.primera_sesion === 1;
      if (esPrimera) {
        await this.dataSource.query(`UPDATE sis_usuario SET primera_sesion = 0 WHERE id_usuario = ?`, [userId]);
      }
      return esPrimera;
    } catch (_) {
      return false;
    }
  }

  async cambiarPassword(userId: number, dto: CambiarPasswordDto) {
    const [row] = await this.dataSource.query(`SELECT password FROM sis_usuario WHERE id_usuario = ?`, [userId]);
    if (!row) throw new NotFoundException('Usuario no encontrado');

    const passwordValida = await bcrypt.compare(dto.passwordActual, row.password);
    if (!passwordValida) throw new BadRequestException('La contraseña actual es incorrecta');

    const hashedPassword = await bcrypt.hash(dto.passwordNueva, 10);
    await this.dataSource.query(`UPDATE sis_usuario SET password = ? WHERE id_usuario = ?`, [hashedPassword, userId]);

    await this.auditoriaService.registrar('sis_usuario', userId, 'ACTUALIZAR', userId, { password: '***' }, { password: '***' });
    return { success: true, message: 'Contraseña actualizada correctamente' };
  }

  async remove(id: number, userId: number) {
    if (id === 1) throw new ConflictException('No se puede eliminar al Administrador Principal del Sistema.');
    const antiguo = await this.findOne(id);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(`CALL sis_usuario_eliminar(?)`, [id]);
      await this.auditoriaService.registrarConTransaccion(queryRunner, 'sis_usuario', id, 'ELIMINAR', userId, antiguo.data, null);
      await queryRunner.commitTransaction();
      return { success: true, message: 'Usuario dado de baja' };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}