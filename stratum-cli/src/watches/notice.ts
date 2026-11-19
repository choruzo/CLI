/**
 * M22 — el texto de un aviso de vigilante. Lo compone el daemon con una
 * plantilla, **nunca el LLM**. Lo que viene del conector (estado y detalle) ya
 * llega neutralizado por `parseCheckResult`; el nombre del vigilante y el motivo
 * de un fallo se neutralizan aquí. Sin I/O.
 */
import { WATCH_LIMITS } from '../protocol/index.js';
import { neutralizeCheckText, type CheckResult } from '../connectors/checks.js';
import { describeCondition, type WatchCondition } from './condition.js';
import type { WatchNoticeKind } from './engine.js';

const REASON_CHARS = 200;

export interface NoticeInput {
  kind: WatchNoticeKind;
  name: string;
  condition: WatchCondition;
  /** El resultado que provocó `fired` o `resolved`. */
  result?: CheckResult;
  /** El motivo de `failing` o `suspended`. */
  reason?: string;
}

function now(result: CheckResult | undefined): string {
  if (!result) return '';
  const valor =
    result.valor === null || String(result.valor) === result.estado ? '' : ` (${result.valor})`;
  const detalle = result.detalle ? ` · ${result.detalle}` : '';
  return ` Ahora: «${result.estado}»${valor}${detalle}.`;
}

export function watchNoticeText(input: NoticeInput): string {
  const name = neutralizeCheckText(input.name, WATCH_LIMITS.nameChars) || 'sin nombre';
  const reason = neutralizeCheckText(input.reason ?? '', REASON_CHARS) || 'sin motivo';
  let text: string;
  switch (input.kind) {
    case 'fired':
      text = `🔔 Vigilante «${name}»: ${describeCondition(input.condition)}.${now(input.result)}`;
      break;
    case 'resolved':
      text = `✅ Vigilante «${name}»: ya no se cumple (${describeCondition(input.condition)}).${now(input.result)}`;
      break;
    case 'failing':
      text = `⚠️ El vigilante «${name}» no puede mirar: ${reason}`;
      break;
    case 'suspended':
      text = `⏸️ El vigilante «${name}» está suspendido: ${reason}`;
      break;
  }
  return neutralizeCheckText(text, WATCH_LIMITS.noticeChars);
}
