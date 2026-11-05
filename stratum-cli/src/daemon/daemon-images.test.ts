/**
 * Imágenes adjuntas por el protocolo (`runs.start`/`runs.steer`): el daemon las
 * lee del `cwd` de la sesión (o de `~/.stratum/images`) y rechaza el mensaje
 * entero con `INVALID_PARAMS`, sin arrancar nada, si una no vale.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound } from '../providers/mock.js';
import type { ProtocolEvent } from '../protocol/index.js';
import { startTestDaemon, watch, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
});

/** PNG mínimo: el daemon solo mira la firma. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('x'),
]);

const failure = async (p: Promise<unknown>): Promise<ProtocolError | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ProtocolError ? e : null;
  }
};

describe('imágenes por el protocolo', () => {
  it('una fuera del cwd es INVALID_PARAMS y no arranca ningún run; una dentro arranca', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = t.project('con-imagenes', [makeTextRound('listo')]);
    const outside = join(t.base, 'fuera');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secreta.png'), PNG);
    writeFileSync(join(cwd, 'dentro.png'), PNG);

    const client = await t.connect(['operator']);
    const { session } = await client.request('sessions.open', { cwd });
    const live = watch(client, session.id);

    const err = await failure(
      client.request('runs.start', {
        sessionId: session.id,
        input: 'mira',
        images: [join(outside, 'secreta.png')],
      }),
    );
    expect(err?.code).toBe('INVALID_PARAMS');
    const none = await client.request('runs.list', { sessionId: session.id });
    expect(none.runs).toHaveLength(0);

    // Todo o nada: una buena y una mala rechazan el mensaje.
    const mixed = await failure(
      client.request('runs.start', {
        sessionId: session.id,
        input: 'mira',
        images: ['dentro.png', join(outside, 'secreta.png')],
      }),
    );
    expect(mixed?.code).toBe('INVALID_PARAMS');

    const { run } = await client.request('runs.start', {
      sessionId: session.id,
      input: 'mira',
      images: ['dentro.png'],
    });
    await live.until(
      (e: ProtocolEvent) =>
        e.type === 'run.completed' && (e.data as { run: { id: string } }).run.id === run.id,
      20_000,
    );
  });
});
