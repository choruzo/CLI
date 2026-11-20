import type { IProvider } from '../providers/base.js';
import type { Message } from '../agent/types.js';
import type { DecisionMemory, RecallResult } from './decision-memory.js';
import {
  CODE_DECISION_TYPES,
  MEMORY_SECTIONS,
  type DecisionInput,
  type DecisionRecord,
  type DecisionImportance,
  type DecisionType,
  type MemoryTaxonomy,
} from './decisions.js';
import { tracedCompletion } from '../trace/llm-call.js';
import type { TraceScope } from '../trace/recorder.js';

const VALID_IMPORTANCE: DecisionImportance[] = ['low', 'medium', 'high'];

/** Cuántos mensajes recientes se consideran para la extracción. */
const CONTEXT_WINDOW = 8;

/** Exportado para el modelo de guion de `stratum eval`, que reconoce por él la petición. */
export const EXTRACT_SYSTEM_PROMPT = `Eres un asistente de extracción de memoria para un agente de programación.
Analiza la conversación y extrae SOLO decisiones técnicas duraderas que convenga recordar entre sesiones.

Extrae cuando: (1) se eligió entre alternativas técnicas significativas, (2) se definió una convención del proyecto,
(3) se resolvió un bug no trivial, (4) el usuario expresó una preferencia explícita a recordar.
NO extraigas: pasos rutinarios, acciones intermedias, preguntas, lo que dijo el asistente sin decidir nada.

Reglas:
- MÁXIMO 2 decisiones por conversación; solo las más importantes.
- Si nada duradero se decidió, devuelve [].
- Cada decisión es un objeto JSON con: title (string, <100 chars), content (string: contexto, alternativas, razón),
  type (uno de: architectural, tooling, convention, bug_fix, security, user_preference),
  tags (array de máx 5 strings), importance (low | medium | high).

Devuelve SOLO un array JSON válido, sin texto adicional ni fences markdown.`;

/**
 * M19 — extracción para las memorias con secciones (`assistant`, `companion`):
 * recuerdos sobre el usuario y su entorno, no decisiones técnicas.
 */
export const EXTRACT_SECTIONS_PROMPT = `Eres un asistente de extracción de memoria para un asistente personal.
Analiza la conversación y extrae SOLO lo duradero sobre el usuario que convenga recordar en otras conversaciones.

Extrae cuando el usuario: (1) cuenta algo estable sobre sí mismo o su entorno (gustos, rutinas, personas, proyectos),
(2) fija una preferencia sobre cómo quiere las cosas, (3) corrige cómo hiciste algo, (4) pide que recuerdes algo.
NO extraigas: detalles pasajeros de la conversación, preguntas, lo que dijo el asistente sin que el usuario aportara nada,
ni secretos, contraseñas, datos de pago o de salud salvo que lo pida expresamente.

Reglas:
- Extrae solo de los mensajes nuevos; el contexto anterior ya se analizó y solo sirve para entenderlos.
- No devuelvas lo que ya está en «Ya recordado», aunque lo digas con otras palabras o con algún detalle más.
- MÁXIMO 2 recuerdos por conversación; solo los más importantes.
- Si nada duradero se dijo, devuelve [].
- Cada recuerdo es un objeto JSON con: title (string, <100 chars), content (string: el recuerdo con su contexto),
  summary (string, el recuerdo en una línea, <140 chars),
  type (uno de: profile = el propio usuario, person = alguien de su entorno, project = algo en lo que trabaja,
  area = un ámbito estable de su vida o trabajo, topic = cualquier otra cosa; si dudas, topic),
  tags (array de máx 5 strings), importance (low | medium | high).

Devuelve SOLO un array JSON válido, sin texto adicional ni fences markdown.`;

/** Acumula una completion no-stream del provider en un único string. */
async function gatherCompletion(
  opts: ExtractOptions,
  messages: Message[],
  signal: AbortSignal,
): Promise<string> {
  let out = '';
  for await (const chunk of tracedCompletion({
    origin: 'memory-extraction',
    provider: opts.provider,
    providerName: opts.providerName,
    request: { messages, model: opts.model, stream: true, signal, temperature: 0.1 },
    trace: opts.trace,
    cancelSignal: opts.cancelSignal,
  })) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) out += content;
  }
  return out;
}

/**
 * Parsea la respuesta del extractor a un array de objetos, tolerando el ruido
 * de modelos de razonamiento: bloques <think>, fences ```json y prosa alrededor.
 * Nunca lanza: devuelve [] si no se puede parsear.
 */
export function parseDecisionsJson(raw: string): unknown[] {
  let text = (raw || '').trim();
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/```\s*$/i, '')
      .trim();
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Normaliza un objeto crudo del LLM a un DecisionInput válido, o null. */
function toDecisionInput(
  raw: unknown,
  taxonomy: MemoryTaxonomy,
  sessionId?: string,
): DecisionInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const content = typeof o.content === 'string' ? o.content.trim() : '';
  if (title.length < 3 || content.length < 5) return null;

  // Tipo dudoso: `convention` en código; `topic` en secciones (B2).
  const valid: readonly string[] = taxonomy === 'sections' ? MEMORY_SECTIONS : CODE_DECISION_TYPES;
  const type = valid.includes(String(o.type))
    ? (o.type as DecisionType)
    : taxonomy === 'sections'
      ? 'topic'
      : 'convention';
  const summary =
    taxonomy === 'sections' && typeof o.summary === 'string' ? o.summary.trim().slice(0, 140) : '';
  const importance = (VALID_IMPORTANCE as string[]).includes(String(o.importance))
    ? (o.importance as DecisionImportance)
    : 'medium';
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 5)
    : [];

  return {
    title: title.slice(0, 100),
    content,
    type,
    tags,
    importance,
    ...(summary ? { summary } : {}),
    source: 'auto',
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function messageText(m: Message): string {
  return typeof m.content === 'string' ? m.content.trim() : '';
}

export interface ExtractOptions {
  provider: IProvider;
  /** Nombre del provider en la config: solo para la traza. */
  providerName?: string;
  /** Con scope, la llamada queda en la traza como `memory-extraction`. */
  trace?: TraceScope;
  /** Cierre de la sesión: corta la llamada en vuelo, que queda como cancelada. */
  cancelSignal?: AbortSignal;
  model: string;
  messages: Message[];
  memory: DecisionMemory;
  /** Clasificación de la memoria (por preset); sin ella, la de código. */
  taxonomy?: MemoryTaxonomy;
  sessionId?: string;
  signal?: AbortSignal;
  /**
   * Solo con secciones: los mensajes ya analizados de esta sesión (lo mantiene
   * quien llama, uno por sesión). En una sesión de larga vida la ventana de un
   * turno pisa casi entera la del anterior: sin esto, cada turno volvía a
   * extraer los mismos hechos. Se marca tras una respuesta del modelo, no tras
   * un fallo, para que el turno siguiente lo reintente.
   */
  analyzed?: Set<string>;
}

/** Cuántos recuerdos parecidos se enseñan al extractor como «Ya recordado». */
const KNOWN_TOP_K = 8;

/** Tope de claves en `analyzed`: de sobra para la ventana, y acotado en una sesión de larga vida. */
const ANALYZED_CAP = 512;

function analyzedKey(m: Message): string {
  return `${m.role}\u0000${messageText(m)}`;
}

function markAnalyzed(analyzed: Set<string>, messages: Message[]): void {
  for (const m of messages) {
    const key = analyzedKey(m);
    analyzed.delete(key);
    analyzed.add(key);
  }
  for (const key of analyzed) {
    if (analyzed.size <= ANALYZED_CAP) break;
    analyzed.delete(key);
  }
}

function knownLine(r: DecisionRecord): string {
  const text = (r.summary ?? r.content).replace(/\s+/g, ' ').trim().slice(0, 160);
  return `- [${r.type}] ${r.title}: ${text}`;
}

/**
 * La petición al extractor con secciones: el contexto ya analizado aparte de
 * los mensajes nuevos, y lo que ya hay en la memoria parecido a ellos.
 */
async function sectionsRequest(
  recent: Message[],
  analyzed: Set<string> | undefined,
  memory: DecisionMemory,
): Promise<string | null> {
  const fresh = analyzed ? recent.filter((m) => !analyzed.has(analyzedKey(m))) : recent;
  // Lo duradero lo aporta el usuario: sin un mensaje suyo nuevo no hay nada que extraer.
  if (!fresh.some((m) => m.role === 'user')) return null;
  const context = recent.slice(0, recent.length - fresh.length);
  const render = (ms: Message[]) => ms.map((m) => `${m.role}: ${messageText(m)}`).join('\n\n');

  let known: RecallResult[] = [];
  try {
    known = await memory.nearest(render(fresh), KNOWN_TOP_K);
  } catch {
    // Sin índice se extrae igual: el dedup al guardar sigue en su sitio.
  }

  return [
    known.length > 0
      ? `Ya recordado (no lo repitas):\n${known.map((k) => knownLine(k.record)).join('\n')}`
      : 'Ya recordado: nada parecido.',
    context.length > 0 ? `Contexto ya analizado (no extraigas de aquí):\n\n${render(context)}` : '',
    `Mensajes nuevos:\n\n${render(fresh)}`,
    'Devuelve ahora el array JSON de recuerdos duraderos nuevos (o [] si no hay).',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Extracción automática de decisiones (detección LLM-based, §9). Pensada para
 * correr en background tras la respuesta del agente (fire-and-forget). Errores
 * solo se registran, nunca se propagan. Devuelve el nº de decisiones añadidas.
 */
export async function extractAndStore(opts: ExtractOptions): Promise<number> {
  try {
    const { memory, sessionId } = opts;
    const taxonomy = opts.taxonomy ?? 'code';
    const timeout = opts.signal ?? AbortSignal.timeout(30000);
    const signal = opts.cancelSignal ? AbortSignal.any([timeout, opts.cancelSignal]) : timeout;

    // Ventana reciente, solo mensajes con texto de usuario/asistente.
    const recent = opts.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && messageText(m))
      .slice(-CONTEXT_WINDOW);
    if (recent.length < 2) return 0;

    // Aplanar a UN mensaje de usuario: pasarlo como conversación hace que el
    // modelo la "continúe" en vez de analizarla y devuelve [] sistemáticamente.
    let request: string;
    if (taxonomy === 'sections') {
      const built = await sectionsRequest(recent, opts.analyzed, memory);
      if (built === null) return 0;
      request = built;
    } else {
      // La de código no cambia (M19): toda la ventana, sin lo ya recordado.
      const transcript = recent.map((m) => `${m.role}: ${messageText(m)}`).join('\n\n');
      request =
        'Conversación a analizar:\n\n' +
        transcript +
        '\n\nDevuelve ahora el array JSON de decisiones duraderas (o [] si no hay).';
    }
    const extractionMessages: Message[] = [
      {
        role: 'system',
        content: taxonomy === 'sections' ? EXTRACT_SECTIONS_PROMPT : EXTRACT_SYSTEM_PROMPT,
      },
      { role: 'user', content: request },
    ];

    let raw = '';
    try {
      raw = await gatherCompletion(opts, extractionMessages, signal);
    } catch {
      return 0;
    }
    if (taxonomy === 'sections' && opts.analyzed) markAnalyzed(opts.analyzed, recent);

    const candidates = parseDecisionsJson(raw);
    if (candidates.length === 0) return 0;

    let added = 0;
    for (const cand of candidates.slice(0, 2)) {
      const input = toDecisionInput(cand, taxonomy, sessionId);
      if (!input) continue;
      // memory.save aplica dedup semántico contra lo ya almacenado.
      const result = await memory.save(input, {
        source: 'auto-extract',
        ...(sessionId ? { sessionId } : {}),
      });
      if (!result.deduped) added++;
    }
    return added;
  } catch {
    return 0;
  }
}
