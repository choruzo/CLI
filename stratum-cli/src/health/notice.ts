/**
 * M23 — el texto de un aviso de degradación. Lo compone el daemon con una
 * plantilla, **nunca el LLM**. El nombre del conector sale del catálogo; el
 * motivo de un fallo viene del conector (contenido no confiable) y se
 * neutraliza aquí. Sin I/O.
 */
import { HEALTH_LIMITS } from '../protocol/index.js';
import { neutralizeCheckText } from '../connectors/checks.js';
import type { ConnectorHealthNotice } from './engine.js';

const REASON_CHARS = 200;

export interface ConnectorNoticeInput {
  kind: ConnectorHealthNotice;
  connector: string;
  /** Nombre del manifiesto. */
  name: string;
  /** El `detalle` del último fallo, con `failing`. */
  reason?: string;
}

export function connectorHealthText(input: ConnectorNoticeInput): string {
  const name = neutralizeCheckText(input.name, 60) || input.connector;
  const setup = `stratum connectors setup ${input.connector}`;
  let text: string;
  switch (input.kind) {
    case 'auth':
      text =
        `🔑 ${name} ha rechazado la autorización del asistente (caducada o revocada). ` +
        `Hasta renovarla no funcionarán sus herramientas ni sus vigilantes: «${setup}».`;
      break;
    case 'failing': {
      const reason = neutralizeCheckText(input.reason ?? '', REASON_CHARS);
      text = `⚠️ ${name} no responde al asistente${reason ? `: ${reason}` : '.'}`;
      break;
    }
    case 'recovered':
      text = `✅ ${name} vuelve a funcionar.`;
      break;
  }
  return neutralizeCheckText(text, HEALTH_LIMITS.noticeChars);
}

export function boxImageText(): string {
  return neutralizeCheckText(
    '📦 La caja del asistente se creó con una imagen o unos ajustes anteriores a los de este ' +
      'Stratum. Se recrea, sin perder su home, con «stratum box start».',
    HEALTH_LIMITS.noticeChars,
  );
}
