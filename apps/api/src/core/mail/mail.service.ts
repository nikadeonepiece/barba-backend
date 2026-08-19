import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly urlBase: string;

  constructor(
    private readonly mailerService: MailerService,
    private configService: ConfigService
  ) {
    this.urlBase = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:4200';
  }

  // --- PLANTILLAS DINÁMICAS Y DEEP LINKING ---

  async enviarNotificacionDerivacion(correoDestino: string, codigoExpediente: string, idExpediente: number, mensajeExtra?: string) {
    const enlace = `${this.urlBase}/expedientes/${idExpediente}`;
    const html = `
      <h2>Notificación de Expediente Derivado</h2>
      <p>Se te ha derivado el expediente <strong>${codigoExpediente}</strong>.</p>
      ${mensajeExtra ? `<p><strong>Comentario:</strong> ${mensajeExtra}</p>` : ''}
      <p>Por favor, ingresa al sistema para continuar con el flujo.</p>
      <a href="${enlace}" style="padding: 10px 20px; background-color: #0070C0; color: white; text-decoration: none; border-radius: 5px;">Ir al Expediente</a>
    `;
    await this.dispararCorreo(correoDestino, `Expediente Derivado: ${codigoExpediente}`, html);
  }

  async enviarNotificacionAsignacionMultiple(correoDestino: string, codigoExpediente: string, idExpediente: number) {
    const enlace = `${this.urlBase}/expedientes/revision/${idExpediente}`;
    const html = `
      <h2>Asignación de Revisión Técnica</h2>
      <p>Has sido asignado para la revisión en paralelo del expediente <strong>${codigoExpediente}</strong>.</p>
      <p>Recuerda que debes evaluar y emitir tu conformidad u observación.</p>
      <a href="${enlace}" style="padding: 10px 20px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px;">Evaluar Expediente</a>
    `;
    await this.dispararCorreo(correoDestino, `Revisión Asignada: ${codigoExpediente}`, html);
  }

  async enviarNotificacionObservacion(correoDestino: string, codigoExpediente: string, idExpediente: number) {
    const enlace = `${this.urlBase}/expedientes/${idExpediente}`;
    const html = `
      <h2 style="color: #dc3545;">Expediente Observado</h2>
      <p>El revisor técnico ha encontrado observaciones en el expediente <strong>${codigoExpediente}</strong> y ha adjuntado un Acta.</p>
      <p>Es obligatorio ingresar al sistema y subir el PDF con la corrección para continuar.</p>
      <a href="${enlace}" style="padding: 10px 20px; background-color: #dc3545; color: white; text-decoration: none; border-radius: 5px;">Ver Observaciones</a>
    `;
    await this.dispararCorreo(correoDestino, `URGENTE - Observación en: ${codigoExpediente}`, html);
  }

  async enviarNotificacionCargaPendiente(correoDestino: string, codigoExpediente: string, idExpediente: number) {
    const enlace = `${this.urlBase}/expedientes/${idExpediente}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
        <div style="background-color: #0070C0; padding: 24px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 22px;">¡Tu proyecto está listo!</h1>
        </div>
        <div style="padding: 32px 24px;">
          <p style="font-size: 16px; color: #333;">Hola,</p>
          <p style="font-size: 16px; color: #333;">
            Te informamos que el expediente <strong style="color: #0070C0;">${codigoExpediente}</strong> ha sido
            creado exitosamente y está esperando que subas la documentación necesaria para continuar con el proceso.
          </p>
          <div style="background-color: #f0f7ff; border-left: 4px solid #0070C0; padding: 16px; border-radius: 4px; margin: 24px 0;">
            <p style="margin: 0; font-size: 15px; color: #333;">
              📂 <strong>¿Qué necesitas hacer?</strong><br><br>
              Ingresa al sistema y sube los documentos del proyecto en las carpetas habilitadas para ti.
              Asegúrate de subir todos los archivos requeridos para que podamos avanzar con la revisión técnica.
            </p>
          </div>
          <p style="font-size: 14px; color: #666;">Si tienes alguna duda, no dudes en comunicarte con el equipo responsable del proyecto.</p>
          <div style="text-align: center; margin-top: 32px;">
            <a href="${enlace}" style="display: inline-block; padding: 14px 28px; background-color: #0070C0; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">
              Subir documentos del proyecto
            </a>
          </div>
        </div>
        <div style="background-color: #f5f5f5; padding: 16px; text-align: center;">
          <p style="margin: 0; font-size: 12px; color: #999;">Este correo fue generado automáticamente. Por favor no respondas a este mensaje.</p>
        </div>
      </div>
    `;
    await this.dispararCorreo(correoDestino, `📂 Proyecto listo para carga de documentos: ${codigoExpediente}`, html);
  }

  // Motor interno para no repetir código del try/catch
  private async dispararCorreo(to: string, subject: string, html: string) {
    try {
      await this.mailerService.sendMail({ to, subject, html });
      this.logger.log(`📧 Correo enviado con éxito a: ${to}`);
    } catch (error) {
      this.logger.error(`❌ Error enviando correo a ${to}:`, error);
    }
  }
}