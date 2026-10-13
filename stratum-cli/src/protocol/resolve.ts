import type {
  ProtocolApprovalDecision,
  ProtocolQuestion,
  ProtocolQuestionAnswer,
} from './model.js';

/**
 * Qué respuestas **valen** para una solicitud pendiente. Reglas puras, sobre las
 * formas del protocolo, que aplican igual quien arbitra (el servidor, para no
 * reenviar lo que no puede valer) y quien decide (el anfitrión de la sesión,
 * que es la autoridad). Una respuesta que no vale **no resuelve nada**: la
 * solicitud sigue pendiente.
 */

/** Por qué una respuesta no vale. `path` es el campo de la petición. */
export interface ResolutionIssue {
  path: string;
  message: string;
}

/** Lo que hace falta saber de una aprobación para validar su respuesta. */
export interface ApprovalRules {
  /** La exige una política `confirm-always`. */
  forced?: boolean;
  /** Texto que hay que teclear para aprobar. */
  confirmPhrase?: string;
}

/**
 * - Denegar vale siempre, sin frase.
 * - `allow-all` no vale para una solicitud forzada ni para una con frase: esas
 *   se aprueban de una en una.
 * - Con `confirmPhrase`, aprobar exige la frase exacta.
 */
export function checkApprovalResolution(
  rules: ApprovalRules,
  decision: ProtocolApprovalDecision,
  phrase: string | undefined,
): ResolutionIssue | null {
  if (decision === 'deny') return null;
  if (decision === 'allow-all' && (rules.forced || rules.confirmPhrase !== undefined)) {
    return {
      path: 'decision',
      message: 'this request must be approved on its own: allow-all does not apply to it',
    };
  }
  if (rules.confirmPhrase !== undefined && phrase !== rules.confirmPhrase) {
    return { path: 'phrase', message: 'the confirmation phrase does not match' };
  }
  return null;
}

/**
 * Canoniza una tanda de respuestas contra sus preguntas, o dice por qué no vale.
 *
 * - `null` (omitir la tanda) vale siempre: el agente sigue con supuestos.
 * - Una respuesta por pregunta, en su orden.
 * - Con opciones, la respuesta es **una** de ellas: por su `optionId`, o por una
 *   etiqueta que coincida exactamente con una sola. El texto libre solo vale
 *   si la pregunta lo admite (`allowCustom`) o no tiene opciones.
 * - Nada se aproxima: lo que no encaja se rechaza.
 *
 * El texto de `question` de cada respuesta se toma de la pregunta, no del
 * cliente.
 */
export function checkQuestionAnswers(
  questions: readonly ProtocolQuestion[],
  answers: readonly ProtocolQuestionAnswer[] | null,
): { ok: true; answers: ProtocolQuestionAnswer[] | null } | { ok: false; issue: ResolutionIssue } {
  if (answers === null) return { ok: true, answers: null };
  if (answers.length !== questions.length) {
    return {
      ok: false,
      issue: { path: 'answers', message: `expected ${questions.length} answers, one per question` },
    };
  }
  const out: ProtocolQuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const a = answers[i]!;
    const path = `answers.${i}`;
    const options = q.options ?? [];
    if (a.optionId !== undefined) {
      const option = options.find((o) => o.id === a.optionId);
      if (!option) return { ok: false, issue: { path, message: 'unknown option' } };
      out.push({ question: q.question, answer: option.label, optionId: option.id });
      continue;
    }
    const text = a.answer.trim();
    const matching = options.filter((o) => o.label === text);
    if (matching.length === 1) {
      const option = matching[0]!;
      out.push({ question: q.question, answer: option.label, optionId: option.id });
      continue;
    }
    if (options.length > 0 && q.allowCustom !== true) {
      return { ok: false, issue: { path, message: 'the answer must be one of the options' } };
    }
    if (text.length === 0) return { ok: false, issue: { path, message: 'empty answer' } };
    out.push({ question: q.question, answer: text });
  }
  return { ok: true, answers: out };
}
