import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SubagentStore,
  SUBAGENT_HEARTBEAT_MS,
  SUBAGENT_STALE_MS,
  ownerState,
  parseSubagentFile,
  type LivenessProbe,
} from './subagent-store.js';
import { SessionStore } from './store.js';
import { deleteSessionWithArtifacts, pruneSessionsWithArtifacts } from './cleanup.js';
import type { SubagentResult } from '../agent/types.js';

const DAY = 24 * 60 * 60 * 1000;

function result(id: string, status: SubagentResult['status'] = 'completed'): SubagentResult {
  return {
    id,
    status,
    summary: 'resumen',
    filesChanged: [],
    usage: { iterations: 1, durationMs: 5 },
  };
}

/** Proceso A lanza subagentes; B reanuda. `aliveA` decide si A sigue vivo. */
function probes(opts?: { aliveA?: boolean }) {
  const a = (): LivenessProbe => ({ pid: 1111, host: 'h', now: Date.now(), pidAlive: () => true });
  const b = (): LivenessProbe => ({
    pid: 2222,
    host: 'h',
    now: Date.now(),
    pidAlive: (pid) => pid === 2222 || (pid === 1111 && opts?.aliveA === true),
  });
  return { a, b };
}

describe('ownerState', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const probe: LivenessProbe = { pid: 10, host: 'h', now, pidAlive: (p) => p === 20 };
  const beat = (msAgo: number) => new Date(now - msAgo).toISOString();

  it('el propio proceso siempre está vivo', () => {
    expect(ownerState({ owner: { pid: 10, host: 'h', heartbeatAt: beat(DAY) } }, probe)).toBe(
      'alive',
    );
  });
  it('mismo host: pid muerto → dead, pid vivo con latido fresco → alive', () => {
    expect(ownerState({ owner: { pid: 30, host: 'h', heartbeatAt: beat(1000) } }, probe)).toBe(
      'dead',
    );
    expect(ownerState({ owner: { pid: 20, host: 'h', heartbeatAt: beat(1000) } }, probe)).toBe(
      'alive',
    );
  });
  it('latido caducado → dead aunque el pid exista (pid reutilizado)', () => {
    const stale = beat(SUBAGENT_STALE_MS + 1000);
    expect(ownerState({ owner: { pid: 20, host: 'h', heartbeatAt: stale } }, probe)).toBe('dead');
  });
  it('otro host: solo decide el latido', () => {
    expect(ownerState({ owner: { pid: 30, host: 'otro', heartbeatAt: beat(1000) } }, probe)).toBe(
      'alive',
    );
    expect(
      ownerState(
        { owner: { pid: 30, host: 'otro', heartbeatAt: beat(SUBAGENT_STALE_MS + 1) } },
        probe,
      ),
    ).toBe('dead');
  });
  it('sin owner (registro anterior al campo) → unknown', () => {
    expect(ownerState({ owner: null }, probe)).toBe('unknown');
  });
});

describe('parseSubagentFile', () => {
  const base = {
    id: 'sub_1',
    profile: 'general',
    task: 't',
    status: 'running',
    result: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('acepta un registro anterior al endurecimiento de 8B (sin schemaVersion, sessionId ni owner)', () => {
    const r = parseSubagentFile(base, 'sub_1');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.record.schemaVersion).toBe(1);
      expect(r.record.sessionId).toBeNull();
      expect(r.record.owner).toBeNull();
    }
  });
  it('schemaVersion mayor → newer', () => {
    expect(parseSubagentFile({ ...base, schemaVersion: 99 }).kind).toBe('newer');
  });
  it('estados contradictorios, id ajeno o forma rota → corrupt', () => {
    expect(parseSubagentFile({ ...base, result: result('sub_1') }).kind).toBe('corrupt');
    expect(parseSubagentFile({ ...base, status: 'completed' }).kind).toBe('corrupt');
    expect(
      parseSubagentFile({ ...base, status: 'failed', result: result('sub_1', 'completed') }).kind,
    ).toBe('corrupt');
    expect(parseSubagentFile(base, 'sub_2').kind).toBe('corrupt');
    expect(parseSubagentFile({ ...base, id: '../x' }).kind).toBe('corrupt');
    expect(parseSubagentFile([]).kind).toBe('corrupt');
    expect(parseSubagentFile({ ...base, schemaVersion: 'x' }).kind).toBe('corrupt');
  });
  it('conserva campos desconocidos de la misma versión', () => {
    const r = parseSubagentFile({ ...base, extra: 1 });
    expect(r.kind === 'ok' && (r.record as unknown as { extra: number }).extra).toBe(1);
  });
});

describe('SubagentStore (8B endurecido)', () => {
  let dir: string;
  let subDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-substore18-'));
    subDir = join(dir, '.stratum', 'subagents');
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRaw(name: string, body: unknown): string {
    mkdirSync(subDir, { recursive: true });
    const p = join(subDir, name);
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  }

  it('persist guarda sessionId y owner', () => {
    const { a } = probes();
    const store = new SubagentStore(dir, { probe: a });
    store.persist({ id: 'sub_p', profile: 'code', task: 't', sessionId: 'sess_1' });
    const rec = store.read('sub_p');
    expect(rec?.sessionId).toBe('sess_1');
    expect(rec?.owner).toMatchObject({ pid: 1111, host: 'h' });
    expect(rec?.schemaVersion).toBe(1);
    store.persist({ id: 'sub_p', profile: 'code', task: 't', result: result('sub_p') });
    // El resultado no pierde la sesión aunque el callback no la repita.
    expect(store.read('sub_p')?.sessionId).toBe('sess_1');
    store.dispose();
  });

  it('findOrphaned: solo la sesión pedida y solo con el dueño muerto', () => {
    const { a, b } = probes();
    const writer = new SubagentStore(dir, { probe: a });
    writer.saveRunning('sub_mine', 'code', 't', { sessionId: 'sess_1' });
    writer.saveRunning('sub_other', 'code', 't', { sessionId: 'sess_2' });
    writer.dispose();
    const reader = new SubagentStore(dir, { probe: b });
    expect(reader.findOrphaned('sess_1').map((r) => r.id)).toEqual(['sub_mine']);
  });

  it('un subagente vivo en otra terminal NO es huérfano ni se marca', () => {
    const { a, b } = probes({ aliveA: true });
    const writer = new SubagentStore(dir, { probe: a });
    writer.saveRunning('sub_live', 'code', 't', { sessionId: 'sess_1' });
    writer.dispose();
    const reader = new SubagentStore(dir, { probe: b });
    expect(reader.findOrphaned('sess_1')).toEqual([]);
    reader.markInterrupted('sub_live');
    expect(reader.read('sub_live')?.status).toBe('running');
  });

  it('un registro anterior al campo owner no se adopta en ninguna sesión', () => {
    writeRaw('sub_legacy.json', {
      id: 'sub_legacy',
      profile: 'g',
      task: 't',
      status: 'running',
      result: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const store = new SubagentStore(dir, { probe: probes().b });
    expect(store.list().map((r) => r.id)).toEqual(['sub_legacy']);
    expect(store.findOrphaned('sess_1')).toEqual([]);
  });

  it('el latido refresca heartbeatAt mientras corre y para con el resultado', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-26T12:00:00Z'));
    const store = new SubagentStore(dir, { probe: probes().a });
    store.saveRunning('sub_hb', 'code', 't', { sessionId: 's' });
    const first = store.read('sub_hb')!.owner!.heartbeatAt;
    vi.advanceTimersByTime(SUBAGENT_HEARTBEAT_MS);
    const second = store.read('sub_hb')!.owner!.heartbeatAt;
    expect(Date.parse(second) - Date.parse(first)).toBe(SUBAGENT_HEARTBEAT_MS);
    store.saveResult('sub_hb', 'code', 't', result('sub_hb'));
    const after = readFileSync(join(subDir, 'sub_hb.json'), 'utf-8');
    vi.advanceTimersByTime(SUBAGENT_HEARTBEAT_MS * 3);
    expect(readFileSync(join(subDir, 'sub_hb.json'), 'utf-8')).toBe(after);
  });

  it('deferInterrupted solo marca en commitDeferred', () => {
    const writer = new SubagentStore(dir, { probe: probes().a });
    writer.saveRunning('sub_d', 'code', 't', { sessionId: 's' });
    writer.dispose();
    const reader = new SubagentStore(dir, { probe: probes().b });
    reader.deferInterrupted(['sub_d']);
    expect(reader.read('sub_d')?.status).toBe('running');
    reader.commitDeferred();
    expect(reader.read('sub_d')?.status).toBe('interrupted');
  });

  it('nunca reescribe ni borra un registro de un Stratum más nuevo', () => {
    const body = JSON.stringify({ schemaVersion: 99, id: 'sub_new', futuro: true });
    const p = writeRaw('sub_new.json', body);
    utimesSync(p, new Date(0), new Date(0));
    const store = new SubagentStore(dir, { probe: probes().b });
    expect(store.read('sub_new')).toBeNull();
    expect(store.inspect('sub_new').kind).toBe('newer');
    store.saveResult('sub_new', 'code', 't', result('sub_new'));
    expect(store.prune(DAY)).toBe(0);
    expect(readFileSync(p, 'utf-8')).toBe(body);
  });

  it('un JSON roto se ignora al leer y no tumba list()', () => {
    writeRaw('sub_bad.json', '{ no es json');
    const store = new SubagentStore(dir, { probe: probes().b });
    store.saveResult('sub_ok', 'code', 't', result('sub_ok'));
    expect(store.read('sub_bad')).toBeNull();
    expect(store.inspect('sub_bad').kind).toBe('corrupt');
    expect(store.list().map((r) => r.id)).toEqual(['sub_ok']);
  });

  it('un id con separadores de ruta no escribe fuera de la carpeta', () => {
    const store = new SubagentStore(dir, { probe: probes().a });
    store.saveRunning('../escape', 'code', 't');
    store.dispose();
    expect(existsSync(join(dir, '.stratum', 'escape.json'))).toBe(false);
    expect(store.read('../escape')).toBeNull();
  });

  it('deleteSession borra los de la sesión salvo los que siguen corriendo', () => {
    const { a, b } = probes({ aliveA: true });
    const writer = new SubagentStore(dir, { probe: a });
    writer.saveResult('sub_done', 'code', 't', result('sub_done'), { sessionId: 's1' });
    writer.saveRunning('sub_live', 'code', 't', { sessionId: 's1' });
    writer.saveResult('sub_else', 'code', 't', result('sub_else'), { sessionId: 's2' });
    writer.dispose();
    const store = new SubagentStore(dir, { probe: b });
    expect(store.deleteSession('s1')).toBe(1);
    expect(
      store
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['sub_else', 'sub_live']);
  });

  it('prune: viejos terminales, corruptos y temporales fuera; recientes y vivos dentro', () => {
    const { a, b } = probes({ aliveA: true });
    const writer = new SubagentStore(dir, { probe: a });
    writer.saveResult('sub_recent', 'code', 't', result('sub_recent'), { sessionId: 's' });
    writer.saveRunning('sub_live', 'code', 't', { sessionId: 's' });
    writer.dispose();
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    writeRaw('sub_old.json', {
      schemaVersion: 1,
      id: 'sub_old',
      sessionId: 's',
      owner: null,
      profile: 'code',
      task: 't',
      status: 'completed',
      result: result('sub_old'),
      createdAt: old,
      updatedAt: old,
    });
    // El vivo, aunque su updatedAt sea antiguo, no se toca.
    const live = JSON.parse(readFileSync(join(subDir, 'sub_live.json'), 'utf-8'));
    writeRaw('sub_live.json', { ...live, updatedAt: old, createdAt: old });
    const past = new Date(Date.now() - 40 * DAY);
    utimesSync(writeRaw('sub_broken.json', 'xx'), past, past);
    utimesSync(writeRaw('sub_x.json.tmp', 'xx'), past, past);
    writeRaw('sub_fresh_broken.json', 'xx');

    const store = new SubagentStore(dir, { probe: b });
    expect(store.prune(30 * DAY)).toBe(3);
    expect(existsSync(join(subDir, 'sub_old.json'))).toBe(false);
    expect(existsSync(join(subDir, 'sub_broken.json'))).toBe(false);
    expect(existsSync(join(subDir, 'sub_x.json.tmp'))).toBe(false);
    expect(existsSync(join(subDir, 'sub_recent.json'))).toBe(true);
    expect(existsSync(join(subDir, 'sub_live.json'))).toBe(true);
    expect(existsSync(join(subDir, 'sub_fresh_broken.json'))).toBe(true);
  });
});

describe('limpieza de sesiones con sus subagentes (8B endurecido)', () => {
  let root: string;
  let project: string;
  let sessions: SessionStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratum-cleanup-'));
    project = join(root, 'proj');
    mkdirSync(project);
    sessions = new SessionStore(join(root, 'sessions'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Con `usedAt`, la sesión queda sin usar desde esa fecha (prune mira `updatedAt`). */
  async function saveSession(usedAt?: string) {
    const s = await sessions.save({
      provider: 'p',
      model: 'm',
      project,
      messages: [{ role: 'user', content: 'hola' }],
      toolCallCount: 0,
    });
    if (usedAt) {
      const file = join(root, 'sessions', `${s.id}.json`);
      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      writeFileSync(file, JSON.stringify({ ...raw, createdAt: usedAt, updatedAt: usedAt }));
    }
    return s;
  }

  it('sessions delete borra también los registros de esa sesión en su proyecto', async () => {
    const s = await saveSession();
    const subs = new SubagentStore(project);
    subs.saveResult('sub_a', 'code', 't', result('sub_a'), { sessionId: s.id });
    subs.saveResult('sub_b', 'code', 't', result('sub_b'), { sessionId: 'otra' });
    // Se borra desde otro cwd: cuenta el `project` guardado.
    expect(deleteSessionWithArtifacts(sessions, s.id)).toEqual({ subagents: 1, plans: 0 });
    expect(subs.list().map((r) => r.id)).toEqual(['sub_b']);
    expect(() => sessions.load(s.id)).toThrow();
  });

  it('sessions prune arrastra los registros de las sesiones podadas', async () => {
    const old = await saveSession(new Date(Date.now() - 40 * DAY).toISOString());
    const recent = await saveSession();
    const subs = new SubagentStore(project);
    subs.saveResult('sub_old', 'code', 't', result('sub_old'), { sessionId: old.id });
    subs.saveResult('sub_new', 'code', 't', result('sub_new'), { sessionId: recent.id });
    const out = pruneSessionsWithArtifacts(sessions, 30 * DAY, join(root, 'otro-cwd'));
    expect(out).toEqual({ sessions: 1, subagents: 1, plans: 0 });
    expect(subs.list().map((r) => r.id)).toEqual(['sub_new']);
  });
});
