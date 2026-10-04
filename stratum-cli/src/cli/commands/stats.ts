import { Command } from 'commander';
import { readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { loadConfig } from '../../config/loader.js';
import { listTraces, type TraceFileInfo } from '../../trace/store.js';
import { readTraceFile } from '../../trace/read.js';
import { formatStats } from '../../eval/report.js';
import { aggregateStats } from '../../eval/stats.js';

/**
 * `stratum stats` — estadísticas agregadas de las trazas guardadas. Se calculan
 * en local al invocarlo: no hay telemetría ni nada que salga del equipo.
 */

/** Trazas bajo una carpeta cualquiera (p. ej. la de una ejecución de `stratum eval`). */
function tracesUnder(dir: string, out: TraceFileInfo[] = []): TraceFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (st.isDirectory()) tracesUnder(file, out);
      else if (name.endsWith('.jsonl')) {
        out.push({
          sessionId: basename(name, '.jsonl'),
          file,
          updatedAt: st.mtimeMs,
          bytes: st.size,
        });
      }
    } catch {
      /* desapareció entre el listado y el stat */
    }
  }
  return out;
}

export const statsCommand = new Command('stats')
  .description(
    'Local aggregate statistics from the recorded session traces (nothing leaves this machine)',
  )
  .option('--days <n>', 'only sessions touched in the last N days')
  .option('--session <id>', 'only this session')
  .option('--dir <path>', 'read the traces under this folder instead of trace.dir')
  .option('--top <n>', 'rows in the tools and models tables', '10')
  .option('--json', 'machine-readable output')
  .action(
    (opts: { days?: string; session?: string; dir?: string; top: string; json?: boolean }) => {
      let traces = opts.dir ? tracesUnder(resolve(opts.dir)) : listTraces(loadConfig());
      if (opts.session) traces = traces.filter((t) => t.sessionId === opts.session);
      if (opts.days !== undefined) {
        const days = Number(opts.days);
        if (!(days > 0)) {
          process.stderr.write(`--days: "${opts.days}" no es un número de días válido.\n`);
          process.exit(1);
        }
        const since = Date.now() - days * 86_400_000;
        traces = traces.filter((t) => t.updatedAt >= since);
      }
      const stats = aggregateStats(
        traces
          .map((t) => ({
            sessionId: t.sessionId,
            updatedAt: t.updatedAt,
            records: readTraceFile(t.file),
          }))
          .filter((t) => t.records.length > 0),
      );
      process.stdout.write(
        opts.json
          ? JSON.stringify(stats, null, 2) + '\n'
          : formatStats(stats, Math.max(1, parseInt(opts.top, 10) || 10)),
      );
    },
  );
