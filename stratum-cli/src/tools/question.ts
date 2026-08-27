import { z } from 'zod';
import type { QuestionAnswer, QuestionItem, ToolDefinition, ToolResult } from '../agent/types.js';

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
            'Opciones sugeridas entre las que elegir. Omítelas para respuesta libre. ' +
              `Máximo ${MAX_OPTIONS}.`,
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
    'Cada pregunta puede traer opciones sugeridas; sin opciones, la respuesta es libre. ' +
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

/**
 * Normaliza los argumentos crudos de la tool a `QuestionItem[]`. El loop la usa
 * antes de abrir el gate: el modelo puede emitir formas laxas (opciones vacías,
 * strings sueltos, más preguntas de la cuenta).
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
    const options = Array.isArray(rawOptions)
      ? rawOptions
          .map((o) => String(o ?? '').trim())
          .filter((o) => o.length > 0)
          .slice(0, MAX_OPTIONS)
      : undefined;
    items.push(
      options && options.length > 0
        ? { question: question.trim(), options }
        : { question: question.trim() },
    );
  }
  return items;
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
  const unanswered =
    !answers || answers.length === 0 || answers.every((a) => !a.answer.trim().length);
  if (unanswered) {
    return (
      '<question_answers unavailable="true">\n' +
      'El usuario no respondió (sesión no interactiva o preguntas omitidas). ' +
      'No vuelvas a llamar a `question`: continúa con los supuestos más razonables ' +
      'y deja constancia de ellos en tu respuesta o en el fichero que escribas.\n' +
      '</question_answers>'
    );
  }
  const byQuestion = new Map(answers.map((a) => [a.question, a.answer]));
  const lines = questions.map((q, i) => {
    const answer = (byQuestion.get(q.question) ?? answers[i]?.answer ?? '').trim();
    return (
      `  <item>\n` +
      `    <question>${q.question}</question>\n` +
      `    <answer>${answer || '(sin respuesta)'}</answer>\n` +
      `  </item>`
    );
  });
  return `<question_answers>\n${lines.join('\n')}\n</question_answers>`;
}
