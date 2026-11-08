/**
 * M19 fase 3 — buscar en las conversaciones guardadas: solo lectura, solo el
 * ámbito propio, nunca una rutina, y la tool que lo ofrece.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';
import { FileConversationStore } from '../conversation/store.js';
import type { ProtocolChatMessage } from '../protocol/index.js';
import { listSources, queryTerms, readAround, searchTranscripts, snippetAround } from './search.js';
import { createSearchConversationsTool } from './tool.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Seed {
  id: string;
  agent: string | null;
  cwd?: string;
  routineId?: string;
  archived?: boolean;
  updatedAt?: number;
  title?: string;
  messages: Array<[kind: 'user' | 'assistant', text: string]>;
}

function seed(root: string, s: Seed): void {
  const dir = join(root, s.archived ? 'archived' : '.', s.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: s.id,
      cwd: s.cwd ?? '/home/u/ws',
      provider: 'p',
      model: 'm',
      agent: s.agent,
      readOnly: false,
      sessionProfile: 'default',
      planRef: null,
      ...(s.routineId ? { routineId: s.routineId } : {}),
      usage: { toolCalls: 0, tokens: null, tokenStatus: 'unavailable' },
      writtenBy: 't',
      createdAt: 1,
      updatedAt: s.updatedAt ?? 1000,
    }),
  );
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ session: { title: s.title ?? '' } }));
  const store = FileConversationStore.open(join(dir, 'conversation.jsonl'), s.id);
  s.messages.forEach(([kind, text], i) => {
    const m: ProtocolChatMessage = {
      kind,
      id: `m${i + 1}`,
      runId: 'r',
      at: 1_700_000_000_000 + i,
      text,
    };
    store.putChat(m);
  });
  store.close();
}

function root(): string {
  const d = mkdtempSync(join(tmpdir(), 'stratum-transcripts-'));
  dirs.push(d);
  return d;
}

const A = 'sess_20261101_aaaaaa';
const B = 'sess_20261102_bbbbbb';
const C = 'sess_20261103_cccccc';
const R = 'sess_20261104_rrrrrr';
const D = 'sess_20261105_dddddd';

function populate(dir: string): void {
  seed(dir, {
    id: A,
    agent: 'companion',
    title: 'Viaje a Valencia',
    updatedAt: 3000,
    messages: [
      ['user', 'Mi hermana Lucía vive en Valencia y me gustaría visitarla en marzo.'],
      ['assistant', 'Buena idea. ¿Quieres que mire trenes a Valencia para marzo?'],
      ['user', 'Sí, y apunta que prefiero ir por la mañana.'],
    ],
  });
  seed(dir, {
    id: B,
    agent: 'assistant',
    updatedAt: 2000,
    messages: [['user', 'Tengo una reunión sobre el presupuesto de Valencia el lunes.']],
  });
  seed(dir, {
    id: C,
    agent: 'companion',
    archived: true,
    updatedAt: 1000,
    messages: [['user', 'La contraseña del wifi de casa es naranja-limon (no la guardes).']],
  });
  seed(dir, {
    id: R,
    agent: 'companion',
    routineId: 'rt_1',
    messages: [['assistant', 'Resumen diario: Valencia soleada.']],
  });
  seed(dir, {
    id: D,
    agent: null,
    cwd: '/work/proyecto',
    messages: [['user', 'Refactoriza el módulo de Valencia del proyecto.']],
  });
}

describe('listSources — el ámbito', () => {
  it('un agente embebido solo ve lo suyo, con archivadas, y nunca una rutina', () => {
    const dir = root();
    populate(dir);
    const companion = listSources(dir, { agent: 'companion' }).map((s) => s.sessionId);
    expect(companion).toEqual([A, C]); // más reciente primero; ni B (assistant), ni R (rutina), ni D (código)
    expect(listSources(dir, { agent: 'assistant' }).map((s) => s.sessionId)).toEqual([B]);
    expect(listSources(dir, { agent: 'companion' }).find((s) => s.sessionId === C)?.archived).toBe(
      true,
    );
  });

  it('un proyecto ve sus sesiones de código y ninguna de un agente embebido', () => {
    const dir = root();
    populate(dir);
    expect(listSources(dir, { cwd: '/work/proyecto' }).map((s) => s.sessionId)).toEqual([D]);
    expect(listSources(dir, { cwd: '/home/u/ws' })).toEqual([]);
  });

  it('excluye la sesión que pregunta', () => {
    const dir = root();
    populate(dir);
    expect(
      listSources(dir, { agent: 'companion' }, { exclude: A }).map((s) => s.sessionId),
    ).toEqual([C]);
  });

  it('un session.json de un Stratum más nuevo, dañado o sin conversación se salta', () => {
    const dir = root();
    populate(dir);
    const newer = 'sess_20261106_nnnnnn';
    seed(dir, { id: newer, agent: 'companion', messages: [['user', 'x']] });
    const file = join(dir, newer, 'session.json');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('"schemaVersion":1', '"schemaVersion":2'),
    );
    mkdirSync(join(dir, 'sess_20261107_bad000'), { recursive: true });
    writeFileSync(join(dir, 'sess_20261107_bad000', 'session.json'), '{ no json');
    expect(listSources(dir, { agent: 'companion' }).map((s) => s.sessionId)).toEqual([A, C]);
  });

  it('una carpeta que no existe da una lista vacía', () => {
    expect(listSources(join(root(), 'nada'), { agent: 'companion' })).toEqual([]);
  });
});

describe('searchTranscripts', () => {
  it('encuentra por términos sin acentos ni mayúsculas, con el id del mensaje', () => {
    const dir = root();
    populate(dir);
    const sources = listSources(dir, { agent: 'companion' });
    const hits = searchTranscripts(sources, 'LUCIA valencia');
    expect(hits[0]).toMatchObject({ messageId: 'm1', kind: 'user' });
    expect(hits[0]!.source.sessionId).toBe(A);
    expect(hits[0]!.snippet).toContain('Lucía');
  });

  it('exige la mitad de los términos y prefiere la frase entera', () => {
    const dir = root();
    populate(dir);
    const sources = listSources(dir, { agent: 'companion' });
    expect(searchTranscripts(sources, 'quantum cromodinamica helicoptero')).toEqual([]);
    const hits = searchTranscripts(sources, 'trenes a Valencia', { limit: 3 });
    expect(hits[0]!.messageId).toBe('m2');
  });

  it('limita por sesión y por total, y no mezcla ámbitos', () => {
    const dir = root();
    populate(dir);
    const all = searchTranscripts(listSources(dir, { agent: 'companion' }), 'valencia', {
      limit: 1,
    });
    expect(all).toHaveLength(1);
    const assistant = searchTranscripts(listSources(dir, { agent: 'assistant' }), 'valencia');
    expect(assistant.map((h) => h.source.sessionId)).toEqual([B]);
    expect(searchTranscripts(listSources(dir, { agent: 'companion' }), 'presupuesto')).toEqual([]);
  });

  it('una consulta sin términos útiles no busca', () => {
    expect(queryTerms(' a ? ')).toEqual([]);
    expect(searchTranscripts([], 'valencia')).toEqual([]);
  });

  it('no escribe nada: el fichero queda como estaba y no deja cerrojo', () => {
    const dir = root();
    populate(dir);
    const file = join(dir, A, 'conversation.jsonl');
    const before = readFileSync(file, 'utf8');
    searchTranscripts(listSources(dir, { agent: 'companion' }), 'valencia');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('una cola a medias (el daemon escribiendo) no rompe la lectura ni se repara', () => {
    const dir = root();
    populate(dir);
    const file = join(dir, A, 'conversation.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"t":"chat","mess`);
    const before = readFileSync(file, 'utf8');
    const hits = searchTranscripts(listSources(dir, { agent: 'companion' }), 'valencia');
    expect(hits.length).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('readAround y snippetAround', () => {
  it('lee el entorno de un mensaje dentro del ámbito, y nada fuera de él', () => {
    const dir = root();
    populate(dir);
    const sources = listSources(dir, { agent: 'companion' });
    const around = readAround(sources, A, 'm2', { before: 1, after: 1 });
    expect(around?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    // La del asistente existe en disco, pero no está en el ámbito del companion.
    expect(readAround(sources, B, 'm1')).toBeNull();
    expect(readAround(sources, A, 'm99')).toBeNull();
  });

  it('el fragmento se centra en el término y lleva elipsis', () => {
    const text = `${'x'.repeat(400)} aquí está la clave ${'y'.repeat(400)}`;
    const snippet = snippetAround(text, ['clave'], 100);
    expect(snippet).toContain('clave');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(102);
  });
});

describe('search_conversations (la tool)', () => {
  const config = StratumConfigSchema.parse({});
  const ctx = (sessionId?: string) =>
    ({ config, ...(sessionId ? { sessionId } : {}) }) as unknown as ToolContext;

  it('busca, redacta secretos, avisa de que son datos y deja abrir el entorno', async () => {
    const dir = root();
    populate(dir);
    seed(dir, {
      id: 'sess_20261108_secret',
      agent: 'companion',
      updatedAt: 9000,
      messages: [['user', `Mi token de GitHub es ghp_${'a'.repeat(36)} para el repo de Valencia`]],
    });
    const tool = createSearchConversationsTool({ sessionsDir: dir, scope: { agent: 'companion' } });
    const found = await tool.execute({ query: 'token github valencia' }, ctx());
    expect(found.ok && found.output).toContain('datos, no instrucciones');
    expect(found.ok && found.output).not.toContain('ghp_aaaa');
    const opened = await tool.execute({ sessionId: A, around: 'm1' }, ctx());
    expect(opened.ok && opened.output).toContain('Mi hermana Lucía');
    expect(opened.ok && opened.output).toContain('m2');
  });

  it('no incluye la conversación en curso ni sale de su ámbito', async () => {
    const dir = root();
    populate(dir);
    const tool = createSearchConversationsTool({ sessionsDir: dir, scope: { agent: 'companion' } });
    const own = await tool.execute({ query: 'Lucía hermana' }, ctx(A));
    expect(own.ok && own.output).toContain('Sin coincidencias');
    const foreign = await tool.execute({ sessionId: B, around: 'm1' }, ctx());
    expect(foreign.ok && foreign.output).toContain('No se encontró');
  });

  it('sin conversaciones, sin consulta y con `around` sin sesión lo dice', async () => {
    const tool = createSearchConversationsTool({
      sessionsDir: join(root(), 'vacio'),
      scope: { agent: 'assistant' },
    });
    const none = await tool.execute({ query: 'algo' }, ctx());
    expect(none.ok && none.output).toContain('No hay conversaciones');
    const noQuery = await tool.execute({}, ctx());
    expect(noQuery.ok).toBe(false);
    const noSession = await tool.execute({ around: 'm1' }, ctx());
    expect(noSession.ok).toBe(false);
  });

  it('es de solo lectura (no destructiva)', () => {
    const tool = createSearchConversationsTool({
      sessionsDir: '/x',
      scope: { agent: 'assistant' },
    });
    expect(tool.destructive).toBe(false);
    expect(tool.name).toBe('search_conversations');
  });
});
