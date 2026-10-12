import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import { fileDiscovery } from '../../client/discovery.js';
import type { ProtocolRun, ProtocolSession } from '../../protocol/index.js';
import { cliVersion } from '../version.js';

/**
 * `stratum ps`: las sesiones vivas que conoce `stratumd`, alojadas en él o
 * publicadas por una CLI. Es un cliente más del Stratum Protocol, con rol
 * `observer`: no lee ningún fichero del daemon ni puede cambiar nada.
 */

const ACTIVE: ReadonlySet<ProtocolRun['status']> = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'paused',
]);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** El final de una ruta es lo que la distingue. */
function clipPath(path: string, max: number): string {
  return path.length > max ? `…${path.slice(path.length - max + 1)}` : path;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Dónde corre: `daemon`, o el tipo de cliente que la aloja (`cli`). */
export function hostLabel(session: ProtocolSession): string {
  return session.host.kind === 'daemon' ? 'daemon' : session.host.client;
}

/** El run de una sesión para la tabla: el que tiene en curso o, si no, el último. */
export function runLabel(run: ProtocolRun | undefined, now: number): string {
  if (!run) return '-';
  const input = clip(run.input.replace(/\s+/g, ' ').trim(), 36);
  if (ACTIVE.has(run.status)) return `${run.status} ${age(now - run.startedAt)} · ${input}`;
  return `${run.status} · ${input}`;
}

/** Tabla de sesiones. Pura: los datos son DTOs del protocolo. */
export function formatSessionsTable(
  sessions: readonly ProtocolSession[],
  runs: readonly ProtocolRun[],
  now: number = Date.now(),
): string {
  if (sessions.length === 0) return 'No live sessions.\n';
  // El run de cada sesión: el vigente, o el más reciente que se conozca de ella.
  const runOf = new Map<string, ProtocolRun>();
  for (const run of runs) {
    const known = runOf.get(run.sessionId);
    if (!known || run.startedAt >= known.startedAt) runOf.set(run.sessionId, run);
  }
  const rows = [
    ['SESSION', 'HOST', 'STATE', 'AGENT', 'MODEL', 'CWD', 'RUN'],
    ...sessions.map((s) => [
      s.id,
      hostLabel(s),
      s.state,
      clip(s.agent, 16),
      clip(s.model, 28),
      clipPath(s.cwd, 40),
      runLabel(runOf.get(s.id), now),
    ]),
  ];
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)));
  return (
    rows
      .map((r) =>
        r
          .map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]!)))
          .join('  ')
          .trimEnd(),
      )
      .join('\n') + '\n'
  );
}

async function connect(): Promise<StratumClient> {
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum ps', version: cliVersion(), roles: ['observer'] },
    reconnect: false,
    requestTimeoutMs: 10_000,
  });
  await client.connect();
  return client;
}

async function fetchAll(
  client: StratumClient,
): Promise<{ sessions: ProtocolSession[]; runs: ProtocolRun[] }> {
  const [{ sessions }, { runs }] = await Promise.all([
    client.request('sessions.list', { live: true }),
    client.request('runs.list', {}),
  ]);
  const live = new Set(sessions.map((s) => s.id));
  return { sessions, runs: runs.filter((r) => live.has(r.sessionId)) };
}

export const psCommand = new Command('ps')
  .description('List the live sessions known to stratumd (daemon-hosted and CLI-hosted)')
  .option('--json', 'machine-readable output: protocol DTOs')
  .option('-w, --watch', 'keep running and refresh as sessions change')
  .action(async (opts: { json?: boolean; watch?: boolean }) => {
    let client: StratumClient;
    try {
      client = await connect();
    } catch (err) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ running: false, sessions: [], runs: [] }) + '\n');
      } else {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      }
      process.exitCode = 1;
      return;
    }

    if (!opts.watch) {
      try {
        const data = await fetchAll(client);
        process.stdout.write(
          opts.json
            ? JSON.stringify({ running: true, ...data }) + '\n'
            : formatSessionsTable(data.sessions, data.runs),
        );
      } catch (err) {
        process.stderr.write(
          `Cannot list sessions: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      } finally {
        client.close();
      }
      return;
    }

    // --watch: una suscripción de conjunto. Lo que llega son los mismos DTOs:
    // la foto sustituye, y cada evento actualiza su sesión o su run.
    const sessions = new Map<string, ProtocolSession>();
    const runs = new Map<string, ProtocolRun>();
    let scheduled = false;
    const paint = (): void => {
      scheduled = false;
      const list = [...sessions.values()];
      const current = [...runs.values()].filter((r) => sessions.has(r.sessionId));
      if (opts.json) {
        process.stdout.write(JSON.stringify({ sessions: list, runs: current }) + '\n');
        return;
      }
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(formatSessionsTable(list, current));
      if (!process.stdout.isTTY) process.stdout.write('\n');
    };
    const repaint = (): void => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(paint, 50);
    };

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearInterval(tick);
        client.close();
        resolve();
      };
      const subscription = client.subscribeOverview({
        onOverview: (overview) => {
          sessions.clear();
          for (const s of overview.sessions) sessions.set(s.id, s);
          // La foto de conjunto no trae los runs: se piden aparte.
          void client
            .request('runs.list', {})
            .then((result) => {
              runs.clear();
              for (const run of result.runs.reverse()) runs.set(run.id, run);
              repaint();
            })
            .catch(() => undefined);
          repaint();
        },
        onEvent: (event) => {
          switch (event.type) {
            case 'session.opened':
            case 'session.updated':
              sessions.set(event.sessionId, event.data.session);
              break;
            case 'session.closed':
              sessions.delete(event.sessionId);
              break;
            case 'run.started':
            case 'run.updated':
            case 'run.completed':
            case 'run.failed':
            case 'run.cancelled':
              runs.set(event.data.run.id, event.data.run);
              break;
            default:
              return;
          }
          repaint();
        },
        onError: finish,
      });
      // El tiempo de un run en curso avanza aunque no llegue nada.
      const tick = setInterval(() => {
        if (process.stdout.isTTY && !opts.json && sessions.size > 0) repaint();
        if (client.status === 'closed') {
          process.stderr.write('stratumd is gone.\n');
          finish();
        }
      }, 1_000);
      process.once('SIGINT', () => {
        subscription.close();
        finish();
      });
    });
  });
