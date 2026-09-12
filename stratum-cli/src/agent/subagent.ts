/**
 * Hito 8A — Subagente (§12.16). Un subagente es una instancia del MISMO ReactLoop
 * con contexto aislado, su propio ProviderRouter y el toolset restringido por un
 * perfil. No es una clase nueva ni un pipeline: misma filosofía que /init (Hito
 * 2.5) y plan (Hito 7). `runSubagent` lo lanza, lo ejecuta a término de forma
 * bloqueante y devuelve un SubagentResult compacto y truncado.
 */
import type { StratumConfig } from '../config/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  AgentEvent,
  AgentProfile,
  ConfirmRequest,
  DestructiveDecision,
  DestructivePolicy,
  Message,
  RunOptions,
  SubagentResult,
  SubagentRouter,
  SubagentStatus,
  SubagentTask,
} from './types.js';
import { ReactLoop } from './harness.js';
import { ProviderRouter } from '../providers/router.js';
import { buildSystemPrompt } from './system-prompt.js';
import { truncateToolOutput } from '../tools/truncate.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent.subagent');

/** Cap del resultado inyectado de vuelta al padre (reutiliza el cap de tool outputs). */
const RESULT_SUMMARY_CAP = 30_000;

export interface RunSubagentOptions {
  task: SubagentTask;
  profile: AgentProfile;
  registry: ToolRegistry;
  config: StratumConfig;
  /** Signal del padre; se encadena con el timeout del presupuesto (§12.12). */
  parentSignal: AbortSignal;
  /** Política destructiva del padre, usada si el perfil no define una propia. */
  parentDestructivePolicy?: DestructivePolicy;
  /**
   * Id de sesión del padre. El hijo lo hereda para que lo que escriba fuera de
   * la sesión (auditoría SSH, §12.14) se atribuya a la misma conversación.
   */
  sessionId?: string;
  /** Callback de confirmación del padre: el subagente nunca posee la TTY (§12.16). */
  onConfirmDestructive?: (req: ConfirmRequest) => Promise<DestructiveDecision>;
  /**
   * Factory del router del hijo. Si se omite, se construye un `ProviderRouter`
   * propio desde la config. Punto de inyección para tests.
   */
  makeRouter?: () => SubagentRouter;
  /**
   * Callback de eventos del loop hijo (Hito 8C). Cuando se pasa, `runSubagent`
   * lo invoca con CADA `AgentEvent` que emite el hijo, para que el orquestador
   * los re-emita envueltos como `subagent_event` (árbol vivo, inspector). El
   * `done` del hijo también se reporta. Best-effort: nunca debe lanzar.
   */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Bloque `# Skills` ya renderizado por el padre (Hito 12). El hijo no
   * redescubre skills: el índice se resuelve una vez por sesión y se hereda.
   */
  skillsBlock?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Genera un id de subagente: `sub_YYYYMMDD_HHMMSS_<rnd>`. */
export function generateSubagentId(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 7);
  return `sub_${date}_${time}_${rnd}`;
}

/** Construye el mensaje de usuario que aísla al hijo: fragmento del perfil + task + refs. */
function buildTaskInjection(profile: AgentProfile, task: SubagentTask): string {
  const parts = [profile.systemPromptFragment.trim(), '', '# Task', task.task];
  if (task.context && task.context.length > 0) {
    parts.push(
      '',
      '# Relevant files (read them yourself with read_file; they are shared, mutable working files)',
      ...task.context.map((p) => `- ${p}`),
    );
  }
  return parts.join('\n');
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusErrorText(status: SubagentStatus): string | undefined {
  switch (status) {
    case 'budget_exceeded':
      return 'Subagent exhausted its iteration/time budget before finishing.';
    case 'cancelled':
      return 'Subagent was cancelled.';
    case 'failed':
      return 'Subagent failed.';
    default:
      return undefined;
  }
}

/**
 * Ejecuta un subagente a término. Contexto aislado (NO hereda el historial del
 * padre), ProviderRouter propio (un fallback del hijo no muta el del padre),
 * toolset por perfil + profundidad = 1 (delegate_task oculto), signal encadenado
 * con el timeout del presupuesto. Nunca lanza: los fallos vuelven como
 * SubagentResult{status:'failed'} para que el padre los reciba como tool result.
 */
export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
  const { task, profile, registry, config, parentSignal } = opts;
  const start = Date.now();
  const filesChanged = new Map<string, 'created' | 'modified' | 'deleted'>();
  const pendingCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const decisions: string[] = [];
  let iterations = 0;
  let tokens: number | undefined;
  let currentText = '';

  // Signal encadenado: cancelación del padre + pared de tiempo del presupuesto.
  let signal = parentSignal;
  if (profile.budget.timeoutMs && profile.budget.timeoutMs > 0) {
    signal = AbortSignal.any([parentSignal, AbortSignal.timeout(profile.budget.timeoutMs)]);
  }

  // Router PROPIO por hijo (§12.16): barato, sin conexiones persistentes. Un
  // switch/fallback del hijo muere con el hijo y no toca al padre.
  let router: SubagentRouter;
  try {
    if (opts.makeRouter) {
      router = opts.makeRouter();
    } else {
      const pr = new ProviderRouter(config, profile.provider);
      if (profile.model) pr.switchModel(profile.model);
      router = pr;
    }
  } catch (err) {
    log.warn('subagent router init failed', { id: task.id, profile: profile.name, err });
    return {
      id: task.id,
      status: 'failed',
      summary: '',
      filesChanged: [],
      usage: { iterations: 0, durationMs: Date.now() - start },
      error: `No se pudo inicializar el provider del perfil '${profile.name}': ${msg(err)}`,
    };
  }

  // Contexto aislado: solo system (con marca de subagente) + la task inyectada.
  const messages: Message[] = [
    {
      role: 'system',
      content: buildSystemPrompt(config, undefined, {
        modelId: router.model,
        providerName: router.providerName,
        isSubagent: true,
        skills: opts.skillsBlock,
      }),
    },
    { role: 'user', content: buildTaskInjection(profile, task) },
  ];

  const loop = new ReactLoop(
    router.getActive(),
    registry,
    messages,
    config,
    router.model,
    router.contextWindow,
    router,
    { toolsetFilter: { allowedTools: profile.allowedTools, isSubagent: true } },
  );

  const runOpts: RunOptions = {
    signal,
    sessionId: opts.sessionId,
    destructivePolicy: profile.destructivePolicy ?? opts.parentDestructivePolicy,
    onConfirmDestructive: opts.onConfirmDestructive,
    maxIterations: profile.budget.maxIterations,
    maxTokens: profile.budget.maxTokens,
  };

  log.info('subagent run', {
    id: task.id,
    profile: profile.name,
    provider: router.providerName,
    model: router.model,
    maxIterations: profile.budget.maxIterations,
  });

  let stopReason = 'stop';
  try {
    for await (const ev of loop.run(runOpts)) {
      // Re-emitir cada evento del hijo hacia el orquestador (Hito 8C): la UI lo
      // envuelve como subagent_event bajo el nodo de este subagente. Best-effort.
      if (opts.onEvent) {
        try {
          opts.onEvent(ev);
        } catch {
          /* el consumidor de eventos nunca debe tumbar al subagente */
        }
      }
      switch (ev.type) {
        case 'text_delta':
          currentText += ev.delta;
          break;
        case 'tool_call_ready':
          pendingCalls.set(ev.id, { name: ev.name, input: ev.input });
          // El texto final (resumen) es el que viene tras el último tool call.
          currentText = '';
          break;
        case 'tool_result': {
          const call = pendingCalls.get(ev.id);
          if (call) {
            recordFileChange(filesChanged, call);
            if (call.name === 'store_decision' && typeof ev.result === 'string') {
              const m = ev.result.match(/\bdec_\d{8}_[A-Za-z0-9]+/);
              if (m) decisions.push(m[0]);
            }
          }
          break;
        }
        case 'done':
          stopReason = ev.stopReason;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    log.warn('subagent threw', { id: task.id, err });
    return {
      id: task.id,
      status: 'failed',
      summary: truncateToolOutput(currentText.trim(), RESULT_SUMMARY_CAP),
      filesChanged: toFilesArray(filesChanged),
      decisions: decisions.length ? decisions : undefined,
      usage: {
        iterations: loop.iterationsRun,
        tokens: loop.tokensUsed || undefined,
        durationMs: Date.now() - start,
      },
      error: msg(err),
    };
  }

  // Iteraciones REALES del loop hijo (no número de tool calls).
  iterations = loop.iterationsRun;
  // Tokens best-effort (Hito 8B): solo si el backend devolvió usage; si no, queda
  // undefined y el control de coste recayó en maxIterations + timeoutMs (§12.16).
  tokens = loop.tokensUsed || undefined;
  if (tokens === undefined) {
    log.debug('subagent tokens unavailable (backend sin usage)', { id: task.id });
  }

  // 'max_iterations' y 'budget_tokens' son ambos agotamiento de presupuesto.
  const status: SubagentStatus =
    stopReason === 'cancelled'
      ? 'cancelled'
      : stopReason === 'max_iterations' || stopReason === 'budget_tokens'
        ? 'budget_exceeded'
        : stopReason === 'error'
          ? 'failed'
          : 'completed';

  const summary = truncateToolOutput(
    currentText.trim() || 'El subagente terminó sin un resumen textual.',
    RESULT_SUMMARY_CAP,
  );

  log.info('subagent done', { id: task.id, status, iterations, durationMs: Date.now() - start });

  return {
    id: task.id,
    status,
    summary,
    filesChanged: toFilesArray(filesChanged),
    decisions: decisions.length ? decisions : undefined,
    usage: { iterations, tokens, durationMs: Date.now() - start },
    error: statusErrorText(status),
  };
}

/** Write-log best-effort (§12.16): infiere ficheros tocados de las tools mutantes. */
function recordFileChange(
  acc: Map<string, 'created' | 'modified' | 'deleted'>,
  call: { name: string; input: Record<string, unknown> },
): void {
  if (call.name === 'write_file' || call.name === 'edit_file') {
    const path = typeof call.input.path === 'string' ? call.input.path : undefined;
    if (!path) return;
    if (call.name === 'write_file') {
      if (!acc.has(path)) acc.set(path, 'created');
    } else {
      acc.set(path, 'modified');
    }
    return;
  }
  // bash: inferencia best-effort de los paths que se puedan leer del comando
  // (redirecciones, tee, touch, cp/mv destino, rm). El límite reconocido de
  // §12.16: comandos que escriben por vías no inferibles escapan al write-log.
  if (call.name === 'bash' && typeof call.input.command === 'string') {
    for (const { path, action } of inferBashWrites(call.input.command)) {
      // No degradar un 'deleted'/'modified' ya registrado a 'created'.
      if (action === 'created' && acc.has(path)) continue;
      acc.set(path, action);
    }
  }
}

/**
 * Infiere (best-effort) los ficheros que un comando shell escribe/borra. No es un
 * parser de shell: reconoce los patrones comunes y acepta falsos negativos.
 * §12.16: la detección reduce el riesgo de conflicto, no lo elimina.
 */
export function inferBashWrites(
  command: string,
): Array<{ path: string; action: 'created' | 'modified' | 'deleted' }> {
  const out: Array<{ path: string; action: 'created' | 'modified' | 'deleted' }> = [];
  const seen = new Set<string>();
  const add = (rawPath: string, action: 'created' | 'modified' | 'deleted'): void => {
    const path = rawPath.replace(/^['"]|['"]$/g, '').trim();
    if (!path || path.startsWith('-')) return;
    const key = `${action}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, action });
  };

  // Redirecciones: `> file`, `>> file`, `2> file`, `&> file`.
  const redir = /(?:^|\s|\d|&)>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;
  for (let m = redir.exec(command); m; m = redir.exec(command)) add(m[1]!, 'modified');

  // `tee [-a] file...` — escribe cada fichero hasta el siguiente operador.
  const tee = /\btee\b((?:\s+(?!-)[^\s;|&]+)+)/g;
  for (let m = tee.exec(command); m; m = tee.exec(command)) {
    for (const tok of m[1]!.trim().split(/\s+/)) add(tok, 'modified');
  }

  // `touch file...`
  const touch = /\btouch\b((?:\s+(?!-)[^\s;|&]+)+)/g;
  for (let m = touch.exec(command); m; m = touch.exec(command)) {
    for (const tok of m[1]!.trim().split(/\s+/)) add(tok, 'created');
  }

  // `rm [-rf] file...` → deleted
  const rm = /\brm\b((?:\s+[^\s;|&]+)+)/g;
  for (let m = rm.exec(command); m; m = rm.exec(command)) {
    for (const tok of m[1]!.trim().split(/\s+/)) {
      if (tok.startsWith('-')) continue;
      add(tok, 'deleted');
    }
  }

  // `mv src dst` / `cp src dst` → el ÚLTIMO token no-flag es el destino escrito.
  const mvcp = /\b(?:mv|cp)\b((?:\s+[^\s;|&]+)+)/g;
  for (let m = mvcp.exec(command); m; m = mvcp.exec(command)) {
    const toks = m[1]!
      .trim()
      .split(/\s+/)
      .filter((t) => !t.startsWith('-'));
    if (toks.length >= 2) add(toks[toks.length - 1]!, 'modified');
  }

  return out;
}

function toFilesArray(
  acc: Map<string, 'created' | 'modified' | 'deleted'>,
): SubagentResult['filesChanged'] {
  return [...acc.entries()].map(([path, action]) => ({ path, action }));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Preámbulo de reanudación de subagentes interrumpidos (Hito 8B, §12.16). Recibe
 * los registros `running` que quedaron sin estado terminal (un cuelgue duro entre
 * el arranque del hijo y su fin) e instruye al PADRE a verificar el estado real
 * antes de decidir. **No relanza el hijo**: un subagente no es idempotente (pudo
 * ejecutar `bash`, escribir ficheros o tocar servicios), reejecutar a ciegas
 * duplicaría efectos. La decisión (reintentar, dar por bueno, o preguntar al
 * usuario) es del agente, igual que la verificación de un paso `in_progress` de
 * un plan (§12.15). Devuelve null si no hay nada interrumpido.
 */
export function buildInterruptedSubagentsPreamble(
  interrupted: Array<{ id: string; profile: string; task: string }>,
): string | null {
  if (interrupted.length === 0) return null;
  const items = interrupted.map((s) => `- [${s.profile}] ${s.id}: ${s.task}`).join('\n');
  return [
    'Reanudación de sesión: uno o más subagentes que delegaste quedaron INTERRUMPIDOS',
    'antes de terminar (la sesión anterior se cerró a mitad de su ejecución). No se han',
    'reejecutado automáticamente porque un subagente puede haber tenido efectos parciales',
    '(comandos ejecutados, ficheros escritos).',
    '',
    'Subagentes interrumpidos:',
    items,
    '',
    'Antes de continuar: verifica el estado real (relee los ficheros implicados, comprueba',
    'si la tarea quedó a medias) y decide explícitamente si vuelves a delegar la tarea, la',
    'das por completada, o preguntas al usuario. No asumas que se completó ni que no se hizo nada.',
  ].join('\n');
}

/** Serializa el SubagentResult a XML para inyectarlo como tool result (§12.16). */
export function serializeSubagentResult(result: SubagentResult, profile: string): string {
  const attrs =
    `id="${escapeXml(result.id)}" profile="${escapeXml(profile)}" status="${result.status}" ` +
    `iterations="${result.usage.iterations}" durationMs="${result.usage.durationMs}"`;
  const lines = [`<subagent_result ${attrs}>`];
  lines.push(`  <summary>${escapeXml(result.summary)}</summary>`);
  if (result.filesChanged.length > 0) {
    lines.push('  <files_changed>');
    for (const f of result.filesChanged) {
      lines.push(`    <file path="${escapeXml(f.path)}" action="${f.action}" />`);
    }
    lines.push('  </files_changed>');
  }
  if (result.error) {
    lines.push(`  <error>${escapeXml(result.error)}</error>`);
  }
  lines.push('</subagent_result>');
  return lines.join('\n');
}
