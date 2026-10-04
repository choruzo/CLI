import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { ReactLoop } from '../agent/harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import type { AgentEvent, Message } from '../agent/types.js';
import { TraceRecorder } from './recorder.js';
import type { TraceRecord } from './records.js';
import {
  deleteTrace,
  isTraceId,
  listTraces,
  openSessionTrace,
  pruneTraces,
  traceFilePath,
} from './store.js';
import { startAuditorServer, type AuditorServer } from './server.js';

let dir: string;
let config: StratumConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-trace-'));
  config = StratumConfigSchema.parse({ trace: { dir } });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readTrace(file: string): TraceRecord[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceRecord);
}

function newRecorder(id = 'sess_test'): TraceRecorder {
  return new TraceRecorder({ file: join(dir, `${id}.jsonl`), sessionId: id, config });
}

/** Un turno como lo hace `StratumAgent.run`: el loop anota el modelo; el consumidor, los eventos. */
async function runTurn(
  rec: TraceRecorder,
  provider: MockProvider,
  messages: Message[],
  input: string,
): Promise<AgentEvent[]> {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, config);
  messages.push({ role: 'user', content: input });
  const scope = rec.scope();
  scope.turnStart(input, messages);
  const loop = new ReactLoop(provider, registry, messages, config, 'mock-model', 32768);
  const events: AgentEvent[] = [];
  let stop: string | null = null;
  for await (const ev of loop.run({ trace: scope })) {
    scope.event(ev);
    events.push(ev);
    if (ev.type === 'done') stop = ev.stopReason;
  }
  scope.turnEnd(stop);
  await rec.flush();
  return events;
}

describe('TraceRecorder', () => {
  it('graba un turno: sistema, usuario, llamadas al modelo y tool', async () => {
    const rec = newRecorder();
    const provider = new MockProvider([
      makeToolCallRound('c1', 'todo', { action: 'write', items: [{ title: 'Paso uno' }] }),
      makeTextRound('Hecho.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'You are Stratum.' }];
    await runTurn(rec, provider, messages, 'haz algo');

    const records = readTrace(rec.file);
    expect(records[0]).toMatchObject({ t: 'meta', v: 1, sessionId: 'sess_test' });
    expect(records.filter((r) => r.t === 'turn')).toEqual([
      expect.objectContaining({ input: 'haz algo' }),
    ]);
    expect(records.at(-1)).toMatchObject({ t: 'turn_end', stopReason: 'stop' });

    const system = records.find((r) => r.t === 'point' && r.kind === 'system');
    expect(system).toMatchObject({ name: 'Prompt inicial del sistema' });

    const models = records.filter((r) => r.t === 'begin' && r.kind === 'model');
    expect(models).toHaveLength(2);
    const ends = records.filter((r) => r.t === 'end');
    const firstModelEnd = ends.find(
      (e) => e.t === 'end' && e.id === (models[0] as { id: string }).id,
    );
    expect(firstModelEnd).toMatchObject({
      status: 'ok',
      data: { toolCalls: [expect.objectContaining({ id: 'c1', name: 'todo' })] },
    });
    const lastModelEnd = ends.find(
      (e) => e.t === 'end' && e.id === (models[1] as { id: string }).id,
    );
    expect(lastModelEnd).toMatchObject({ data: { text: 'Hecho.' } });
    expect(records.some((r) => r.t === 'mark' && r.name === 'first_token')).toBe(true);

    const tool = records.find((r) => r.t === 'begin' && r.kind === 'tool');
    expect(tool).toMatchObject({ name: 'todo', data: { callId: 'c1' } });
    const toolEnd = ends.find((e) => e.t === 'end' && e.id === (tool as { id: string }).id);
    expect(toolEnd).toMatchObject({ status: 'ok' });
    // El prompt del sistema cambió (bloque de tareas reinyectado) antes de la 2.ª llamada.
    expect(
      records.some((r) => r.t === 'point' && r.name === 'Prompt del sistema actualizado'),
    ).toBe(true);
  });

  it('el input del usuario no se duplica como contexto, y lo inyectado sí aparece', async () => {
    const rec = newRecorder();
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    await runTurn(rec, new MockProvider([makeTextRound('uno')]), messages, 'primero');
    // Algo que el runtime inyecta entre turnos (preámbulo, aviso…).
    messages.push({ role: 'user', content: '<runtime_note>recuerda esto</runtime_note>' });
    await runTurn(rec, new MockProvider([makeTextRound('dos')]), messages, 'segundo');

    const context = readTrace(rec.file).filter((r) => r.t === 'point' && r.kind === 'context');
    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({
      name: '<runtime_note>recuerda esto</runtime_note>',
      data: { role: 'user' },
    });
  });

  it('una sesión reanudada resume el historial previo en un paso', async () => {
    const rec = newRecorder();
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'antes' },
      { role: 'assistant', content: 'respuesta' },
    ];
    await runTurn(rec, new MockProvider([makeTextRound('ok')]), messages, 'ahora');
    const context = readTrace(rec.file).filter((r) => r.t === 'point' && r.kind === 'context');
    expect(context).toEqual([expect.objectContaining({ name: 'Historial previo: 2 mensajes' })]);
  });

  it('redacta secretos en entrada, argumentos y salida', async () => {
    const rec = newRecorder();
    const secret = 'sk-proj-abcdefghij0123456789ABCDEFGHIJ';
    const provider = new MockProvider([
      makeToolCallRound('c1', 'todo', { action: 'write', items: [{ title: `usa ${secret}` }] }),
      makeTextRound(`la clave es ${secret}`),
    ]);
    await runTurn(rec, provider, [{ role: 'system', content: 'sys' }], `mi key: ${secret}`);
    const raw = readFileSync(rec.file, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[redacted:');
  });

  it('cierra como cancelados los pasos que un turno abandonado dejó abiertos', async () => {
    const rec = newRecorder();
    const scope = rec.scope();
    scope.turnStart('x', [{ role: 'user', content: 'x' }]);
    scope.event({ type: 'tool_call_ready', id: 'c9', name: 'exec', input: { command: 'sleep 9' } });
    scope.turnEnd('cancelled');
    await rec.flush();
    const records = readTrace(rec.file);
    const begin = records.find((r) => r.t === 'begin') as { id: string };
    expect(records.find((r) => r.t === 'end' && r.id === begin.id)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('los pasos de un subagente cuelgan de su id', async () => {
    const rec = newRecorder();
    const scope = rec.scope();
    scope.turnStart('delega', [{ role: 'user', content: 'delega' }]);
    scope.event({ type: 'subagent_started', subagentId: 'sub_1', profile: 'code', task: 't' });
    const child = scope.child('sub_1');
    const span = child.modelStart({
      iteration: 0,
      model: 'm',
      tools: 0,
      messages: [
        { role: 'system', content: 'child sys' },
        { role: 'user', content: '# Task\nt' },
      ],
    });
    span.end({ text: 'listo', reasoning: '', toolCalls: [] });
    child.event({ type: 'done', stopReason: 'stop' });
    scope.event({
      type: 'subagent_completed',
      subagentId: 'sub_1',
      result: {
        id: 'sub_1',
        status: 'completed',
        summary: 'listo',
        filesChanged: [],
        usage: { iterations: 1, durationMs: 5 },
      },
    });
    scope.turnEnd('stop');
    await rec.flush();
    const records = readTrace(rec.file);
    const childRecords = records.filter(
      (r) => (r.t === 'begin' || r.t === 'point') && r.parent === 'sub_1',
    );
    expect(childRecords.map((r) => (r as { kind: string }).kind)).toEqual([
      'system',
      'context',
      'model',
    ]);
    expect(records.find((r) => r.t === 'end' && r.id === 'sub_1')).toMatchObject({ status: 'ok' });
  });

  it('una sesión sin turnos no deja fichero y un fallo de escritura no lanza', async () => {
    const rec = newRecorder('sess_empty');
    await rec.flush();
    expect(listTraces(config)).toEqual([]);

    // El "directorio" es un fichero: no se puede escribir dentro.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const broken = new TraceRecorder({
      file: join(blocker, 'nope.jsonl'),
      sessionId: 'nope',
      config,
    });
    broken.scope().turnStart('x', [{ role: 'user', content: 'x' }]);
    await expect(broken.flush()).resolves.toBeUndefined();
  });
});

describe('trace store', () => {
  it('solo acepta ids que no salen del directorio', () => {
    expect(isTraceId('sess_20260101_101010_abc')).toBe(true);
    expect(isTraceId('../etc')).toBe(false);
    expect(isTraceId('a/b')).toBe(false);
    expect(traceFilePath(config, '..')).toBeNull();
  });

  it('trace.enabled: false no graba', () => {
    const off = StratumConfigSchema.parse({ trace: { dir, enabled: false } });
    expect(openSessionTrace(off, 'sess_x')).toBeNull();
    expect(openSessionTrace(config, 'sess_x')).not.toBeNull();
    expect(openSessionTrace(config, '../x')).toBeNull();
  });

  it('lista, borra y purga por antigüedad', () => {
    writeFileSync(join(dir, 'old.jsonl'), '{}\n');
    writeFileSync(join(dir, 'new.jsonl'), '{}\n');
    writeFileSync(join(dir, 'ignored.txt'), 'x');
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, 'old.jsonl'), longAgo, longAgo);

    expect(listTraces(config).map((t) => t.sessionId)).toEqual(['new', 'old']);
    expect(pruneTraces(config, 30 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(listTraces(config).map((t) => t.sessionId)).toEqual(['new']);
    expect(deleteTrace(config, 'new')).toBe(true);
    expect(deleteTrace(config, 'new')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Servidor del visor
// ---------------------------------------------------------------------------

function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Lee el SSE hasta ver `count` mensajes `data:`. */
function readEvents(url: string, count: number, onOpen?: () => void): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    let buf = '';
    const req = request(url, (res) => {
      res.setEncoding('utf8');
      onOpen?.();
      res.on('data', (c: string) => {
        buf += c;
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          if (p.startsWith('data: ')) out.push(p.slice(6));
        }
        if (out.length >= count) {
          req.destroy();
          resolve(out);
        }
      });
    });
    req.on('error', (err) => (out.length >= count ? undefined : reject(err)));
    req.end();
  });
}

describe('servidor del visor', () => {
  let server: AuditorServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('sirve la página solo con el token y con el Host de loopback', async () => {
    const file = join(dir, 's.jsonl');
    server = await startAuditorServer({ file, sessionId: 'sess_abc' });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);

    const page = await get(server.url);
    expect(page.status).toBe(200);
    expect(page.body).toContain('sess_abc');
    expect(page.body).not.toContain('__SESSION_ID__');
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'");

    expect((await get(`http://127.0.0.1:${server.port}/`)).status).toBe(404);
    expect((await get(`http://127.0.0.1:${server.port}/${'0'.repeat(32)}/`)).status).toBe(404);
    expect((await get(server.url, { Host: 'evil.example' })).status).toBe(404);
  });

  it('retransmite lo que ya había y lo que se añade después', async () => {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '{"t":"turn","at":1,"input":"año"}\n');
    server = await startAuditorServer({ file, sessionId: 's', pollMs: 20 });
    const lines = await readEvents(`${server.url}events`, 2, () => {
      setTimeout(() => appendFileSync(file, '{"t":"turn_end","at":2,"stopReason":"stop"}\n'), 60);
    });
    expect(lines.map((l) => (JSON.parse(l) as TraceRecord).t)).toEqual(['turn', 'turn_end']);
    expect(lines[0]).toContain('año');
  });

  it('espera a que exista el fichero de una sesión sin turnos', async () => {
    const file = join(dir, 'later.jsonl');
    server = await startAuditorServer({ file, sessionId: 's', pollMs: 20 });
    const lines = await readEvents(`${server.url}events`, 1, () => {
      setTimeout(() => writeFileSync(file, '{"t":"turn","at":1,"input":"x"}\n'), 60);
    });
    expect(lines).toHaveLength(1);
  });
});

describe('página del visor', () => {
  it('es un template válido: el script parsea', async () => {
    const { VIEWER_PAGE } = await import('./viewer-page.js');
    const script = /<script>([\s\S]*)<\/script>/.exec(VIEWER_PAGE)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });
});
