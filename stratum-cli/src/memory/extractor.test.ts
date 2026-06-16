import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StratumConfigSchema } from '../config/schema.js';
import { DecisionMemory } from './decision-memory.js';
import type { EmbedFn } from './embeddings.js';
import { parseDecisionsJson, extractAndStore } from './extractor.js';
import type { IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { Message } from '../agent/types.js';

const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Float32Array(4);
    for (let i = 0; i < t.length && i < 4; i++) v[i] = t.charCodeAt(i) % 7;
    if (v.every((x) => x === 0)) v[0] = 0.01;
    return v;
  });

function memory(dir: string): DecisionMemory {
  const config = StratumConfigSchema.parse({
    memory: {
      decisionsFile: join(dir, 'decisions.json'),
      vectorDb: join(dir, 'vectors.db'),
      embeddingDimension: 4,
    },
  });
  return new DecisionMemory(config, {
    embedding: { embedFn: fakeEmbed },
    forceFallbackVectors: true,
  });
}

function provider(reply: string): IProvider {
  return {
    async *complete(): AsyncGenerator<OpenAIStreamChunk> {
      yield { choices: [{ delta: { content: reply }, finish_reason: null, index: 0 }] };
    },
    async healthCheck() {
      return true;
    },
  };
}

const convo: Message[] = [
  { role: 'user', content: 'Vamos a usar Ansible para aprovisionar las VMs de vSphere.' },
  { role: 'assistant', content: 'De acuerdo, configuro los playbooks de Ansible.' },
];

describe('parseDecisionsJson', () => {
  it('parsea un array limpio', () => {
    expect(parseDecisionsJson('[{"title":"a"}]')).toHaveLength(1);
  });

  it('tolera bloques <think> y fences markdown', () => {
    const raw = '<think>razonando...</think>\n```json\n[{"title":"x"}]\n```';
    expect(parseDecisionsJson(raw)).toHaveLength(1);
  });

  it('tolera prosa antes y después del array', () => {
    const raw = 'Claro, aquí tienes: [{"title":"y"}]. ¡Listo!';
    expect(parseDecisionsJson(raw)).toHaveLength(1);
  });

  it('devuelve [] ante basura no-JSON', () => {
    expect(parseDecisionsJson('no hay nada aquí')).toEqual([]);
  });
});

describe('extractAndStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-ex-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('extrae y persiste decisiones del transcript', async () => {
    const reply = JSON.stringify([
      {
        title: 'Aprovisionar con Ansible',
        content: 'Se decidió usar Ansible para las VMs de vSphere.',
        type: 'tooling',
        tags: ['ansible', 'vmware'],
        importance: 'high',
      },
    ]);
    const mem = memory(dir);
    const added = await extractAndStore({
      provider: provider(reply),
      model: 'm',
      messages: convo,
      memory: mem,
    });
    expect(added).toBe(1);
    const stored = mem.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.source).toBe('auto');
  });

  it('no añade nada cuando el modelo devuelve []', async () => {
    const mem = memory(dir);
    const added = await extractAndStore({
      provider: provider('[]'),
      model: 'm',
      messages: convo,
      memory: mem,
    });
    expect(added).toBe(0);
    expect(mem.list()).toHaveLength(0);
  });

  it('ignora conversaciones demasiado cortas', async () => {
    const mem = memory(dir);
    const added = await extractAndStore({
      provider: provider('[{"title":"x","content":"yyyyy","type":"tooling","tags":[],"importance":"low"}]'),
      model: 'm',
      messages: [{ role: 'user', content: 'hola' }],
      memory: mem,
    });
    expect(added).toBe(0);
  });
});
