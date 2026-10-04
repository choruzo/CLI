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
      if (f.type === 'trace_records') frames.push(f);
    },
    10,
  );
});
afterEach(() => {
  feed.unsubscribe();
  rmSync(dir, { recursive: true, force: true });
});

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const line = (at: number): string => `${JSON.stringify({ t: 'turn', at, input: `m${at}` })}\n`;

describe('TraceFeed', () => {
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
