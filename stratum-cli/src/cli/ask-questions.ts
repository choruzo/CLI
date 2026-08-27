import { createInterface } from 'readline';
import type { QuestionAnswer, QuestionItem } from '../agent/types.js';

/**
 * Gate de la tool `question` para los comandos no-Ink (`run`, `init`).
 *
 * Devuelve `undefined` cuando no hay TTY (CI/piped): sin callback, el loop
 * inyecta "usuario no disponible" y el agente continúa con supuestos — nunca
 * se queda esperando una respuesta que nadie va a escribir.
 *
 * Las preguntas se imprimen en stderr (stdout es la salida del agente). Con
 * opciones se responde por número; Enter en blanco omite la pregunta.
 */
export function makeCliQuestionAsker():
  | ((questions: QuestionItem[]) => Promise<QuestionAnswer[] | null>)
  | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;

  return async (questions: QuestionItem[]): Promise<QuestionAnswer[] | null> => {
    process.stderr.write('\n?  El agente necesita que decidas algo:\n');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answers: QuestionAnswer[] = [];
      for (const [i, q] of questions.entries()) {
        process.stderr.write(`\n   (${i + 1}/${questions.length}) ${q.question}\n`);
        const options = q.options ?? [];
        for (const [j, opt] of options.entries()) {
          process.stderr.write(`     ${j + 1}) ${opt}\n`);
        }
        const prompt = options.length > 0 ? '   > (número o texto libre) ' : '   > ';
        const raw = (await new Promise<string>((resolve) => rl.question(prompt, resolve))).trim();
        const asNumber = Number.parseInt(raw, 10);
        const chosen =
          options.length > 0 &&
          String(asNumber) === raw &&
          asNumber >= 1 &&
          asNumber <= options.length
            ? options[asNumber - 1]!
            : raw;
        answers.push({ question: q.question, answer: chosen });
      }
      process.stderr.write('\n');
      return answers;
    } finally {
      rl.close();
    }
  };
}
