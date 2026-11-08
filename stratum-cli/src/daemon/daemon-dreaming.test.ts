/**
 * M19 fase 5 — dreaming por el protocolo (`memory.proposals|dream|applyProposal|
 * rejectProposal`), sobre un daemon real con clientes reales, una conversación
 * sintética en disco y un modelo de guion. Comprueba lo que importa: pedir una
 * pasada solo propone, aplicar es lo único que cambia la memoria, cada memoria
 * ve lo suyo, y los permisos.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Message } from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';
import { FileConversationStore } from '../conversation/store.js';
import { ProtocolError } from '../ipc/codec.js';
import { buildAssistantConfig } from '../host/assistant.js';
import { buildCompanionConfig } from '../host/companion.js';
import {
  DecisionMemory,
  _resetDecisionMemoryCache,
  _setDecisionMemory,
} from '../memory/decision-memory.js';
import { DecisionStore, type DecisionInput } from '../memory/decisions.js';
import type { IProvider, OpenAIStreamChunk } from '../providers/base.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
const memories: DecisionMemory[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const m of memories.splice(0)) await m.vectors.close();
  _resetDecisionMemoryCache();
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

const CO = 'sess_20261101_aaaaaa';
const AS = 'sess_20261102_bbbbbb';

function seedSession(sessions: string, id: string, agent: string, talk: string[]): void {
  const dir = join(sessions, id);
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
  talk.forEach((text, i) =>
    store.putChat({ kind: 'user', id: `m${i + 1}`, runId: 'r', at: 1_700_000_000_000 + i, text }),
  );
  store.close();
}

interface Env {
  t: TestDaemon;
  base: string;
  /** Lo que el modelo de guion contestará; lo cambia el test. */
  reply: { text: string; gate?: Promise<void> };
  prompts: Message[][];
  companionIds: string[];
}

const note = (title: string, extra: Partial<DecisionInput> = {}): DecisionInput => ({
  title,
  content: `${title}: contenido`,
  type: 'topic',
  tags: [],
  importance: 'medium',
  ...extra,
});

async function env(options: { noModel?: boolean } = {}): Promise<Env> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m19-dream-')));
  bases.push(base);
  const sessions = join(base, 'sessions');
  seedSession(sessions, CO, 'companion', [
    'Mi hermana Lucía vive ahora en Sevilla, ya no en Valencia.',
    'Y mi gato se llama Miso.',
  ]);
  seedSession(sessions, AS, 'assistant', ['SECRETO-DEL-ASISTENTE: mi jefa es Marta.']);

  const reply: Env['reply'] = { text: '{"proposals":[]}' };
  const prompts: Message[][] = [];
  const provider: IProvider = {
    async *complete(req: { messages: Message[] }): AsyncGenerator<OpenAIStreamChunk> {
      prompts.push(req.messages);
      if (reply.gate) await reply.gate;
      yield { choices: [{ delta: { content: reply.text }, finish_reason: null, index: 0 }] };
    },
    async healthCheck() {
      return true;
    },
  };
  const t = await startTestDaemon({
    base,
    sessionsDir: sessions,
    dreamingModel: () =>
      options.noModel
        ? { ok: false, message: 'no model for the test' }
        : { ok: true, provider, providerName: 'scripted', model: 'm' },
  });
  daemons.push(t);

  const config = StratumConfigSchema.parse({});
  let n = 0;
  const memoryOf = (c: ReturnType<typeof buildCompanionConfig>) => {
    const m = new DecisionMemory(c, {
      embedding: {
        embedFn: async (texts) =>
          texts.map(() => {
            const v = new Float32Array(16);
            v[n++ % 16] = 1;
            return v;
          }),
      },
      forceFallbackVectors: true,
    });
    _setDecisionMemory(c, m);
    memories.push(m);
  };
  const companionCfg = buildCompanionConfig(config, join(base, 'companion'));
  const assistantCfg = buildAssistantConfig(config, join(base, 'assistant'));
  memoryOf(companionCfg);
  memoryOf(assistantCfg);
  const store = new DecisionStore(join(base, 'companion', 'memory', 'decisions.json'));
  const companionIds = [
    store.add(note('Lucía vive en Valencia', { type: 'person' })).id,
    store.add(note('Detalle trivial')).id,
  ];
  new DecisionStore(join(base, 'assistant', 'memory', 'decisions.json')).add(
    note('Nota del asistente'),
  );
  return { t, base, reply, prompts, companionIds };
}

const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

const evidence = (messageId: string) => [{ sessionId: CO, messageId }];

function proposalsReply(ids: string[]): string {
  return JSON.stringify({
    proposals: [
      {
        kind: 'correct',
        targetId: ids[0],
        content: 'Su hermana Lucía vive en Sevilla.',
        rationale: 'Lo dijo ella: ya no vive en Valencia.',
        evidence: evidence('m1'),
      },
      {
        kind: 'create',
        memory: { title: 'Gato Miso', content: 'Su gato se llama Miso.', type: 'topic' },
        rationale: 'Dato duradero que no está en las notas.',
        evidence: evidence('m2'),
      },
      { kind: 'prune', targetId: ids[1], rationale: 'Sin valor duradero.' },
    ],
  });
}

describe('M19 — dreaming por el protocolo', () => {
  it('memory.dream solo propone: devuelve las propuestas y no cambia la memoria', async () => {
    const e = await env();
    e.reply.text = proposalsReply(e.companionIds);
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const file = join(e.base, 'companion', 'memory', 'decisions.json');
    const before = readFileSync(file, 'utf-8');

    expect((await op.request('memory.proposals', { agent: 'companion' })).proposals).toEqual([]);
    const result = await op.request('memory.dream', { agent: 'companion' });
    expect(result).toMatchObject({ status: 'done', discarded: 0, tokens: null });
    expect(result.proposals.map((p) => p.kind)).toEqual(['correct', 'create', 'prune']);
    const correct = result.proposals[0]!;
    expect(correct.targets).toEqual([{ id: e.companionIds[0], title: 'Lucía vive en Valencia' }]);
    expect(correct.content).toBe('Su hermana Lucía vive en Sevilla.');
    expect(correct.evidence).toEqual(evidence('m1'));
    expect(result.proposals[1]).toMatchObject({ title: 'Gato Miso', type: 'topic', targets: [] });

    // Nada cambió, y las propuestas se pueden volver a pedir.
    expect(readFileSync(file, 'utf-8')).toBe(before);
    const listed = await op.request('memory.proposals', { agent: 'companion' });
    expect(listed.proposals.map((p) => p.id)).toEqual(result.proposals.map((p) => p.id));
  });

  it('cada memoria ve lo suyo: ni las conversaciones ni las propuestas del otro agente', async () => {
    const e = await env();
    e.reply.text = proposalsReply(e.companionIds);
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    await op.request('memory.dream', { agent: 'companion' });
    const sent = e.prompts[0]!.map((m) => String(m.content)).join('\n');
    expect(sent).toContain('Lucía vive ahora en Sevilla');
    expect(sent).not.toContain('SECRETO-DEL-ASISTENTE');
    expect(sent).not.toContain('Nota del asistente');
    expect((await op.request('memory.proposals', { agent: 'assistant' })).proposals).toEqual([]);
    expect((await op.request('memory.proposals', {})).proposals).toEqual([]);
  });

  it('aplicar cambia la memoria y la propuesta deja de estar pendiente; rechazar no toca nada', async () => {
    const e = await env();
    e.reply.text = proposalsReply(e.companionIds);
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { proposals } = await op.request('memory.dream', { agent: 'companion' });
    const [correct, create, prune] = proposals as [
      (typeof proposals)[number],
      (typeof proposals)[number],
      (typeof proposals)[number],
    ];

    const applied = await op.request('memory.applyProposal', {
      agent: 'companion',
      proposalId: correct.id,
    });
    expect(applied.applied).toBe(true);
    const titles = async () =>
      (await op.request('memory.decisions', { agent: 'companion' })).decisions.map((d) => d.title);
    const decisions = (await op.request('memory.decisions', { agent: 'companion' })).decisions;
    expect(decisions.find((d) => d.id === e.companionIds[0])?.content).toBe(
      'Su hermana Lucía vive en Sevilla.',
    );

    const rejected = await op.request('memory.rejectProposal', {
      agent: 'companion',
      proposalId: prune.id,
    });
    expect(rejected.rejected).toBe(true);
    expect(await titles()).toContain('Detalle trivial'); // no se olvidó

    expect(
      (await op.request('memory.applyProposal', { agent: 'companion', proposalId: create.id }))
        .applied,
    ).toBe(true);
    expect(await titles()).toContain('Gato Miso');
    expect((await op.request('memory.proposals', { agent: 'companion' })).proposals).toEqual([]);

    // Ya resueltas: no se vuelven a aplicar, y la respuesta lo dice sin error.
    const again = await op.request('memory.applyProposal', {
      agent: 'companion',
      proposalId: correct.id,
    });
    expect(again.applied).toBe(false);
    expect(
      (await op.request('memory.applyProposal', { agent: 'companion', proposalId: 'prop_nope' }))
        .applied,
    ).toBe(false);
  });

  it('una segunda pasada sin conversaciones nuevas se salta, y --force revisa las notas', async () => {
    const e = await env();
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    expect((await op.request('memory.dream', { agent: 'companion' })).status).toBe('done');
    const second = await op.request('memory.dream', { agent: 'companion' });
    expect(second).toMatchObject({ status: 'skipped', reason: 'nothing-new' });
    expect((await op.request('memory.dream', { agent: 'companion', force: true })).status).toBe(
      'done',
    );
  });

  it('sin modelo contesta skipped/no-model, sin error', async () => {
    const e = await env({ noModel: true });
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    expect(await op.request('memory.dream', { agent: 'companion' })).toMatchObject({
      status: 'skipped',
      reason: 'no-model',
    });
  });

  it('una pasada a la vez por memoria: la segunda es BUSY', async () => {
    const e = await env();
    let release: () => void = () => undefined;
    e.reply.gate = new Promise<void>((resolve) => (release = resolve));
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const first = op.request('memory.dream', { agent: 'companion' });
    await new Promise((r) => setTimeout(r, 200));
    expect(await failure(op.request('memory.dream', { agent: 'companion' }))).toBe('BUSY');
    // La otra memoria no se bloquea por ella.
    release();
    expect((await first).status).toBe('done');
  });

  it('permisos: un observador ve las propuestas pero no pide, aplica ni rechaza', async () => {
    const e = await env();
    e.reply.text = proposalsReply(e.companionIds);
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { proposals } = await op.request('memory.dream', { agent: 'companion' });
    const observer = await e.t.connect(['observer'], 'stratum-dot', { kind: 'dot' });
    expect(
      (await observer.request('memory.proposals', { agent: 'companion' })).proposals,
    ).toHaveLength(3);
    expect(await failure(observer.request('memory.dream', { agent: 'companion' }))).toBe(
      'FORBIDDEN',
    );
    expect(
      await failure(
        observer.request('memory.applyProposal', {
          agent: 'companion',
          proposalId: proposals[0]!.id,
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await failure(
        observer.request('memory.rejectProposal', {
          agent: 'companion',
          proposalId: proposals[0]!.id,
        }),
      ),
    ).toBe('FORBIDDEN');
    expect((await op.request('memory.proposals', { agent: 'companion' })).proposals).toHaveLength(
      3,
    );
  });

  it('cwd y agent juntos no valen', async () => {
    const e = await env();
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    expect(await failure(op.request('memory.proposals', { agent: 'companion', cwd: e.base }))).toBe(
      'INVALID_PARAMS',
    );
    expect(await failure(op.request('memory.dream', { agent: 'companion', cwd: e.base }))).toBe(
      'INVALID_PARAMS',
    );
  });

  it('el título de una nota con un secreto sale redactado en la propuesta', async () => {
    const e = await env();
    const secret = `ghp_${'a'.repeat(36)}`;
    const id = new DecisionStore(join(e.base, 'companion', 'memory', 'decisions.json')).add(
      note(`Token ${secret}`),
    ).id;
    e.reply.text = JSON.stringify({
      proposals: [{ kind: 'prune', targetId: id, rationale: 'Es un secreto.' }],
    });
    const op = await e.t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const result = await op.request('memory.dream', { agent: 'companion', force: true });
    expect(result.proposals).toHaveLength(1);
    expect(JSON.stringify(result.proposals[0])).not.toContain(secret);
  });
});
