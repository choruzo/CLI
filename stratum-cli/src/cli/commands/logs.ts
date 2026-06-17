import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { logFilePath } from '../../logging/index.js';
import type { LogRecord } from '../../logging/index.js';

/**
 * `stratum logs` — utilidades sobre el fichero de logs JSONL.
 *
 * Pensado para soporte/bug reports: permite localizar el fichero y revisar las
 * últimas entradas sin abrir un editor. El fichero solo existe si el sink de
 * fichero estuvo activo (`logging.file.enabled`, `--debug` o `STRATUM_LOG_FILE=1`).
 */

const LEVEL_COLOR: Record<string, (s: string) => string> = {
  trace: chalk.gray,
  debug: chalk.cyan,
  info: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
};

function formatRecord(r: LogRecord, color: boolean): string {
  const paint = color ? (LEVEL_COLOR[r.level] ?? ((s: string) => s)) : (s: string) => s;
  const time = r.time.slice(11, 23);
  const label = r.level.toUpperCase().padEnd(5);
  let fields = '';
  if (r.fields) {
    fields = Object.entries(r.fields)
      .map(([k, v]) => ` ${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('');
  }
  let line = `${time} ${paint(label)} ${r.ns}: ${r.msg}${fields}`;
  if (r.err) line += `\n        ${r.err.name}: ${r.err.message}`;
  return line;
}

const pathSub = new Command('path').description('Print the log file path').action(() => {
  const config = loadConfig();
  process.stdout.write(logFilePath(config) + '\n');
});

const tailSub = new Command('tail')
  .description('Print the last N log entries (default 50)')
  .argument('[n]', 'number of entries', '50')
  .option('--raw', 'print raw JSON lines instead of formatted output')
  .action((n: string, opts: { raw?: boolean }) => {
    const config = loadConfig();
    const file = logFilePath(config);
    if (!existsSync(file)) {
      process.stderr.write(
        `No log file at ${file}\n` +
          `Enable it with "logging.file.enabled": true, --debug, or STRATUM_LOG_FILE=1.\n`,
      );
      process.exit(1);
    }
    const count = Math.max(1, parseInt(n, 10) || 50);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-count);
    const color = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];
    for (const line of tail) {
      if (opts.raw) {
        process.stdout.write(line + '\n');
        continue;
      }
      try {
        process.stdout.write(formatRecord(JSON.parse(line) as LogRecord, color) + '\n');
      } catch {
        process.stdout.write(line + '\n');
      }
    }
  });

export const logsCommand = new Command('logs')
  .description('Inspect the Stratum log file (path, tail)')
  .addCommand(pathSub)
  .addCommand(tailSub);
