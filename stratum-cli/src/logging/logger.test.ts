import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  configureLogging,
  getLogger,
  resetLogging,
  flushLogging,
  MemorySink,
  StderrSink,
  FileSink,
  redact,
  type LogRecord,
} from './index.js';
import { StratumConfigSchema } from '../config/schema.js';

function capture(): MemorySink {
  const sink = new MemorySink('trace');
  resetLogging([sink], true);
  return sink;
}

afterEach(() => resetLogging());

describe('Logger niveles y filtrado', () => {
  it('respeta el nivel mínimo del sink', () => {
    const sink = new MemorySink('warn');
    resetLogging([sink], true);
    const log = getLogger('t');
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes2');
    expect(sink.records.map((r) => r.msg)).toEqual(['yes', 'yes2']);
  });

  it('es un no-op seguro antes de configurarse', () => {
    resetLogging(); // silent
    expect(() => getLogger('x').info('hola')).not.toThrow();
  });
});

describe('Logger child', () => {
  it('anida namespaces y fusiona campos', () => {
    const sink = capture();
    const base = getLogger('agent');
    const child = base.child('loop', { model: 'm1' });
    child.info('iter', { iter: 3 });
    expect(sink.records[0]!.ns).toBe('agent.loop');
    expect(sink.records[0]!.fields).toEqual({ model: 'm1', iter: 3 });
  });
});

describe('Logger error y timers', () => {
  it('serializa Error en el campo err', () => {
    const sink = capture();
    getLogger('e').error('boom', { err: new Error('kaboom'), code: 7 });
    const rec = sink.records[0]!;
    expect(rec.err?.message).toBe('kaboom');
    expect(rec.fields).toEqual({ code: 7 });
  });

  it('startTimer devuelve ms', () => {
    const end = getLogger('t').startTimer();
    expect(typeof end()).toBe('number');
  });
});

describe('Redacción', () => {
  it('redacta claves sensibles y patrones', () => {
    const out = redact({
      apiKey: 'sk-secret',
      nested: { Authorization: 'Bearer abc.def' },
      msg: 'token sk-ABCDEFGHIJKLMNOP12345 in text',
      safe: 'visible',
    }) as Record<string, unknown>;
    expect(out['apiKey']).toBe('«redacted»');
    expect((out['nested'] as Record<string, unknown>)['Authorization']).toBe('«redacted»');
    expect(out['msg']).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(out['safe']).toBe('visible');
  });

  it('el logger redacta los campos al emitir', () => {
    const sink = capture();
    getLogger('p').info('req', { apiKey: 'sk-xyz' });
    expect(sink.records[0]!.fields).toEqual({ apiKey: '«redacted»' });
  });

  it('no redacta si redact=false', () => {
    const sink = new MemorySink('trace');
    resetLogging([sink], false);
    getLogger('p').info('req', { apiKey: 'sk-xyz' });
    expect(sink.records[0]!.fields).toEqual({ apiKey: 'sk-xyz' });
  });
});

describe('StderrSink', () => {
  it('escribe líneas formateadas al stream', () => {
    const out: string[] = [];
    const sink = new StderrSink({ level: 'info', color: false, stream: { write: (s) => out.push(s) } });
    resetLogging([sink], true);
    getLogger('ns').info('hello', { a: 1 });
    expect(out[0]).toContain('INFO');
    expect(out[0]).toContain('ns: hello');
    expect(out[0]).toContain('a=1');
  });
});

describe('FileSink JSONL', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persiste registros como JSON Lines', async () => {
    const file = join(dir, 'stratum.jsonl');
    const sink = new FileSink({ path: file, level: 'debug' });
    resetLogging([sink], true);
    getLogger('fs').debug('line1', { n: 1 });
    getLogger('fs').warn('line2');
    await flushLogging();
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const r0 = JSON.parse(lines[0]!) as LogRecord;
    expect(r0.msg).toBe('line1');
    expect(r0.ns).toBe('fs');
    expect(r0.fields).toEqual({ n: 1 });
  });
});

describe('configureLogging + overrides', () => {
  const cfg = StratumConfigSchema.parse({});

  it('--debug activa nivel debug y fichero', () => {
    const out: string[] = [];
    configureLogging(cfg, { debug: true, stderrStream: { write: (s) => out.push(s), isTTY: false } });
    getLogger('x').debug('visible');
    expect(out.join('')).toContain('visible');
  });

  it('STRATUM_LOG_LEVEL tiene prioridad sobre config', () => {
    process.env['STRATUM_LOG_LEVEL'] = 'error';
    const out: string[] = [];
    configureLogging(cfg, { stderrStream: { write: (s) => out.push(s), isTTY: false } });
    getLogger('x').info('hidden');
    getLogger('x').error('shown');
    delete process.env['STRATUM_LOG_LEVEL'];
    expect(out.join('')).not.toContain('hidden');
    expect(out.join('')).toContain('shown');
  });

  it('silent desactiva todo', () => {
    const out: string[] = [];
    configureLogging(cfg, { level: 'silent', stderrStream: { write: (s) => out.push(s), isTTY: false } });
    getLogger('x').error('nada');
    expect(out).toHaveLength(0);
  });
});
