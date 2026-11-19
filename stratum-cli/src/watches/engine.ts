/**
 * M22 — la máquina de estados de un vigilante. Pura: recibe el estado guardado,
 * lo que dio la comprobación y la hora, y devuelve el estado nuevo y, si toca,
 * qué aviso dar. Quien la llama (el `WatchScheduler`) guarda y avisa.
 *
 * Reglas (PRD de Dot §23.11, M22 parte 1):
 *  - salta solo **en el flanco**: de falsa a verdadera, sostenida `forMinutes`;
 *    luego espera a que vuelva a ser falsa (`firing`). Un vigilante nuevo parte
 *    de falsa: si ya se cumple al crearlo, salta;
 *  - entre dos saltos, un descanso mínimo (`cooldownMinutes`); si se cumple
 *    durante el descanso, salta al acabar este si sigue cumpliéndose;
 *  - `changes` compara con el último estado visto (`reference`): el primero solo
 *    lo anota, y cada salto lo actualiza;
 *  - un valor que no se puede saber (umbral sin `valor`) no cambia nada;
 *  - un fallo de la comprobación nunca salta; tras `failuresBeforeNotice`
 *    seguidos se avisa una vez de que no puede mirar;
 *  - suspendido (sin caja, conector apagado o sin configurar) se avisa una vez,
 *    y la cuenta de «durante N minutos» vuelve a empezar.
 */
import { WATCH_LIMITS } from '../protocol/index.js';
import type { CheckResult } from '../connectors/checks.js';
import { conditionHolds, type WatchCondition } from './condition.js';

const MINUTE_MS = 60_000;

/** Lo que se guarda de cada vigilante entre evaluaciones (y entre reinicios). */
export interface WatchState {
  /** Saltó y la condición sigue cumpliéndose. */
  firing: boolean;
  /** Desde cuándo se cumple sin haber saltado aún. */
  pendingSince: number | null;
  /** `changes`: el último estado aceptado. */
  reference: string | null;
  lastFiredAt: number | null;
  /** Fallos seguidos de la comprobación. */
  failures: number;
  failingNotified: boolean;
  suspendedNotified: boolean;
}

export const INITIAL_WATCH_STATE: WatchState = {
  firing: false,
  pendingSince: null,
  reference: null,
  lastFiredAt: null,
  failures: 0,
  failingNotified: false,
  suspendedNotified: false,
};

/** Lo que el engine necesita del vigilante. */
export interface WatchRule {
  condition: WatchCondition;
  cooldownMinutes: number;
  notifyResolved: boolean;
}

export type WatchInput =
  | { kind: 'result'; result: CheckResult }
  | { kind: 'failure'; reason: string }
  | { kind: 'suspended'; reason: string };

export type WatchNoticeKind = 'fired' | 'resolved' | 'failing' | 'suspended';

export interface WatchStep {
  state: WatchState;
  notice: WatchNoticeKind | null;
}

/**
 * Al arrancar el daemon: lo que pasó con él apagado no se recupera. Se conserva
 * si estaba saltado (para no repetir el aviso) y la referencia, pero la cuenta
 * de «durante N minutos» empieza de nuevo y los fallos se olvidan.
 */
export function stateAfterRestart(state: WatchState): WatchState {
  return { ...state, pendingSince: null, failures: 0 };
}

function cooldownOver(rule: WatchRule, state: WatchState, now: number): boolean {
  return state.lastFiredAt === null || now - state.lastFiredAt >= rule.cooldownMinutes * MINUTE_MS;
}

function heldLongEnough(rule: WatchRule, since: number, now: number): boolean {
  return now - since >= (rule.condition.forMinutes ?? 0) * MINUTE_MS;
}

export function stepWatch(
  rule: WatchRule,
  prev: WatchState,
  input: WatchInput,
  now: number,
): WatchStep {
  if (input.kind === 'suspended') {
    const state: WatchState = { ...prev, pendingSince: null, failures: 0 };
    if (prev.suspendedNotified) return { state, notice: null };
    return { state: { ...state, suspendedNotified: true }, notice: 'suspended' };
  }
  if (input.kind === 'failure') {
    const state: WatchState = {
      ...prev,
      suspendedNotified: false,
      failures: prev.failures + 1,
    };
    if (!prev.failingNotified && state.failures >= WATCH_LIMITS.failuresBeforeNotice) {
      return { state: { ...state, failingNotified: true }, notice: 'failing' };
    }
    return { state, notice: null };
  }

  const { result } = input;
  const base: WatchState = {
    ...prev,
    failures: 0,
    failingNotified: false,
    suspendedNotified: false,
  };
  const { condition } = rule;

  if (condition.kind === 'changes') {
    if (base.reference === null) {
      return { state: { ...base, reference: result.estado, pendingSince: null }, notice: null };
    }
    if (result.estado === base.reference) {
      return { state: { ...base, pendingSince: null }, notice: null };
    }
    const since = base.pendingSince ?? now;
    if (heldLongEnough(rule, since, now) && cooldownOver(rule, base, now)) {
      return {
        state: { ...base, reference: result.estado, pendingSince: null, lastFiredAt: now },
        notice: 'fired',
      };
    }
    return { state: { ...base, pendingSince: since }, notice: null };
  }

  const holds = conditionHolds(condition, result);
  if (holds === null) return { state: base, notice: null };
  if (!holds) {
    const state: WatchState = { ...base, pendingSince: null, firing: false };
    return { state, notice: base.firing && rule.notifyResolved ? 'resolved' : null };
  }
  if (base.firing) return { state: { ...base, pendingSince: null }, notice: null };
  const since = base.pendingSince ?? now;
  if (heldLongEnough(rule, since, now) && cooldownOver(rule, base, now)) {
    return {
      state: { ...base, firing: true, pendingSince: null, lastFiredAt: now },
      notice: 'fired',
    };
  }
  return { state: { ...base, pendingSince: since }, notice: null };
}
