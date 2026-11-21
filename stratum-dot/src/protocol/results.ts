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
  ProtocolConnector,
  ProtocolConnectorsList,
  ProtocolDecision,
  ProtocolDoctorReport,
  ProtocolDreamResult,
  ProtocolProposal,
  ProtocolMemoryChange,
  ProtocolModel,
  ProtocolRoutine,
  ProtocolRoutineFire,
  ProtocolReminder,
  ProtocolWatch,
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

/** M21 — `reminders.list`: los recordatorios (cada uno validado con `reminderSchema`) y el solo lectura. */
export interface ReminderList {
  reminders: ProtocolReminder[];
  readOnly: boolean;
}

export function parseReminders(raw: unknown): ReminderList | null {
  const parsed = RESULTS['reminders.list'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** M23 — `doctor.run`: el informe de diagnóstico, validado con el contrato. */
export function parseDoctorReport(raw: unknown): ProtocolDoctorReport | null {
  const parsed = RESULTS['doctor.run'].safeParse(raw);
  return parsed.success ? parsed.data.report : null;
}

/** M21 — `reminders.cancel`: el recordatorio tal como quedó (ya `cancelled`). */
export function parseCancelledReminder(raw: unknown): ProtocolReminder | null {
  const parsed = RESULTS['reminders.cancel'].safeParse(raw);
  return parsed.success ? parsed.data.reminder : null;
}

/** M22 — `watches.list`: los vigilantes (validados con `watchSchema`) y el solo lectura. */
export interface WatchList {
  watches: ProtocolWatch[];
  readOnly: boolean;
}

export function parseWatches(raw: unknown): WatchList | null {
  const parsed = RESULTS['watches.list'].safeParse(raw);
  return parsed.success ? { watches: parsed.data.watches, readOnly: parsed.data.readOnly } : null;
}

/** M22 — `watches.pause|resume|remove`: el vigilante tal como quedó. */
export function parseWatchResult(raw: unknown): ProtocolWatch | null {
  const parsed = RESULTS['watches.pause'].safeParse(raw);
  return parsed.success ? parsed.data.watch : null;
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

/** M19 — `memory.reclassify`: `updated: false` si ya no estaba (no es un error). */
export function parseMoved(raw: unknown): boolean | null {
  const parsed = RESULTS['memory.reclassify'].safeParse(raw);
  return parsed.success ? parsed.data.updated : null;
}

/** M19 fase 5 — `memory.proposals`: las propuestas de dreaming pendientes. */
export function parseProposals(raw: unknown): ProtocolProposal[] | null {
  const parsed = RESULTS['memory.proposals'].safeParse(raw);
  return parsed.success ? parsed.data.proposals : null;
}

/** M19 fase 5 — `memory.dream`: cómo terminó una pasada (solo propone). */
export function parseDream(raw: unknown): ProtocolDreamResult | null {
  const parsed = RESULTS['memory.dream'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** M19 fase 5 — `memory.applyProposal`: `applied: false` con el motivo si ya no se puede. */
export function parseApplied(raw: unknown): { applied: boolean; message: string } | null {
  const parsed = RESULTS['memory.applyProposal'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** M19 fase 5 — `memory.rejectProposal`. */
export function parseRejected(raw: unknown): { rejected: boolean; message: string } | null {
  const parsed = RESULTS['memory.rejectProposal'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** `memory.changes`: lo que el agente corrigió o retiró de su memoria (el más reciente primero). */
export function parseMemoryChanges(raw: unknown): ProtocolMemoryChange[] | null {
  const parsed = RESULTS['memory.changes'].safeParse(raw);
  return parsed.success ? parsed.data.changes : null;
}

/** `memory.undoChange`: `undone: false` con el motivo si ya no se puede (no es un error). */
export function parseUndone(raw: unknown): { undone: boolean; message: string } | null {
  const parsed = RESULTS['memory.undoChange'].safeParse(raw);
  return parsed.success ? parsed.data : null;
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

/** M20 — `connectors.list`: el catálogo con su estado y el de la caja de conectores. */
export function parseConnectorsList(raw: unknown): ProtocolConnectorsList | null {
  const parsed = RESULTS['connectors.list'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** M20 — `connectors.enable|disable`: el conector tal como quedó y si cambió algo (`false`: ya estaba así). */
export function parseConnectorChange(raw: unknown): { connector: ProtocolConnector; changed: boolean } | null {
  const parsed = RESULTS['connectors.disable'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}
