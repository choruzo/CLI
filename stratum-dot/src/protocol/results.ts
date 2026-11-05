/**
 * Lo que devuelven las llamadas del chat. El lado nativo lo pasa **sin
 * interpretar**; aquí se valida con los schemas del contrato, igual que una
 * foto o un evento. Lo que no valida no se usa.
 */
import { RESULTS } from '../../../stratum-cli/src/protocol/schemas';
import type {
  ProtocolAgent,
  ProtocolBoxScreen,
  ProtocolBoxStatus,
  ProtocolTelegramStatus,
  ProtocolDecision,
  ProtocolModel,
  ProtocolRoutine,
  ProtocolRoutineFire,
  ProtocolRun,
  ProtocolSession,
  ProtocolSessionMemory,
} from './index';

export function parseOpenedSession(raw: unknown): ProtocolSession | null {
  const parsed = RESULTS['sessions.open'].safeParse(raw);
  return parsed.success ? parsed.data.session : null;
}

/**
 * Cierre de M14 — conversación nueva del asistente: la sesión nueva y, si la
 * hubo, la que se archivó (y si su memoria pasó a la nueva).
 */
export function parseFreshConversation(
  raw: unknown,
): { session: ProtocolSession; archived: { sessionId: string; memoryCarried: boolean } | null } | null {
  const parsed = RESULTS['sessions.open'].safeParse(raw);
  return parsed.success ? { session: parsed.data.session, archived: parsed.data.archived ?? null } : null;
}

export function parseStartedRun(raw: unknown): ProtocolRun | null {
  const parsed = RESULTS['runs.start'].safeParse(raw);
  return parsed.success ? parsed.data.run : null;
}

export function parseAgents(raw: unknown): ProtocolAgent[] | null {
  const parsed = RESULTS['agents.list'].safeParse(raw);
  return parsed.success ? parsed.data.agents : null;
}

export interface ModelList {
  models: ProtocolModel[];
  /** Algún provider no contestó: la lista puede estar incompleta. */
  incomplete: boolean;
}

export function parseModels(raw: unknown): ModelList | null {
  const parsed = RESULTS['models.list'].safeParse(raw);
  return parsed.success ? { models: parsed.data.models, incomplete: parsed.data.error !== undefined } : null;
}

/** M14 — `box.status`, `box.start` y `box.stop` devuelven lo mismo: el estado de la caja. */
export function parseBoxStatus(raw: unknown): ProtocolBoxStatus | null {
  const parsed = RESULTS['box.status'].safeParse(raw);
  return parsed.success ? parsed.data.box : null;
}

/** M15 — `box.screen`: la pantalla de la caja ahora (JPEG en base64). */
export function parseBoxScreen(raw: unknown): ProtocolBoxScreen | null {
  const parsed = RESULTS['box.screen'].safeParse(raw);
  return parsed.success ? parsed.data.screen : null;
}

/** Una imagen compartida: un trozo de `images.get` (base64 de la parte pedida). */
export function parseImageChunk(raw: unknown) {
  const parsed = RESULTS['images.get'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** M16 — `routines.list`: las rutinas y si el almacén está en solo lectura. */
export interface RoutineList {
  routines: ProtocolRoutine[];
  readOnly: boolean;
}

export function parseRoutines(raw: unknown): RoutineList | null {
  const parsed = RESULTS['routines.list'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** M16 — `routines.add`, `routines.update` y `routines.remove` devuelven la rutina (la borrada, en `remove`). */
export function parseRoutine(raw: unknown): ProtocolRoutine | null {
  const parsed = RESULTS['routines.add'].safeParse(raw);
  return parsed.success ? parsed.data.routine : null;
}

/** M16 — `routines.run`: qué pasó con el disparo y la rutina resultante. */
export function parseRoutineRun(raw: unknown): { fire: ProtocolRoutineFire; routine: ProtocolRoutine } | null {
  const parsed = RESULTS['routines.run'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** M17 — `memory.decisions`: lo que recuerda el asistente (las últimas, o la búsqueda). */
export function parseDecisions(raw: unknown): ProtocolDecision[] | null {
  const parsed = RESULTS['memory.decisions'].safeParse(raw);
  return parsed.success ? parsed.data.decisions : null;
}

/** M17 — `memory.forget`: `removed: false` si ya no estaba (no es un error). */
export function parseForget(raw: unknown): boolean | null {
  const parsed = RESULTS['memory.forget'].safeParse(raw);
  return parsed.success ? parsed.data.removed : null;
}

/** M17 — `sessions.memory`: la memoria de sesión (M11), solo lectura. */
export function parseSessionMemory(raw: unknown): ProtocolSessionMemory | null {
  const parsed = RESULTS['sessions.memory'].safeParse(raw);
  return parsed.success ? parsed.data.memory : null;
}

/** M18 — `channels.status`: el canal de Telegram (sin el secreto del bot ni el código). */
export function parseChannelsStatus(raw: unknown): ProtocolTelegramStatus | null {
  const parsed = RESULTS['channels.status'].safeParse(raw);
  return parsed.success ? parsed.data.telegram : null;
}

/** M18 — `channels.pairBegin`: el código de un solo uso, su enlace y hasta cuándo vale. */
export function parsePairBegin(raw: unknown): { code: string; link: string; expiresAt: number } | null {
  const parsed = RESULTS['channels.pairBegin'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** M18 — `channels.unpair`: `removed: false` si ya no estaba (no es un error). */
export function parseUnpair(raw: unknown): boolean | null {
  const parsed = RESULTS['channels.unpair'].safeParse(raw);
  return parsed.success ? parsed.data.removed : null;
}