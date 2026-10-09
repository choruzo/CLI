import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { StratumConfigSchema } from '../config/schema.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import type { ToolDefinition } from './types.js';
import { buildAssistantPrompt, buildSystemPrompt, type SystemPromptEnv } from './system-prompt.js';
import { applyTodoToSystemMessage } from './todo.js';

// Lo que una caché de prefijo puede reutilizar es lo que va antes del primer
// byte que cambia (docs/prompt-caching.md). Estos tests fijan lo que Stratum
// garantiza: el orden de las tools y dónde va cada bloque del system prompt.
// El bloque `<env>` sigue donde estaba, justo detrás de las instrucciones base:
// moverlo al final mejoraba la caché entre sesiones, pero no se pudo descartar
// que cambiase el comportamiento de un modelo pequeño (prompt-caching-live.md).

const config = StratumConfigSchema.parse({
  ssh: { hosts: { web1: { host: '10.0.0.5', user: 'deploy', password: 'env:X' } } },
  environments: { prod: { tier: 'production', match: ['ssh:web1'] } },
  tools: { testCommand: 'npm test' },
});

const env = (over: Partial<SystemPromptEnv> = {}): SystemPromptEnv => ({
  modelId: 'qwen3',
  providerName: 'local',
  cwd: '/work/repo',
  agentProfiles: ['code', 'research'],
  profileIndex:
    '# Agent profiles\n| Profile | Use it when |\n|---|---|\n| code | writing |\n| research | reading |',
  skills: '# Skills\n| Skill | When |\n|---|---|\n| deploy | deploying |',
  activeProfile: { name: 'code', fragment: 'Write code carefully.' },
  ...over,
});

const MEMORY = '# Project\nUse pnpm. Tests live next to the code.';

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

describe('orden del system prompt', () => {
  const prompt = buildSystemPrompt(config, MEMORY, env());
  const at = (marker: string): number => {
    const index = prompt.indexOf(marker);
    expect(index, marker).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('los bloques van en un orden fijo, con <env> detrás de las instrucciones base', () => {
    const order = [
      'You are Stratum, an interactive CLI tool',
      '<env>',
      '# Shell',
      '# Long-term memory',
      '# Remote hosts (SSH)',
      '# Environments',
      '# Asking the user',
      '# Work routing',
      '# Testing discipline',
      '# Skills',
      '| Profile | Use it when |',
      '# Active agent profile: code',
      '## Project Memory',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('el bloque de entorno lleva lo que cambia entre sesiones', () => {
    const block = prompt.slice(at('You are powered by the model named'), at('# Shell'));
    expect(block).toContain('Working directory: /work/repo');
    expect(block).toContain("Today's date:");
    expect(block).toContain('local/qwen3');
    expect(block.trimEnd().endsWith('</env>')).toBe(true);
  });

  it('otra carpeta u otro modelo conservan las instrucciones base y nada más', () => {
    // Lo que se comparte entre dos sesiones acaba donde empieza `<env>`: es el
    // coste conocido de dejarlo en su sitio.
    const other = buildSystemPrompt(
      config,
      MEMORY,
      env({ cwd: '/work/repo/packages/api', modelId: 'glm-5', providerName: 'hosted' }),
    );
    expect(commonPrefix(prompt, other)).toBe(
      at('You are powered by the model named') + 'You are powered by the model named '.length,
    );
  });

  it('el mismo entorno da el mismo prompt byte a byte', () => {
    expect(buildSystemPrompt(config, MEMORY, env())).toBe(prompt);
  });

  it('un subagente lleva su marca en el bloque de entorno', () => {
    const child = buildSystemPrompt(config, undefined, env({ isSubagent: true }));
    expect(child.indexOf('Running as: subagent')).toBeGreaterThanOrEqual(0);
    expect(child.indexOf('Running as: subagent')).toBeLessThan(child.indexOf('# Shell'));
  });

  it('las tareas abiertas se reinyectan detrás de todo: el prompt estable queda intacto', () => {
    const messages = [{ role: 'system' as const, content: prompt }];
    applyTodoToSystemMessage(messages, '# Open tasks\n- [in_progress] read the files');
    const injected = messages[0]!.content;
    expect(injected.startsWith(prompt)).toBe(true);
    applyTodoToSystemMessage(messages, '# Open tasks\n- [done] read the files');
    expect(commonPrefix(messages[0]!.content, injected)).toBeGreaterThanOrEqual(prompt.length);
  });

  it('el prompt del asistente lleva su bloque de entorno antes de la memoria', () => {
    const a = buildAssistantPrompt('Prefiero respuestas breves.', { modelId: 'qwen3' });
    expect(a.indexOf('<env>')).toBeGreaterThanOrEqual(0);
    expect(a.indexOf('<env>')).toBeLessThan(a.indexOf('## User Memory'));
    expect(buildAssistantPrompt('Prefiero respuestas breves.', { modelId: 'qwen3' })).toBe(a);
  });
});

describe('orden de las tools ofrecidas al modelo', () => {
  const mcpTool = (name: string): ToolDefinition => ({
    name,
    description: `MCP ${name}`,
    schema: z.object({}),
    rawParameters: { type: 'object', properties: { key: { type: 'string' } } },
    async execute() {
      return { ok: true, output: '' };
    },
  });

  const names = (registry: ToolRegistry): string[] =>
    registry.toToolSchemas().map((t) => t.function.name);

  function registryWith(mcp: string[]): ToolRegistry {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, StratumConfigSchema.parse({}));
    for (const name of mcp) registry.register(mcpTool(name));
    return registry;
  }

  const MCP = ['mcp__github__list_issues', 'mcp__files__read', 'mcp__github__create_pr'];

  it('las built-in conservan su orden de registro y las MCP van detrás, por nombre', () => {
    const plain = names(registryWith([]));
    const all = names(registryWith(MCP));
    expect(all.slice(0, plain.length)).toEqual(plain);
    expect(all.slice(plain.length)).toEqual([
      'mcp__files__read',
      'mcp__github__create_pr',
      'mcp__github__list_issues',
    ]);
  });

  it('no depende de qué server conectó antes ni de cómo anunció su catálogo', () => {
    const a = JSON.stringify(registryWith(MCP).toToolSchemas());
    const b = JSON.stringify(registryWith([...MCP].reverse()).toToolSchemas());
    expect(b).toBe(a);
  });

  it('un server que reconecta (se retira y se registra de nuevo) no mueve nada', () => {
    const registry = registryWith(MCP);
    const before = JSON.stringify(registry.toToolSchemas());
    registry.unregister('mcp__files__read');
    registry.register(mcpTool('mcp__files__read'));
    expect(JSON.stringify(registry.toToolSchemas())).toBe(before);
  });

  it('dos llamadas seguidas serializan los schemas byte a byte igual', () => {
    const registry = registryWith(MCP);
    expect(JSON.stringify(registry.toToolSchemas())).toBe(JSON.stringify(registry.toToolSchemas()));
  });

  it('una tool MCP que llega tarde no desplaza a las built-in', () => {
    const registry = registryWith(['mcp__zeta__ping']);
    const before = names(registry);
    registry.register(mcpTool('mcp__alpha__ping'));
    const after = names(registry);
    const builtin = before.length - 1;
    expect(after.slice(0, builtin)).toEqual(before.slice(0, builtin));
    expect(after.slice(builtin)).toEqual(['mcp__alpha__ping', 'mcp__zeta__ping']);
  });
});
