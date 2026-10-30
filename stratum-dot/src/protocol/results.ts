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
  ProtocolModel,
  ProtocolRun,
  ProtocolSession,
} from './index';

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
