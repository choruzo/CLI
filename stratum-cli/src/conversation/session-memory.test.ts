import { describe, expect, it } from 'vitest';
import {
  applyMemoryUpdate,
  emptySessionMemory,
  memoryCounts,
  renderSessionMemory,
  SESSION_MEMORY_PREAMBLE,
  type Extraction,
  type SessionMemory,
} from './session-memory.js';
import { parseExtraction } from './extract.js';

const order = (id: string): number => Number(id.slice(1));

function apply(
  memory: SessionMemory,
  extraction: Extraction,
  chunk: string[],
  summary: string | null = null,
): SessionMemory {
  return applyMemoryUpdate(memory, {
    extraction,
    summary,
    chunk,
    order,
    now: '2026-10-18T00:00:00.000Z',
  }).memory;
}

describe('memoria de sesión — actualización incremental', () => {
  it('añade lo extraído con su procedencia y avanza versión y cursor', () => {
    const m = apply(
      emptySessionMemory('s'),
      {
        items: [
          { kind: 'decision', key: 'db', text: 'Probar primero SQLite.', sources: ['e3', 'e4'] },
          { kind: 'task', key: 'bench', text: 'Medir latencia.', sources: ['e5'], status: 'open' },
        ],
      },
      ['e3', 'e4', 'e5'],
      'Se discute el almacenamiento.',
    );
    expect(m.version).toBe(1);
    expect(m.sourceCursor).toBe('e5');
    expect(m.items).toHaveLength(2);
    expect(m.items[0]).toMatchObject({ status: 'active', sources: ['e3', 'e4'] });
    expect(m.summary?.sources).toEqual(['e3', 'e4', 'e5']);
  });

  it('procedencia obligatoria: una fuente fuera del trozo no cuenta y sin fuentes no entra', () => {
    const { memory, report } = applyMemoryUpdate(emptySessionMemory('s'), {
      extraction: {
        items: [
          { kind: 'fact', key: 'a', text: 'Inventado.', sources: ['e99'] },
          { kind: 'fact', key: 'b', text: 'Real.', sources: ['e1', 'e99'] },
        ],
      },
      summary: null,
      chunk: ['e1', 'e2'],
      order,
      now: 'x',
    });
    expect(report.rejected).toBe(1);
    expect(memory.items.map((i) => i.text)).toEqual(['Real.']);
    expect(memory.items[0]!.sources).toEqual(['e1']);
  });

  it('un hecho que contradice a otro lo sustituye (misma clave), sin perder la historia', () => {
    let m = apply(
      emptySessionMemory('s'),
      { items: [{ kind: 'fact', key: 'model', text: 'El modelo es llama3.', sources: ['e1'] }] },
      ['e1'],
    );
    m = apply(
      m,
      { items: [{ kind: 'fact', key: 'Model', text: 'El modelo es qwen3.', sources: ['e7'] }] },
      ['e7'],
    );
    const [old, current] = m.items;
    expect(old).toMatchObject({ status: 'superseded', supersededBy: current!.id, sources: ['e1'] });
    expect(current).toMatchObject({ status: 'active', supersedes: old!.id, sources: ['e7'] });
    const text = renderSessionMemory(m, 10_000);
    expect(text).toContain('qwen3');
    expect(text).not.toContain('llama3');
  });

  it('`supersedes` explícito sustituye aunque la clave cambie', () => {
    let m = apply(
      emptySessionMemory('s'),
      { items: [{ kind: 'decision', key: 'storage', text: 'Usar Postgres.', sources: ['e1'] }] },
      ['e1'],
    );
    const id = m.items[0]!.id;
    m = apply(
      m,
      {
        items: [
          {
            kind: 'decision',
            key: 'db-engine',
            text: 'Usar SQLite.',
            sources: ['e2'],
            supersedes: id,
          },
        ],
      },
      ['e2'],
    );
    expect(m.items.find((i) => i.id === id)?.status).toBe('superseded');
  });

  it('un conflicto sin resolver conserva las dos versiones marcadas', () => {
    let m = apply(
      emptySessionMemory('s'),
      { items: [{ kind: 'fact', key: 'port', text: 'Puerto 8080.', sources: ['e1'] }] },
      ['e1'],
    );
    m = apply(
      m,
      {
        items: [
          { kind: 'fact', key: 'port', text: 'Puerto 9090.', sources: ['e2'], conflict: true },
        ],
      },
      ['e2'],
    );
    expect(m.items.map((i) => i.status)).toEqual(['conflict', 'conflict']);
    expect(renderSessionMemory(m, 10_000)).toContain('(conflicting) Puerto 9090.');
  });

  it('una tarea abierta se cierra con `done` y la misma clave', () => {
    let m = apply(
      emptySessionMemory('s'),
      {
        items: [
          { kind: 'task', key: 'tests', text: 'Arreglar tests.', sources: ['e1'], status: 'open' },
        ],
      },
      ['e1'],
    );
    m = apply(
      m,
      {
        items: [
          {
            kind: 'task',
            key: 'tests',
            text: 'Tests arreglados.',
            sources: ['e9'],
            status: 'done',
          },
        ],
      },
      ['e9'],
    );
    expect(m.items).toHaveLength(1);
    expect(m.items[0]).toMatchObject({ status: 'done', sources: ['e1', 'e9'] });
    expect(memoryCounts(m).task).toBe(0);
  });

  it('lo mismo dicho otra vez solo suma procedencia', () => {
    let m = apply(
      emptySessionMemory('s'),
      { items: [{ kind: 'fact', key: 'os', text: 'Windows 11.', sources: ['e1'] }] },
      ['e1'],
    );
    m = apply(m, { items: [{ kind: 'fact', key: 'os', text: 'Windows 11.', sources: ['e4'] }] }, [
      'e4',
    ]);
    expect(m.items).toHaveLength(1);
    expect(m.items[0]!.sources).toEqual(['e1', 'e4']);
  });

  it('la memoria de entrada no se modifica (el commit es sustituir)', () => {
    const before = emptySessionMemory('s');
    const frozen = JSON.stringify(before);
    apply(before, { items: [{ kind: 'fact', key: 'k', text: 't', sources: ['e1'] }] }, ['e1'], 'r');
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

describe('memoria de sesión — lo que ve el modelo', () => {
  it('lleva el aviso de que no es autoridad y respeta el presupuesto', () => {
    let m = emptySessionMemory('s');
    const items = Array.from({ length: 60 }, (_, i) => ({
      kind: 'fact' as const,
      key: `k${i}`,
      text: `Hecho número ${i} con algo de texto para ocupar sitio.`,
      sources: [`e${i + 1}`],
    }));
    m = apply(
      m,
      { items },
      items.map((i) => i.sources[0]!),
      'Resumen de lo ocurrido.',
    );
    const full = renderSessionMemory(m, 100_000);
    expect(full.startsWith(SESSION_MEMORY_PREAMBLE)).toBe(true);
    expect(full).toMatch(/not authority/);
    const small = renderSessionMemory(m, 1_500);
    expect(small.length).toBeLessThanOrEqual(1_500);
    expect(small).toContain('Resumen de lo ocurrido.');
  });

  it('vacía si no hay nada', () => {
    expect(renderSessionMemory(emptySessionMemory('s'), 1_000)).toBe('');
  });
});

describe('contrato del extractor', () => {
  it('lee JSON, también dentro de un bloque de código o como lista suelta', () => {
    const items = [{ kind: 'fact', key: 'a', text: 'x', sources: ['e1'] }];
    expect(parseExtraction(JSON.stringify({ items })).items).toHaveLength(1);
    expect(parseExtraction('```json\n' + JSON.stringify({ items }) + '\n```').items).toHaveLength(
      1,
    );
    expect(parseExtraction(JSON.stringify(items)).items).toHaveLength(1);
  });

  it('descarta entradas fuera de contrato y falla si no hay JSON', () => {
    const out = parseExtraction(
      JSON.stringify({
        items: [
          { kind: 'opinion', key: 'a', text: 'x', sources: ['e1'] },
          { kind: 'fact', key: 'b', text: 'y', sources: [] },
          { kind: 'fact', key: 'c', text: 'z', sources: ['e1'] },
        ],
      }),
    );
    expect(out.items.map((i) => i.key)).toEqual(['c']);
    expect(() => parseExtraction('no hay nada que extraer')).toThrow(/JSON/);
  });
});
