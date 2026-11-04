import { describe, expect, it } from 'vitest';
import {
  INHERITED_PREAMBLE,
  MAX_INHERITED_ITEMS,
  buildInherited,
  renderInherited,
  type InheritedMemory,
} from './inherited.js';
import { emptySessionMemory, type MemoryItem, type SessionMemory } from './session-memory.js';
import { MemoryConversationStore } from './store.js';
import { SessionConversation } from './session-conversation.js';
import { CHUNK_CHARS, EXTRACTOR_PROMPT } from './extract.js';
import { makeTextRound } from '../providers/mock.js';
import type { IProvider } from '../providers/base.js';
import type { Message } from '../agent/types.js';

const NOW = '2026-11-04T10:00:00.000Z';

function item(over: Partial<MemoryItem> & Pick<MemoryItem, 'key' | 'text'>): MemoryItem {
  return {
    id: `sm_${over.key}`,
    kind: 'fact',
    status: 'active',
    sources: ['e1'],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function memoryOf(sessionId: string, items: MemoryItem[], summary?: string): SessionMemory {
  return {
    ...emptySessionMemory(sessionId),
    version: 1,
    updatedAt: NOW,
    summary: summary ? { text: summary, sources: ['e1'], updatedAt: NOW } : null,
    items,
  };
}

describe('buildInherited', () => {
  it('nada que pasar: null', () => {
    expect(
      buildInherited({
        sessionId: 'sess_b',
        from: emptySessionMemory('sess_a'),
        previous: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('solo lo vigente, con procedencia; lo propio gana a lo heredado por clase y clave', () => {
    const previous: InheritedMemory = {
      schemaVersion: 1,
      sessionId: 'sess_a',
      fromSessionId: 'sess_0',
      archivedAt: NOW,
      summary: 'old summary',
      items: [
        {
          kind: 'fact',
          key: 'city',
          text: 'Lives in Madrid.',
          origin: { sessionId: 'sess_0', sources: ['e3'] },
        },
        {
          kind: 'fact',
          key: 'pet',
          text: 'Has a dog.',
          origin: { sessionId: 'sess_0', sources: ['e4'] },
        },
        {
          kind: 'task',
          key: 'trip',
          text: 'Plan the trip.',
          origin: { sessionId: 'sess_0', sources: ['e5'] },
        },
      ],
    };
    const from = memoryOf(
      'sess_a',
      [
        item({ key: 'city', text: 'Lives in Bilbao.', sources: ['e2', 'e7'] }),
        item({ key: 'old', text: 'Superseded.', status: 'superseded' }),
        // Una tarea hecha deja anticuada la heredada abierta.
        item({ kind: 'task', key: 'trip', text: 'Trip planned.', status: 'done' }),
      ],
      'new summary',
    );
    const inherited = buildInherited({ sessionId: 'sess_b', from, previous, now: NOW })!;
    expect(inherited).toMatchObject({
      sessionId: 'sess_b',
      fromSessionId: 'sess_a',
      summary: 'new summary',
    });
    expect(inherited.items.map((i) => [i.key, i.text, i.origin])).toEqual([
      ['city', 'Lives in Bilbao.', { sessionId: 'sess_a', sources: ['e2', 'e7'] }],
      ['pet', 'Has a dog.', { sessionId: 'sess_0', sources: ['e4'] }],
    ]);
  });

  it('sin resumen propio, se queda el heredado; y no pasa del tope de entradas', () => {
    const many = Array.from({ length: MAX_INHERITED_ITEMS + 5 }, (_, n) =>
      item({ key: `k${n}`, text: `Fact ${n}.` }),
    );
    const previous: InheritedMemory = {
      schemaVersion: 1,
      sessionId: 'sess_a',
      fromSessionId: 'sess_0',
      archivedAt: NOW,
      summary: 'carried summary',
      items: [],
    };
    const inherited = buildInherited({
      sessionId: 'sess_b',
      from: memoryOf('sess_a', many),
      previous,
      now: NOW,
    })!;
    expect(inherited.summary).toBe('carried summary');
    expect(inherited.items).toHaveLength(MAX_INHERITED_ITEMS);
  });
});

describe('renderInherited y renderMemory', () => {
  const inherited: InheritedMemory = {
    schemaVersion: 1,
    sessionId: 'sess_b',
    fromSessionId: 'sess_a',
    archivedAt: NOW,
    summary: 'S'.repeat(400),
    items: Array.from({ length: 20 }, (_, n) => ({
      kind: 'fact' as const,
      key: `k${n}`,
      text: `Carried fact number ${n}.`,
      origin: { sessionId: 'sess_a', sources: ['e1', 'e2', 'e3'] },
    })),
  };

  it('dice que no es autoridad, con procedencia, y cabe en el presupuesto', () => {
    const full = renderInherited(inherited, 100_000);
    expect(full).toContain(INHERITED_PREAMBLE);
    expect(full).toContain('- Carried fact number 0. [sess_a:e1,e2,…]');
    const small = renderInherited(inherited, 900);
    expect(small.length).toBeLessThanOrEqual(900);
    // Sale primero lo más viejo: lo primero se queda.
    expect(small).toContain('Carried fact number 0.');
    expect(small).not.toContain('Carried fact number 19.');
    expect(renderInherited(inherited, 0)).toBe('');
  });

  it('la memoria propia va primero y lo heredado no baja del 40 % si no cabe todo', () => {
    const own = memoryOf(
      'sess_b',
      Array.from({ length: 60 }, (_, n) =>
        item({ key: `own${n}`, text: `Own fact ${n}.`.repeat(4) }),
      ),
    );
    const conversation = new SessionConversation({
      sessionId: 'sess_b',
      store: new MemoryConversationStore('sess_b'),
      memory: own,
      inherited,
    });
    const text = conversation.renderMemory(4_000);
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text.indexOf('Own fact 0.')).toBeLessThan(
      text.indexOf('From the previous conversation'),
    );
    const carried = text.slice(text.indexOf('# From the previous conversation'));
    expect(carried.length).toBeGreaterThanOrEqual(1_500);

    const alone = new SessionConversation({
      sessionId: 'sess_b',
      store: new MemoryConversationStore('sess_b'),
      inherited,
    });
    expect(alone.renderMemory(100_000)).toBe(renderInherited(inherited, 100_000));
  });
});

describe('SessionConversation.compactAll (cierre de M14)', () => {
  /** Modelo de memoria falso: cuenta peticiones y falla la `failAt`-ésima del extractor. */
  function fakeModels(opts: { failAt?: number } = {}) {
    const prompts: string[] = [];
    let extractions = 0;
    const provider = {
      async *complete(req: { messages: Array<{ content?: string | null }> }) {
        const prompt = String(req.messages[0]?.content ?? '');
        prompts.push(prompt);
        const extractor = prompt.startsWith(EXTRACTOR_PROMPT);
        if (extractor && ++extractions === opts.failAt) throw new Error('memory model down');
        const ids = [...prompt.matchAll(/\[(e\d+) /g)].map((m) => m[1]!);
        const reply = extractor
          ? JSON.stringify({
              items: [{ kind: 'fact', key: `k${extractions}`, text: 'A fact.', sources: [ids[0]] }],
            })
          : 'A summary.';
        for (const chunk of makeTextRound(reply)) yield chunk;
      },
    } as unknown as IProvider;
    const model = (role: 'extractor' | 'summarizer') => ({
      role,
      provider,
      providerName: 'fake',
      model: 'm',
      sameProvider: true,
    });
    return {
      prompts,
      models: { ok: true as const, extractor: model('extractor'), summarizer: model('summarizer') },
    };
  }

  const long = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `${i}: ${'x'.repeat(3_500)}`,
    }));

  it('por lotes que caben enteros: ningún trozo enviado pasa del tope ni se recorta', async () => {
    const saved: SessionMemory[] = [];
    const conversation = new SessionConversation({
      sessionId: 'sess_a',
      store: new MemoryConversationStore('sess_a'),
      persistence: { saveMemory: (m) => saved.push(m), saveState: () => undefined },
    });
    const { models, prompts } = fakeModels();
    const outcome = await conversation.compactAll({
      messages: long(40),
      models,
      timeoutMs: 5_000,
      tokensBefore: 1,
      tokensAfter: 1,
    });
    expect(outcome).toMatchObject({ ok: true, compacted: 40 });
    const chunks = prompts
      .filter((p) => p.startsWith(EXTRACTOR_PROMPT))
      .map((p) => p.slice(p.indexOf('<conversation>')));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_CHARS + 40);
      expect(chunk).not.toContain('truncated');
    }
    // Todas las entradas llegaron, y se guardó una sola vez.
    const seen = chunks.join('\n').match(/\[e\d+ /g) ?? [];
    expect(seen).toHaveLength(40);
    expect(saved).toHaveLength(1);
    expect(conversation.state.compactionCount).toBe(chunks.length);
  });

  it('un fallo en un lote intermedio no guarda nada: memoria y estado como estaban', async () => {
    const saved: SessionMemory[] = [];
    const conversation = new SessionConversation({
      sessionId: 'sess_a',
      store: new MemoryConversationStore('sess_a'),
      persistence: { saveMemory: (m) => saved.push(m), saveState: () => undefined },
    });
    const before = conversation.memory;
    const outcome = await conversation.compactAll({
      messages: long(40),
      models: fakeModels({ failAt: 2 }).models,
      timeoutMs: 5_000,
      tokensBefore: 1,
      tokensAfter: 1,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'extractor' });
    expect(saved).toEqual([]);
    expect(conversation.memory).toBe(before);
    expect(conversation.state.compactionCount).toBe(0);
  });
});
