import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore, parseDuration } from './store.js';
import type { Message } from '../agent/types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `stratum-sessions-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sampleMessages: Message[] = [
  { role: 'system', content: 'Eres un agente.' },
  { role: 'user', content: 'Hola' },
  { role: 'assistant', content: 'Hola, ¿en qué puedo ayudarte?' },
];

describe('SessionStore', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('save y load round-trip', async () => {
    const saved = await store.save({
      provider: 'local-ollama',
      model: 'qwen2.5',
      project: '/home/test',
      messages: sampleMessages,
      toolCallCount: 3,
    });

    expect(saved.id).toMatch(/^sess_\d{8}_\d{6}_[a-z0-9]{3}$/);
    expect(saved.provider).toBe('local-ollama');

    const loaded = store.load(saved.id);
    expect(loaded.messages).toHaveLength(sampleMessages.length);
    expect(loaded.toolCallCount).toBe(3);
  });

  it('no persiste apiKey ni baseUrl', async () => {
    const saved = await store.save({
      provider: 'local-ollama',
      model: 'qwen2.5',
      project: '/test',
      messages: sampleMessages,
      toolCallCount: 0,
    });

    const raw = readFileSync(join(tmpDir, `${saved.id}.json`), 'utf-8');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('baseUrl');
    expect(raw).not.toContain('sk-');
  });

  it('list devuelve sesiones más recientes primero', async () => {
    await store.save({
      provider: 'p1',
      model: 'm1',
      project: '/p',
      messages: sampleMessages,
      toolCallCount: 0,
    });
    // Pausa para garantizar updatedAt distinto
    await new Promise((r) => setTimeout(r, 50));
    await store.save({
      provider: 'p2',
      model: 'm2',
      project: '/p',
      messages: sampleMessages,
      toolCallCount: 0,
    });

    const list = store.list();
    // b se guardó después → su updatedAt es mayor → debe aparecer primero
    expect(list[0]!.provider).toBe('p2');
    expect(list[1]!.provider).toBe('p1');
  });

  it('list --last limita resultados', async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await store.save({
        provider: 'p',
        model: 'm',
        project: '/p',
        messages: sampleMessages,
        toolCallCount: 0,
      });
    }
    const list = store.list({ last: 3 });
    expect(list).toHaveLength(3);
  });

  it('delete elimina la sesión', async () => {
    const saved = await store.save({
      provider: 'p',
      model: 'm',
      project: '/p',
      messages: sampleMessages,
      toolCallCount: 0,
    });
    store.delete(saved.id);
    expect(() => store.load(saved.id)).toThrow();
  });

  it('prune elimina sesiones antiguas', async () => {
    const saved = await store.save({
      provider: 'p',
      model: 'm',
      project: '/p',
      messages: sampleMessages,
      toolCallCount: 0,
    });

    // Esperar un poco y usar un umbral de 1ms para que sean "antiguas"
    await new Promise((r) => setTimeout(r, 5));
    const deleted = store.prune(1);
    expect(deleted).toBeGreaterThan(0);
    expect(() => store.load(saved.id)).toThrow();
  });

  it('load lanza error si no existe la sesión', () => {
    expect(() => store.load('sess_no_existe')).toThrow();
  });
});

describe('parseDuration', () => {
  it('parsea días', () => expect(parseDuration('30d')).toBe(30 * 86_400_000));
  it('parsea horas', () => expect(parseDuration('2h')).toBe(2 * 3_600_000));
  it('parsea minutos', () => expect(parseDuration('5m')).toBe(5 * 60_000));
  it('parsea segundos', () => expect(parseDuration('10s')).toBe(10_000));
  it('lanza en formato inválido', () => expect(() => parseDuration('abc')).toThrow());
});
