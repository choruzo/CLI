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
  /** Callback de confirmación del padre: el subagente nunca posee la TTY (§12.16). */
  onConfirmDestructive?: (req: ConfirmRequest) => Promise<DestructiveDecision>;
  /**
   * Factory del router del hijo. Si se omite, se construye un `ProviderRouter`
   * propio desde la config. Punto de inyección para tests.
   */
  makeRouter?: () => SubagentRouter;
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
    destructivePolicy: profile.destructivePolicy ?? opts.parentDestructivePolicy,
    onConfirmDestructive: opts.onConfirmDestructive,
    maxIterations: profile.budget.maxIterations,
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
      usage: { iterations: loop.iterationsRun, tokens, durationMs: Date.now() - start },
      error: msg(err),
    };
  }

  // Iteraciones REALES del loop hijo (no número de tool calls).
  iterations = loop.iterationsRun;

  const status: SubagentStatus =
    stopReason === 'cancelled'
      ? 'cancelled'
      : stopReason === 'max_iterations'
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
  const path = typeof call.input.path === 'string' ? call.input.path : undefined;
  if (!path) return;
  if (call.name === 'write_file') {
    if (!acc.has(path)) acc.set(path, 'created');
  } else if (call.name === 'edit_file') {
    acc.set(path, 'modified');
  }
}

function toFilesArray(
  acc: Map<string, 'created' | 'modified' | 'deleted'>,
): SubagentResult['filesChanged'] {
  return [...acc.entries()].map(([path, action]) => ({ path, action }));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
