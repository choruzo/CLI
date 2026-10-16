import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import { fileDiscovery } from '../../client/discovery.js';
import { ProtocolError } from '../../ipc/codec.js';
import { UnknownOutcomeError } from '../../ipc/peer.js';
import { describeDetachRefusal } from '../handoff-text.js';
import { describeHost } from '../attach-view.js';
import { cliVersion } from '../version.js';

/**
 * `stratum detach <id>`: que una sesión que aloja una terminal (`stratum chat`)
 * pase a alojarla `stratumd`, con el mismo id y el mismo contexto. Lo hace la
 * propia terminal, que es quien sabe si puede soltarla; aquí solo se pide y se
 * dice cómo acabó. Si la respuesta no llega, **no se reintenta**: se vuelve a
 * preguntar quién aloja la sesión.
 */

async function connect(): Promise<StratumClient> {
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum detach', version: cliVersion(), roles: ['operator'] },
    reconnect: false,
    requestTimeoutMs: 10_000,
  });
  await client.connect();
  return client;
}

export const detachCommand = new Command('detach')
  .description(
    'Hand a terminal-hosted session over to stratumd (same id and context): it survives its terminal',
  )
  .argument('<session-id>', 'id of a live session (see `stratum ps`)')
  .option('--json', 'machine-readable output')
  .action(async (sessionId: string, opts: { json?: boolean }) => {
    const say = (data: Record<string, unknown>, text: string): void => {
      process.stdout.write(opts.json ? `${JSON.stringify(data)}\n` : `${text}\n`);
    };
    let client: StratumClient;
    try {
      client = await connect();
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      const result = await client.request(
        'sessions.detach',
        { sessionId, operationId: `detach-${randomUUID()}` },
        // Incluye que el daemon monte la sesión (servers MCP, provider).
        { timeoutMs: 150_000 },
      );
      say(
        { status: result.status, session: result.session },
        result.status === 'detached'
          ? `Session ${sessionId} is now hosted by stratumd. Its terminal may exit.\n` +
              `Continue with: stratum attach ${sessionId}`
          : `Session ${sessionId} was already hosted by stratumd.`,
      );
    } catch (err) {
      process.exitCode = 1;
      if (err instanceof ProtocolError) {
        const reason = typeof err.data?.reason === 'string' ? err.data.reason : undefined;
        say(
          { status: 'refused', code: err.code, ...(reason ? { reason } : {}) },
          `Not handed off: ${describeDetachRefusal(err.code, reason)}.`,
        );
        return;
      }
      if (!(err instanceof UnknownOutcomeError)) {
        say(
          { status: 'error' },
          `Cannot hand it off: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      // Sin respuesta: puede haberse hecho. Se pregunta, no se repite.
      client.close();
      try {
        const fresh = await connect();
        try {
          const { snapshot } = await fresh.request('sessions.get', { sessionId });
          const host = snapshot.session.host.kind;
          if (host === 'daemon') process.exitCode = 0;
          say(
            { status: 'unknown', host },
            `No answer from stratumd; the session is now hosted by ${describeHost(snapshot.session)}.`,
          );
        } finally {
          fresh.close();
        }
      } catch {
        say(
          { status: 'unknown' },
          'No answer from stratumd, and it cannot be asked now. Check with `stratum ps`.',
        );
      }
    } finally {
      client.close();
    }
  });
