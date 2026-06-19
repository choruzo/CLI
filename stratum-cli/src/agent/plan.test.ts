import { describe, it, expect } from 'vitest';
import {
  makePlanFromProposal,
  serializePlanToMarkdown,
  parsePlanFromMarkdown,
  buildExecutionInjection,
  buildResumePreamble,
  isPlanComplete,
  PLAN_ALLOWLIST,
} from './plan.js';
import type { Plan } from './types.js';
import { isToolVisibleInMode } from '../tools/registry.js';

describe('makePlanFromProposal', () => {
  it('asigna ids secuenciales y estado pending', () => {
    const plan = makePlanFromProposal({
      summary: '  Refactor  ',
      steps: [{ title: '  Paso uno  ' }, { title: 'Paso dos', detail: '  detalle  ' }],
    });
    expect(plan.summary).toBe('Refactor');
    expect(plan.steps).toEqual([
      { id: 'step-1', title: 'Paso uno', detail: undefined, status: 'pending' },
      { id: 'step-2', title: 'Paso dos', detail: 'detalle', status: 'pending' },
    ]);
  });
});

describe('isPlanComplete', () => {
  const base = (s: Plan['steps']): Plan => ({ summary: 's', steps: s });
  it('true cuando todos done/skipped', () => {
    expect(
      isPlanComplete(
        base([
          { id: 'step-1', title: 'a', status: 'done' },
          { id: 'step-2', title: 'b', status: 'skipped' },
        ]),
      ),
    ).toBe(true);
  });
  it('false si queda alguno pending/in_progress', () => {
    expect(
      isPlanComplete(
        base([
          { id: 'step-1', title: 'a', status: 'done' },
          { id: 'step-2', title: 'b', status: 'in_progress' },
        ]),
      ),
    ).toBe(false);
  });
});

describe('serialize/parse markdown roundtrip', () => {
  it('preserva títulos y detalles, reasigna ids y pone pending', () => {
    const plan = makePlanFromProposal({
      summary: 'Mi plan',
      steps: [
        { title: 'Extraer weightedPick()' },
        { title: 'Añadir campo weight', detail: 'en el schema Zod' },
      ],
    });
    const md = serializePlanToMarkdown(plan);
    const parsed = parsePlanFromMarkdown(md, plan.summary);
    expect(parsed.summary).toBe('Mi plan');
    expect(parsed.steps.map((s) => s.title)).toEqual([
      'Extraer weightedPick()',
      'Añadir campo weight',
    ]);
    expect(parsed.steps[1]?.detail).toBe('en el schema Zod');
    expect(parsed.steps.map((s) => s.id)).toEqual(['step-1', 'step-2']);
    expect(parsed.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('ignora comentarios y líneas en blanco, soporta reordenar/borrar', () => {
    const md = [
      '# Plan',
      '# Summary: Tarea editada',
      '#',
      '- Primer paso',
      '',
      '- Segundo paso :: con detalle',
      '- Tercero',
    ].join('\n');
    const parsed = parsePlanFromMarkdown(md);
    expect(parsed.summary).toBe('Tarea editada');
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[1]).toMatchObject({ title: 'Segundo paso', detail: 'con detalle' });
  });
});

describe('buildExecutionInjection', () => {
  it('numera los pasos e incluye los ids y reglas de update_plan', () => {
    const plan = makePlanFromProposal({ summary: 'X', steps: [{ title: 'Uno' }, { title: 'Dos' }] });
    const text = buildExecutionInjection(plan);
    expect(text).toContain('1. [step-1] Uno');
    expect(text).toContain('2. [step-2] Dos');
    expect(text).toContain('update_plan');
    expect(text).toContain('APPROVED');
  });
});

describe('buildResumePreamble', () => {
  it('refleja el estado de cada paso e instruye a verificar in_progress', () => {
    const plan: Plan = {
      summary: 'Reanudable',
      steps: [
        { id: 'step-1', title: 'Hecho', status: 'done' },
        { id: 'step-2', title: 'A medias', status: 'in_progress' },
        { id: 'step-3', title: 'Pendiente', status: 'pending' },
      ],
    };
    const text = buildResumePreamble(plan);
    expect(text).toContain('[done]');
    expect(text).toContain('[in progress]');
    expect(text).toContain('[pending]');
    expect(text.toLowerCase()).toContain('verify');
  });
});

describe('allowlist de modo (isToolVisibleInMode)', () => {
  it('plan: solo read-only + present_plan', () => {
    expect(isToolVisibleInMode('read_file', 'plan')).toBe(true);
    expect(isToolVisibleInMode('present_plan', 'plan')).toBe(true);
    expect(isToolVisibleInMode('write_file', 'plan')).toBe(false);
    expect(isToolVisibleInMode('bash', 'plan')).toBe(false);
    expect(isToolVisibleInMode('update_plan', 'plan')).toBe(false);
    for (const t of PLAN_ALLOWLIST) expect(isToolVisibleInMode(t, 'plan')).toBe(true);
  });
  it('execute: todo salvo present_plan; update_plan visible', () => {
    expect(isToolVisibleInMode('write_file', 'execute')).toBe(true);
    expect(isToolVisibleInMode('update_plan', 'execute')).toBe(true);
    expect(isToolVisibleInMode('present_plan', 'execute')).toBe(false);
  });
  it('normal: oculta las tools de control de plan', () => {
    expect(isToolVisibleInMode('present_plan', 'normal')).toBe(false);
    expect(isToolVisibleInMode('update_plan', 'normal')).toBe(false);
    expect(isToolVisibleInMode('write_file', 'normal')).toBe(true);
  });
});
