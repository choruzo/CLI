import { createInterface } from 'readline';
import { askLine } from './readline-prompt.js';
import type { QuestionAnswer, QuestionItem } from '../agent/types.js';

/**
 * Gate de la tool `question` para los comandos no-Ink (`run`, `init`).
 *
 * Devuelve `undefined` cuando no hay TTY (CI/piped): sin callback, el loop
 * inyecta "usuario no disponible" y el agente continúa con supuestos — nunca
 * se queda esperando una respuesta que nadie va a escribir.
 *
 * Las preguntas se imprimen en stderr (stdout es la salida del agente). Con
 * opciones se responde por número y se devuelve el **token opaco** de la opción
 * elegida, nunca el ordinal ni la etiqueta reconstruida: el loop resuelve la
 * etiqueta desde el envelope original (ver `resolveQuestionAnswers`). El texto
 * libre solo se ofrece si la pregunta no tiene opciones o declara `allowCustom`;
 * en el resto de los casos, un número fuera de rango se vuelve a pedir en lugar
 * de colarse como respuesta escrita.
 */
export function makeCliQuestionAsker():
  | ((questions: QuestionItem[]) => Promise<QuestionAnswer[] | null>)
  | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;

  return async (questions: QuestionItem[]): Promise<QuestionAnswer[] | null> => {
    process.stderr.write('\n?  El agente necesita que decidas algo:\n');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    // Ctrl+C (o EOF) en mitad de la tanda: se abandona entera y el comando
    // cancela el turno (§12.12). `null` = el usuario no respondió.
    class Interrupted extends Error {}
    const ask = async (prompt: string): Promise<string> => {
      const answer = await askLine(rl, prompt);
      if (answer === null) throw new Interrupted();
      return answer;
    };

    try {
      const answers: QuestionAnswer[] = [];
      for (const [i, q] of questions.entries()) {
        process.stderr.write(`\n   (${i + 1}/${questions.length}) ${q.question}\n`);
        const options = q.options ?? [];
        for (const [j, opt] of options.entries()) {
          process.stderr.write(`     ${j + 1}) ${opt.label}\n`);
        }

        if (options.length === 0) {
          const raw = (await ask('   > ')).trim();
          answers.push({ question: q.question, answer: raw });
          continue;
        }

        const prompt = q.allowCustom
          ? '   > (número o texto libre, Enter omite) '
          : `   > (1-${options.length}, Enter omite) `;

        // Con dominio cerrado se reintenta hasta que la entrada sea un número
        // válido o esté vacía. Aceptar la cadena tal cual sería exactamente el
        // fallo que el token opaco evita: una respuesta que no está en el menú.
        for (;;) {
          const raw = (await ask(prompt)).trim();
          if (!raw) {
            answers.push({ question: q.question, answer: '' });
            break;
          }
          const n = Number.parseInt(raw, 10);
          const picked = String(n) === raw && n >= 1 && n <= options.length;
          if (picked) {
            const option = options[n - 1]!;
            answers.push({ question: q.question, answer: option.label, optionId: option.id });
            break;
          }
          if (q.allowCustom) {
            answers.push({ question: q.question, answer: raw });
            break;
          }
          process.stderr.write(`     Elige un número entre 1 y ${options.length}.\n`);
        }
      }
      process.stderr.write('\n');
      return answers;
    } catch (err) {
      if (err instanceof Interrupted) return null;
      throw err;
    } finally {
      rl.close();
    }
  };
}
