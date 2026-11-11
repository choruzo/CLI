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
  ProtocolAgent,
  ProtocolBrowserScreen,
  ProtocolBrowserStatus,
  ProtocolChangesSummary,
  ProtocolSessionInspection,
  ProtocolContextReport,
  ProtocolFileDiff,
  ProtocolDecision,
  ProtocolDreamResult,
  ProtocolProposal,
  ProtocolHistoryPage,
  ProtocolModel,
  ProtocolRun,
  ProtocolSession,
  ProtocolRevertPlan,
  ProtocolSessionMemory,
  ProtocolSkill,
  RevertStatus,
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

/** Modo código — `agents.list`: los perfiles que se pueden elegir (el asistente, el primero). */
export function parseAgents(raw: unknown): ProtocolAgent[] | null {
  const parsed = RESULTS['agents.list'].safeParse(raw);
  return parsed.success ? parsed.data.agents : null;
}

/** Modo código — `sessions.inspect`: perfil de sesión, tools, MCP, plugins y entornos. */
export function parseInspection(raw: unknown): ProtocolSessionInspection | null {
  const parsed = RESULTS['sessions.inspect'].safeParse(raw);
  return parsed.success ? parsed.data.inspection : null;
}

/** Modo código — `git.changes`: el working tree del proyecto (`isRepo: false` si no es un repo). */
export function parseChanges(raw: unknown): ProtocolChangesSummary | null {
  const parsed = RESULTS['git.changes'].safeParse(raw);
  return parsed.success ? parsed.data.changes : null;
}

/**
 * Modo código — `browser.screen`: el estado del navegador del agente de la
 * sesión y su pestaña en JPEG (`screen: null` si no está abierto).
 */
export function parseBrowserView(
  raw: unknown,
): { browser: ProtocolBrowserStatus; screen: ProtocolBrowserScreen | null } | null {
  const parsed = RESULTS['browser.screen'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Modo código — `git.diff`: el diff de un fichero, ya redactado (`binary`: sin texto). */
export function parseDiff(raw: unknown): ProtocolFileDiff | null {
  const parsed = RESULTS['git.diff'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Modo código — `sessions.revert` (el plan o lo que se hizo). `planned`: era el
 * plan; `conflicts`: no se tocó nada; `nothing`: no había turnos que deshacer;
 * `failed`: falló a medias y `plan` dice lo que sí se deshizo.
 */
export function parseRevert(raw: unknown): { status: RevertStatus; plan: ProtocolRevertPlan | null } | null {
  const parsed = RESULTS['sessions.revert'].safeParse(raw);
  return parsed.success ? parsed.data : null;
}
