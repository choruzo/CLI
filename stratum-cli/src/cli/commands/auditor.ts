import { Command } from 'commander';
import { existsSync } from 'fs';
import { loadConfig } from '../../config/loader.js';
import { listTraces, traceFilePath } from '../../trace/store.js';
import { startAuditorServer } from '../../trace/server.js';
import { openInBrowser } from '../../trace/open-browser.js';

/**
 * `stratum auditor [sessionId]` — visor de trayectoria de una sesión guardada
 * (o de una que sigue viva en otra terminal: el visor sigue el fichero según
 * crece). Dentro del chat, el equivalente para la sesión en curso es `/auditor`.
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const listSub = new Command('list')
  .description('List the sessions that have a recorded trace')
  .option('--last <n>', 'show only the N most recent', '20')
  .action((opts: { last: string }) => {
    const config = loadConfig();
    const traces = listTraces(config).slice(0, Math.max(1, parseInt(opts.last, 10) || 20));
    if (traces.length === 0) {
      process.stdout.write('No hay trazas guardadas.\n');
      return;
    }
    for (const t of traces) {
      process.stdout.write(
        `${t.sessionId}  ${new Date(t.updatedAt).toLocaleString()}  ${formatBytes(t.bytes)}\n`,
      );
    }
  });

export const auditorCommand = new Command('auditor')
  .description('Open the trajectory viewer (timeline of everything the agent did) for a session')
  .argument('[sessionId]', 'session to inspect (default: the most recent one)')
  .option('--no-open', 'do not launch the browser, just print the URL')
  .option('--port <n>', 'port to listen on (default: a free one)')
  .addCommand(listSub)
  .action(async (sessionId: string | undefined, opts: { open: boolean; port?: string }) => {
    const config = loadConfig();
    let id = sessionId;
    if (!id) {
      id = listTraces(config)[0]?.sessionId;
      if (!id) {
        process.stderr.write('No hay trazas guardadas todavía.\n');
        process.exit(1);
      }
    }
    const file = traceFilePath(config, id);
    if (!file || !existsSync(file)) {
      process.stderr.write(
        `No hay traza para la sesión "${id}". Usa "stratum auditor list" para ver las disponibles.\n`,
      );
      process.exit(1);
    }
    const port = opts.port ? parseInt(opts.port, 10) : undefined;
    if (port !== undefined && !(port > 0 && port < 65536)) {
      process.stderr.write(`--port: "${opts.port}" no es un puerto válido.\n`);
      process.exit(1);
    }

    const server = await startAuditorServer({ file, sessionId: id, port });
    process.stdout.write(`Trayectoria de ${id}: ${server.url}\n`);
    if (opts.open && !(await openInBrowser(server.url))) {
      process.stderr.write('No se pudo abrir el navegador: abre esa URL a mano.\n');
    }
    process.stderr.write('Ctrl+C para cerrar el visor.\n');

    // El servidor no retiene el proceso (va con `unref`): se espera a la señal.
    const keepAlive = setInterval(() => {}, 60_000);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    clearInterval(keepAlive);
    await server.close();
  });
