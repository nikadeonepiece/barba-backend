import { Injectable, InternalServerErrorException, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import * as bcrypt from 'bcrypt';
import { CreateEmpresaDto, UpdateEmpresaDto, CreateUsuarioPortalDto, UpdateUsuarioPortalDto } from './dto/empresa.dto';
import { CredencialesCryptoService } from '@app/security';
import { GuardarCredencialesDto } from './dto/empresa.dto';
import { SunatLoginClient } from './sunat-login.client';

@Injectable()
export class EmpresasService {
  constructor(
    @InjectDataSource('ESTUDIOBARBA_CONN') private dataSource: DataSource,
    private auditoriaService: AuditoriaService,
    private credencialesCrypto: CredencialesCryptoService,
    private sunatLoginClient: SunatLoginClient,
  ) {}

  async create(dto: CreateEmpresaDto, userId: number) {
    try {
      const [[result]] = await this.dataSource.query(
        `CALL empresa_crear(?, ?, ?, ?, ?, ?)`,
        [dto.razon_social.trim().toUpperCase(), dto.ruc.trim(), dto.regimen_tributario, dto.id_encargado_contable ?? null, dto.id_encargado_laboral ?? null, userId],
      );
      const idEmpresaNueva = result.id_insertado;
      await this.auditoriaService.registrar('empresa', idEmpresaNueva, 'CREAR', userId, null, { ruc: dto.ruc, razon_social: dto.razon_social });
      return { success: true, message: 'Empresa registrada', id: idEmpresaNueva };
    } catch (error: any) {
      if (error.message?.includes('ruc')) throw new ConflictException('El RUC ya está registrado');
      throw new InternalServerErrorException('Error al crear la empresa');
    }
  }

  async findAll(estadoCliente?: string, search?: string) {
    const [data] = await this.dataSource.query(`CALL empresa_listar(?, ?)`, [estadoCliente ?? null, search ?? null]);
    // Sin paginación real todavía (dataset chico, ~150 empresas); se envuelve en meta
    // para ser compatible con el `useCrud` del frontend, que lo completa solo si meta.total viene en 0.
    return { success: true, data, meta: { total: data.length, page: 1, limit: data.length || 1 } };
  }

  async findOne(id: number) {
    const [data] = await this.dataSource.query(`CALL empresa_obtener(?)`, [id]);
    if (!data || data.length === 0) throw new NotFoundException('Empresa no encontrada');
    return { success: true, data: data[0] };
  }

  async update(id: number, dto: UpdateEmpresaDto, userId: number) {
    const antiguo = await this.findOne(id);
    try {
      await this.dataSource.query(
        `CALL empresa_actualizar(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          dto.razon_social ?? antiguo.data.razon_social,
          dto.regimen_tributario ?? antiguo.data.regimen_tributario,
          dto.estado_cliente ?? antiguo.data.estado_cliente,
          dto.estado_sunat ?? antiguo.data.estado_sunat,
          dto.observaciones ?? antiguo.data.observaciones,
          dto.id_encargado_contable ?? antiguo.data.id_encargado_contable,
          dto.id_encargado_laboral ?? antiguo.data.id_encargado_laboral,
          userId,
        ],
      );
      await this.auditoriaService.registrar('empresa', id, 'ACTUALIZAR', userId, antiguo.data, dto);
      return { success: true, message: 'Empresa actualizada' };
    } catch (error) {
      throw new InternalServerErrorException('Error al actualizar la empresa');
    }
  }

  async remove(id: number, userId: number) {
    const antiguo = await this.findOne(id);
    await this.dataSource.query(`CALL empresa_eliminar(?)`, [id]);
    await this.auditoriaService.registrar('empresa', id, 'ELIMINAR', userId, antiguo.data, null);
    return { success: true, message: 'Empresa dada de baja' };
  }

  /**
   * Descifra y devuelve las credenciales SUNAT guardadas — reemplaza al Excel
   * ("Control de Vencimientos_EBA.xlsm") como fuente de consulta para el
   * encargado del área. Requiere el mismo permiso `ver_credenciales_sunat`
   * que ya gateaba el guardado; queda auditado (sin loguear el valor) porque
   * es lectura de un dato sensible, no solo escritura.
   */
  async obtenerCredenciales(id: number, userId: number) {
    const [row] = await this.dataSource.query(
      `SELECT sunat_sol_usuario, sunat_sol_password, sunat_api_client_id, sunat_api_client_secret
       FROM empresa WHERE id_empresa = ?`,
      [id],
    );
    if (!row) throw new NotFoundException('Empresa no encontrada');

    await this.auditoriaService.registrar('empresa', id, 'ACTUALIZAR', userId, null, { accion: 'ver_credenciales_sunat' });

    return {
      success: true,
      data: {
        sunat_sol_usuario: row.sunat_sol_usuario ? this.credencialesCrypto.descifrar(row.sunat_sol_usuario) : null,
        sunat_sol_password: row.sunat_sol_password ? this.credencialesCrypto.descifrar(row.sunat_sol_password) : null,
        sunat_api_client_id: row.sunat_api_client_id ? this.credencialesCrypto.descifrar(row.sunat_api_client_id) : null,
        sunat_api_client_secret: row.sunat_api_client_secret ? this.credencialesCrypto.descifrar(row.sunat_api_client_secret) : null,
      },
    };
  }

  /**
   * Las claves llegan en texto plano desde el cliente (por HTTPS) y se cifran acá
   * antes de tocar la base de datos. Nunca se guardan ni se loguean en claro.
   */
  async guardarCredenciales(id: number, dto: GuardarCredencialesDto, userId: number) {
    await this.findOne(id);
    // .trim(): el client_id/secret y el usuario SOL se pegan a mano desde el portal de
    // SUNAT, y un espacio o salto de línea al final viaja tal cual hasta el OAuth de
    // SIRE — SUNAT responde 401 "cliente no autorizado" sin decir por qué. Se limpia acá.
    const limpiar = (v?: string) => { const t = v?.trim(); return t ? t : null; };
    const solUsuarioTxt = limpiar(dto.sunat_sol_usuario);
    const solPasswordTxt = limpiar(dto.sunat_sol_password);
    const apiClientIdTxt = limpiar(dto.sunat_api_client_id);
    const apiClientSecretTxt = limpiar(dto.sunat_api_client_secret);

    const solUsuario = solUsuarioTxt ? this.credencialesCrypto.cifrar(solUsuarioTxt) : null;
    const solPassword = solPasswordTxt ? this.credencialesCrypto.cifrar(solPasswordTxt) : null;
    const apiClientId = apiClientIdTxt ? this.credencialesCrypto.cifrar(apiClientIdTxt) : null;
    const apiClientSecret = apiClientSecretTxt ? this.credencialesCrypto.cifrar(apiClientSecretTxt) : null;

    await this.dataSource.query(
      `CALL empresa_credenciales_guardar(?, ?, ?, ?, ?)`,
      [id, solUsuario, solPassword, apiClientId, apiClientSecret],
    );
    // Auditoría sin valores: jamás se guarda la clave, ni cifrada, en el log de auditoría.
    await this.auditoriaService.registrar('empresa', id, 'ACTUALIZAR', userId, { credenciales: '***' }, { credenciales: '***' });
    return { success: true, message: 'Credenciales guardadas' };
  }

  /**
   * Abre un Chromium visible (headless:false) ya logueado en "Mis Declaraciones
   * y Pagos" de SUNAT con la Clave SOL guardada — para uso manual del usuario a
   * partir de ahí. Solo tiene efecto visible si erp-backend corre en la misma
   * PC desde la que se usa la app (ver advertencia en sunat-login.client.ts).
   */
  async abrirMisDeclaraciones(id: number, userId: number) {
    const { ruc, razonSocial, solUsuario, solPassword } = await this.credencialesSolParaLogin(id);
    await this.auditoriaService.registrar('empresa', id, 'ACTUALIZAR', userId, null, { accion: 'abrir_mis_declaraciones_sunat' });
    await this.sunatLoginClient.abrirSesionMisDeclaraciones(ruc, solUsuario, solPassword);
    return { success: true, message: `Sesión abierta en SUNAT para ${razonSocial}` };
  }

  /**
   * Igual que `abrirMisDeclaraciones`, pero entrando por "Mis trámites y consultas"
   * (el menú COMPLETO de SOL). Son sesiones distintas y no se puede saltar de una
   * a otra una vez adentro — por eso son dos acciones separadas y no una sola.
   */
  async abrirTramitesConsultas(id: number, userId: number) {
    const { ruc, razonSocial, solUsuario, solPassword } = await this.credencialesSolParaLogin(id);
    await this.auditoriaService.registrar('empresa', id, 'ACTUALIZAR', userId, null, { accion: 'abrir_tramites_consultas_sunat' });
    await this.sunatLoginClient.abrirSesionTramitesConsultas(ruc, solUsuario, solPassword);
    return { success: true, message: `Sesión abierta en SUNAT para ${razonSocial}` };
  }

  /**
   * Trae y descifra la Clave SOL de la empresa para abrir sesión en SUNAT.
   * Compartido por las dos puertas del portal; nunca se loguea ni se audita
   * el valor descifrado.
   */
  private async credencialesSolParaLogin(id: number) {
    const [row] = await this.dataSource.query(
      `SELECT ruc, razon_social, sunat_sol_usuario, sunat_sol_password FROM empresa WHERE id_empresa = ?`,
      [id],
    );
    if (!row) throw new NotFoundException('Empresa no encontrada');
    if (!row.sunat_sol_usuario || !row.sunat_sol_password) {
      throw new ConflictException('Esta empresa no tiene Usuario/Clave SOL guardados todavía');
    }

    return {
      ruc: row.ruc,
      razonSocial: row.razon_social,
      solUsuario: this.credencialesCrypto.descifrar(row.sunat_sol_usuario),
      solPassword: this.credencialesCrypto.descifrar(row.sunat_sol_password),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CUENTAS DEL PORTAL CLIENTE
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Son filas de `sis_usuario` con `id_empresa` puesto. Viven acá y no en el módulo
  // USUARIOS porque el trabajo real es "esta empresa necesita entrar al portal", y lo
  // hace el encargado de la empresa, no quien administra al personal del estudio. Los
  // cuatro permisos (`*_usuario_portal`) son de VENCIMIENTOS_TRIBUTARIO por lo mismo —
  // ver el comentario del bloque en bd.sql.
  //
  // ⚠️ El `id_empresa` de la cuenta SIEMPRE sale del `:id` de la URL, nunca del body.
  // Ese número es el scope con el que el portal acota todas sus consultas
  // (`resolverEmpresaDelUsuario`), así que aceptarlo del cliente sería regalar acceso
  // a la planilla de cualquier otra empresa.

  private static readonly MODULO_PORTAL = 'PLANILLAS_CLIENTE';

  /**
   * Roles asignables a una cuenta de portal: los que tienen permisos DENTRO de
   * `PLANILLAS_CLIENTE` y ninguno fuera de ahí (hoy, el rol `CLIENTE`).
   *
   * Se calcula desde `sis_permiso` en vez de hardcodear `'CLIENTE'` para que un rol de
   * portal nuevo aparezca solo, sin desplegar. Y se valida también en el backend
   * aunque el front ya muestre solo estos: el `id_rol` llega por el body.
   *
   * El rol 1 se excluye explícitamente: `PermissionsGuard` lo deja pasar TODO sin
   * mirar `sis_permiso`, así que un cliente con ese rol tendría el ERP entero aunque
   * su `id_empresa` acote las consultas del portal. Eso no se ve en las tablas de
   * permisos — de ahí la exclusión a mano.
   */
  async rolesPortal() {
    const data = await this.dataSource.query(
      `SELECT r.id_rol, r.nombre, r.descripcion
         FROM sis_rol r
        WHERE r.estado_registro = 'ACTIVO'
          AND r.id_rol <> 1
          AND EXISTS (
                SELECT 1 FROM sis_permiso p
                  INNER JOIN sis_accion a ON a.id_accion = p.id_accion
                  INNER JOIN sis_modulo m ON m.id_modulo = a.id_modulo
                 WHERE p.id_rol = r.id_rol AND p.estado_registro = 'ACTIVO'
                   AND a.estado_registro = 'ACTIVO' AND m.nombre = ?)
          AND NOT EXISTS (
                SELECT 1 FROM sis_permiso p
                  INNER JOIN sis_accion a ON a.id_accion = p.id_accion
                  INNER JOIN sis_modulo m ON m.id_modulo = a.id_modulo
                 WHERE p.id_rol = r.id_rol AND p.estado_registro = 'ACTIVO'
                   AND a.estado_registro = 'ACTIVO' AND m.nombre <> ?)
        ORDER BY r.nombre ASC`,
      [EmpresasService.MODULO_PORTAL, EmpresasService.MODULO_PORTAL],
    );
    return { success: true, data };
  }

  private async validarRolPortal(idRol: number) {
    const { data } = await this.rolesPortal();
    if (!data.some((r: any) => Number(r.id_rol) === Number(idRol))) {
      throw new BadRequestException(
        'Ese rol no sirve para una cuenta de portal. Solo se permite un rol cuyos permisos estén TODOS dentro de "Planillas Cliente" (hoy, el rol CLIENTE). Si hace falta otro, se crea desde Permisos usando únicamente acciones de ese módulo.',
      );
    }
  }

  /**
   * Confirma que la cuenta que se quiere tocar es de ESTA empresa. Se llama al inicio
   * de todo update/reset/estado/baja.
   *
   * Sin esto, `PUT /empresas/5/usuarios/12` con permiso sobre la empresa 5 le cambiaría
   * la contraseña al usuario 12 aunque sea de otra empresa — o del estudio. El permiso
   * responde "puede administrar cuentas de portal"; esta consulta responde "de cuál"
   * (la regla IDOR de CLAUDE.md).
   */
  private async verificarUsuarioDeEmpresa(idEmpresa: number, idUsuario: number) {
    const [usuario] = await this.dataSource.query(
      `SELECT id_usuario, id_rol, id_empresa, nombres, apellidos, correo, estado_registro
         FROM sis_usuario
        WHERE id_usuario = ? AND id_empresa = ? AND estado_registro <> 'ELIMINADO'`,
      [idUsuario, idEmpresa],
    );
    if (!usuario) throw new NotFoundException('Esa cuenta no existe o no pertenece a esta empresa');
    return usuario;
  }

  async listarUsuarios(idEmpresa: number) {
    await this.findOne(idEmpresa);
    const [data] = await this.dataSource.query(`CALL sis_usuario_listar_por_empresa(?)`, [idEmpresa]);
    return { success: true, data };
  }

  async crearUsuario(idEmpresa: number, dto: CreateUsuarioPortalDto, userId: number) {
    const empresa = await this.findOne(idEmpresa);

    // Una empresa que ya no es cliente del estudio no recibe cuentas nuevas: el login
    // las rechaza igual (AuthService mira el estado de la empresa), así que crearlas
    // solo dejaría cuentas que no entran y nadie sabe por qué.
    if (empresa.data.estado_cliente !== 'ACTIVO') {
      throw new BadRequestException(
        'Esta empresa está INACTIVA con el estudio, así que sus cuentas no podrían entrar al portal. Reactivá la empresa antes de darle acceso.',
      );
    }

    await this.validarRolPortal(dto.id_rol);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const hashedPassword = await bcrypt.hash(dto.password, 10);
      const [[result]] = await queryRunner.query(
        `CALL sis_usuario_crear(?, ?, ?, ?, ?, ?)`,
        [
          dto.id_rol,
          idEmpresa,
          dto.nombres.trim().toUpperCase(),
          dto.apellidos.trim().toUpperCase(),
          dto.correo.trim().toLowerCase(),
          hashedPassword,
        ],
      );
      const idUsuarioNuevo = result.id_insertado;

      await this.auditoriaService.registrarConTransaccion(
        queryRunner, 'sis_usuario', idUsuarioNuevo, 'CREAR', userId, null,
        { correo: dto.correo, id_rol: dto.id_rol, id_empresa: idEmpresa, origen: 'portal_empresa' },
      );
      await queryRunner.commitTransaction();
      return { success: true, id: idUsuarioNuevo, mensaje: 'Cuenta de portal creada. Ya puede entrar con ese correo y contraseña.' };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      if (error.code === 'ER_DUP_ENTRY' || error.message?.includes('correo')) {
        throw new ConflictException('Ese correo ya tiene una cuenta en el sistema. Usá otro, o buscá la cuenta que ya existe.');
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async actualizarUsuario(idEmpresa: number, idUsuario: number, dto: UpdateUsuarioPortalDto, userId: number) {
    const antiguo = await this.verificarUsuarioDeEmpresa(idEmpresa, idUsuario);
    if (dto.id_rol !== undefined) await this.validarRolPortal(dto.id_rol);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const nombres = dto.nombres ? dto.nombres.trim().toUpperCase() : antiguo.nombres;
      const apellidos = dto.apellidos ? dto.apellidos.trim().toUpperCase() : antiguo.apellidos;
      const correo = dto.correo ? dto.correo.trim().toLowerCase() : antiguo.correo;

      // El 3.er parámetro es `p_id_empresa` y va con `idEmpresa` fijo, no con lo que
      // traiga el body: este endpoint edita la cuenta, nunca la muda de empresa.
      await queryRunner.query(
        `CALL sis_usuario_actualizar(?, ?, ?, ?, ?, ?)`,
        [idUsuario, dto.id_rol ?? antiguo.id_rol, idEmpresa, nombres, apellidos, correo],
      );

      await this.auditoriaService.registrarConTransaccion(
        queryRunner, 'sis_usuario', idUsuario, 'ACTUALIZAR', userId, antiguo,
        { id_rol: dto.id_rol ?? antiguo.id_rol, id_empresa: idEmpresa, nombres, apellidos, correo },
      );
      await queryRunner.commitTransaction();
      return { success: true, mensaje: 'Cuenta actualizada' };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      if (error.code === 'ER_DUP_ENTRY' || error.message?.includes('correo')) {
        throw new ConflictException('Ese correo ya está en uso por otra cuenta');
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Resetea la contraseña de una cuenta de portal — es lo que se usa cuando el cliente
   * la olvidó, porque todavía no hay recuperación por correo.
   *
   * `primera_sesion` vuelve a 1: el front usa esa bandera para pedir el cambio de clave
   * al entrar, así que la provisional que le pasa el estudio no queda como definitiva.
   */
  async resetearPasswordUsuario(idEmpresa: number, idUsuario: number, password: string, userId: number) {
    await this.verificarUsuarioDeEmpresa(idEmpresa, idUsuario);
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await this.dataSource.query(
      `UPDATE sis_usuario SET password = ?, primera_sesion = 1
        WHERE id_usuario = ? AND id_empresa = ? AND estado_registro <> 'ELIMINADO'`,
      [hashedPassword, idUsuario, idEmpresa],
    );
    if (result.affectedRows === 0) throw new NotFoundException('Esa cuenta no existe o no pertenece a esta empresa');

    // Nunca se audita el valor, ni el viejo ni el nuevo — solo que pasó y quién lo hizo.
    await this.auditoriaService.registrar('sis_usuario', idUsuario, 'ACTUALIZAR', userId, { password: '***' }, { password: '***', accion: 'reset_password_portal' });
    return { success: true, mensaje: 'Contraseña restablecida. Pasásela al cliente: se la va a pedir cambiar al entrar.' };
  }

  /**
   * Suspende o reactiva el acceso sin borrar la cuenta. 'BLOQUEADO' es lo que mira
   * `sis_usuario_obtener_por_correo` (solo trae ACTIVO), así que el login falla como
   * si el correo no existiera.
   */
  async cambiarEstadoUsuario(idEmpresa: number, idUsuario: number, estado: string, userId: number) {
    const antiguo = await this.verificarUsuarioDeEmpresa(idEmpresa, idUsuario);

    await this.dataSource.query(`CALL sis_usuario_cambiar_estado(?, ?)`, [idUsuario, estado]);

    await this.auditoriaService.registrar('sis_usuario', idUsuario, 'ACTUALIZAR', userId, { estado_registro: antiguo.estado_registro }, { estado_registro: estado });
    return { success: true, mensaje: estado === 'BLOQUEADO' ? 'Acceso bloqueado' : 'Acceso reactivado' };
  }

  async eliminarUsuario(idEmpresa: number, idUsuario: number, userId: number) {
    const antiguo = await this.verificarUsuarioDeEmpresa(idEmpresa, idUsuario);
    await this.dataSource.query(`CALL sis_usuario_eliminar(?)`, [idUsuario]);
    await this.auditoriaService.registrar('sis_usuario', idUsuario, 'ELIMINAR', userId, antiguo, null);
    return { success: true, mensaje: 'Cuenta de portal dada de baja' };
  }
}
