/**
 * Lo que devuelven las llamadas del chat. El lado nativo lo pasa **sin
 * interpretar**; aquí se valida con los schemas del contrato, igual que una
 * foto o un evento. Lo que no valida no se usa.
 */
import { RESULTS } from '../../../stratum-cli/src/protocol/schemas';
import type { ProtocolAgent, ProtocolModel, ProtocolRun, ProtocolSession } from './index';

export function parseOpenedSession(raw: unknown): ProtocolSession | null {
  const parsed = RESULTS['sessions.open'].safeParse(raw);
  return parsed.success ? parsed.data.session : null;
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
