/**
 * Traspaso de una sesión viva al daemon (M10), del lado de los anfitriones:
 * qué se captura del agente en el par, cómo se rehidrata en el daemon y cómo
 * deja el par de empezar trabajo mientras dura.
 *
 * Solo se traspasa una sesión **parada y sin nada del proceso par en vuelo**:
 * un turno (aunque esté en pausa o esperando una aprobación: lo pendiente es
 * una promesa de este proceso), un job (un proceso de este proceso), un aviso
 * o un mensaje que el agente aún no ha visto, o trabajo auxiliar en vuelo. En
 * esos casos no se finge una migración: se rechaza con el motivo.
 *
 * Lo que se lleva es el **contexto lógico** del agente —su historial, system
 * prompt incluido, y los ajustes de la sesión—, con la misma rehidratación que
 * ya usa una sesión reanudada (`StratumAgentOptions.initialMessages`): lista de
 * tareas y evidencia de TDD salen del historial. No se lleva lo que es del
 * proceso: el entorno del terminal, la config cargada, claves, la política
 * destructiva ni la autoridad de aprobar, conexiones SSH o servers MCP. El
 * daemon monta los suyos.
 */
import { ASSISTANT_AGENT } from '../agent/presets.js';
import type { StratumAgent, StratumAgentOptions } from '../agent/core.js';
import { fromStoredMessage, toStoredMessage } from '../conversation/messages.js';
import {
  HANDOFF_FORMAT,
  type HandoffBlocker,
  type ProtocolHandoffContext,
} from '../protocol/index.js';
import type { PendingInteractions } from './interactions.js';

/** Lo que hace falta de una sesión para capturarla. */
export interface HandoffSource {
  readonly sessionId: string;
  readonly agent: StratumAgent;
  readonly env: { readonly cwd: string };
  readonly interactions?: PendingInteractions;
}

export interface HandoffRefusal {
  ok: false;
  code: 'BUSY' | 'NOT_TRANSFERABLE';
  reason: HandoffBlocker;
  message: string;
}

export type HandoffCapture = { ok: true; context: ProtocolHandoffContext } | HandoffRefusal;

export function refuse(
  code: HandoffRefusal['code'],
  reason: HandoffBlocker,
  message: string,
): HandoffRefusal {
  return { ok: false, code, reason, message };
}

/** ¿Hay algo del proceso par que impide traspasar ahora? `null` si nada. */
export function handoffBlocker(source: HandoffSource): HandoffRefusal | null {
  const { agent } = source;
  if (agent.pause.state !== 'idle' || (source.interactions?.size ?? 0) > 0) {
    return refuse('BUSY', 'run-active', 'The session has a run in progress.');
  }
  if ((agent.jobs?.runningCount ?? 0) > 0) {
    return refuse(
      'NOT_TRANSFERABLE',
      'jobs-running',
      'A background job is running in this process; wait for it or cancel it first.',
    );
  }
  if (agent.inbox.hasPendingUserMessages() || agent.jobs?.hasNotifications('main')) {
    return refuse(
      'NOT_TRANSFERABLE',
      'inbox-pending',
      'The agent has updates it has not seen yet; send a turn first.',
    );
  }
  if (agent.hasBackgroundWork) {
    return refuse(
      'NOT_TRANSFERABLE',
      'background-work',
      'Background work (memory extraction) is still running; try again in a moment.',
    );
  }
  return null;
}

/**
 * Captura el contexto de la sesión para traspasarla, o dice por qué no se
 * puede. Síncrono: entre comprobar y capturar no cabe un turno.
 */
export function captureHandoff(source: HandoffSource): HandoffCapture {
  const blocked = handoffBlocker(source);
  if (blocked) return blocked;
  const { agent } = source;
  const tokens = agent.getTokenUsage();
  return {
    ok: true,
    context: {
      format: HANDOFF_FORMAT,
      sessionId: source.sessionId,
      cwd: source.env.cwd,
      provider: agent.providerName,
      model: agent.model,
      // El asistente (M12) viaja como su nombre: el daemon lo monta con su preset.
      agent:
        agent.promptPreset === 'assistant'
          ? ASSISTANT_AGENT
          : (agent.getActiveProfile()?.name ?? null),
      readOnly: agent.isReadOnly(),
      sessionProfile: agent.getSessionProfileRequest(),
      planRef: agent.getPlanRef(),
      usage: {
        toolCalls: agent.toolCallCount,
        tokens: tokens.status === 'reported' ? (tokens.tokens ?? 0) : null,
        tokenStatus: tokens.status,
      },
      messages: agent.getMessages().map(toStoredMessage),
    },
  };
}

/**
 * Las opciones del agente que continúa la sesión en el daemon: el mismo camino
 * que una sesión reanudada. El perfil principal se reaplica (si ya no vale, el
 * agente sigue con el de por defecto y lo avisa en `takeResumeNotice()`).
 */
export function handoffAgentOptions(
  context: ProtocolHandoffContext,
): Omit<StratumAgentOptions, 'env'> {
  return {
    initialMessages: context.messages.map(fromStoredMessage),
    readOnly: context.readOnly,
    sessionProfile: context.sessionProfile,
    // `assistant` no es un perfil que se active: es el preset con el que se monta.
    ...(context.agent && context.agent !== ASSISTANT_AGENT ? { activeAgent: context.agent } : {}),
    ...(context.planRef ? { planRef: context.planRef } : {}),
    usage: {
      toolCalls: context.usage.toolCalls,
      tokens: context.usage.tokens,
      tokenStatus: context.usage.tokenStatus,
    },
  };
}

// ---------------------------------------------------------------------------
// Propiedad de la sesión en el anfitrión par
// ---------------------------------------------------------------------------

/**
 * Una sesión lista para traspasarse: ya no empieza trabajo nuevo, y este es su
 * contexto. `settle` se llama una vez con el desenlace: `committed` (el daemon
 * es su anfitrión) o `kept` (sigue siéndolo este proceso, y vuelve a trabajar).
 */
export type HandoffPreparation =
  | {
      ok: true;
      context: ProtocolHandoffContext;
      /** Lo que deba quedar en disco antes de soltar la sesión (la traza). */
      flush?: () => Promise<void>;
      settle(outcome: 'committed' | 'kept'): void;
    }
  | HandoffRefusal;

/**
 * `PeerHostControl.prepareHandoff` de un anfitrión par: cierra la puerta de
 * turnos (`ownership`) y captura el contexto, en un solo paso síncrono. Si la
 * sesión no se puede soltar, la puerta vuelve a abrirse y se dice por qué.
 */
export function prepareHandoff(
  source: HandoffSource,
  ownership: SessionOwnership,
  flush?: () => Promise<void>,
): HandoffPreparation {
  if (ownership.state === 'detaching') {
    return refuse('BUSY', 'handoff-in-progress', 'The session is already being handed off.');
  }
  if (!ownership.beginHandoff()) {
    return refuse('BUSY', 'run-active', 'The session has a run in progress.');
  }
  const captured = captureHandoff(source);
  if (!captured.ok) {
    ownership.abortHandoff();
    return captured;
  }
  return {
    ok: true,
    context: captured.context,
    ...(flush ? { flush } : {}),
    settle: (outcome) => {
      if (outcome === 'committed') ownership.completeHandoff();
      else ownership.abortHandoff();
    },
  };
}

/**
 * `owner` → `detaching` → `handed-off` (o de vuelta a `owner` si el traspaso
 * no se hizo). Mientras no es `owner`, la sesión no empieza turnos.
 */
export type OwnershipState = 'owner' | 'detaching' | 'handed-off';

/**
 * La propiedad de una sesión en su anfitrión par, y la puerta de sus turnos.
 * Empezar un turno y empezar un traspaso son **comprobar y cambiar**, síncronos
 * y aquí: o hay un turno en curso y el traspaso se rechaza, o hay un traspaso y
 * el turno no empieza. `handed-off` es definitivo.
 */
export class SessionOwnership {
  private current: OwnershipState = 'owner';
  private turns = 0;
  private readonly listeners = new Set<(state: OwnershipState) => void>();

  get state(): OwnershipState {
    return this.current;
  }

  get turnsInFlight(): number {
    return this.turns;
  }

  /**
   * Abre un turno si la sesión es de este proceso. Devuelve con qué cerrarlo,
   * o `null` si no se puede empezar.
   */
  tryBeginTurn(): (() => void) | null {
    if (this.current !== 'owner') return null;
    this.turns++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.turns--;
    };
  }

  /** Empieza un traspaso: solo sin turnos en curso. */
  beginHandoff(): boolean {
    if (this.current !== 'owner' || this.turns > 0) return false;
    this.set('detaching');
    return true;
  }

  /** El traspaso no se hizo: la sesión sigue siendo de este proceso. */
  abortHandoff(): void {
    if (this.current === 'detaching') this.set('owner');
  }

  /** El daemon es ya su anfitrión. Definitivo. */
  completeHandoff(): void {
    if (this.current !== 'handed-off') this.set('handed-off');
  }

  subscribe(listener: (state: OwnershipState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: OwnershipState): void {
    this.current = state;
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch {
        /* quien escucha no puede impedir el cambio */
      }
    }
  }
}
