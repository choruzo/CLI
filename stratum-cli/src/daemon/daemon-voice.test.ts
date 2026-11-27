import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { VoiceConfig } from '../config/schema.js';
import { ProtocolError } from '../ipc/codec.js';
import { VOICE_UPLOAD_LIMITS } from '../protocol/model.js';
import { PARAMS, RESULTS } from '../protocol/schemas.js';
import type { VoiceTranscript } from '../voice/worker-protocol.js';
import { VoiceNotes, type VoiceClientPort } from './voice-notes.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

/**
 * M25 fase 4 — el push-to-talk por el protocolo (§35): `voice.begin|append|end|
 * cancel` con un `operator`. La voz es de verdad (`VoiceNotes`) salvo el worker,
 * que es falso: lo que se prueba es el cableado, las capacidades y los motivos
 * de error, no el modelo.
 */

/** Un segundo de audio a 16 kHz, en base64 (PCM16 LE mono). */
function audio(seconds = 1): string {
  const samples = Math.round(seconds * VOICE_UPLOAD_LIMITS.sampleRate);
  const bytes = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(1_000, i * 2);
  return bytes.toString('base64');
}

/** Un worker falso: devuelve siempre la misma nota, sin cargar nada. */
class FakeClient implements VoiceClientPort {
  readonly calls: Float32Array[] = [];

  async transcribe(pcm16k: Float32Array): Promise<VoiceTranscript> {
    this.calls.push(pcm16k);
    const durationSec = pcm16k.length / VOICE_UPLOAD_LIMITS.sampleRate;
    return {
      text: 'hola desde el micrófono',
      durationSec,
      capped: false,
      ms: 12,
      device: 'gpu',
      chunks: [{ start: 0, end: pcm16k.length, reason: 'end', skipped: false }],
    };
  }

  close(): void {}
}

/** La voz del daemon: la de verdad, con el worker falso y el modelo a mano. */
function voiceNotes(ready = true): { notes: VoiceNotes; client: FakeClient } {
  const client = new FakeClient();
  const notes = new VoiceNotes({
    config: () => voiceConfig(),
    dir: '/modelos/canary',
    modelStatus: async () => ({ state: ready ? 'ready' : 'missing' }),
    // Una nota de un canal no debería llegar aquí: `voice.*` va por `transcribePcm`.
    downloadModel: async () => {
      throw new Error('no se descarga el modelo desde el push-to-talk');
    },
    decode: async () => {
      throw new Error('el push-to-talk no decodifica Opus');
    },
    client: () => client,
  });
  return { notes, client };
}

function voiceConfig(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return { enabled: true, language: 'es', device: 'auto', idleUnloadMinutes: 10, ...over };
}

/** El código y el motivo de un rechazo, como los vería el cliente. */
async function failure(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) return 'OK';
  if (err instanceof ProtocolError) {
    const reason = err.data?.reason;
    return `${err.code}${reason ? `:${reason}` : ''}`;
  }
  return `threw ${String(err)}`;
}

/** Espera a que se cumpla algo (el daemon suelta la conexión en su momento). */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let t: TestDaemon | undefined;
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-voice-')));
});
afterEach(async () => {
  await t?.stop();
  t = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe('voice.* (M25 fase 4)', () => {
  it('un operator sube el audio por trozos y recibe el texto de su dictado', async () => {
    const { notes, client } = voiceNotes();
    t = await startTestDaemon({
      base,
      voiceNotes: notes,
      voiceConfig: () => voiceConfig(),
      voiceModelStatus: async () => ({ state: 'ready' }),
    });
    const cwd = t.project('dictado', []);
    const operator = await t.connect(['operator'], 'dot', { kind: 'dot' });
    const { session } = await operator.request('sessions.open', { cwd });

    const begun = await operator.request('voice.begin', { sessionId: session.id });
    expect(RESULTS['voice.begin'].parse(begun)).toEqual({
      uploadId: begun.uploadId,
      sampleRate: 16_000,
      maxSeconds: 300,
      chunkBytes: 65_536,
    });
    // Tres trozos de un segundo: `seconds` es lo acumulado.
    for (const seq of [0, 1, 2]) {
      const params = PARAMS['voice.append'].parse({
        uploadId: begun.uploadId,
        seq,
        pcm: audio(),
      });
      const chunk = await operator.request('voice.append', params);
      expect(chunk.seconds).toBeCloseTo(seq + 1, 6);
    }
    const ended = await operator.request('voice.end', { uploadId: begun.uploadId });
    const { transcript } = RESULTS['voice.end'].parse(ended);
    expect(transcript).toEqual({
      text: 'hola desde el micrófono',
      durationSec: 3,
      capped: false,
      device: 'gpu',
    });
    // Al worker le llegaron las 3 s enteras, ya a 16 kHz.
    expect(client.calls[0]).toHaveLength(3 * 16_000);
    // Terminada la subida, no queda nada abierto.
    expect(t.daemon.voiceUploads?.count).toBe(0);
  });

  it('sin sesión es NOT_FOUND: la nota solo dice en qué traza se anota', async () => {
    const { notes } = voiceNotes();
    t = await startTestDaemon({
      base,
      voiceNotes: notes,
      voiceConfig: () => voiceConfig(),
      voiceModelStatus: async () => ({ state: 'ready' }),
    });
    const operator = await t.connect(['operator'], 'op');
    expect(await failure(operator.request('voice.begin', { sessionId: 'ses_que_no_existe' }))).toBe(
      'NOT_FOUND',
    );
  });

  it('con la voz apagada (o sin notas de voz) es UNAVAILABLE voice-disabled', async () => {
    const off = await startTestDaemon({ base, voiceConfig: () => voiceConfig({ enabled: false }) });
    const operator = await off.connect(['operator'], 'op');
    const cwd = off.project('apagada', []);
    const { session } = await operator.request('sessions.open', { cwd });
    expect(await failure(operator.request('voice.begin', { sessionId: session.id }))).toBe(
      'UNAVAILABLE:voice-disabled',
    );
    await off.stop();
    rmSync(join(base, 'daemon'), { recursive: true, force: true });

    // Sin `VoiceNotes` (el defecto de las fixtures) no hay voz que ofrecer.
    t = await startTestDaemon({ base, voiceNotes: null });
    const other = await t.connect(['operator'], 'op2');
    const cwd2 = t.project('sin-voz', []);
    const second = await other.request('sessions.open', { cwd: cwd2 });
    expect(await failure(other.request('voice.begin', { sessionId: second.session.id }))).toBe(
      'UNAVAILABLE:voice-disabled',
    );
  });

  it('sin el modelo descargado es UNAVAILABLE voice-model-missing (y no se descarga)', async () => {
    const { notes } = voiceNotes(false);
    t = await startTestDaemon({
      base,
      voiceNotes: notes,
      voiceConfig: () => voiceConfig(),
      voiceModelStatus: async () => ({ state: 'missing' }),
    });
    const operator = await t.connect(['operator'], 'op');
    const cwd = t.project('sin-modelo', []);
    const { session } = await operator.request('sessions.open', { cwd });
    expect(await failure(operator.request('voice.begin', { sessionId: session.id }))).toBe(
      'UNAVAILABLE:voice-model-missing',
    );
    expect(t.daemon.voiceUploads?.count).toBe(0);
  });

  it('el uploadId de otra conexión es NOT_FOUND', async () => {
    const { notes } = voiceNotes();
    t = await startTestDaemon({
      base,
      voiceNotes: notes,
      voiceConfig: () => voiceConfig(),
      voiceModelStatus: async () => ({ state: 'ready' }),
    });
    const cwd = t.project('ajena', []);
    const owner = await t.connect(['operator'], 'uno', { kind: 'dot' });
    const other = await t.connect(['operator'], 'otro', { kind: 'dot' });
    const { session } = await owner.request('sessions.open', { cwd });
    const { uploadId } = await owner.request('voice.begin', { sessionId: session.id });

    expect(await failure(other.request('voice.append', { uploadId, seq: 0, pcm: audio() }))).toBe(
      'NOT_FOUND',
    );
    expect(await failure(other.request('voice.end', { uploadId }))).toBe('NOT_FOUND');
    expect(await failure(other.request('voice.cancel', { uploadId }))).toBe('NOT_FOUND');
    // La del dueño sigue viva y se puede terminar.
    await owner.request('voice.append', { uploadId, seq: 0, pcm: audio() });
    await expect(owner.request('voice.end', { uploadId })).resolves.toMatchObject({
      transcript: { text: 'hola desde el micrófono' },
    });
  });

  it('al cerrar la conexión su subida desaparece', async () => {
    const { notes } = voiceNotes();
    t = await startTestDaemon({
      base,
      voiceNotes: notes,
      voiceConfig: () => voiceConfig(),
      voiceModelStatus: async () => ({ state: 'ready' }),
    });
    const cwd = t.project('se-va', []);
    const operator = await t.connect(['operator'], 'efímero', { kind: 'dot' });
    const { session } = await operator.request('sessions.open', { cwd });
    await operator.request('voice.begin', { sessionId: session.id });
    expect(t.daemon.voiceUploads?.count).toBe(1);
    operator.close();
    await until(() => t?.daemon.voiceUploads?.count === 0);
  });

  it('un observer, sin control, no puede dictar', async () => {
    const { notes } = voiceNotes();
    t = await startTestDaemon({
      base,
      voiceNotes: notes,
      voiceConfig: () => voiceConfig(),
      voiceModelStatus: async () => ({ state: 'ready' }),
    });
    const cwd = t.project('mirón', []);
    const operator = await t.connect(['operator'], 'op');
    const observer = await t.connect(['observer'], 'obs');
    const { session } = await operator.request('sessions.open', { cwd });
    const { uploadId } = await operator.request('voice.begin', { sessionId: session.id });

    expect(await failure(observer.request('voice.begin', { sessionId: session.id }))).toBe(
      'FORBIDDEN',
    );
    expect(
      await failure(observer.request('voice.append', { uploadId, seq: 0, pcm: audio() })),
    ).toBe('FORBIDDEN');
    expect(await failure(observer.request('voice.end', { uploadId }))).toBe('FORBIDDEN');
    expect(await failure(observer.request('voice.cancel', { uploadId }))).toBe('FORBIDDEN');
  });

  it('un toque sin querer (menos de medio segundo) es INVALID_PARAMS voice-too-short', async () => {
    const { notes } = voiceNotes();
    t = await startTestDaemon({
      base,
      voiceNotes: notes,
      voiceConfig: () => voiceConfig(),
      voiceModelStatus: async () => ({ state: 'ready' }),
    });
    const cwd = t.project('toque', []);
    const operator = await t.connect(['operator'], 'op');
    const { session } = await operator.request('sessions.open', { cwd });
    const { uploadId } = await operator.request('voice.begin', { sessionId: session.id });
    await operator.request('voice.append', { uploadId, seq: 0, pcm: audio(0.2) });
    expect(await failure(operator.request('voice.end', { uploadId }))).toBe(
      'INVALID_PARAMS:voice-too-short',
    );
    // La subida se tiró: repetir el `end` ya es NOT_FOUND.
    expect(await failure(operator.request('voice.end', { uploadId }))).toBe('NOT_FOUND');
  });

  it('cancel tira la subida y un append con el seq saltado es voice-seq', async () => {
    const { notes } = voiceNotes();
    t = await startTestDaemon({
      base,
      voiceNotes: notes,
      voiceConfig: () => voiceConfig(),
      voiceModelStatus: async () => ({ state: 'ready' }),
    });
    const cwd = t.project('cancela', []);
    const operator = await t.connect(['operator'], 'op');
    const { session } = await operator.request('sessions.open', { cwd });

    const first = await operator.request('voice.begin', { sessionId: session.id });
    await expect(operator.request('voice.cancel', { uploadId: first.uploadId })).resolves.toEqual(
      {},
    );
    expect(await failure(operator.request('voice.end', { uploadId: first.uploadId }))).toBe(
      'NOT_FOUND',
    );

    // Abrir otra tira la anterior y, con el seq saltado, la subida se tira.
    const second = await operator.request('voice.begin', { sessionId: session.id });
    expect(
      await failure(
        operator.request('voice.append', { uploadId: second.uploadId, seq: 1, pcm: audio() }),
      ),
    ).toBe('INVALID_PARAMS:voice-seq');
    expect(t.daemon.voiceUploads?.count).toBe(0);
  });
});
