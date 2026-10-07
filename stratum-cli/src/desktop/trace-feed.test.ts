import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumConfigSchema } from '../config/schema.js';
import { TraceFeed } from './trace-feed.js';
import { parseInboundFrame } from './codec.js';
import {
  CLIENT_FRAME_TYPES,
  type ConversationOutboundFrame,
  type TraceRecordsFrame,
} from './protocol.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let dir: string;
let frames: TraceRecordsFrame[];
let feed: TraceFeed;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-trace-feed-'));
  mkdirSync(dir, { recursive: true });
  frames = [];
  feed = new TraceFeed(
    dir,
    (f: ConversationOutboundFrame) => {
      if (f.type !== 'trace_records') return;
      frames.push(f);
      onFrame();
    },
    10,
  );
});
afterEach(() => {
  onFrame = () => {};
  feed.unsubscribe();
  rmSync(dir, { recursive: true, force: true });
});

/** Lo llama el feed al emitir cada trama. */
let onFrame: () => void = () => {};

/**
 * Espera a que la condición se cumpla, comprobándola cuando llega una trama.
 * Sin plazo propio: con el equipo cargado (la suite entera en paralelo) el
 * sondeo del fichero tarda lo que tarde, y un plazo fijo de 2 s fallaba sin
 * que hubiera nada roto. Si la trama no llega nunca, corta el timeout del test.
 */
function until(cond: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!cond()) return;
      onFrame = () => {};
      resolve();
    };
    onFrame = check;
    check();
  });
}

const line = (at: number): string => `${JSON.stringify({ t: 'turn', at, input: `m${at}` })}\n`;

describe('TraceFeed', { timeout: 30_000 }, () => {
  it('manda lo ya grabado con reset y luego solo lo nuevo', async () => {
    writeFileSync(feed.file(ID), line(1) + line(2));
    feed.subscribe(ID);
    await until(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ conversationId: ID, reset: true });
    expect(frames[0].records).toHaveLength(2);

    appendFileSync(feed.file(ID), line(3));
    await until(() => frames.length === 2);
    expect(frames[1]).toMatchObject({ reset: false, records: [{ t: 'turn', at: 3 }] });
  });

  it('una conversación sin traza responde con una tanda vacía (el panel deja de cargar)', async () => {
    feed.subscribe(ID);
    await until(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ reset: true, records: [] });
  });

  it('solo sigue una conversación: suscribirse a otra sustituye a la anterior', async () => {
    writeFileSync(feed.file(ID), line(1));
    writeFileSync(feed.file(OTHER), line(9));
    feed.subscribe(ID);
    await until(() => frames.length === 1);
    feed.subscribe(OTHER);
    await until(() => frames.length === 2);
    appendFileSync(feed.file(ID), line(2));
    await new Promise((r) => setTimeout(r, 60));
    expect(frames.map((f) => f.conversationId)).toEqual([ID, OTHER]);
  });

  it('descarta las líneas que no son JSON y trocea las tandas grandes', async () => {
    writeFileSync(
      feed.file(ID),
      `{"t":"turn","at":0,"inp\n${Array.from({ length: 450 }, (_, i) => line(i + 1)).join('')}`,
    );
    feed.subscribe(ID);
    await until(() => frames.reduce((n, f) => n + f.records.length, 0) === 450);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.filter((f) => f.reset)).toHaveLength(1);
  });

  it('un sondeo que se solapa con otro no adelanta un reset vacío', async () => {
    // Sondeo cada 1 ms sobre un fichero que tarda más que eso en leerse: los
    // sondeos se pisan, y la primera trama tiene que seguir siendo la lectura
    // completa, no una tanda vacía emitida por el que llegó segundo.
    const stressed: TraceRecordsFrame[] = [];
    const fast = new TraceFeed(
      dir,
      (f: ConversationOutboundFrame) => {
        if (f.type !== 'trace_records') return;
        stressed.push(f);
        onFrame();
      },
      1,
    );
    writeFileSync(fast.file(ID), Array.from({ length: 5000 }, (_, i) => line(i + 1)).join(''));
    try {
      fast.subscribe(ID);
      await until(() => stressed.reduce((n, f) => n + f.records.length, 0) === 5000);
      expect(stressed[0]).toMatchObject({ reset: true });
      expect(stressed.every((f) => f.records.length > 0)).toBe(true);
      expect(stressed.filter((f) => f.reset)).toHaveLength(1);
    } finally {
      fast.unsubscribe();
    }
  });

  it('remove borra la traza y deja de seguirla', async () => {
    writeFileSync(feed.file(ID), line(1));
    feed.subscribe(ID);
    await until(() => frames.length === 1);
    feed.remove(ID);
    expect(existsSync(feed.file(ID))).toBe(false);
  });

  it('recorder: null con la traza desactivada', () => {
    const on = StratumConfigSchema.parse({});
    const off = StratumConfigSchema.parse({ trace: { enabled: false } });
    expect(feed.recorder(ID, on)?.file).toBe(feed.file(ID));
    expect(feed.recorder(ID, off)).toBeNull();
  });
});

describe('tramas de trayectoria (v9)', () => {
  it('el códec acepta trace_subscribe / trace_unsubscribe y rechaza campos de más', () => {
    expect(CLIENT_FRAME_TYPES).toContain('trace_subscribe');
    expect(CLIENT_FRAME_TYPES).toContain('trace_unsubscribe');
    const parse = (frame: unknown) => parseInboundFrame(JSON.stringify(frame));
    expect(parse({ type: 'trace_subscribe', conversationId: ID })).toEqual({
      type: 'trace_subscribe',
      conversationId: ID,
    });
    expect(parse({ type: 'trace_unsubscribe' })).toEqual({ type: 'trace_unsubscribe' });
    expect(parse({ type: 'trace_subscribe', conversationId: '../x' })).toBeNull();
    expect(parse({ type: 'trace_unsubscribe', extra: 1 })).toBeNull();
  });
});
