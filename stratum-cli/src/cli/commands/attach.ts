import { randomUUID } from 'crypto';
import { clearLine, createInterface, cursorTo, moveCursor } from 'readline';
import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import type { Subscription } from '../../client/subscriptions.js';
import { fileDiscovery } from '../../client/discovery.js';
import { ProtocolError } from '../../ipc/codec.js';
import { NotSentError, UnknownOutcomeError } from '../../ipc/peer.js';
import {
  applySessionEvent,
  isStateEvent,
  type ProtocolEvent,
  type ProtocolSessionSnapshot,
} from '../../protocol/index.js';
import {
  ATTACH_HELP,
  attachAction,
  formatChatMessage,
  formatEvent,
  formatHeader,
  formatPending,
  hostChange,
} from '../attach-view.js';
import { describeDetachRefusal } from '../handoff-text.js';
import { cliVersion } from '../version.js';

/**
 * `stratum attach <id>`: una conversación interactiva sobre una sesión viva de
 * `stratumd` —alojada en el daemon o en una terminal—, como **cliente**: ve la
 * conversación y lo que pasa, empieza turnos (sesión del daemon y parada),
 * redirige el run en curso, lo pausa, lo reanuda o lo cancela, y enseña lo que
 * espera a una persona. No aloja nada: salir no cambia la sesión, y aprobar
 * sigue siendo de `stratum approvals` (la clave de aprobador no pasa por aquí).
 *
 * «Adjuntarse» no es un método del protocolo: es elegir una sesión, seguirla
 * (`events.subscribe`) y conducirla con los métodos de siempre.
 */

function describeError(err: unknown): string {
  if (err instanceof UnknownOutcomeError) {
    return 'outcome unknown: the request was sent but no answer came. Check the session before retrying.';
  }
  if (err instanceof NotSentError) return 'not sent: stratumd is not reachable right now.';
  if (err instanceof ProtocolError) {
    const reason = typeof err.data?.reason === 'string' ? err.data.reason : undefined;
    return reason ? `${err.code} (${reason}): ${err.message}` : `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export const attachCommand = new Command('attach')
  .description(
    'Talk to a live session of stratumd (daemon- or terminal-hosted) from this terminal, as a client',
  )
  .argument('<session-id>', 'id of a live session (see `stratum ps`)')
  .action(async (sessionId: string) => {
    const out = process.stdout;
    const tty = out.isTTY === true;
    const client = new StratumClient({
      discovery: fileDiscovery(),
      identity: { kind: 'cli', name: 'stratum attach', version: cliVersion(), roles: ['operator'] },
      // Un cliente de larga duración: si el canal se corta, vuelve y se resincroniza con una foto.
      reconnect: { initialMs: 250, maxMs: 3_000 },
      requestTimeoutMs: 15_000,
    });
    try {
      await client.connect();
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }

    const rl = createInterface({ input: process.stdin, output: out, terminal: tty });
    rl.setPrompt('> ');
    let snapshot: ProtocolSessionSnapshot | null = null;
    const printed = new Set<string>();
    // Texto del asistente que se está pintando a trozos (fragmentos volátiles).
    let streaming = false;
    let streamed = '';
    let finished = false;

    const clearPromptLine = (): void => {
      if (!tty) return;
      clearLine(out, 0);
      cursorTo(out, 0);
    };
    const endStream = (): void => {
      if (!streaming) return;
      streaming = false;
      streamed = '';
      out.write('\n');
    };
    const print = (text: string): void => {
      endStream();
      clearPromptLine();
      out.write(`${text}\n`);
      if (!finished) rl.prompt(true);
    };
    const remember = (s: ProtocolSessionSnapshot): void => {
      for (const m of s.messages) printed.add(m.id);
    };

    let subscription: Subscription | null = null;
    const finish = (code = 0): void => {
      if (finished) return;
      finished = true;
      endStream();
      subscription?.close();
      client.close();
      rl.close();
      process.exitCode = code;
    };

    subscription = client.subscribeSession(
      sessionId,
      {
        onSnapshot: (next) => {
          const before = snapshot;
          snapshot = next;
          if (!before) {
            print(formatHeader(next));
            if (next.messagesTruncated) print('[earlier messages are not kept]');
            for (const m of next.messages) print(formatChatMessage(m));
            remember(next);
            if (next.approvals.length + next.questions.length + next.plans.length > 0) {
              print(formatPending(next));
            }
            if (next.partial.text) {
              clearPromptLine();
              out.write(next.partial.text);
              streaming = true;
              streamed = next.partial.text;
            }
            return;
          }
          // Resincronización: lo que no se había pintado, y si cambió de anfitrión.
          const moved = hostChange(before.session, next.session);
          if (moved) print(moved);
          for (const m of next.messages) if (!printed.has(m.id)) print(formatChatMessage(m));
          remember(next);
          if (next.session.state === 'closed') {
            print('[the session is gone]');
            finish();
          }
        },
        onEvent: (event: ProtocolEvent) => {
          if (event.type === 'message.delta') {
            if (event.subagentId) return;
            if (!streaming) {
              clearPromptLine();
              streaming = true;
            }
            out.write(event.data.text);
            streamed += event.data.text;
            return;
          }
          if (!isStateEvent(event)) return;
          const before = snapshot;
          if (snapshot) snapshot = applySessionEvent(snapshot, event);
          if (snapshot) remember(snapshot);
          if (event.type === 'message.completed' && !event.subagentId) {
            const text = event.data.text;
            if (streaming && text.startsWith(streamed)) {
              out.write(text.slice(streamed.length));
              endStream();
              rl.prompt(true);
            } else {
              print(text);
            }
            return;
          }
          if (event.type === 'session.updated' && before) {
            const moved = hostChange(before.session, event.data.session);
            if (moved) print(moved);
            return;
          }
          const line = formatEvent(event);
          if (line) print(line);
          if (event.type === 'session.closed') finish();
        },
        onError: (err) => {
          print(
            err instanceof ProtocolError && err.code === 'NOT_FOUND'
              ? `No live session ${sessionId} (see \`stratum ps\`).`
              : `Cannot follow the session: ${describeError(err)}`,
          );
          finish(1);
        },
      },
      { volatile: true },
    );

    const operationId = (): string => `attach-${randomUUID()}`;
    const run = async (what: string, fn: () => Promise<string | null>): Promise<void> => {
      try {
        const said = await fn();
        if (said) print(said);
      } catch (err) {
        print(`[${what}: ${describeError(err)}]`);
      }
    };

    rl.on('line', (line) => {
      const action = attachAction(snapshot?.session ?? null, line);
      const runId = snapshot?.session.currentRunId ?? undefined;
      switch (action.kind) {
        case 'none':
          rl.prompt();
          return;
        case 'quit':
          finish();
          return;
        case 'help':
          print(ATTACH_HELP);
          return;
        case 'refuse':
          print(action.message);
          return;
        case 'pending':
          void run('pending', async () =>
            formatPending(await client.request('approvals.list', { sessionId })),
          );
          return;
        case 'cancel':
          void run('cancel', async () => {
            const r = await client.request('runs.cancel', {
              sessionId,
              ...(runId ? { runId } : {}),
              operationId: operationId(),
            });
            return r.status === 'not-running' ? '[no run in progress]' : null;
          });
          return;
        case 'pause':
          void run('pause', async () => {
            const r = await client.request('runs.pause', {
              sessionId,
              ...(runId ? { runId } : {}),
              operationId: operationId(),
            });
            return r.status === 'requested'
              ? '[pause requested: the run stops at its next safe point]'
              : `[${r.status.replace('-', ' ')}]`;
          });
          return;
        case 'resume':
          void run('resume', async () => {
            const r = await client.request('runs.resume', {
              sessionId,
              ...(runId ? { runId } : {}),
              operationId: operationId(),
            });
            return r.status === 'resumed' ? null : `[${r.status.replace('-', ' ')}]`;
          });
          return;
        case 'detach':
          void run('detach', async () => {
            try {
              const r = await client.request(
                'sessions.detach',
                { sessionId, operationId: operationId() },
                { timeoutMs: 150_000 },
              );
              return r.status === 'already-daemon'
                ? '[the session is already hosted by stratumd]'
                : null;
            } catch (err) {
              if (err instanceof ProtocolError) {
                const reason = typeof err.data?.reason === 'string' ? err.data.reason : undefined;
                return `[not handed off: ${describeDetachRefusal(err.code, reason)}]`;
              }
              throw err;
            }
          });
          return;
        case 'start':
          // Lo pinta `run.started`: la línea tecleada no se repite.
          if (tty) {
            moveCursor(out, 0, -1);
            clearLine(out, 0);
          }
          void run('not sent', async () => {
            await client.request('runs.start', {
              sessionId,
              input: action.input,
              operationId: operationId(),
            });
            return null;
          });
          return;
        case 'steer':
          void run('steer', async () => {
            const r = await client.request('runs.steer', {
              sessionId,
              text: action.text,
              operationId: operationId(),
            });
            if (r.status === 'accepted') return null;
            if (r.status === 'not-accepting') {
              return '[the run is finishing: send it again when it ends]';
            }
            return r.status === 'too-large' ? '[too large to steer: not sent]' : null;
          });
          return;
      }
    });

    await new Promise<void>((resolve) => {
      rl.on('close', () => {
        finish();
        resolve();
      });
      rl.on('SIGINT', () => finish());
      client
        .request('core.status', {})
        .catch(() => undefined)
        .finally(() => {
          if (!finished) rl.prompt();
        });
    });
  });
