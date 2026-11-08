/**
 * Lo que devuelven las llamadas. El lado nativo lo pasa **sin interpretar**;
 * aquí se valida con los schemas del contrato, igual que una foto o un
 * evento. Lo que no valida no se usa (`null`).
 */
import {
  RESULTS,
  classifyEvent,
  parseOverviewSnapshot,
  parseSessionSnapshot,
} from '../../../stratum-cli/src/protocol/schemas';
import type {
  ProtocolContextReport,
  ProtocolDecision,
  ProtocolHistoryPage,
  ProtocolModel,
  ProtocolRun,
  ProtocolSession,
  ProtocolSessionMemory,
  ProtocolSkill,
} from './index';

export { classifyEvent, parseOverviewSnapshot, parseSessionSnapshot };

export function parseOpenedSession(raw: unknown): ProtocolSession | null {
  const parsed = RESULTS['sessions.open'].safeParse(raw);
  return parsed.success ? parsed.data.session : null;
}

export function parseStartedRun(raw: unknown): ProtocolRun | null {
  const parsed = RESULTS['runs.start'].safeParse(raw);
  return parsed.success ? parsed.data.run : null;
}

export interface ModelList {
  models: ProtocolModel[];
  /** Algún provider no contestó: la lista puede estar incompleta. */
  incomplete: boolean;
}

export function parseModels(raw: unknown): ModelList | null {
  const parsed = RESULTS['models.list'].safeParse(raw);
  return parsed.success
    ? { models: parsed.data.models, incomplete: parsed.data.error !== undefined }
    : null;
}

export function parseSetModel(raw: unknown): ProtocolSession | null {
  const parsed = RESULTS['sessions.setModel'].safeParse(raw);
  return parsed.success ? parsed.data.session : null;
}

export function parseHistoryPage(raw: unknown): ProtocolHistoryPage | null {
  const parsed = RESULTS['sessions.history'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseContextReport(raw: unknown): ProtocolContextReport | null {
  const parsed = RESULTS['sessions.context'].safeParse(raw);
  return parsed.success ? parsed.data.report : null;
}

export function parseSessionMemory(raw: unknown): ProtocolSessionMemory | null {
  const parsed = RESULTS['sessions.memory'].safeParse(raw);
  return parsed.success ? parsed.data.memory : null;
}

export function parseSkills(raw: unknown): ProtocolSkill[] | null {
  const parsed = RESULTS['skills.list'].safeParse(raw);
  return parsed.success ? parsed.data.skills : null;
}

/** `memory.decisions`: lo que recuerda el asistente (las últimas, o la búsqueda). */
export function parseDecisions(raw: unknown): ProtocolDecision[] | null {
  const parsed = RESULTS['memory.decisions'].safeParse(raw);
  return parsed.success ? parsed.data.decisions : null;
}

/** `memory.forget`: `removed: false` si ya no estaba (no es un error). */
export function parseForget(raw: unknown): boolean | null {
  const parsed = RESULTS['memory.forget'].safeParse(raw);
  return parsed.success ? parsed.data.removed : null;
}

/** M19 — `memory.reclassify`: `updated: false` si ya no estaba (no es un error). */
export function parseMoved(raw: unknown): boolean | null {
  const parsed = RESULTS['memory.reclassify'].safeParse(raw);
  return parsed.success ? parsed.data.updated : null;
}
