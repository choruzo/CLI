import { useCallback, useEffect, useReducer, useRef } from 'react';
import { reloadSidecar, subscribeSidecarFrames } from '../ipc/bridge';
import type { ConfigApplied, ConfigIssue, ConfigSnapshot, SidecarFrame } from '../ipc/types';
import { configApplied, configIssues, configSnapshot, isRecord } from '../ipc/validate';
import { post } from './useAgentStream';

/**
 * Ajustes (D5, 15.7). El `.stratumrc.json` global lo lee, valida y escribe el
 * sidecar; aquí vive el borrador y la concurrencia optimista:
 *
 * - se guarda sobre el `hash` leído: si el fichero cambió en disco (la CLI,
 *   otro editor), el sidecar no lo pisa y responde `config_conflict`;
 * - un cambio externo sin cambios locales se recarga solo; con cambios sin
 *   guardar, se pregunta («Descartar los míos» / «Mantener los míos»);
 * - el borrador se valida en vivo contra el schema (debounce), así un JSON
 *   inválido se marca antes de guardar.
 */

export interface ConfigState {
  loaded: boolean;
  snapshot: ConfigSnapshot | null;
  applied: ConfigApplied | null;
  defaults: Record<string, unknown>;
  /** Texto que se edita (con `SECRET_PLACEHOLDER` en los secretos). */
  draft: string;
  /** Texto de la versión sobre la que se edita: `draft !== baseText` = cambios sin guardar. */
  baseText: string;
  /** Hash de esa versión; es el que se manda al guardar. */
  baseHash: string | null;
  issues: ConfigIssue[];
  /** El borrador cambió desde la última validación recibida. */
  validating: boolean;
  saving: boolean;
  /** El guardado se rechazó porque el fichero había cambiado en disco. */
  conflict: ConfigSnapshot | null;
  /** Cambió en disco mientras había cambios sin guardar. */
  external: ConfigSnapshot | null;
  notice: string | null;
  error: string | null;
}

export const initialConfigState: ConfigState = {
  loaded: false,
  snapshot: null,
  applied: null,
  defaults: {},
  draft: '',
  baseText: '',
  baseHash: null,
  issues: [],
  validating: false,
  saving: false,
  conflict: null,
  external: null,
  notice: null,
  error: null,
};

export type ConfigAction =
  | {
      type: 'state';
      reason: 'requested' | 'saved' | 'external';
      snapshot: ConfigSnapshot;
      applied: ConfigApplied | null;
      defaults: Record<string, unknown> | null;
    }
  | { type: 'edit'; text: string }
  | { type: 'validation'; issues: ConfigIssue[] }
  | { type: 'saving' }
  | { type: 'conflict'; snapshot: ConfigSnapshot }
  | { type: 'invalid'; issues: ConfigIssue[] }
  | { type: 'error'; message: string }
  | { type: 'take_disk'; snapshot: ConfigSnapshot }
  | { type: 'keep_mine' }
  | { type: 'discard' }
  | { type: 'dismiss_notice' }
  | { type: 'reset' };

export const isDirty = (s: ConfigState): boolean => s.draft !== s.baseText;

/** Adopta la versión de disco como base y como borrador. */
function adopt(state: ConfigState, snapshot: ConfigSnapshot): ConfigState {
  return {
    ...state,
    loaded: true,
    snapshot,
    draft: snapshot.text,
    baseText: snapshot.text,
    baseHash: snapshot.hash,
    conflict: null,
    external: null,
    // La validación del texto nuevo llega enseguida (debounce).
    issues: [],
    validating: true,
  };
}

export function configReducer(state: ConfigState, action: ConfigAction): ConfigState {
  switch (action.type) {
    case 'state': {
      const withApplied = {
        ...state,
        applied: action.applied ?? state.applied,
        defaults: action.defaults ?? state.defaults,
      };
      if (action.reason === 'saved') {
        return { ...adopt(withApplied, action.snapshot), saving: false, notice: 'Guardado.' };
      }
      if (!state.loaded || !isDirty(state)) {
        const next = adopt(withApplied, action.snapshot);
        return action.reason === 'external' && state.loaded
          ? {
              ...next,
              notice: 'La configuración cambió fuera de la app (CLI u otro editor) y se ha recargado.',
            }
          : next;
      }
      // Hay cambios sin guardar: no se pisan.
      if (action.reason === 'external' && action.snapshot.hash !== state.baseHash) {
        return { ...withApplied, external: action.snapshot };
      }
      return withApplied;
    }
    case 'edit':
      return {
        ...state,
        draft: action.text,
        validating: true,
        notice: null,
        error: null,
      };
    case 'validation':
      return { ...state, issues: action.issues, validating: false };
    case 'saving':
      return { ...state, saving: true, error: null, notice: null };
    case 'conflict':
      return { ...state, saving: false, conflict: action.snapshot, external: null };
    case 'invalid':
      return { ...state, saving: false, issues: action.issues, validating: false };
    case 'error':
      return { ...state, saving: false, error: action.message };
    case 'take_disk':
      return adopt(state, action.snapshot);
    case 'keep_mine': {
      // Se sigue editando sobre la versión nueva: guardar la sustituirá, que es
      // justo lo que se eligió.
      const other = state.external ?? state.conflict;
      if (!other) return state;
      return {
        ...state,
        snapshot: other,
        baseText: other.text,
        baseHash: other.hash,
        external: null,
        conflict: null,
      };
    }
    case 'discard':
      return state.snapshot ? adopt(state, state.snapshot) : state;
    case 'dismiss_notice':
      return { ...state, notice: null };
    case 'reset':
      return initialConfigState;
  }
}

export interface ProbeResult {
  requestId: string;
  models: string[];
  error?: string;
}

export interface WorkspacesUsage {
  root: string;
  totalBytes: number;
  active: { count: number; bytes: number };
  archived: { count: number; bytes: number };
  purged: { count: number };
}

export interface RetentionReport {
  archived: number;
  purged: number;
  inUse: number;
  failed: number;
  disabled: boolean;
}

export interface Config extends ConfigState {
  dirty: boolean;
  load: () => void;
  edit: (text: string) => void;
  save: (opts?: { force?: boolean; text?: string }) => void;
  discard: () => void;
  takeDisk: () => void;
  keepMine: () => void;
  dismissNotice: () => void;
  /** Sondea `/models` de un endpoint; la respuesta llega a `onProbe`. */
  probe: (req: { baseUrl: string; apiKey?: string; provider?: string }) => string;
  probeResult: (requestId: string) => ProbeResult | null;
  usage: WorkspacesUsage | null;
  refreshUsage: () => void;
  retention: { running: boolean; report: RetentionReport | null };
  runRetention: () => void;
  restartAgent: () => void;
}

const VALIDATE_DEBOUNCE_MS = 300;

export function useConfig(enabled: boolean): Config {
  const [state, dispatch] = useReducer(configReducer, initialConfigState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const validationSeq = useRef(0);
  const probes = useRef(new Map<string, ProbeResult>());
  const [, forceProbe] = useReducer((n: number) => n + 1, 0);
  const usageRef = useRef<WorkspacesUsage | null>(null);
  const [retention, setRetention] = useReducer(
    (_: Config['retention'], next: Config['retention']) => next,
    { running: false, report: null },
  );

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const onFrame = (frame: SidecarFrame) => {
      if (disposed) return;
      const f = frame as unknown as Record<string, unknown>;
      if (!isRecord(f)) return;
      switch (f.type) {
        case 'config_state': {
          const snapshot = configSnapshot(f.snapshot);
          if (!snapshot) return;
          const reason =
            f.reason === 'saved' || f.reason === 'external' ? f.reason : ('requested' as const);
          dispatch({
            type: 'state',
            reason,
            snapshot,
            applied: configApplied(f.applied),
            defaults: isRecord(f.defaults) ? f.defaults : null,
          });
          return;
        }
        case 'config_validation': {
          if (f.requestId !== `v${validationSeq.current}`) return; // una respuesta vieja
          dispatch({ type: 'validation', issues: configIssues(f.issues) ?? [] });
          return;
        }
        case 'config_conflict': {
          const snapshot = configSnapshot(f.snapshot);
          if (snapshot) dispatch({ type: 'conflict', snapshot });
          return;
        }
        case 'config_invalid':
          dispatch({ type: 'invalid', issues: configIssues(f.issues) ?? [] });
          return;
        case 'config_error':
          if (typeof f.message === 'string') dispatch({ type: 'error', message: f.message });
          return;
        case 'provider_probe_result':
          if (typeof f.requestId === 'string') {
            probes.current.set(f.requestId, {
              requestId: f.requestId,
              models: Array.isArray(f.models)
                ? f.models.filter((m): m is string => typeof m === 'string')
                : [],
              ...(typeof f.error === 'string' ? { error: f.error } : {}),
            });
            forceProbe();
          }
          return;
        case 'workspaces_usage': {
          const a = f.active;
          const ar = f.archived;
          const p = f.purged;
          if (
            typeof f.root === 'string' &&
            typeof f.totalBytes === 'number' &&
            isRecord(a) &&
            isRecord(ar) &&
            isRecord(p)
          ) {
            usageRef.current = {
              root: f.root,
              totalBytes: f.totalBytes,
              active: { count: Number(a.count) || 0, bytes: Number(a.bytes) || 0 },
              archived: { count: Number(ar.count) || 0, bytes: Number(ar.bytes) || 0 },
              purged: { count: Number(p.count) || 0 },
            };
            forceProbe();
          }
          return;
        }
        case 'retention_report':
          setRetention({
            running: false,
            report: {
              archived: Number(f.archived) || 0,
              purged: Number(f.purged) || 0,
              inUse: Number(f.inUse) || 0,
              failed: Number(f.failed) || 0,
              disabled: f.disabled === true,
            },
          });
          return;
      }
    };
    void subscribeSidecarFrames(onFrame).then((u) => {
      if (disposed) u();
      else unsubscribe = u;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const fail = useCallback((message: string) => dispatch({ type: 'error', message }), []);
  const load = useCallback(() => post({ type: 'config_get' }, fail), [fail]);
  const refreshUsage = useCallback(() => post({ type: 'workspaces_usage_get' }, fail), [fail]);

  // Al abrir Ajustes: la versión de disco y el uso de disco.
  useEffect(() => {
    if (!enabled) return;
    dispatch({ type: 'reset' });
    load();
    refreshUsage();
  }, [enabled, load, refreshUsage]);

  // Validación en vivo del borrador.
  const { draft, loaded } = state;
  useEffect(() => {
    if (!enabled || !loaded) return;
    const timer = setTimeout(() => {
      const requestId = `v${++validationSeq.current}`;
      post({ type: 'config_validate', requestId, text: draft }, fail);
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, loaded, draft, fail]);

  const edit = useCallback((text: string) => dispatch({ type: 'edit', text }), []);

  const save = useCallback(
    (opts: { force?: boolean; text?: string } = {}) => {
      const s = stateRef.current;
      const text = opts.text ?? s.draft;
      if (opts.text !== undefined) dispatch({ type: 'edit', text });
      dispatch({ type: 'saving' });
      post(
        {
          type: 'config_save',
          text,
          baseHash: opts.force ? (s.conflict?.hash ?? s.baseHash) : s.baseHash,
          ...(opts.force ? { force: true } : {}),
        },
        fail,
      );
    },
    [fail],
  );

  const probeSeq = useRef(0);
  const probe = useCallback(
    (req: { baseUrl: string; apiKey?: string; provider?: string }) => {
      const requestId = `p${++probeSeq.current}`;
      post({ type: 'provider_probe', requestId, ...req }, (message) => {
        probes.current.set(requestId, { requestId, models: [], error: message });
        forceProbe();
      });
      return requestId;
    },
    [],
  );
  const probeResult = useCallback((id: string) => probes.current.get(id) ?? null, []);

  const runRetention = useCallback(() => {
    setRetention({ running: true, report: null });
    post({ type: 'retention_run' }, (message) => {
      setRetention({ running: false, report: null });
      fail(message);
    });
  }, [fail]);

  const restartAgent = useCallback(() => {
    void reloadSidecar().catch((err) => fail(err instanceof Error ? err.message : String(err)));
  }, [fail]);

  return {
    ...state,
    dirty: isDirty(state),
    load,
    edit,
    save,
    discard: useCallback(() => dispatch({ type: 'discard' }), []),
    takeDisk: useCallback(() => {
      const other = stateRef.current.external ?? stateRef.current.conflict;
      if (other) dispatch({ type: 'take_disk', snapshot: other });
    }, []),
    keepMine: useCallback(() => dispatch({ type: 'keep_mine' }), []),
    dismissNotice: useCallback(() => dispatch({ type: 'dismiss_notice' }), []),
    probe,
    probeResult,
    usage: usageRef.current,
    refreshUsage,
    retention,
    runRetention,
    restartAgent,
  };
}
