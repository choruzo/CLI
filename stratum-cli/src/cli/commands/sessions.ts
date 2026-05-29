import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { SessionStore, parseDuration } from '../../session/store.js';
import { resolveMemoryPaths } from '../../config/paths.js';

function getStore(): SessionStore {
  const config = loadConfig();
  const paths = resolveMemoryPaths(config);
  return new SessionStore(paths.sessionsDir);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

const sessionsList = new Command('list')
  .description('List saved sessions')
  .option('--last <n>', 'show only the last N sessions', '10')
  .action((opts: { last?: string }) => {
    const store = getStore();
    const last = opts.last ? parseInt(opts.last, 10) : 10;
    const sessions = store.list({ last });

    if (sessions.length === 0) {
      process.stdout.write('No hay sesiones guardadas.\n');
      return;
    }

    process.stdout.write(`\nSesiones guardadas (${sessions.length}):\n\n`);
    for (const s of sessions) {
      const summary = s.summary ? `  ${s.summary}` : '';
      process.stdout.write(`  ${s.id}\n`);
      process.stdout.write(
        `    ${formatDate(s.updatedAt)} │ ${s.provider} / ${s.model}${summary}\n\n`,
      );
    }
  });

const sessionsResume = new Command('resume')
  .description('Resume a saved session')
  .argument('<id>', 'session ID to resume')
  .action((id: string) => {
    // Verificar que la sesión existe antes de delegar a chat
    const store = getStore();
    try {
      store.load(id); // lanza si no existe
    } catch (err) {
      process.stderr.write(`Error: ${String(err)}\n`);
      process.exit(1);
    }

    // Delegar a chat --resume
    // Importar dinámicamente para evitar ciclos
    import('./chat.js')
      .then(({ chatCommand }) => {
        chatCommand.parse(['--resume', id], { from: 'user' });
      })
      .catch((err: unknown) => {
        process.stderr.write(`Error: ${String(err)}\n`);
        process.exit(1);
      });
  });

const sessionsDelete = new Command('delete')
  .description('Delete a saved session')
  .argument('<id>', 'session ID to delete')
  .action((id: string) => {
    const store = getStore();
    try {
      store.delete(id);
      process.stdout.write(`Sesión "${id}" eliminada.\n`);
    } catch (err) {
      process.stderr.write(`Error: ${String(err)}\n`);
      process.exit(1);
    }
  });

const sessionsPrune = new Command('prune')
  .description('Remove sessions older than a given age')
  .option('--older <duration>', 'remove sessions older than this duration (e.g. 30d)', '30d')
  .action((opts: { older?: string }) => {
    const durationStr = opts.older ?? '30d';
    let olderThanMs: number;
    try {
      olderThanMs = parseDuration(durationStr);
    } catch (err) {
      process.stderr.write(`Error: ${String(err)}\n`);
      process.exit(1);
      return;
    }

    const store = getStore();
    const deleted = store.prune(olderThanMs);
    process.stdout.write(`${deleted} sesión(es) eliminada(s) (más antiguas de ${durationStr}).\n`);
  });

export const sessionsCommand = new Command('sessions')
  .description('Manage saved conversation sessions')
  .addCommand(sessionsList)
  .addCommand(sessionsResume)
  .addCommand(sessionsDelete)
  .addCommand(sessionsPrune);
