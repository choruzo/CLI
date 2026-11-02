import { describe, it, expect } from 'vitest';
import { StratumConfigSchema } from '../config/schema.js';
import {
  buildAssistantPrompt,
  buildCompanionPrompt,
  buildMemoryBlock,
  buildSystemPrompt,
} from './system-prompt.js';

// El bloque `# Long-term memory` dice cuándo usar la memoria sin que el usuario
// lo pida. Estos tests fijan los disparadores, no la redacción entera.

const config = StratumConfigSchema.parse({});
const skillsIndex = (name: string): string =>
  `# Skills\n| Skill | When |\n|---|---|\n| ${name} | memory |`;

describe('bloque de memoria del system prompt', () => {
  it('coding: consultar al empezar una tarea y guardar al ser corregido', () => {
    const block = buildMemoryBlock('coding', {});
    expect(block.startsWith('# Long-term memory')).toBe(true);
    expect(block).toMatch(/proactively/);
    expect(block).toMatch(/recall_decisions: .*Before your first change to the project/);
    expect(block).toMatch(/store_decision: .*user corrects you/);
    expect(block).toMatch(/secrets/);
    expect(block).toMatch(/read-only session/);
  });

  it('assistant y companion: sin la línea de read-only/plan, que es solo de coding', () => {
    for (const preset of ['assistant', 'companion'] as const) {
      const block = buildMemoryBlock(preset, {});
      expect(block).toMatch(/proactively/);
      expect(block).toMatch(/store_decision: .*correct how you did something/);
      expect(block).not.toMatch(/read-only session/);
    }
    expect(buildMemoryBlock('companion', {})).toMatch(/not shared with Stratum Desktop/);
  });

  it('nombra la skill del preset solo si está en el índice', () => {
    expect(buildMemoryBlock('coding', {})).not.toMatch(/stratum-project-memory/);
    expect(buildMemoryBlock('coding', { skills: skillsIndex('stratum-project-memory') })).toMatch(
      /Read the stratum-project-memory skill/,
    );
    expect(buildMemoryBlock('assistant', { skills: skillsIndex('stratum-global-memory') })).toMatch(
      /stratum-global-memory/,
    );
    expect(
      buildMemoryBlock('companion', { skills: skillsIndex('stratum-companion-memory') }),
    ).toMatch(/stratum-companion-memory/);
  });

  it('cada prompt lleva el bloque de su preset', () => {
    expect(buildSystemPrompt(config, undefined, {})).toContain(buildMemoryBlock('coding', {}));
    expect(buildAssistantPrompt(undefined, {})).toContain(buildMemoryBlock('assistant', {}));
    expect(buildCompanionPrompt(undefined, {})).toContain(buildMemoryBlock('companion', {}));
  });
});
