import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import type {
  QuestionAnswer,
  QuestionItem,
  QuestionOption,
  ToolDefinition,
  ToolResult,
} from '../agent/types.js';

/** Nombre de la tool de control de preguntas al usuario (Hito 2.5, F7). */
export const QUESTION_TOOL = 'question';

/** Tope de preguntas por tanda: es una tanda ÚNICA, no un interrogatorio. */
export const MAX_QUESTIONS = 4;
/** Tope de opciones por pregunta (caben en una pantalla del selector Ink). */
export const MAX_OPTIONS = 6;

const schema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).describe('La pregunta, concreta y en una frase'),
        options: z
          .array(z.string().min(1))
          .max(MAX_OPTIONS)
          .optional()
          .describe(
            'Opciones cerradas entre las que elegir. Omítelas para respuesta libre. ' +
              `Máximo ${MAX_OPTIONS}.`,
          ),
        allowCustom: z
          .boolean()
          .optional()
          .describe(
            'Solo con opciones: permite además una respuesta escrita a mano. ' +
              'Por defecto false — las opciones son el dominio completo de respuesta.',
          ),
      }),
    )
    .min(1)
    .max(MAX_QUESTIONS)
    .describe(`Todas las preguntas de la tanda, máximo ${MAX_QUESTIONS}`),
});

/**
 * Tool de control interceptada por el `ReactLoop` (como `present_plan`): nunca
 * se despacha. Pausa el turno, muestra la tanda de preguntas al usuario (Ink en
 * `chat`, readline en `run`/`init`) y devuelve las respuestas como tool result.
 *
 * Si no hay usuario disponible (CI/piped sin TTY) el loop inyecta un resultado
 * indicando que continúe con supuestos razonables — nunca bloquea.
 */
export const questionTool: ToolDefinition = {
  name: QUESTION_TOOL,
  description:
    'Pregunta al usuario cuando algo importante no se puede deducir del repositorio y una decisión ' +
    'equivocada cambiaría el trabajo por completo. Envía TODAS tus dudas en una sola llamada ' +
    `(máximo ${MAX_QUESTIONS}) y solo una vez por turno: no es un chat. ` +
    'Cada pregunta puede traer opciones cerradas; sin opciones, la respuesta es libre. ' +
    'Con opciones, solo se acepta una de ellas: añade allowCustom si una respuesta escrita a mano ' +
    'también sirve. ' +
    'No la uses para lo que puedes averiguar leyendo ficheros ni para pedir permiso de ejecución.',
  schema,
  destructive: false,
  serialized: true,

  async execute(): Promise<ToolResult> {
    return {
      ok: false,
      error: 'question solo está disponible dentro del loop interactivo.',
      recoverable: false,
    };
  },
};

// Alfabeto sin guiones para que el token sea limpio en logs y en el XML del
// tool result. 6 caracteres: el token vive un solo turno.
const optionToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);

/** Token opaco de una opción. No codifica el ordinal ni la etiqueta. */
export function makeOptionId(): string {
  return `opt_${optionToken()}`;
}

/**
 * Normaliza los argumentos crudos de la tool a `QuestionItem[]`. El loop la usa
 * antes de abrir el gate: el modelo puede emitir formas laxas (opciones vacías,
 * strings sueltos, más preguntas de la cuenta).
 *
 * Aquí es donde cada opción recibe su token opaco. El envelope resultante es la
 * única fuente de verdad del dominio de respuesta: `resolveQuestionAnswers` no
 * acepta nada que no esté en él.
 */
export function parseQuestionInput(input: unknown): QuestionItem[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  const items: QuestionItem[] = [];
  for (const entry of raw) {
    if (items.length >= MAX_QUESTIONS) break;
    const question =
      typeof entry === 'string'
        ? entry
        : String((entry as { question?: unknown })?.question ?? '').trim();
    if (!question.trim()) continue;
    const rawOptions = (entry as { options?: unknown })?.options;
    const labels = Array.isArray(rawOptions)
      ? rawOptions
          .map((o) => String(o ?? '').trim())
          .filter((o) => o.length > 0)
          .slice(0, MAX_OPTIONS)
      : [];
    // Etiquetas duplicadas harían ambigua cualquier resolución por texto; se
    // colapsan aquí, donde todavía es barato.
    const unique = labels.filter((l, i) => labels.findIndex((o) => sameLabel(o, l)) === i);
    if (unique.length === 0) {
      items.push({ question: question.trim() });
      continue;
    }
    const options: QuestionOption[] = unique.map((label) => ({ id: makeOptionId(), label }));
    const allowCustom = (entry as { allowCustom?: unknown })?.allowCustom === true;
    items.push({ question: question.trim(), options, ...(allowCustom ? { allowCustom } : {}) });
  }
  return items;
}

function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Una respuesta rechazada por no caer dentro del dominio de la pregunta. */
export interface AnswerRejection {
  question: string;
  reason: string;
}

export interface ResolvedQuestionAnswers {
  answers: QuestionAnswer[];
  rejections: AnswerRejection[];
}

/**
 * Valida las respuestas contra el envelope original y las canoniza (§3 de la
 * investigación `gentle-pi`). Un gate puede devolver cualquier cosa —un token
 * que ya no existe, el texto de una opción escrito a mano, algo que se parece a
 * dos opciones— y el loop nunca debe adivinar cuál era la intención:
 *
 * - `optionId` debe casar con **exactamente una** opción de esa pregunta.
 * - Texto libre solo se admite si la pregunta no tiene opciones o declara
 *   `allowCustom`.
 * - Con opciones y sin `allowCustom`, el texto se acepta solo si coincide
 *   exactamente (trim + case-insensitive) con **una** etiqueta. Cero
 *   coincidencias y más de una se rechazan igual.
 * - Vacío es la omisión legítima del usuario, no un rechazo.
 *
 * Una respuesta rechazada se propaga como pregunta sin responder más el motivo,
 * nunca como una elección aproximada.
 */
export function resolveQuestionAnswers(
  questions: QuestionItem[],
  raw: QuestionAnswer[] | null,
): ResolvedQuestionAnswers {
  if (!raw || raw.length === 0) return { answers: [], rejections: [] };

  const answers: QuestionAnswer[] = [];
  const rejections: AnswerRejection[] = [];
  const used = new Set<number>();

  questions.forEach((q, i) => {
    // Emparejado por texto de la pregunta; el índice es el fallback para gates
    // que devuelven solo la respuesta en orden.
    let at = raw.findIndex((a, j) => !used.has(j) && a.question === q.question);
    if (at < 0 && raw[i] !== undefined && !used.has(i)) at = i;
    if (at < 0) return;
    used.add(at);

    const incoming = raw[at]!;
    const text = (incoming.answer ?? '').trim();
    const options = q.options ?? [];

    if (options.length === 0) {
      if (text) answers.push({ question: q.question, answer: text });
      return;
    }

    if (incoming.optionId !== undefined) {
      const matches = options.filter((o) => o.id === incoming.optionId);
      if (matches.length === 1) {
        answers.push({ question: q.question, answer: matches[0]!.label, optionId: matches[0]!.id });
      } else {
        rejections.push({
          question: q.question,
          reason: `respuesta descartada: el token "${incoming.optionId}" no corresponde a ninguna de las opciones ofrecidas`,
        });
      }
      return;
    }

    if (!text) return;

    if (q.allowCustom) {
      answers.push({ question: q.question, answer: text });
      return;
    }

    const byLabel = options.filter((o) => sameLabel(o.label, text));
    if (byLabel.length === 1) {
      answers.push({ question: q.question, answer: byLabel[0]!.label, optionId: byLabel[0]!.id });
      return;
    }
    rejections.push({
      question: q.question,
      reason:
        byLabel.length === 0
          ? 'respuesta descartada: no coincide con ninguna de las opciones ofrecidas y la pregunta no admitía texto libre'
          : 'respuesta descartada: coincide con más de una opción',
    });
  });

  return { answers, rejections };
}

/**
 * Serializa las respuestas como tool result. `null` (o todas vacías) significa
 * que no hubo usuario: se instruye explícitamente a seguir sin volver a
 * preguntar, para que un modelo pequeño no entre en bucle de preguntas.
 */
export function formatQuestionAnswers(
  questions: QuestionItem[],
  answers: QuestionAnswer[] | null,
): string {
  const { answers: resolved, rejections } = resolveQuestionAnswers(questions, answers);

  if (resolved.length === 0) {
    const note = rejections.length
      ? 'Las respuestas recibidas quedaron fuera del dominio de la pregunta y se descartaron. '
      : 'El usuario no respondió (sesión no interactiva o preguntas omitidas). ';
    return (
      '<question_answers unavailable="true">\n' +
      note +
      'No vuelvas a llamar a `question`: continúa con los supuestos más razonables ' +
      'y deja constancia de ellos en tu respuesta o en el fichero que escribas.\n' +
      '</question_answers>'
    );
  }

  const byQuestion = new Map(resolved.map((a) => [a.question, a]));
  const rejected = new Map(rejections.map((r) => [r.question, r.reason]));
  const lines = questions.map((q) => {
    const answer = byQuestion.get(q.question);
    const text = answer?.answer ?? rejected.get(q.question) ?? '(sin respuesta)';
    return (
      `  <item>\n` +
      `    <question>${q.question}</question>\n` +
      `    <answer>${text}</answer>\n` +
      `  </item>`
    );
  });

  const tail =
    resolved.length < questions.length
      ? '\n  <note>Las preguntas sin respuesta quedan a tu criterio: sigue con el supuesto más ' +
        'razonable y dilo explícitamente. No repitas la tanda en este turno.</note>'
      : '';

  return `<question_answers>\n${lines.join('\n')}${tail}\n</question_answers>`;
}
