/**
 * M17 — el inspector de memoria por el protocolo (`docs/protocol.md` §13.6),
 * sobre un daemon real con clientes reales:
 *
 *  - `memory.*` con `agent: 'companion'` mira la memoria del companion; sin
 *    `cwd` ni `agent`, la del asistente; `cwd` y `agent` juntos no valen;
 *  - `memory.decisions` trae el contenido redactado y la procedencia;
 *  - `memory.forget` borra solo de la memoria pedida, exige `control` y un id
 *    que ya no está contesta `removed: false`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { StratumConfigSchema } from '../config/schema.js';
import { buildAssistantConfig } from '../host/assistant.js';
import { buildCompanionConfig } from '../host/companion.js';
import {
  DecisionMemory,
  _resetDecisionMemoryCache,
  _setDecisionMemory,
} from '../memory/decision-memory.js';
import { DecisionStore, type DecisionInput } from '../memory/decisions.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
const memories: DecisionMemory[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  // El índice abierto impediría borrar la carpeta en Windows.
  for (const m of memories.splice(0)) await m.vectors.close();
  _resetDecisionMemoryCache();
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

async function daemon(): Promise<TestDaemon> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m17-mem-')));
  bases.push(base);
  const t = await startTestDaemon({ base });
  daemons.push(t);
  // Las memorias que mirará el daemon, con el índice en JS y sin modelo ONNX.
  const config = StratumConfigSchema.parse({});
  for (const c of [
    buildCompanionConfig(config, join(base, 'companion')),
    buildAssistantConfig(config, join(base, 'assistant')),
  ]) {
    const memory = new DecisionMemory(c, {
      embedding: { embedFn: async (texts) => texts.map(() => new Float32Array([1, 0, 0])) },
      forceFallbackVectors: true,
    });
    _setDecisionMemory(c, memory);
    memories.push(memory);
  }
  return t;
}

const decision = (title: string, extra: Partial<DecisionInput> = {}): DecisionInput => ({
  title,
  content: `${title}: contenido`,
  type: 'user_preference',
  tags: ['dot'],
  importance: 'medium',
  ...extra,
});

/** Siembra decisiones directamente en disco, como las dejaría el agente. */
function seed(dir: string, inputs: DecisionInput[]): string[] {
  const store = new DecisionStore(join(dir, 'memory', 'decisions.json'));
  return inputs.map((i) => store.add(i).id);
}

const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

describe('M17 — memory.* del companion', () => {
  it('agent elige la memoria; sin cwd ni agent, la del asistente; nunca se mezclan', async () => {
    const t = await daemon();
    seed(join(t.base, 'companion'), [decision('Café sin azúcar')]);
    seed(join(t.base, 'assistant'), [decision('Informes en PDF')]);
    const dot = await t.connect(['observer'], 'stratum-dot', { kind: 'dot' });

    const companion = await dot.request('memory.decisions', { agent: 'companion' });
    expect(companion.decisions.map((d) => d.title)).toEqual(['Café sin azúcar']);
    const assistant = await dot.request('memory.decisions', {});
    expect(assistant.decisions.map((d) => d.title)).toEqual(['Informes en PDF']);
    expect((await dot.request('memory.decisions', { agent: 'assistant' })).decisions).toEqual(
      assistant.decisions,
    );
    expect((await dot.request('memory.status', { agent: 'companion' })).decisions).toBe(1);

    expect(
      await failure(dot.request('memory.decisions', { agent: 'companion', cwd: t.base })),
    ).toBe('INVALID_PARAMS');
    expect(
      await failure(
        dot.request('memory.decisions', { agent: 'desktop' } as unknown as { agent: 'assistant' }),
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('trae el contenido redactado y la procedencia', async () => {
    const t = await daemon();
    const secret = 'ghp_' + 'a'.repeat(36);
    seed(join(t.base, 'companion'), [
      decision('Token de GitHub', {
        content: `usa ${secret} para el repo`,
        source: 'agent',
        session_id: 'ses_abc',
      }),
      decision('Sin procedencia'),
    ]);
    const dot = await t.connect(['observer'], 'stratum-dot', { kind: 'dot' });
    const { decisions } = await dot.request('memory.decisions', { agent: 'companion' });
    const withSource = decisions.find((d) => d.title === 'Token de GitHub')!;
    expect(withSource).toMatchObject({ source: 'agent', sessionId: 'ses_abc' });
    expect(withSource.content).toContain('para el repo');
    expect(withSource.content).not.toContain(secret);
    const bare = decisions.find((d) => d.title === 'Sin procedencia')!;
    expect(bare.content).toBe('Sin procedencia: contenido');
    expect(bare).not.toHaveProperty('source');
    expect(bare).not.toHaveProperty('sessionId');
  });

  it('memory.forget borra solo de la memoria pedida, y repetirlo es inocuo', async () => {
    const t = await daemon();
    const [companionId] = seed(join(t.base, 'companion'), [decision('Olvídame')]);
    const [assistantId] = seed(join(t.base, 'assistant'), [decision('Quédate')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });

    // El id del companion no existe en la del asistente: no la toca.
    expect(await dot.request('memory.forget', { decisionId: companionId! })).toEqual({
      removed: false,
    });
    expect(
      await dot.request('memory.forget', {
        agent: 'companion',
        decisionId: companionId!,
        operationId: 'op-1',
      }),
    ).toEqual({ removed: true });
    expect((await dot.request('memory.decisions', { agent: 'companion' })).decisions).toEqual([]);
    expect((await dot.request('memory.decisions', {})).decisions.map((d) => d.id)).toEqual([
      assistantId,
    ]);

    // Ya no está: un reintento contesta `removed: false`, sin error.
    expect(
      await dot.request('memory.forget', { agent: 'companion', decisionId: companionId! }),
    ).toEqual({ removed: false });
  });

  it('memory.forget exige control: un observador no olvida nada', async () => {
    const t = await daemon();
    const [id] = seed(join(t.base, 'companion'), [decision('Sigo aquí')]);
    const observer = await t.connect(['observer'], 'stratum-dot', { kind: 'dot' });
    expect(
      await failure(observer.request('memory.forget', { agent: 'companion', decisionId: id! })),
    ).toBe('FORBIDDEN');
    expect((await observer.request('memory.status', { agent: 'companion' })).decisions).toBe(1);
  });
});

describe('M19 — secciones en memory.*', () => {
  it('memory.decisions de un agente trae sección y resumen; los tipos antiguos se migran', async () => {
    const t = await daemon();
    seed(join(t.base, 'companion'), [
      decision('Prefiere café', { type: 'user_preference', summary: 'Café sin azúcar' }),
      decision('Usa Ansible', { type: 'tooling' }),
      decision('Lucía', { type: 'person' }),
    ]);
    const dot = await t.connect(['observer'], 'stratum-dot', { kind: 'dot' });
    const { decisions } = await dot.request('memory.decisions', { agent: 'companion' });
    const by = Object.fromEntries(decisions.map((d) => [d.title, d]));
    expect(by['Prefiere café']).toMatchObject({ type: 'profile', summary: 'Café sin azúcar' });
    expect(by['Usa Ansible']).toMatchObject({ type: 'topic', summary: 'Usa Ansible: contenido' });
    expect(by['Lucía']).toMatchObject({ type: 'person' });
    expect(by['Lucía']!.updatedAt).toBeTruthy();
  });

  it('memory.reclassify mueve el recuerdo solo en la memoria pedida y exige control', async () => {
    const t = await daemon();
    const [companionId] = seed(join(t.base, 'companion'), [decision('Lucía', { type: 'topic' })]);
    seed(join(t.base, 'assistant'), [decision('Otra', { type: 'topic' })]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });

    // El id del companion no está en la del asistente: no la toca.
    expect(
      await dot.request('memory.reclassify', {
        agent: 'assistant',
        decisionId: companionId!,
        type: 'person',
      }),
    ).toEqual({ updated: false });
    expect(
      await dot.request('memory.reclassify', {
        agent: 'companion',
        decisionId: companionId!,
        type: 'person',
      }),
    ).toEqual({ updated: true });
    const { decisions } = await dot.request('memory.decisions', { agent: 'companion' });
    expect(decisions[0]).toMatchObject({ title: 'Lucía', type: 'person' });

    const observer = await t.connect(['observer'], 'stratum-dot', { kind: 'dot' });
    expect(
      await failure(
        observer.request('memory.reclassify', {
          agent: 'companion',
          decisionId: companionId!,
          type: 'area',
        }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('memory.reclassify rechaza una sección que no existe y un cwd', async () => {
    const t = await daemon();
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    expect(
      await failure(
        dot.request('memory.reclassify', {
          agent: 'companion',
          decisionId: 'dec_x',
          type: 'bug_fix',
        } as unknown as { agent: 'companion'; decisionId: string; type: 'topic' }),
      ),
    ).toBe('INVALID_PARAMS');
    expect(
      await failure(
        dot.request('memory.reclassify', {
          cwd: t.base,
          decisionId: 'dec_x',
          type: 'topic',
        } as unknown as { agent: 'companion'; decisionId: string; type: 'topic' }),
      ),
    ).toBe('INVALID_PARAMS');
  });
});
