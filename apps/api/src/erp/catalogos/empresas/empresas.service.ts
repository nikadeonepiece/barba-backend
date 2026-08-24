import { Injectable, InternalServerErrorException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuditoriaService } from '@app/common';
import { CreateEmpresaDto, UpdateEmpresaDto } from './dto/empresa.dto';
import { CredencialesCryptoService } from '../../comun/credenciales-crypto.service';
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
    const solUsuario = dto.sunat_sol_usuario ? this.credencialesCrypto.cifrar(dto.sunat_sol_usuario) : null;
    const solPassword = dto.sunat_sol_password ? this.credencialesCrypto.cifrar(dto.sunat_sol_password) : null;
    const apiClientId = dto.sunat_api_client_id ? this.credencialesCrypto.cifrar(dto.sunat_api_client_id) : null;
    const apiClientSecret = dto.sunat_api_client_secret ? this.credencialesCrypto.cifrar(dto.sunat_api_client_secret) : null;

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
    const [row] = await this.dataSource.query(
      `SELECT ruc, razon_social, sunat_sol_usuario, sunat_sol_password FROM empresa WHERE id_empresa = ?`,
      [id],
    );
    if (!row) throw new NotFoundException('Empresa no encontrada');
    if (!row.sunat_sol_usuario || !row.sunat_sol_password) {
      throw new ConflictException('Esta empresa no tiene Usuario/Clave SOL guardados todavía');
    }

    const solUsuario = this.credencialesCrypto.descifrar(row.sunat_sol_usuario);
    const solPassword = this.credencialesCrypto.descifrar(row.sunat_sol_password);

    await this.auditoriaService.registrar('empresa', id, 'ACTUALIZAR', userId, null, { accion: 'abrir_mis_declaraciones_sunat' });

    await this.sunatLoginClient.abrirSesionMisDeclaraciones(row.ruc, solUsuario, solPassword);
    return { success: true, message: `Sesión abierta en SUNAT para ${row.razon_social}` };
  }
}
