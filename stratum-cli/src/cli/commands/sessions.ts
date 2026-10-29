import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { SessionStore, describeSkippedSessions, parseDuration } from '../../session/store.js';
import { resolveMemoryPaths } from '../../config/paths.js';
import {
  deleteSessionWithArtifacts,
  describeArtifacts,
  pruneSessionsWithArtifacts,
} from '../../session/cleanup.js';
import { deleteTrace, pruneTraces } from '../../trace/store.js';
import {
  SESSION_EXPORT_FORMATS,
  exportSession,
  type SessionExportFormat,
} from '../../session/export.js';
import { redactText } from '../../security/redact-output.js';
import { writeFileAtomic } from '../../config/writer.js';

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
    const { sessions, skipped } = store.scan({ last });
    const skippedNotice = describeSkippedSessions(skipped);
    if (skippedNotice) process.stderr.write(`${skippedNotice}\n`);

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
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    // Delegar a chat --resume
    // Importar dinámicamente para evitar ciclos
    import('./chat.js')
      .then(({ chatCommand }) => {
        chatCommand.parse(['--resume', id], { from: 'user' });
      })
      .catch((err: unknown) => {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
  });

const sessionsDelete = new Command('delete')
  .description('Delete a saved session')
  .argument('<id>', 'session ID to delete')
  .action((id: string) => {
    const store = getStore();
    try {
      const removed = deleteSessionWithArtifacts(store, id);
      deleteTrace(loadConfig(), id);
      process.stdout.write(`Sesión "${id}" eliminada${describeArtifacts(removed)}.\n`);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

const sessionsExport = new Command('export')
  .description('Export a saved session as JSON or Markdown (secrets redacted)')
  .argument('<id>', 'session ID to export')
  .option('--format <format>', `output format: ${SESSION_EXPORT_FORMATS.join(' | ')}`, 'markdown')
  .option('-o, --output <file>', 'write to this file instead of stdout')
  .action((id: string, opts: { format: string; output?: string }) => {
    const format = opts.format as SessionExportFormat;
    if (!SESSION_EXPORT_FORMATS.includes(format)) {
      process.stderr.write(
        `Error: formato "${opts.format}" no válido (usa ${SESSION_EXPORT_FORMATS.join(' o ')}).\n`,
      );
      process.exit(1);
    }
    try {
      const config = loadConfig();
      const store = new SessionStore(resolveMemoryPaths(config).sessionsDir);
      const text = exportSession(store.load(id), format, (t) => redactText(t, config));
      if (opts.output) {
        writeFileAtomic(opts.output, text);
        process.stderr.write(`Sesión "${id}" exportada a ${opts.output}.\n`);
      } else {
        process.stdout.write(text);
      }
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
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
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
      return;
    }

    const store = getStore();
    const { sessions, subagents, plans } = pruneSessionsWithArtifacts(
      store,
      olderThanMs,
      process.cwd(),
    );
    // Las trazas son derivadas de la sesión: se van con el mismo umbral.
    pruneTraces(loadConfig(), olderThanMs);
    process.stdout.write(
      `${sessions} sesión(es), ${subagents} registro(s) de subagente y ${plans} plan(es) ` +
        `eliminados (más antiguos de ${durationStr}).\n`,
    );
  });

export const sessionsCommand = new Command('sessions')
  .description('Manage saved conversation sessions')
  .addCommand(sessionsList)
  .addCommand(sessionsResume)
  .addCommand(sessionsDelete)
  .addCommand(sessionsExport)
  .addCommand(sessionsPrune);
