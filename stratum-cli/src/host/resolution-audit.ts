/**
 * Rastro de quién resolvió cada solicitud pendiente: una línea en la traza de
 * la sesión y, para las aprobaciones, otra en `exec-audit.jsonl`, junto a los
 * comandos que autorizan. Lo usa todo anfitrión de sesión (`SessionHost`, y el
 * chat, que aún monta la suya a mano).
 *
 * Solo metadatos: qué se pidió ya redactado, cómo acabó y por qué vía. Nunca la
 * frase tecleada, las respuestas ni credencial alguna.
 */
import type { StratumConfig } from '../config/schema.js';
import { redactText } from '../security/redact-output.js';
import { getExecAuditLog } from '../tools/exec/runtime.js';
import type { TraceScope } from '../trace/recorder.js';
import type { GrantChange } from './approval-grants.js';
import type { InteractionChange } from './interactions.js';

export interface ResolutionAuditTarget {
  config: StratumConfig;
  sessionId: string;
  trace?: TraceScope | undefined;
}

export function recordResolution(target: ResolutionAuditTarget, change: InteractionChange): void {
  if (change.type !== 'resolved') return;
  const { interaction, outcome } = change;
  const by = outcome.by?.kind ?? 'none';
  const who = {
    ...(outcome.by?.client ? { client: outcome.by.client } : {}),
    ...(outcome.by?.connectionId !== undefined ? { connectionId: outcome.by.connectionId } : {}),
  };
  target.trace?.runtime({
    event: 'resolution',
    kind: interaction.kind,
    id: interaction.id,
    status: outcome.status,
    by,
    ...who,
    ...(interaction.kind === 'approval'
      ? { tool: interaction.request.toolName, callId: interaction.request.callId }
      : {}),
  });
  if (interaction.kind !== 'approval' || outcome.kind !== 'approval') return;
  try {
    getExecAuditLog(target.config).write({
      timestamp: new Date().toISOString(),
      sessionId: target.sessionId,
      event: 'approval',
      approvalId: interaction.id,
      tool: interaction.request.toolName,
      description: redactText(interaction.request.description, target.config),
      ...(interaction.request.target ? { target: interaction.request.target } : {}),
      ...(interaction.request.environment
        ? { environment: interaction.request.environment.name }
        : {}),
      ...(interaction.request.forced ? { forced: true } : {}),
      status: outcome.status,
      decision: outcome.decision,
      by,
      ...who,
    });
  } catch {
    /* la auditoría nunca tumba una decisión */
  }
}

/**
 * M17 — una concesión temporal se abrió, se revocó o caducó: un aviso en la
 * traza, para que el `/auditor` distinga «aprobada por concesión» (en cada
 * `confirmation` con `granted`) de quién y cuándo la dio.
 */
export function recordGrant(
  target: Pick<ResolutionAuditTarget, 'trace'>,
  change: GrantChange,
): void {
  const { grant } = change;
  const by = grant.grantedBy;
  target.trace?.runtime({
    event: 'grant',
    phase: change.type === 'created' ? 'created' : change.reason,
    grantId: grant.id,
    tool: grant.tool,
    ...(grant.target !== undefined ? { target: grant.target } : {}),
    minutes: grant.minutes,
    expiresAt: grant.expiresAt,
    ...(change.type === 'created' && (by.kind === 'local' || by.kind === 'remote')
      ? {
          by: by.kind,
          ...(by.client ? { client: by.client } : {}),
          ...(by.connectionId !== undefined ? { connectionId: by.connectionId } : {}),
        }
      : {}),
  });
}
