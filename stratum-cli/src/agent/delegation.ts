/**
 * Hito 15 — Primitiva de delegación extraída de `ReactLoop.runDelegations`
 * (Hito 8C). Hasta ahora solo el loop la usaba, al interceptar los
 * `delegate_task` del modelo; la invocación directa del usuario (`@perfil`,
 * `stratum run --delegate`) necesita exactamente la misma maquinaria —
 * semáforo, eventos en tiempo real, mutex de confirmaciones, persistencia y
 * detección de conflictos — sin pasar por un turno del LLM.
 *
 * Lo que queda fuera a propósito: resolver qué perfiles pidió el modelo y
 * escribir los tool results en el historial. Eso depende de quién delega (el
 * loop inyecta en orden de tool calls; `StratumAgent.runDelegate` monta además
 * el par sintético), así que lo hace cada llamante con el `Map` de resultados.
 */
import type { StratumConfig } from '../config/schema.js';
import type {
  AgentEvent,
  AgentProfile,
  ConfirmRequest,
  DestructiveDecision,
  RunOptions,
  SubagentResult,
} from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ProfileLoader } from './profiles.js';
import { isDelegable } from './profiles.js';
import { runSubagent } from './subagent.js';
import { Semaphore, Mutex } from './concurrency.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent').child('subagent');

export interface DelegationJob {
  /** Id de la tool call que originó la delegación (real o sintética). */
  callId: string;
  profile: AgentProfile;
  taskText: string;
  context?: string[];
  subId: string;
}

export interface DelegationContext {
  registry: ToolRegistry;
  config: StratumConfig;
  signal: AbortSignal;
  opts?: RunOptions;
  /** Índice `# Skills` del padre, heredado sin redescubrir (Hito 12). */
  skillsBlock?: string;
}

export type ProfileResolution =
  | { ok: true; profile: AgentProfile }
  | { ok: false; error: string; hint: string };

/**
 * Resuelve el perfil de una delegación. Un perfil `primary` existe pero no se
 * puede delegar: se distingue de «no existe» porque el arreglo es distinto.
 */
export function resolveDelegationProfile(
  profiles: ProfileLoader | undefined,
  name: string,
): ProfileResolution {
  const available = profiles?.delegable().map((p) => p.name) ?? ['general'];
  const profile = profiles?.resolve(name);
  if (!profile) {
    return {
      ok: false,
      error: `unknown profile '${name}'; available: ${available.join(', ')}`,
      hint: 'Use one of the available profiles, or "general".',
    };
  }
  if (!isDelegable(profile)) {
    return {
      ok: false,
      error:
        `profile '${name}' is primary-only (mode: primary) and cannot be delegated; ` +
        `available: ${available.join(', ')}`,
      hint: 'Delegate to one of the available subagent profiles instead.',
    };
  }
  return { ok: true, profile };
}

/**
 * Ejecuta las delegaciones y devuelve sus resultados por `subId`. Paralelas
 * acotadas por `agents.maxConcurrency` (con 1 degrada a secuencial). Los
 * eventos del hijo se re-emiten envueltos (`subagent_event`) en tiempo real
 * vía una cola fan-in; las confirmaciones destructivas de los hijos se
 * serializan contra la TTY única del padre. Al terminar: detección best-effort
 * de conflictos de fichero → `warning`.
 */
export async function* executeDelegations(
  jobs: DelegationJob[],
  ctx: DelegationContext,
): AsyncGenerator<AgentEvent, Map<string, SubagentResult>> {
  const results = new Map<string, SubagentResult>();
  if (jobs.length === 0) return results;

  const { opts, signal } = ctx;

  // Concurrencia estructurada: los hijos cuelgan de un signal propio. Si quien
  // consume este generador lo abandona, el finally aborta a los hijos y espera
  // a que terminen — un subagente huérfano seguiría escribiendo ficheros
  // mientras el historial ya lo da por cancelado.
  const internal = new AbortController();
  const onParentAbort = (): void => internal.abort();
  if (signal.aborted) internal.abort();
  else signal.addEventListener('abort', onParentAbort, { once: true });
  const childSignal = internal.signal;
  let markAllDone!: () => void;
  const allDone = new Promise<void>((resolve) => {
    markAllDone = resolve;
  });

  // --- Infraestructura de concurrencia (§12.16). ---
  const maxConcurrency = Math.max(1, ctx.config.agents.maxConcurrency);
  const sem = new Semaphore(maxConcurrency);
  // Mutex compartido: nunca dos prompts destructivos simultáneos sobre la TTY
  // única del padre (igual que el ToolDispatcher serializa su fase de confirmación).
  const confirmMutex = new Mutex();
  const parentConfirm = opts?.onConfirmDestructive;
  const wrappedConfirm: ((req: ConfirmRequest) => Promise<DestructiveDecision>) | undefined =
    parentConfirm ? (req) => confirmMutex.runExclusive(() => parentConfirm(req)) : undefined;
  const parentPolicy =
    opts?.destructivePolicy ?? (opts?.allowDestructive === true ? 'allow' : 'ask');

  log.info('delegations start', { count: jobs.length, maxConcurrency });

  // --- Cola fan-in: los hijos empujan eventos; este generador los drena. ---
  const events: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  const push = (ev: AgentEvent): void => {
    events.push(ev);
    notify();
  };

  let remaining = jobs.length;

  // --- Lanzar todos los trabajos (el semáforo limita los vivos a N). ---
  for (const job of jobs) {
    void (async () => {
      const release = await sem.acquire();
      try {
        if (childSignal.aborted) {
          results.set(job.subId, {
            id: job.subId,
            status: 'cancelled',
            summary: '',
            filesChanged: [],
            usage: { iterations: 0, durationMs: 0 },
            error: 'Subagent was cancelled.',
          });
          return;
        }
        // Emitir started + persistir `running` al adquirir el slot (no antes):
        // el árbol muestra así qué subagentes están en cola vs. en ejecución.
        push({
          type: 'subagent_started',
          subagentId: job.subId,
          profile: job.profile.name,
          task: job.taskText,
        });
        opts?.onSubagentPersist?.({
          id: job.subId,
          profile: job.profile.name,
          task: job.taskText,
        });

        let result: SubagentResult;
        try {
          result = await runSubagent({
            task: {
              id: job.subId,
              task: job.taskText,
              profile: job.profile.name,
              context: job.context,
              budget: job.profile.budget,
            },
            profile: job.profile,
            registry: ctx.registry,
            config: ctx.config,
            parentSignal: childSignal,
            parentDestructivePolicy: parentPolicy,
            sessionId: opts?.sessionId,
            onConfirmDestructive: wrappedConfirm,
            makeRouter: opts?.makeSubagentRouter
              ? () => opts.makeSubagentRouter!(job.profile)
              : undefined,
            onEvent: (ev) => push({ type: 'subagent_event', subagentId: job.subId, event: ev }),
            skillsBlock: ctx.skillsBlock,
          });
        } catch (err) {
          // runSubagent no debería lanzar (captura internamente); red de seguridad.
          result = {
            id: job.subId,
            status: 'failed',
            summary: '',
            filesChanged: [],
            usage: { iterations: 0, durationMs: 0 },
            error: err instanceof Error ? err.message : String(err),
          };
        }
        results.set(job.subId, result);
        opts?.onSubagentPersist?.({
          id: job.subId,
          profile: job.profile.name,
          task: job.taskText,
          result,
        });
        push({ type: 'subagent_completed', subagentId: job.subId, result });
      } finally {
        release();
        remaining--;
        if (remaining === 0) markAllDone();
        notify();
      }
    })();
  }

  // --- Drenar la cola en tiempo real hasta que todos los hijos terminen. ---
  try {
    while (remaining > 0 || events.length > 0) {
      while (events.length > 0) {
        yield events.shift()!;
      }
      if (remaining === 0) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        // Re-chequeo anti lost-wakeup: si algo llegó entre el while y este punto.
        if (events.length > 0 || remaining === 0) notify();
      });
    }
  } finally {
    signal.removeEventListener('abort', onParentAbort);
    if (remaining > 0) {
      log.info('delegations abandoned, aborting children', { remaining });
      internal.abort();
      await allDone;
    }
  }

  // --- Detección de conflictos de fichero (best-effort, §12.16). ---
  const pathOwners = new Map<string, Set<string>>();
  for (const [subId, result] of results) {
    for (const f of result.filesChanged) {
      let owners = pathOwners.get(f.path);
      if (!owners) {
        owners = new Set();
        pathOwners.set(f.path, owners);
      }
      owners.add(subId);
    }
  }
  const conflicts = [...pathOwners.entries()].filter(([, owners]) => owners.size > 1);
  if (conflicts.length > 0) {
    const detail = conflicts
      .map(([path, owners]) => `${path} (${[...owners].join(', ')})`)
      .join('; ');
    log.warn('file conflict detected', { files: conflicts.map(([p]) => p) });
    yield {
      type: 'warning',
      message:
        `subagent_file_conflict: ${conflicts.length} fichero(s) escritos por más de un ` +
        `subagente en paralelo: ${detail}. No se intentó fusionar; revisa el resultado.`,
    };
  }

  return results;
}
