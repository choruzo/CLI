import { createInterface } from 'readline';
import { dirname } from 'path';
import chalk from 'chalk';
import { askLine } from './readline-prompt.js';
import {
  declineProjectPreset,
  projectPresetOffer,
  writeProjectPreset,
} from '../config/project-preset.js';

/**
 * Al abrir `chat` en una carpeta sin config de proyecto, ofrece crear la
 * mínima (`config/project-preset.ts`) una sola vez: un «no» se recuerda para
 * esa carpeta. Va antes de montar Ink, con readline, y solo con terminal.
 * `STRATUM_NO_PROJECT_PROMPT=1` la salta (el arnés de la TUI lo pone). Nunca
 * impide arrancar: un fallo se avisa y `chat` sigue con lo que haya.
 */
export async function offerProjectConfig(cwd: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  if (process.env.STRATUM_NO_PROJECT_PROMPT) return;

  let path: string | null;
  try {
    path = projectPresetOffer(cwd);
  } catch {
    return;
  }
  if (!path) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string | null;
  try {
    process.stdout.write(
      `\n  Esta carpeta no tiene config de proyecto.\n` +
        chalk.dim(
          `  Se crearía ${path} con los turnos del agente, los subagentes y la memoria\n` +
            `  del proyecto; lo demás se sigue heredando de la global.\n`,
        ),
    );
    answer = await askLine(rl, '  ¿Crearla? [S/n] ');
  } finally {
    rl.close();
  }
  // Ctrl+C: ni se crea ni se recuerda, y `chat` no arranca.
  if (answer === null) {
    process.stdout.write('\n');
    process.exit(130);
  }

  try {
    if (/^n/i.test(answer.trim())) {
      declineProjectPreset(dirname(path));
      process.stdout.write(
        chalk.dim('  No se volverá a preguntar aquí. `stratum config` la crea cuando quieras.\n\n'),
      );
    } else if (writeProjectPreset(path)) {
      process.stdout.write(
        `  ${chalk.green('✓')} ${path} creada. Ajústala con \`stratum config\`.\n\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `  No se pudo crear la config de proyecto: ${err instanceof Error ? err.message : String(err)}\n\n`,
    );
  }
}
