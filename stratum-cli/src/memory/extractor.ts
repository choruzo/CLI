import type { IProvider } from '../providers/base.js';
import type { Message } from '../agent/types.js';
import type { DecisionMemory } from './decision-memory.js';
import type { DecisionInput, DecisionImportance, DecisionType } from './decisions.js';

const VALID_TYPES: DecisionType[] = [
  'architectural',
  'tooling',
  'convention',
  'bug_fix',
  'security',
  'user_preference',
];
const VALID_IMPORTANCE: DecisionImportance[] = ['low', 'medium', 'high'];

/** Cuántos mensajes recientes se consideran para la extracción. */
const CONTEXT_WINDOW = 8;

const EXTRACT_SYSTEM_PROMPT = `Eres un asistente de extracción de memoria para un agente de programación.
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

/** Acumula una completion no-stream del provider en un único string. */
async function gatherCompletion(
  provider: IProvider,
  messages: Message[],
  model: string,
  signal: AbortSignal,
): Promise<string> {
  let out = '';
  for await (const chunk of provider.complete({ messages, model, stream: true, signal, temperature: 0.1 })) {
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
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/```\s*$/i, '').trim();
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
function toDecisionInput(raw: unknown, sessionId?: string): DecisionInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const content = typeof o.content === 'string' ? o.content.trim() : '';
  if (title.length < 3 || content.length < 5) return null;

  const type = (VALID_TYPES as string[]).includes(String(o.type))
    ? (o.type as DecisionType)
    : 'convention';
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
    source: 'auto',
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function messageText(m: Message): string {
  return typeof m.content === 'string' ? m.content.trim() : '';
}

export interface ExtractOptions {
  provider: IProvider;
  model: string;
  messages: Message[];
  memory: DecisionMemory;
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * Extracción automática de decisiones (detección LLM-based, §9). Pensada para
 * correr en background tras la respuesta del agente (fire-and-forget). Errores
 * solo se registran, nunca se propagan. Devuelve el nº de decisiones añadidas.
 */
export async function extractAndStore(opts: ExtractOptions): Promise<number> {
  try {
    const { provider, model, memory, sessionId } = opts;
    const signal = opts.signal ?? AbortSignal.timeout(30000);

    // Ventana reciente, solo mensajes con texto de usuario/asistente.
    const recent = opts.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && messageText(m))
      .slice(-CONTEXT_WINDOW);
    if (recent.length < 2) return 0;

    // Aplanar a UN mensaje de usuario: pasarlo como conversación hace que el
    // modelo la "continúe" en vez de analizarla y devuelve [] sistemáticamente.
    const transcript = recent.map((m) => `${m.role}: ${messageText(m)}`).join('\n\n');
    const extractionMessages: Message[] = [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          'Conversación a analizar:\n\n' +
          transcript +
          '\n\nDevuelve ahora el array JSON de decisiones duraderas (o [] si no hay).',
      },
    ];

    let raw = '';
    try {
      raw = await gatherCompletion(provider, extractionMessages, model, signal);
    } catch {
      return 0;
    }

    const candidates = parseDecisionsJson(raw);
    if (candidates.length === 0) return 0;

    let added = 0;
    for (const cand of candidates.slice(0, 2)) {
      const input = toDecisionInput(cand, sessionId);
      if (!input) continue;
      // memory.save aplica dedup semántico contra lo ya almacenado.
      const result = await memory.save(input);
      if (!result.deduped) added++;
    }
    return added;
  } catch {
    return 0;
  }
}
