import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdtempSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SessionStore,
  SessionCorruptError,
  describeSkippedSessions,
  parseDuration,
} from './store.js';
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

describe('SessionStore — activeAgent (Hito 15)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('persiste el perfil principal activo y lo omite cuando no hay', async () => {
    const store = new SessionStore(dir);
    const base = {
      provider: 'p',
      model: 'm',
      project: '/x',
      messages: sampleMessages,
      toolCallCount: 0,
    };

    const withAgent = await store.save({ ...base, activeAgent: 'reviewer' });
    expect(store.load(withAgent.id).activeAgent).toBe('reviewer');

    const without = await store.save({ ...base, activeAgent: null });
    expect('activeAgent' in store.load(without.id)).toBe(false);
  });

  it('Hito 17: persiste read-only y el perfil de sesión, y los omite si no aplican', async () => {
    const store = new SessionStore(dir);
    const base = {
      provider: 'p',
      model: 'm',
      project: '/x',
      messages: sampleMessages,
      toolCallCount: 0,
    };
    const ro = await store.save({ ...base, readOnly: true, sessionProfile: 'infra' });
    expect(store.load(ro.id)).toMatchObject({ readOnly: true, sessionProfile: 'infra' });
    const plain = await store.save({ ...base, readOnly: false, sessionProfile: null });
    expect('readOnly' in store.load(plain.id)).toBe(false);
    expect('sessionProfile' in store.load(plain.id)).toBe(false);
  });
});

describe('SessionStore endurecido', () => {
  let dir: string;
  let store: SessionStore;
  const base = {
    provider: 'p',
    model: 'm',
    project: '/x',
    messages: sampleMessages,
    toolCallCount: 0,
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-sess-hard-'));
    store = new SessionStore(join(dir, 'sessions'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (id: string) => join(dir, 'sessions', `${id}.json`);
  const writeRaw = (name: string, body: string) => {
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'sessions', name), body);
  };

  it('guarda de forma atómica: no deja temporales', async () => {
    await store.save(base);
    expect(readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('un id con separadores de ruta no lee ni borra fuera de la carpeta', () => {
    const victim = join(dir, 'victima.json');
    writeFileSync(victim, '{}');
    expect(() => store.delete('../victima')).toThrow(/inválido/);
    expect(() => store.load('../victima')).toThrow(/inválido/);
    expect(existsSync(victim)).toBe(true);
  });

  it('load: JSON roto, forma inválida o id ajeno → SessionCorruptError', async () => {
    writeRaw('sess_roto.json', '{ no');
    expect(() => store.load('sess_roto')).toThrow(SessionCorruptError);
    const ok = await store.save(base);
    const raw = JSON.parse(readFileSync(file(ok.id), 'utf-8'));
    writeRaw('sess_sin_msgs.json', JSON.stringify({ ...raw, id: 'sess_sin_msgs', messages: 'x' }));
    expect(() => store.load('sess_sin_msgs')).toThrow(/messages/);
    writeRaw('sess_ajeno.json', JSON.stringify(raw));
    expect(() => store.load('sess_ajeno')).toThrow(/contiene la sesión/);
  });

  it('una sesión anterior sin summary ni toolCallCount se carga con defaults', async () => {
    const ok = await store.save(base);
    const raw = JSON.parse(readFileSync(file(ok.id), 'utf-8'));
    delete raw.summary;
    delete raw.toolCallCount;
    delete raw.schemaVersion;
    writeFileSync(file(ok.id), JSON.stringify(raw));
    expect(store.load(ok.id)).toMatchObject({ summary: '', toolCallCount: 0 });
  });

  it('list/scan omiten las ilegibles y las de un Stratum más nuevo sin lanzar', async () => {
    const ok = await store.save(base);
    writeRaw('sess_roto.json', '{ no');
    const raw = JSON.parse(readFileSync(file(ok.id), 'utf-8'));
    writeRaw('sess_nueva.json', JSON.stringify({ ...raw, id: 'sess_nueva', schemaVersion: 99 }));
    expect(store.list().map((s) => s.id)).toEqual([ok.id]);
    const { skipped } = store.scan();
    expect(skipped.map((s) => [s.file, s.kind]).sort()).toEqual([
      ['sess_nueva.json', 'newer'],
      ['sess_roto.json', 'corrupt'],
    ]);
    expect(describeSkippedSessions(skipped)).toContain('versión más nueva');
    expect(describeSkippedSessions([])).toBeNull();
    // prune no toca lo que no puede leer.
    expect(store.prune(0)).toBe(1);
    expect(existsSync(join(dir, 'sessions', 'sess_roto.json'))).toBe(true);
    expect(existsSync(join(dir, 'sessions', 'sess_nueva.json'))).toBe(true);
  });

  it('prune mira el último uso, no la creación', async () => {
    const s = await store.save({
      ...base,
      createdAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    });
    expect(store.prune(30 * 86_400_000)).toBe(0);
    expect(store.load(s.id).id).toBe(s.id);
  });

  describe('dos terminales con la misma sesión', () => {
    it('quien guarda sobre la versión que cargó la actualiza', async () => {
      const first = await store.save(base);
      const again = await store.save({
        ...base,
        existingId: first.id,
        createdAt: first.createdAt,
        expectedUpdatedAt: first.updatedAt,
      });
      expect(again.id).toBe(first.id);
      expect(again.forkedFrom).toBeUndefined();
    });

    it('si otra terminal guardó entretanto, esta se guarda aparte sin pisarla', async () => {
      const loaded = await store.save(base);
      await new Promise((r) => setTimeout(r, 5));
      // Terminal B reanuda la misma versión y guarda primero.
      const b = await store.save({
        ...base,
        messages: [...sampleMessages, { role: 'user', content: 'soy B' }],
        existingId: loaded.id,
        expectedUpdatedAt: loaded.updatedAt,
      });
      // Terminal A guarda después partiendo de la versión que cargó.
      const a = await store.save({
        ...base,
        messages: [...sampleMessages, { role: 'user', content: 'soy A' }],
        existingId: loaded.id,
        expectedUpdatedAt: loaded.updatedAt,
      });
      expect(a.id).not.toBe(loaded.id);
      expect(a.forkedFrom).toBe(loaded.id);
      expect(store.load(a.id).messages.at(-1)?.content).toBe('soy A');
      expect(store.load(loaded.id).messages.at(-1)?.content).toBe('soy B');
      expect(b.id).toBe(loaded.id);
    });

    it('un id nuevo que ya existe en disco tampoco se pisa', async () => {
      const existing = await store.save(base);
      const other = await store.save({ ...base, existingId: existing.id });
      expect(other.forkedFrom).toBe(existing.id);
      expect(other.id).not.toBe(existing.id);
    });

    it('un id que aún no existe se guarda con ese id', async () => {
      const s = await store.save({ ...base, existingId: 'sess_20260101_000000_new' });
      expect(s.id).toBe('sess_20260101_000000_new');
      expect(s.forkedFrom).toBeUndefined();
    });
  });
});
