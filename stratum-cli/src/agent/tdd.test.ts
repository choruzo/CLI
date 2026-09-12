import { describe, it, expect } from 'vitest';
import {
  TddLedger,
  TddError,
  applyTddRecord,
  buildTddInjection,
  applyTddToSystemMessage,
  findBannedAssertions,
  formatTddSnapshot,
  parseTddSnapshot,
  rehydrateTdd,
  mockCountNote,
  openTasks,
  MAX_TDD_ENTRIES,
  type TddEntry,
} from './tdd.js';
import type { Message } from './types.js';

function red(task = 'suma'): TddEntry {
  return { task, phase: 'red', outcome: 'fail', evidence: '1 failing' };
}
function green(task = 'suma'): TddEntry {
  return { task, phase: 'green', outcome: 'pass', evidence: '1 passing' };
}

describe('applyTddRecord — orden del ciclo (Hito 13)', () => {
  it('un RED que pasa se rechaza: no es un RED', () => {
    expect(() =>
      applyTddRecord([], { task: 'suma', phase: 'red', outcome: 'pass', evidence: '1 passing' }),
    ).toThrow(TddError);
  });

  it('acepta un RED que falla', () => {
    const { entries } = applyTddRecord([], {
      task: 'suma',
      phase: 'red',
      outcome: 'fail',
      evidence: '1 failing: expected 3, got undefined',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ phase: 'red', outcome: 'fail' });
  });

  it('un GREEN sin RED previo de esa tarea se rechaza', () => {
    expect(() =>
      applyTddRecord([red('otra tarea')], {
        task: 'suma',
        phase: 'green',
        outcome: 'pass',
        evidence: '1 passing',
      }),
    ).toThrow(/No hay un RED registrado/);
  });

  it('acepta el GREEN cuando el RED de la misma tarea existe', () => {
    const { entries } = applyTddRecord([red()], {
      task: 'suma',
      phase: 'green',
      outcome: 'pass',
      evidence: '1 passing',
    });
    expect(entries).toHaveLength(2);
  });

  it('un GREEN con tests en rojo se rechaza', () => {
    expect(() =>
      applyTddRecord([red()], {
        task: 'suma',
        phase: 'green',
        outcome: 'fail',
        evidence: '1 failing',
      }),
    ).toThrow(/no es un GREEN/);
  });

  it('triangular exige un GREEN previo', () => {
    expect(() =>
      applyTddRecord([red()], {
        task: 'suma',
        phase: 'triangulate',
        outcome: 'pass',
        evidence: '2 passing',
      }),
    ).toThrow(/No hay un GREEN registrado/);
  });

  it('un segundo caso que falla delata la implementación hardcodeada', () => {
    expect(() =>
      applyTddRecord([red(), green()], {
        task: 'suma',
        phase: 'triangulate',
        outcome: 'fail',
        evidence: '1 failing',
      }),
    ).toThrow(/hardcodeada/);
  });

  it('la triangulación se puede omitir con razón explícita y sin evidencia', () => {
    const { entries, notes } = applyTddRecord([red(), green()], {
      task: 'suma',
      phase: 'triangulate',
      skipReason: 'la función solo tiene una salida posible',
    });
    expect(entries.at(-1)).toMatchObject({ phase: 'triangulate', outcome: 'pass' });
    expect(notes.join(' ')).toContain('Triangulation skipped');
  });

  it('sin evidencia ni skipReason no se registra nada', () => {
    expect(() => applyTddRecord([], { task: 'suma', phase: 'red', outcome: 'fail' })).toThrow(
      /evidence/,
    );
  });

  it('refactorizar sin triangular avisa pero no bloquea', () => {
    const { entries, notes } = applyTddRecord([red(), green()], {
      task: 'suma',
      phase: 'refactor',
      outcome: 'pass',
      evidence: '1 passing',
    });
    expect(entries).toHaveLength(3);
    expect(notes.join(' ')).toContain('sin haber triangulado');
  });

  it('un refactor que rompe los tests se rechaza', () => {
    expect(() =>
      applyTddRecord([red(), green()], {
        task: 'suma',
        phase: 'refactor',
        outcome: 'fail',
        evidence: '1 failing',
      }),
    ).toThrow(/verde/);
  });

  it('rechaza fases desconocidas con la lista de las válidas', () => {
    expect(() =>
      applyTddRecord([], { task: 't', phase: 'blue', outcome: 'pass', evidence: 'x' }),
    ).toThrow(/safety_net/);
  });
});

describe('SAFETY NET y falsos GREEN (Hito 13)', () => {
  it('una línea base en rojo se registra como fallo preexistente y manda parar', () => {
    const { notes } = applyTddRecord([], {
      task: 'suma',
      phase: 'safety_net',
      outcome: 'fail',
      evidence: '2 failing antes de tocar nada',
    });
    expect(notes.join(' ')).toContain('PREEXISTENTE');
  });

  it('0 tests ejecutados no es un GREEN', () => {
    const { notes } = applyTddRecord([red()], {
      task: 'suma',
      phase: 'green',
      outcome: 'pass',
      evidence: '0 tests ran',
    });
    expect(notes.join(' ')).toContain('no es un GREEN');
  });

  it('tests marcados como skipped no cuentan como ejecutados', () => {
    const { notes } = applyTddRecord([red()], {
      task: 'suma',
      phase: 'green',
      outcome: 'pass',
      evidence: '3 skipped',
    });
    expect(notes.join(' ')).toContain('no se ejecutó el code path');
  });
});

describe('aserciones prohibidas y mocks (Hito 13)', () => {
  it('detecta tautologías', () => {
    expect(findBannedAssertions('expect(true).toBe(true)')).toHaveLength(1);
  });

  it('detecta aserciones solo-de-tipo', () => {
    expect(findBannedAssertions('expect(result).toBeDefined()').join(' ')).toContain(
      'solo-de-tipo',
    );
  });

  it('detecta colecciones vacías sin justificar', () => {
    expect(findBannedAssertions('expect(items).toEqual([])').join(' ')).toContain('vacía');
  });

  it('detecta aserciones sobre clases CSS', () => {
    expect(findBannedAssertions('expect(el).toHaveClass("btn")').join(' ')).toContain('CSS');
  });

  it('no marca una aserción normal', () => {
    expect(findBannedAssertions('expect(sum(1, 2)).toBe(3)')).toEqual([]);
  });

  it('las aserciones prohibidas llegan como nota al registrar', () => {
    const { notes } = applyTddRecord([], {
      task: 'suma',
      phase: 'red',
      outcome: 'fail',
      evidence: 'expect(true).toBe(true) — 1 failing',
    });
    expect(notes.join(' ')).toContain('Aserción prohibida');
  });

  it('los umbrales de mocks siguen la regla 3 / 6 / 7+', () => {
    expect(mockCountNote(3)).toBeNull();
    expect(mockCountNote(5)).toContain('capa adecuada');
    expect(mockCountNote(8)).toContain('capa equivocada');
  });
});

describe('snapshot y rehidratación (Hito 13)', () => {
  it('el snapshot sobrevive a un round-trip', () => {
    const entries = [red(), green()];
    const parsed = parseTddSnapshot(formatTddSnapshot(entries));
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toMatchObject({ task: 'suma', phase: 'red', outcome: 'fail' });
  });

  it('parseTddSnapshot devuelve null si el texto no es un snapshot', () => {
    expect(parseTddSnapshot('cualquier otra cosa')).toBeNull();
  });

  it('rehidrata desde el último tool result del historial', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'tool', name: 'test_evidence', content: formatTddSnapshot([red()]) },
      { role: 'tool', name: 'test_evidence', content: formatTddSnapshot([red(), green()]) },
    ];
    expect(rehydrateTdd(messages, 'test_evidence')).toHaveLength(2);
  });

  it('rehidratar un historial sin evidencia devuelve lista vacía', () => {
    expect(rehydrateTdd([{ role: 'system', content: 'sys' }], 'test_evidence')).toEqual([]);
  });

  it('recorta la evidencia vieja al tope', () => {
    let entries: TddEntry[] = [];
    for (let i = 0; i < MAX_TDD_ENTRIES + 5; i++) {
      entries = applyTddRecord(entries, {
        task: `t${i}`,
        phase: 'safety_net',
        outcome: 'pass',
        evidence: '1 passing',
      }).entries;
    }
    expect(entries).toHaveLength(MAX_TDD_ENTRIES);
  });
});

describe('inyección en el system prompt (Hito 13)', () => {
  it('un ciclo cerrado no inyecta nada', () => {
    const entries = [
      red(),
      green(),
      { task: 'suma', phase: 'triangulate', outcome: 'pass', evidence: '2 passing' } as TddEntry,
    ];
    expect(openTasks(entries)).toEqual([]);
    expect(buildTddInjection(entries)).toBe('');
  });

  it('un ciclo abierto se inyecta con la fase siguiente', () => {
    const block = buildTddInjection([red()]);
    expect(block).toContain('# TDD cycle in progress');
    expect(block).toContain('siguiente: green');
  });

  it('el bloque se reemplaza en el system prompt en vez de acumularse', () => {
    const messages: Message[] = [{ role: 'system', content: 'base' }];
    applyTddToSystemMessage(messages, buildTddInjection([red()]));
    applyTddToSystemMessage(messages, buildTddInjection([red(), green()]));
    const content = messages[0]!.content!;
    expect(content.match(/# TDD cycle in progress/g)).toHaveLength(1);
    expect(content).toContain('base');
    expect(content).toContain('siguiente: triangulate');
  });

  it('al cerrarse el ciclo el bloque desaparece del prompt', () => {
    const messages: Message[] = [{ role: 'system', content: 'base' }];
    applyTddToSystemMessage(messages, buildTddInjection([red()]));
    applyTddToSystemMessage(messages, '');
    expect(messages[0]!.content).toBe('base');
  });
});

describe('TddLedger (Hito 13)', () => {
  it('acumula, expone snapshot y se limpia', () => {
    const ledger = new TddLedger();
    ledger.record({ task: 'suma', phase: 'red', outcome: 'fail', evidence: '1 failing' });
    expect(ledger.snapshot).toHaveLength(1);
    expect(ledger.injection()).toContain('suma');
    ledger.clear();
    expect(ledger.snapshot).toEqual([]);
    expect(ledger.injection()).toBe('');
  });

  it('propaga el TddError para que el loop lo devuelva como tool_error recuperable', () => {
    const ledger = new TddLedger();
    expect(() =>
      ledger.record({ task: 'suma', phase: 'green', outcome: 'pass', evidence: 'ok' }),
    ).toThrow(TddError);
  });
});
