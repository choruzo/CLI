import { homedir } from 'os';
import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { resolveSessionStartup } from '../../host/session-startup.js';
import {
  ImportStateError,
  discoverLegacyConversations,
  legacyDesktopDir,
  legacyWorkspacesRoot,
  readImportState,
  writeImportState,
} from '../../migrate/desktop-legacy.js';
import { importConversation } from '../../migrate/desktop-import.js';
import { locateLiveDaemon, startDaemonAndWait } from '../daemon-link.js';
import { cliVersion } from '../version.js';

/**
 * `stratum desktop import` (M12): las conversaciones de Stratum Desktop de
 * antes de M12 pasan a ser sesiones normales de `stratumd`, una vez. Ver
 * `migrate/desktop-legacy.ts`. Lo de Desktop no se borra ni se modifica.
 */

export const desktopCommand = new Command('desktop').description('Stratum Desktop helpers');

desktopCommand
  .command('import')
  .description(
    'Move the conversations of Stratum Desktop (before M12) into stratumd, once: they become normal sessions',
  )
  .option('--dry-run', 'only list what would be imported')
  .option('--json', 'machine-readable output')
  .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
    const out = (data: Record<string, unknown>, text: string): void => {
      process.stdout.write(opts.json ? `${JSON.stringify(data)}\n` : `${text}\n`);
    };
    const home = homedir();
    const desktopDir = legacyDesktopDir(home);
    let state;
    try {
      state = readImportState(desktopDir);
    } catch (err) {
      process.stderr.write(`${err instanceof ImportStateError ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
    let root: string;
    try {
      root = legacyWorkspacesRoot(loadConfig(home), home);
    } catch (err) {
      process.stderr.write(
        `Cannot load the configuration: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const found = discoverLegacyConversations({ desktopDir, workspacesRoot: root, state });
    const plan = found.conversations.map((c) => ({
      conversationId: c.conversationId,
      title: c.title,
      turns: c.turns.length,
      files: c.folderExists ? 'kept' : c.archived ? 'archived (not restored)' : 'none',
    }));
    if (opts.dryRun || found.conversations.length === 0) {
      out(
        { conversations: plan, skipped: found.skipped },
        found.conversations.length === 0
          ? 'Nothing to import from Stratum Desktop.'
          : [
              `${found.conversations.length} conversation(s) would be imported:`,
              ...plan.map(
                (p) =>
                  `  ${p.conversationId}  ${p.title || '(untitled)'}  · ${p.turns} turn(s) · files ${p.files}`,
              ),
            ].join('\n'),
      );
      for (const s of found.skipped)
        process.stderr.write(`skipped ${s.conversationId}: ${s.reason}\n`);
      return;
    }

    // El daemon, por el mecanismo oficial: el que haya o `stratum daemon start`.
    let daemon = await locateLiveDaemon();
    if (daemon.status !== 'found') daemon = await startDaemonAndWait(15_000);
    if (daemon.status !== 'found') {
      process.stderr.write(
        'No Stratum daemon is running and it could not be started (stratum daemon start).\n',
      );
      process.exitCode = 1;
      return;
    }

    const results: Array<{
      conversationId: string;
      status: string;
      sessionId?: string;
      reason?: string;
    }> = [];
    for (const conv of found.conversations) {
      const outcome = await importConversation(conv, {
        version: cliVersion(),
        startup: async (cwd) => {
          const s = await resolveSessionStartup({ cwd });
          return s.ok
            ? { ok: true, config: s.config, router: s.router }
            : { ok: false, error: s.error };
        },
      });
      if (outcome.status !== 'failed') {
        // Anotado en cuanto se sabe: un corte a mitad no repite lo ya hecho.
        state.conversations[conv.conversationId] = {
          status: outcome.status,
          sessionId: outcome.sessionId,
          at: new Date().toISOString(),
        };
        writeImportState(desktopDir, state);
      }
      results.push({
        conversationId: conv.conversationId,
        status: outcome.status,
        ...(outcome.status === 'failed'
          ? { reason: outcome.reason }
          : { sessionId: outcome.sessionId }),
      });
    }
    const imported = results.filter((r) => r.status === 'imported').length;
    out(
      { results, skipped: found.skipped },
      [
        ...results.map((r) =>
          r.status === 'imported'
            ? `imported ${r.conversationId} → ${r.sessionId}`
            : r.status === 'unknown'
              ? `unknown  ${r.conversationId}: no answer from the daemon; check \`stratum ps\` (it is not retried)`
              : `failed   ${r.conversationId}: ${r.reason}`,
        ),
        `${imported} of ${results.length} imported. Open them in Stratum Desktop, Stratum Dot or with \`stratum attach <id>\`.`,
      ].join('\n'),
    );
    if (results.some((r) => r.status !== 'imported')) process.exitCode = 1;
  });
