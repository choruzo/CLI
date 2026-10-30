import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { StratumConfigSchema } from '../config/schema.js';
import { TraceRecorder, traceShotsDir } from './recorder.js';
import { deleteTrace } from './store.js';
import { startAuditorServer } from './server.js';
import type { TraceRecord } from './records.js';
import type { ToolImage } from '../agent/types.js';

/** M15 (A6) — las capturas en la traza: metadatos siempre, el fichero solo con opción. */

const dir = mkdtempSync(join(tmpdir(), 'stratum-trace-shots-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from('fake-png-bytes');
const IMAGE: ToolImage = {
  mime: 'image/png',
  data: PNG.toString('base64'),
  width: 1280,
  height: 800,
  bytes: PNG.length,
  sha256: createHash('sha256').update(PNG).digest('hex'),
};

async function record(
  id: string,
  screenshots: boolean,
): Promise<{ rec: TraceRecorder; records: TraceRecord[] }> {
  const config = StratumConfigSchema.parse({ trace: { dir, screenshots } });
  const file = join(dir, `${id}.jsonl`);
  const rec = new TraceRecorder({ file, sessionId: id, config });
  const scope = rec.scope();
  scope.turnStart('mira', [{ role: 'user', content: 'mira' }]);
  scope.event({ type: 'tool_call_ready', id: 'c1', name: 'screen_screenshot', input: {} });
  scope.screenshot!('c1', IMAGE);
  scope.event({
    type: 'tool_result',
    id: 'c1',
    name: 'screen_screenshot',
    result: 'Screenshot …',
    durationMs: 5,
  });
  scope.turnEnd('stop');
  await rec.flush();
  const records = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TraceRecord);
  return { rec, records };
}

function toolEnd(records: TraceRecord[]): Record<string, unknown> {
  const end = records.find((r) => r.t === 'end' && r.data && 'image' in r.data);
  return (end as { data: Record<string, unknown> }).data;
}

describe('traza — capturas de la caja', () => {
  it('por defecto: solo metadatos en el paso de la tool, ni la imagen ni fichero', async () => {
    const { records } = await record('s_meta', false);
    expect(toolEnd(records).image).toEqual({
      width: 1280,
      height: 800,
      bytes: PNG.length,
      sha256: IMAGE.sha256,
    });
    expect(JSON.stringify(records)).not.toContain(IMAGE.data);
    expect(existsSync(traceShotsDir(join(dir, 's_meta.jsonl')))).toBe(false);
  });

  it('con trace.screenshots: el PNG junto a la traza, por su sha256, y se borra con ella', async () => {
    const { records } = await record('s_file', true);
    const meta = toolEnd(records).image as { file: string };
    expect(meta.file).toBe(`${IMAGE.sha256}.png`);
    const saved = join(traceShotsDir(join(dir, 's_file.jsonl')), meta.file);
    expect(readFileSync(saved)).toEqual(PNG);
    expect(JSON.stringify(records)).not.toContain(IMAGE.data);

    const config = StratumConfigSchema.parse({ trace: { dir } });
    expect(deleteTrace(config, 's_file')).toBe(true);
    expect(existsSync(saved)).toBe(false);
  });

  it('el auditor sirve una captura guardada y nada que no sea un sha256', async () => {
    await record('s_srv', true);
    const server = await startAuditorServer({ file: join(dir, 's_srv.jsonl'), sessionId: 's_srv' });
    try {
      const ok = await fetch(`${server.url}shots/${IMAGE.sha256}.png`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await ok.arrayBuffer())).toEqual(PNG);
      for (const bad of ['..%2Fs_srv.jsonl', '../s_srv.jsonl', 'x.png', `${IMAGE.sha256}.jsonl`]) {
        expect((await fetch(`${server.url}shots/${bad}`)).status).toBe(404);
      }
    } finally {
      await server.close();
    }
  });
});
