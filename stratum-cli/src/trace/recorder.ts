import { createHash } from 'crypto';
import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { StratumConfig } from '../config/schema.js';
import type { AgentEvent, Message } from '../agent/types.js';
import { redactText } from '../security/redact-output.js';
import { getLogger } from '../logging/index.js';
import { normalizeUsage, type RawTimings, type RawUsage } from '../providers/cache.js';
import {
  TRACE_CAP_LLM_ORIGIN,
  TRACE_CAP_RUNTIME,
  TRACE_FORMAT_VERSION,
  isAuxiliaryOrigin,
  type LlmCallOrigin,
  type TraceData,
  type TraceKind,
  type TraceRecord,
  type TraceRuntimeEvent,
  type TraceStatus,
} from './records.js';

const log = getLogger('trace');

// ---------------------------------------------------------------------------
// Contrato con el runtime
// ---------------------------------------------------------------------------

export interface ModelCallInfo {
  /**
   * Quién hace la llamada. Por defecto, el dueño del scope: `agent` en el del
   * agente principal y `subagent` en el de un hijo. Las llamadas auxiliares lo
   * indican siempre (`tracedCompletion`).
   */
  origin?: LlmCallOrigin;
  /** Iteración del loop; las llamadas auxiliares no tienen. */
  iteration?: number;
  provider?: string;
  model: string;
  /** El prompt exacto de la llamada: el historial tal como se envía. */
  messages: readonly Message[];
  /** Tools ofrecidas al modelo en esta llamada. */
  tools: number;
  /**
   * Los schemas de esas tools, tal como se envían. No se guardan: solo sirven
   * para medir cuánto del prompt repite el de la llamada anterior (`prefix`).
   */
  toolSchemas?: readonly unknown[];
}

/** `usage` crudo del backend; la traza guarda su forma normalizada (`normalizeUsage`). */
export type ModelCallUsage = RawUsage;

export interface ModelCallEnd {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  error?: string;
  cancelled?: boolean;
}

export interface ModelSpan {
  /** Primer chunk del stream: separa la espera de la generación. */
  firstChunk(): void;
  /** `timings` es lo que llama.cpp manda aparte del `usage` (tokens reutilizados del KV cache). */
  usage(usage: ModelCallUsage | undefined, timings?: RawTimings): void;
  end(result: ModelCallEnd): void;
}

/**
 * Lo que el runtime ve de la traza. Ningún método lanza: la traza es auxiliar
 * y un fallo suyo nunca puede afectar a un turno.
 */
export interface TraceScope {
  /** Abre un turno. `messages` es el historial con el input ya añadido. */
  turnStart(input: string, messages: readonly Message[]): void;
  turnEnd(stopReason: string | null): void;
  /** Una llamada al LLM. Registra antes los mensajes nuevos que entran en ella. */
  modelStart(info: ModelCallInfo): ModelSpan;
  /** Cada `AgentEvent` del loop de este scope, en el orden en que se emite. */
  event(event: AgentEvent): void;
  /** Una decisión del runtime que no viaja como `AgentEvent` (confirmación, veto, reintento). */
  runtime(event: TraceRuntimeEvent): void;
  /** Scope de un subagente: sus pasos cuelgan del paso `subagentId`. */
  child(subagentId: string): TraceScope;
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

/**
 * Cola de escritura por lotes: añadir es síncrono y nunca lanza; el disco se
 * toca en el siguiente tick, en orden. Un fallo de escritura desactiva la traza
 * (y se avisa una vez) en vez de reintentar en cada registro.
 */
class TraceWriter {
  private pending: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private scheduled = false;
  private dirReady = false;
  private broken = false;

  constructor(private readonly file: string) {}

  write(record: TraceRecord): void {
    if (this.broken) return;
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      return;
    }
    this.pending.push(line);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.pending.length === 0) return;
    const chunk = this.pending.join('\n') + '\n';
    this.pending = [];
    this.chain = this.chain.then(async () => {
      if (this.broken) return;
      try {
        if (!this.dirReady) {
          await mkdir(dirname(this.file), { recursive: true });
          this.dirReady = true;
        }
        await appendFile(this.file, chunk, 'utf8');
      } catch (err) {
        this.broken = true;
        log.warn('trace disabled: write failed', { file: this.file, err });
      }
    });
  }

  async flush(): Promise<void> {
    this.drain();
    await this.chain;
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface TraceRecorderOptions {
  file: string;
  sessionId: string;
  config: StratumConfig;
  cwd?: string;
  version?: string;
  /** Reloj inyectable (tests). */
  now?: () => number;
}

/** Tope por cadena cuando la config no trae sección `trace` (tests con config parcial). */
const DEFAULT_MAX_FIELD_CHARS = 200_000;

export class TraceRecorder {
  readonly file: string;
  readonly sessionId: string;
  private readonly writer: TraceWriter;
  private readonly now: () => number;
  private readonly maxChars: number;
  private readonly prefix = Math.random().toString(36).slice(2, 6);
  private seq = 0;
  private metaWritten = false;
  private readonly root: Scope;

  constructor(private readonly opts: TraceRecorderOptions) {
    this.file = opts.file;
    this.sessionId = opts.sessionId;
    this.writer = new TraceWriter(opts.file);
    this.now = opts.now ?? Date.now;
    this.maxChars = opts.config.trace?.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;
    this.root = new Scope(this, undefined);
  }

  /** Scope del agente principal. */
  scope(): TraceScope {
    return this.root;
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** @internal */
  nextId(): string {
    return `${this.prefix}${(++this.seq).toString(36)}`;
  }

  /** @internal */
  at(): number {
    return this.now();
  }

  /** @internal */
  write(record: TraceRecord): void {
    if (!this.metaWritten) {
      // La cabecera se escribe con el primer registro real: una sesión sin
      // turnos no deja fichero.
      this.metaWritten = true;
      this.writer.write({
        t: 'meta',
        v: TRACE_FORMAT_VERSION,
        at: record.at,
        sessionId: this.opts.sessionId,
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        ...(this.opts.version ? { version: this.opts.version } : {}),
        caps: [TRACE_CAP_RUNTIME, TRACE_CAP_LLM_ORIGIN],
      });
    }
    this.writer.write(record);
  }

  /** Redacta y recorta una cadena antes de que toque el disco. @internal */
  text(value: string): string {
    let out: string;
    try {
      out = redactText(value, this.opts.config);
    } catch {
      // Sin redacción no se escribe el contenido: mejor un hueco que un secreto.
      return '[trace: content omitted, redaction failed]';
    }
    if (out.length <= this.maxChars) return out;
    return `${out.slice(0, this.maxChars)}\n… [trace: ${out.length - this.maxChars} more chars]`;
  }

  /** Copia profunda con todas las cadenas redactadas. @internal */
  safe(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return this.text(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth > 8) return '[trace: nested too deep]';
    if (Array.isArray(value)) return value.map((v) => this.safe(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = this.safe(v, depth + 1);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const CONFIRMATION_LABEL = {
  approved: 'aprobada',
  'allow-all': 'aprobada (permitir todo)',
  denied: 'denegada',
  blocked: 'bloqueada (nadie puede aprobar)',
} as const;

const VETO_LABEL = {
  preflight: 'la guarda de la tool',
  'read-only': 'el modo read-only',
  environment: 'la política de entorno',
  toolset: 'el toolset de la sesión',
  plan: 'el modo plan',
} as const;

/** Primera línea con contenido, recortada: el nombre de un mensaje inyectado. */
function headline(text: string, max = 120): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const hash8 = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 8);

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Un mensaje tal como cuenta para el prefijo: lo que el backend recibe de él. */
const renderMessage = (m: Message): string => JSON.stringify(m) ?? '';

/**
 * Compara el prompt de cada llamada con el de la anterior del mismo scope, en
 * el orden en que un backend lo procesa (tools, system, conversación): cuántos
 * caracteres iniciales repite y dónde deja de coincidir. Es lo que una caché de
 * prefijo **podría** reutilizar, medido en el cliente; lo que de verdad
 * reutilizó lo dice el `usage` del backend. El prompt anterior se retiene solo
 * en memoria: a la traza va el recuento, nunca el texto.
 */
class PrefixTracker {
  private prevTools: string | null = null;
  private prevRefs: readonly Message[] = [];
  private prevRendered: string[] = [];

  measure(messages: readonly Message[], toolSchemas: readonly unknown[] | undefined): TraceData {
    const tools = JSON.stringify(toolSchemas ?? []);
    const rendered = messages.map((m, i) =>
      m === this.prevRefs[i] ? this.prevRendered[i]! : renderMessage(m),
    );
    const chars = tools.length + rendered.reduce((sum, r) => sum + r.length, 0);
    const first = messages[0];
    const data: TraceData = {
      chars,
      tools: hash8(tools),
      ...(first?.role === 'system' ? { system: hash8(rendered[0]!) } : {}),
    };

    if (this.prevTools !== null) {
      let shared: number;
      if (tools !== this.prevTools) {
        shared = commonPrefix(tools, this.prevTools);
        data.diverged = 'tools';
      } else {
        shared = tools.length;
        for (let i = 0; i < rendered.length && i < this.prevRendered.length; i++) {
          const prev = this.prevRendered[i]!;
          if (rendered[i] === prev) {
            shared += prev.length;
            continue;
          }
          shared += commonPrefix(rendered[i]!, prev);
          data.diverged = i === 0 && first?.role === 'system' ? 'system' : 'history';
          data.divergedAt = i;
          break;
        }
      }
      data.sharedChars = shared;
      data.prevMessages = this.prevRendered.length;
    }

    this.prevTools = tools;
    this.prevRefs = messages.slice();
    this.prevRendered = rendered;
    return data;
  }
}

class Scope implements TraceScope {
  /** Mensajes ya contabilizados como entrada de alguna llamada. */
  private readonly seen = new WeakSet<object>();
  private lastSystem: string | null = null;
  private started = false;
  /** tool call id del modelo → paso abierto (los ids del modelo se repiten entre turnos). */
  private readonly openTools = new Map<string, string>();
  private readonly openSubagents = new Set<string>();
  /** Uno por origen: el prompt del compresor no se compara con el del agente. */
  private readonly prefixes = new Map<LlmCallOrigin, PrefixTracker>();

  constructor(
    private readonly rec: TraceRecorder,
    private readonly parent: string | undefined,
  ) {}

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.debug('trace hook failed', { err });
    }
  }

  private point(kind: TraceKind, name: string, data?: TraceData, status?: TraceStatus): void {
    this.rec.write({
      t: 'point',
      at: this.rec.at(),
      id: this.rec.nextId(),
      kind,
      name,
      ...(this.parent ? { parent: this.parent } : {}),
      ...(status ? { status } : {}),
      ...(data ? { data } : {}),
    });
  }

  private begin(id: string, kind: TraceKind, name: string, data?: TraceData): void {
    this.rec.write({
      t: 'begin',
      at: this.rec.at(),
      id,
      kind,
      name,
      ...(this.parent ? { parent: this.parent } : {}),
      ...(data ? { data } : {}),
    });
  }

  private end(id: string, status: TraceStatus, data?: TraceData): void {
    this.rec.write({ t: 'end', at: this.rec.at(), id, status, ...(data ? { data } : {}) });
  }

  /** Registra el prompt del sistema si es el primero o si cambió. */
  private recordSystem(messages: readonly Message[]): void {
    const first = messages[0];
    if (!first || first.role !== 'system') return;
    this.seen.add(first);
    const content = first.content ?? '';
    if (content === this.lastSystem) return;
    const initial = this.lastSystem === null;
    this.lastSystem = content;
    this.point(
      'system',
      initial ? 'Prompt inicial del sistema' : 'Prompt del sistema actualizado',
      {
        content: this.rec.text(content),
        chars: content.length,
      },
    );
  }

  /**
   * Mensajes que entran por primera vez en una llamada. Solo `system` y `user`:
   * los `assistant` son salida de una llamada anterior y los `tool`, de un paso
   * de herramienta — ya están en la traza.
   */
  private recordNewContext(messages: readonly Message[]): void {
    this.recordSystem(messages);
    for (const msg of messages) {
      if (this.seen.has(msg)) continue;
      this.seen.add(msg);
      if (msg.role !== 'user' && msg.role !== 'system') continue;
      const content = msg.content ?? '';
      this.point('context', headline(content) || `Mensaje ${msg.role}`, {
        role: msg.role,
        content: this.rec.text(content),
        chars: content.length,
      });
    }
  }

  turnStart(input: string, messages: readonly Message[]): void {
    this.guard(() => {
      if (!this.started) {
        // Primer turno de este proceso: lo que ya había en el historial (una
        // sesión reanudada) no es entrada nueva; se resume en un solo paso.
        this.started = true;
        const prior = messages.filter((m) => m.role !== 'system').length - 1;
        this.recordSystem(messages);
        for (const m of messages) this.seen.add(m);
        this.rec.write({ t: 'turn', at: this.rec.at(), input: this.rec.text(input) });
        if (prior > 0)
          this.point('context', `Historial previo: ${prior} mensajes`, { messages: prior });
        return;
      }
      // El input es el último `user` (o se fusionó con uno ya visto).
      const last = messages[messages.length - 1];
      if (last?.role === 'user') this.seen.add(last);
      this.rec.write({ t: 'turn', at: this.rec.at(), input: this.rec.text(input) });
    });
  }

  turnEnd(stopReason: string | null): void {
    this.guard(() => {
      this.closeOpen();
      this.rec.write({ t: 'turn_end', at: this.rec.at(), stopReason });
    });
  }

  /** Cierra lo que un turno cancelado o abandonado dejó abierto. */
  private closeOpen(): void {
    for (const id of this.openTools.values()) this.end(id, 'cancelled');
    this.openTools.clear();
    for (const id of this.openSubagents) this.end(id, 'cancelled');
    this.openSubagents.clear();
  }

  modelStart(info: ModelCallInfo): ModelSpan {
    const id = this.rec.nextId();
    let usage: ModelCallUsage | undefined;
    let timings: RawTimings | undefined;
    let closed = false;
    let first = false;
    const origin: LlmCallOrigin = info.origin ?? (this.parent ? 'subagent' : 'agent');
    this.guard(() => {
      // El prompt de una llamada auxiliar no es entrada del agente: se deriva de
      // un historial que ya está en la traza, y de él solo se guardan recuentos.
      if (!isAuxiliaryOrigin(origin)) {
        this.started = true;
        this.recordNewContext(info.messages);
      }
      let prefix = this.prefixes.get(origin);
      if (!prefix) this.prefixes.set(origin, (prefix = new PrefixTracker()));
      this.begin(id, 'model', info.model, {
        origin,
        ...(info.iteration !== undefined ? { iteration: info.iteration } : {}),
        ...(info.provider ? { provider: info.provider } : {}),
        model: info.model,
        messages: info.messages.length,
        tools: info.tools,
        prefix: prefix.measure(info.messages, info.toolSchemas),
      });
    });
    return {
      firstChunk: () => {
        if (first || closed) return;
        first = true;
        this.guard(() => this.rec.write({ t: 'mark', at: this.rec.at(), id, name: 'first_token' }));
      },
      usage: (u, t) => {
        if (u) usage = u;
        if (t) timings = t;
      },
      end: (result) => {
        if (closed) return;
        closed = true;
        this.guard(() => {
          const data: TraceData = {};
          if (result.text) data.text = this.rec.text(result.text);
          if (result.reasoning) data.reasoning = this.rec.text(result.reasoning);
          if (result.toolCalls.length > 0) {
            data.toolCalls = result.toolCalls.map((c) => ({
              id: c.id,
              name: c.name,
              arguments: this.rec.text(c.arguments),
            }));
          }
          const normalized = normalizeUsage(usage, timings);
          if (normalized) {
            data.usage = {
              ...normalized,
              // Nombre anterior del campo: lo leen los visores de antes.
              ...(normalized.cachedReadTokens !== undefined
                ? { cachedTokens: normalized.cachedReadTokens }
                : {}),
            };
          }
          if (result.error) data.error = this.rec.text(result.error);
          const status: TraceStatus = result.cancelled
            ? 'cancelled'
            : result.error
              ? 'error'
              : 'ok';
          this.end(id, status, data);
        });
      },
    };
  }

  event(event: AgentEvent): void {
    this.guard(() => this.handle(event));
  }

  private handle(ev: AgentEvent): void {
    switch (ev.type) {
      case 'tool_call_ready': {
        const id = this.rec.nextId();
        this.openTools.set(ev.id, id);
        this.begin(id, 'tool', ev.name, { callId: ev.id, input: this.rec.safe(ev.input) });
        break;
      }
      case 'tool_result':
      case 'tool_error': {
        const data: TraceData =
          ev.type === 'tool_result'
            ? { output: this.rec.text(ev.result), execMs: ev.durationMs }
            : {
                error: this.rec.text(ev.error),
                recoverable: ev.recoverable,
                ...(ev.executed !== undefined ? { executed: ev.executed } : {}),
              };
        const status: TraceStatus = ev.type === 'tool_result' ? 'ok' : 'error';
        const open = this.openTools.get(ev.id);
        if (open) {
          this.openTools.delete(ev.id);
          this.end(open, status, data);
        } else {
          // Sin `tool_call_ready` previo: argumentos que no se pudieron parsear,
          // o el resultado sintético de una delegación directa.
          this.point('tool', ev.name, { callId: ev.id, ...data }, status);
        }
        break;
      }
      case 'subagent_started':
        this.openSubagents.add(ev.subagentId);
        this.begin(ev.subagentId, 'subagent', ev.profile, {
          profile: ev.profile,
          task: this.rec.text(ev.task),
        });
        break;
      case 'subagent_completed': {
        const r = ev.result;
        const wasOpen = this.openSubagents.delete(ev.subagentId);
        const status: TraceStatus =
          r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'error' : 'cancelled';
        const data: TraceData = {
          result: r.status,
          summary: this.rec.text(r.summary),
          filesChanged: r.filesChanged,
          usage: r.usage,
          ...(r.error ? { error: this.rec.text(r.error) } : {}),
        };
        // Cancelado antes de arrancar: nunca hubo `subagent_started`.
        if (wasOpen) this.end(ev.subagentId, status, data);
        else this.point('subagent', 'subagente', data, status);
        break;
      }
      case 'warning':
        this.point('notice', headline(ev.message), { message: this.rec.text(ev.message) });
        break;
      case 'error':
        this.point(
          'notice',
          headline(ev.message) || 'Error',
          { message: this.rec.text(ev.message), fatal: ev.fatal },
          'error',
        );
        break;
      case 'context_compressed':
        this.point('context', 'Contexto comprimido', {
          tokensBefore: ev.tokensBefore,
          tokensAfter: ev.tokensAfter,
          rounds: ev.roundsCompressed,
        });
        break;
      case 'memory_retrieved':
        this.point('context', `Memoria recuperada: ${ev.decisions.length} decisiones`, {
          decisions: ev.decisions.map((d) => ({ id: d.id, title: this.rec.text(d.title) })),
        });
        break;
      case 'questions_asked':
        this.point('context', `Preguntas al usuario: ${ev.questions.length}`, {
          questions: this.rec.safe(ev.questions),
        });
        break;
      case 'questions_answered':
        this.point('user', ev.answers ? 'Respuestas del usuario' : 'Preguntas sin responder', {
          answers: this.rec.safe(ev.answers),
        });
        break;
      case 'plan_proposed':
        this.point('context', `Plan propuesto: ${ev.plan.steps.length} pasos`, {
          plan: this.rec.safe(ev.plan),
        });
        break;
      case 'done':
        // En un subagente no hay `turnEnd`: su `done` cierra lo que quedó abierto.
        if (this.parent) this.closeOpen();
        break;
      default:
        // text_delta / thinking / tool_call_start viajan en el paso del modelo;
        // subagent_event lo registra el scope del propio hijo.
        break;
    }
  }

  runtime(ev: TraceRuntimeEvent): void {
    this.guard(() => {
      const data = this.rec.safe(ev) as TraceData;
      if (ev.event === 'confirmation') {
        this.point('notice', `Confirmación ${CONFIRMATION_LABEL[ev.decision]}: ${ev.tool}`, data);
      } else if (ev.event === 'veto') {
        this.point('notice', `Vetada por ${VETO_LABEL[ev.source]}: ${ev.tool}`, data);
      } else {
        this.point('notice', `Reintento ${ev.attempt} de la llamada al modelo`, data);
      }
    });
  }

  child(subagentId: string): TraceScope {
    return new Scope(this.rec, subagentId);
  }
}
