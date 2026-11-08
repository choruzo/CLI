/**
 * M19 fase 5 — dreaming: solo propone. Una pasada con un modelo de guion, las
 * propuestas que no valen, el tope de coste, el aislamiento, y aplicar/rechazar
 * (lo único que escribe la memoria).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumConfigSchema } from '../../config/schema.js';
import { FileConversationStore } from '../../conversation/store.js';
import type { IProvider, OpenAIStreamChunk } from '../../providers/base.js';
import type { Message } from '../../agent/types.js';
import { redactText } from '../../security/redact-output.js';
import { listSources } from '../../transcripts/search.js';
import { DecisionMemory } from '../decision-memory.js';
import type { DecisionInput } from '../decisions.js';
import { applyProposal, rejectProposal } from './apply.js';
import { dream } from './dream.js';
import { openDreamingFiles } from './files.js';
import { resolveDreamingModel } from './model.js';
import { ProposalStore, MAX_PENDING, type ProposalDraft } from './proposals.js';

const dirs: string[] = [];
const memories: DecisionMemory[] = [];
afterEach(async () => {
  for (const m of memories.splice(0)) await m.vectors.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CO = 'sess_20261101_aaaaaa';
const AS = 'sess_20261102_bbbbbb';

function seedSession(
  root: string,
  id: string,
  agent: string,
  messages: Array<[kind: 'user' | 'assistant', text: string]>,
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: id,
      cwd: '/ws',
      provider: 'p',
      model: 'm',
      agent,
      readOnly: false,
      sessionProfile: 'default',
      planRef: null,
      usage: { toolCalls: 0, tokens: null, tokenStatus: 'unavailable' },
      writtenBy: 't',
      createdAt: 1,
      updatedAt: 2,
    }),
  );
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ session: { title: '' } }));
  const store = FileConversationStore.open(join(dir, 'conversation.jsonl'), id);
  messages.forEach(([kind, text], i) =>
    store.putChat({ kind, id: `m${i + 1}`, runId: 'r', at: 1_700_000_000_000 + i, text }),
  );
  store.close();
}

interface Fixture {
  sessions: string;
  memory: DecisionMemory;
  config: ReturnType<typeof StratumConfigSchema.parse>;
  ids: string[];
  decisionsFile: string;
}

const note = (title: string, extra: Partial<DecisionInput> = {}): DecisionInput => ({
  title,
  content: `${title}: contenido de la nota`,
  type: 'topic',
  tags: [],
  importance: 'medium',
  ...extra,
});

async function fixture(dreaming: Record<string, unknown> = {}): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'stratum-dream-'));
  dirs.push(base);
  const sessions = join(base, 'sessions');
  mkdirSync(sessions, { recursive: true });
  seedSession(sessions, CO, 'companion', [
    ['user', 'Mi hermana Lucía vive ahora en Sevilla, ya no en Valencia.'],
    ['assistant', 'Anotado, Lucía vive en Sevilla.'],
    ['user', 'Y mi gato se llama Miso.'],
  ]);
  seedSession(sessions, AS, 'assistant', [['user', 'SECRETO-DEL-ASISTENTE: mi jefa es Marta.']]);
  const config = StratumConfigSchema.parse({
    memory: {
      decisionsFile: join(base, 'memory', 'decisions.json'),
      vectorDb: join(base, 'memory', 'vectors.db'),
      embeddingDimension: 16,
      dreaming,
    },
  });
  let n = 0;
  const memory = new DecisionMemory(config, {
    embedding: {
      embedFn: async (t) =>
        t.map(() => {
          const v = new Float32Array(16);
          v[n++ % 16] = 1;
          return v;
        }),
    },
    forceFallbackVectors: true,
  });
  memories.push(memory);
  const ids: string[] = [];
  for (const input of [
    note('Lucía vive en Valencia', { type: 'person' }),
    note('Café sin azúcar', { type: 'profile' }),
    note('Café solo, sin azúcar', { type: 'profile' }),
    note('Detalle trivial'),
  ]) {
    ids.push((await memory.save(input)).record.id);
  }
  return {
    sessions,
    memory,
    config,
    ids,
    decisionsFile: join(base, 'memory', 'decisions.json'),
  };
}

/** Un modelo de guion: devuelve `reply` y recuerda lo que se le pidió. */
function scripted(
  reply: string | (() => string),
  opts: { usage?: number; fail?: boolean } = {},
): IProvider & { requests: Message[][] } {
  const requests: Message[][] = [];
  return {
    requests,
    async *complete(req: { messages: Message[] }): AsyncGenerator<OpenAIStreamChunk> {
      requests.push(req.messages);
      if (opts.fail) throw new Error('boom');
      const text = typeof reply === 'function' ? reply() : reply;
      yield { choices: [{ delta: { content: text }, finish_reason: null, index: 0 }] };
      if (opts.usage !== undefined) {
        yield {
          choices: [],
          usage: {
            prompt_tokens: opts.usage - 10,
            completion_tokens: 10,
            total_tokens: opts.usage,
          },
        } as unknown as OpenAIStreamChunk;
      }
    },
    async healthCheck() {
      return true;
    },
  };
}

function run(f: Fixture, provider: IProvider, extra: Partial<Parameters<typeof dream>[0]> = {}) {
  const files = openDreamingFiles(f.config);
  return {
    files,
    result: dream({
      notes: () => f.memory.list(),
      proposals: files.proposals,
      state: files.state,
      taxonomy: 'sections',
      sources: listSources(f.sessions, { agent: 'companion' }),
      provider,
      model: 'm',
      config: f.config.memory.dreaming,
      redact: (t) => redactText(t, f.config),
      ...extra,
    }),
  };
}

const ev = { sessionId: CO, messageId: 'm1' };

describe('dream — solo propone', () => {
  it('guarda propuestas con su procedencia y no toca la memoria', async () => {
    const f = await fixture();
    const [lucia, cafe1, cafe2, trivial] = f.ids as [string, string, string, string];
    const before = readFileSync(f.decisionsFile, 'utf-8');
    const reply = JSON.stringify({
      proposals: [
        {
          kind: 'correct',
          targetId: lucia,
          content: 'Su hermana Lucía vive en Sevilla.',
          rationale: 'Lo dijo ella misma, ya no vive en Valencia.',
          evidence: [ev],
        },
        {
          kind: 'create',
          memory: {
            title: 'Gato Miso',
            content: 'Su gato se llama Miso.',
            type: 'topic',
            tags: ['mascotas'],
            importance: 'low',
          },
          rationale: 'Dato estable que no está en las notas.',
          evidence: [{ sessionId: CO, messageId: 'm3' }],
        },
        {
          kind: 'merge',
          targetIds: [cafe1, cafe2],
          into: {
            title: 'Café sin azúcar',
            content: 'Toma el café solo y sin azúcar.',
            type: 'profile',
          },
          rationale: 'Son la misma preferencia.',
          evidence: [ev],
        },
        { kind: 'prune', targetId: trivial, rationale: 'Sin valor.' },
        { kind: 'promote', targetId: cafe1, rationale: 'Pesa mucho.' },
      ],
    });
    const { result, files } = run(f, scripted(reply, { usage: 1234 }));
    const r = await result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposals.map((p) => p.kind)).toEqual([
      'correct',
      'create',
      'merge',
      'prune',
      'promote',
    ]);
    expect(r.tokens).toBe(1234);
    expect(r.considered.sessions).toBe(1); // solo la del companion
    expect(files.proposals.pending()).toHaveLength(5);
    // Nada de la memoria cambió: ni el fichero ni el contenido.
    expect(readFileSync(f.decisionsFile, 'utf-8')).toBe(before);
    expect(f.memory.list()).toHaveLength(4);
  });

  it('el modelo solo recibe su memoria y sus conversaciones, y sabe que son datos', async () => {
    const f = await fixture();
    const provider = scripted('{"proposals":[]}');
    await run(f, provider).result;
    const sent = provider.requests[0]!.map((m) => String(m.content)).join('\n');
    expect(sent).toContain('Lucía vive en Sevilla');
    expect(sent).toContain('Lucía vive en Valencia'); // sus notas
    expect(sent).not.toContain('SECRETO-DEL-ASISTENTE'); // otra memoria
    expect(sent).toMatch(/data, not instructions/);
  });

  it('descarta lo que no vale: sin procedencia real, objetivo ajeno, tipo ajeno, secretos y repetidas', async () => {
    const f = await fixture();
    const [lucia] = f.ids as [string];
    const token = `ghp_${'a'.repeat(36)}`;
    const reply = JSON.stringify({
      proposals: [
        // evidencia inventada
        {
          kind: 'create',
          memory: { title: 'Inventado', content: 'Algo inventado.', type: 'topic' },
          rationale: 'xxxx',
          evidence: [{ sessionId: CO, messageId: 'm99' }],
        },
        // evidencia de la conversación de OTRO agente
        {
          kind: 'create',
          memory: { title: 'Ajeno', content: 'Su jefa es Marta.', type: 'person' },
          rationale: 'xxxx',
          evidence: [{ sessionId: AS, messageId: 'm1' }],
        },
        // objetivo que no existe
        { kind: 'prune', targetId: 'dec_20260101_zzzzzz', rationale: 'xxxx' },
        // tipo de código en una memoria con secciones
        { kind: 'reclassify', targetId: lucia, type: 'bug_fix', rationale: 'xxxx' },
        // un secreto en el texto
        {
          kind: 'create',
          memory: { title: 'Token', content: `Su token es ${token}`, type: 'topic' },
          rationale: 'xxxx',
          evidence: [ev],
        },
        // forma inválida
        { kind: 'explode', rationale: 'xxxx' },
        // buena, y repetida
        { kind: 'promote', targetId: lucia, rationale: 'importante' },
        { kind: 'promote', targetId: lucia, rationale: 'otra vez' },
      ],
    });
    const r = await run(f, scripted(reply)).result;
    expect(r.ok && r.proposals.map((p) => p.kind)).toEqual(['promote']);
    expect(r.ok && r.discarded).toBe(7);
  });

  it('recorta la evidencia a lo que se le enseñó y respeta maxProposals', async () => {
    const f = await fixture({ maxProposals: 2 });
    const [a, b, c] = f.ids as [string, string, string];
    const reply = JSON.stringify([
      {
        kind: 'correct',
        targetId: a,
        content: 'Vive en Sevilla.',
        rationale: 'okay',
        evidence: [ev, { sessionId: AS, messageId: 'm1' }],
      },
      { kind: 'promote', targetId: b, rationale: 'okay' },
      { kind: 'promote', targetId: c, rationale: 'okay' },
    ]);
    const r = await run(f, scripted(reply)).result;
    expect(r.ok && r.proposals).toHaveLength(2);
    expect(r.ok && r.proposals[0]!.evidence).toEqual([ev]);
  });

  it('es incremental: la segunda pasada no ve lo ya revisado, y --force revisa las notas', async () => {
    const f = await fixture();
    const first = scripted('{"proposals":[]}');
    expect((await run(f, first).result).ok).toBe(true);
    const second = scripted('{"proposals":[]}');
    const again = await run(f, second).result;
    expect(again).toMatchObject({ ok: false, reason: 'nothing-new' });
    expect(second.requests).toHaveLength(0);
    const forced = await run(f, scripted('{"proposals":[]}'), { force: true }).result;
    expect(forced.ok).toBe(true);
  });

  it('tolera <think>, fences y prosa alrededor del JSON', async () => {
    const f = await fixture();
    const [a] = f.ids as [string];
    const inner = JSON.stringify({
      proposals: [{ kind: 'promote', targetId: a, rationale: 'okay' }],
    });
    const r = await run(
      f,
      scripted(`<think>hmm</think>Claro:\n\`\`\`json\n${inner}\n\`\`\`\nListo.`),
    ).result;
    expect(r.ok && r.proposals).toHaveLength(1);
  });
});

describe('dream — coste y fallos', () => {
  it('cuenta los tokens que reporta el backend y se detiene en el tope diario', async () => {
    const f = await fixture({ maxTokensPerDay: 1000 });
    const r1 = await run(f, scripted('{"proposals":[]}', { usage: 1200 })).result;
    expect(r1.ok).toBe(true);
    seedSession(f.sessions, 'sess_20261103_cccccc', 'companion', [
      ['user', 'Algo nuevo que contar.'],
    ]);
    const provider = scripted('{"proposals":[]}');
    const r2 = await run(f, provider).result;
    expect(r2).toMatchObject({ ok: false, reason: 'budget' });
    expect(provider.requests).toHaveLength(0);
  });

  it('sin tokens reportados cuenta el tope de entrada (una cota) y devuelve tokens: null', async () => {
    const f = await fixture({ maxInputTokens: 800, maxTokensPerDay: 2000 });
    const r = await run(f, scripted('{"proposals":[]}')).result;
    expect(r.ok && r.tokens).toBeNull();
    const state = JSON.parse(readFileSync(join(f.decisionsFile, '..', 'dreaming.json'), 'utf-8'));
    expect(state.tokens).toBe(800);
  });

  it('limita la entrada al tope por pasada', async () => {
    const f = await fixture({ maxInputTokens: 500 });
    const many: Array<['user', string]> = Array.from({ length: 200 }, (_, i) => [
      'user',
      `Mensaje largo número ${i} ${'palabra '.repeat(30)}`,
    ]);
    seedSession(f.sessions, 'sess_20261104_dddddd', 'companion', many);
    const provider = scripted('{"proposals":[]}');
    await run(f, provider).result;
    const sent = provider.requests[0]!.map((m) => String(m.content)).join('');
    expect(sent.length).toBeLessThan(500 * 3.5 + 4000); // entrada acotada + el prompt fijo
  });

  it('un fallo del modelo o una respuesta sin JSON no lanzan, no pierden lo revisado y gastan la cota', async () => {
    const f = await fixture();
    const failed = await run(f, scripted('', { fail: true })).result;
    expect(failed).toMatchObject({ ok: false, reason: 'model-failed' });
    const garbage = await run(f, scripted('lo siento, no puedo')).result;
    expect(garbage).toMatchObject({ ok: false, reason: 'unparsable' });
    // No se marcó nada como revisado: una pasada buena todavía ve las conversaciones.
    const good = scripted('{"proposals":[]}');
    expect((await run(f, good).result).ok).toBe(true);
    expect(good.requests).toHaveLength(1);
  });

  it('un dreaming.json de un Stratum más nuevo no se toca y no hay pasada', async () => {
    const f = await fixture();
    const file = join(f.decisionsFile, '..', 'dreaming.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 9, x: 1 }));
    const provider = scripted('{"proposals":[]}');
    const r = await run(f, provider).result;
    expect(r).toMatchObject({ ok: false, reason: 'state' });
    expect(provider.requests).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ schemaVersion: 9, x: 1 });
  });
});

describe('apply / reject — lo único que escribe la memoria', () => {
  async function withProposals(f: Fixture, drafts: ProposalDraft[]) {
    const { proposals } = openDreamingFiles(f.config);
    const saved = proposals.add(drafts, { dreamId: 'dream_x', ttlDays: 7 });
    return { proposals, saved };
  }
  const deps = (f: Fixture, proposals: ProposalStore) => ({
    memory: f.memory,
    proposals,
    taxonomy: 'sections' as const,
  });

  it('corregir, crear, fusionar, olvidar, reclasificar y promover cambian la memoria y se marcan aplicadas', async () => {
    const f = await fixture();
    const [lucia, cafe1, cafe2, trivial] = f.ids as [string, string, string, string];
    const { proposals, saved } = await withProposals(f, [
      {
        kind: 'correct',
        targetId: lucia,
        content: 'Vive en Sevilla.',
        rationale: 'razon',
        evidence: [ev],
      },
      {
        kind: 'create',
        memory: {
          title: 'Gato Miso',
          content: 'Su gato es Miso.',
          type: 'topic',
          tags: [],
          importance: 'low',
        },
        rationale: 'razon',
        evidence: [ev],
      },
      {
        kind: 'merge',
        targetIds: [cafe1, cafe2],
        into: {
          title: 'Café solo',
          content: 'Café solo, sin azúcar.',
          type: 'profile',
          tags: [],
          importance: 'high',
        },
        rationale: 'razon',
        evidence: [ev],
      },
      { kind: 'prune', targetId: trivial, rationale: 'razon', evidence: [] },
      { kind: 'reclassify', targetId: lucia, type: 'area', rationale: 'razon', evidence: [] },
      { kind: 'promote', targetId: lucia, rationale: 'razon', evidence: [] },
    ]);
    for (const p of saved) {
      const r = await applyProposal(p.id, deps(f, proposals));
      expect(r.ok, `${p.kind}: ${r.message}`).toBe(true);
    }
    const byId = new Map(f.memory.list().map((d) => [d.id, d]));
    expect(byId.get(lucia)).toMatchObject({
      content: 'Vive en Sevilla.',
      type: 'area',
      importance: 'high',
    });
    expect(byId.get(cafe1)).toMatchObject({ title: 'Café solo', importance: 'high' });
    expect(byId.has(cafe2)).toBe(false); // fusionada
    expect(byId.has(trivial)).toBe(false); // olvidada
    expect([...byId.values()].some((d) => d.title === 'Gato Miso')).toBe(true);
    expect(proposals.pending()).toHaveLength(0);
    expect(proposals.load().every((p) => p.status === 'applied')).toBe(true);
  });

  it('el contenido corregido se vuelve a indexar: se encuentra por lo nuevo', async () => {
    const f = await fixture();
    const [lucia] = f.ids as [string];
    const { proposals, saved } = await withProposals(f, [
      {
        kind: 'correct',
        targetId: lucia,
        title: 'Lucía vive en Sevilla',
        rationale: 'razon',
        evidence: [ev],
      },
    ]);
    expect((await applyProposal(saved[0]!.id, deps(f, proposals))).ok).toBe(true);
    expect(f.memory.list().find((d) => d.id === lucia)?.title).toBe('Lucía vive en Sevilla');
    expect(
      await f.memory.vectors.has(f.memory.list().find((d) => d.id === lucia)!.embedding_ref),
    ).toBe(true);
  });

  it('rechazar no toca la memoria; aplicar dos veces o lo caducado falla sin cambiar nada', async () => {
    const f = await fixture();
    const [a, b] = f.ids as [string, string];
    const { proposals, saved } = await withProposals(f, [
      { kind: 'prune', targetId: a, rationale: 'razon', evidence: [] },
      { kind: 'prune', targetId: b, rationale: 'razon', evidence: [] },
    ]);
    const before = readFileSync(f.decisionsFile, 'utf-8');
    expect(rejectProposal(saved[0]!.id, { proposals }).ok).toBe(true);
    expect(readFileSync(f.decisionsFile, 'utf-8')).toBe(before);
    expect((await applyProposal(saved[0]!.id, deps(f, proposals))).ok).toBe(false); // ya rechazada
    expect((await applyProposal(saved[1]!.id, deps(f, proposals))).ok).toBe(true);
    expect((await applyProposal(saved[1]!.id, deps(f, proposals))).ok).toBe(false); // ya aplicada
    const late = await applyProposal('prop_nope', deps(f, proposals));
    expect(late.ok).toBe(false);
    // Caducada.
    const old = proposals.add(
      [{ kind: 'prune', targetId: f.ids[2]!, rationale: 'razon', evidence: [] }],
      { dreamId: 'd', ttlDays: 1, now: new Date('2020-01-01T00:00:00Z') },
    );
    const expired = await applyProposal(old[0]!.id, { ...deps(f, proposals) });
    expect(expired.ok).toBe(false);
    expect(f.memory.list().some((d) => d.id === f.ids[2])).toBe(true);
  });

  it('si el objetivo ya no existe, la propuesta no se aplica y sigue pendiente', async () => {
    const f = await fixture();
    const [a] = f.ids as [string];
    const { proposals, saved } = await withProposals(f, [
      { kind: 'correct', targetId: a, content: 'Otra cosa.', rationale: 'razon', evidence: [ev] },
    ]);
    await f.memory.remove(a);
    const r = await applyProposal(saved[0]!.id, deps(f, proposals));
    expect(r.ok).toBe(false);
    expect(proposals.pending()).toHaveLength(1);
  });

  it('un tipo que no es de esta memoria no se aplica', async () => {
    const f = await fixture();
    const { proposals, saved } = await withProposals(f, [
      {
        kind: 'reclassify',
        targetId: f.ids[0]!,
        type: 'bug_fix',
        rationale: 'razon',
        evidence: [],
      },
    ]);
    expect((await applyProposal(saved[0]!.id, deps(f, proposals))).ok).toBe(false);
  });
});

describe('ProposalStore', () => {
  function store(): { s: ProposalStore; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-prop-'));
    dirs.push(dir);
    const file = join(dir, 'proposals.json');
    return { s: new ProposalStore(file), file };
  }
  const draft = (i: number): ProposalDraft => ({
    kind: 'prune',
    targetId: `dec_${i}`,
    rationale: 'razon',
    evidence: [],
  });

  it('guarda y lee de forma atómica; caduca lo pendiente y recorta lo resuelto', () => {
    const { s, file } = store();
    const t0 = new Date('2026-11-01T00:00:00Z');
    const [p] = s.add([draft(1)], { dreamId: 'd', ttlDays: 2, now: t0 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(s.pending(new Date('2026-11-02T00:00:00Z'))).toHaveLength(1);
    expect(s.pending(new Date('2026-11-04T00:00:00Z'))).toHaveLength(0); // caducada
    expect(s.resolve(p!.id, 'applied', new Date('2026-11-04T00:00:00Z'))).toBeUndefined();
  });

  it('tiene un tope de pendientes', () => {
    const { s } = store();
    const saved = s.add(
      Array.from({ length: MAX_PENDING + 5 }, (_, i) => draft(i)),
      { dreamId: 'd', ttlDays: 7 },
    );
    expect(saved).toHaveLength(MAX_PENDING);
    expect(s.add([draft(999)], { dreamId: 'd2', ttlDays: 7 })).toHaveLength(0);
  });

  it('un fichero de un Stratum más nuevo no se toca; uno dañado se aparta', () => {
    const a = store();
    writeFileSync(a.file, JSON.stringify({ schemaVersion: 7, proposals: [] }));
    expect(a.s.load()).toEqual([]);
    expect(() => a.s.add([draft(1)], { dreamId: 'd', ttlDays: 1 })).toThrow(/más nuevo/);
    expect(JSON.parse(readFileSync(a.file, 'utf-8')).schemaVersion).toBe(7);

    const b = store();
    writeFileSync(b.file, '{ roto');
    expect(b.s.load()).toEqual([]);
    expect(b.s.add([draft(1)], { dreamId: 'd', ttlDays: 1 })).toHaveLength(1);
  });

  it('conserva las entradas que esta versión no entiende', () => {
    const { s, file } = store();
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, proposals: [{ id: 'x', kind: 'futuro' }] }),
    );
    s.add([draft(1)], { dreamId: 'd', ttlDays: 1 });
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { proposals: Array<{ id: string }> };
    expect(raw.proposals.some((p) => p.id === 'x')).toBe(true);
  });
});

describe('resolveDreamingModel', () => {
  const session = (url: string) =>
    ({ providerName: 'main', model: 'm1', getActive: () => ({}) as IProvider, url }) as never;

  it('same sigue a la sesión', () => {
    const cfg = StratumConfigSchema.parse({});
    const r = resolveDreamingModel(cfg, session(''));
    expect(r).toMatchObject({ ok: true, providerName: 'main', model: 'm1' });
  });

  it('otro provider fuera de esta máquina exige allowRemote; en local, no', () => {
    const providers = {
      remoto: {
        type: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'big',
      },
      local: {
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: '',
        model: 'small',
      },
    };
    const mk = (provider: string, allowRemote = false) =>
      StratumConfigSchema.parse({
        provider: { default: 'remoto', providers },
        memory: { dreaming: { model: { provider }, allowRemote } },
      });
    expect(resolveDreamingModel(mk('remoto'), session(''))).toMatchObject({ ok: false });
    expect(resolveDreamingModel(mk('remoto', true), session(''))).toMatchObject({
      ok: true,
      model: 'big',
    });
    expect(resolveDreamingModel(mk('local'), session(''))).toMatchObject({
      ok: true,
      model: 'small',
    });
    expect(resolveDreamingModel(mk('nope'), session(''))).toMatchObject({ ok: false });
  });
});

describe('arquitectura — dreaming solo propone', () => {
  const here = __dirnameOf();
  function __dirnameOf(): string {
    return join(process.cwd(), 'src', 'memory', 'dreaming');
  }
  const read = (f: string) => readFileSync(join(here, f), 'utf-8');

  it('la pasada no importa apply.ts ni llama a lo que escribe la memoria', () => {
    for (const file of ['dream.ts', 'model.ts', 'format.ts', 'files.ts', 'state.ts']) {
      const text = read(file);
      expect(text, file).not.toMatch(/from '\.\/apply\.js'/);
      expect(text, file).not.toMatch(/\.(save|remove|edit|reclassify|importMissing)\(/);
      expect(text, file).not.toMatch(/import[^;]*(DecisionStore|decision-memory)/);
    }
  });

  it('solo apply.ts escribe en la memoria', () => {
    const text = read('apply.ts');
    expect(text).toMatch(/memory\.(save|remove|edit|reclassify)\(/);
  });
});
