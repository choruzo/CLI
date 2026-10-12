import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { StratumAgent } from './core.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { createSessionEnv } from '../runtime/session-env.js';
import * as sessionEnv from '../runtime/session-env.js';
import type { ToolContext, ToolDefinition } from './types.js';

/**
 * El `cwd` de una sesión llega por `SessionEnv` a todo lo que la compone, sin
 * pasar por el directorio del proceso (M0 del PRD de Stratum Dot).
 */

const config = StratumConfigSchema.parse({
  provider: {
    default: 'test',
    providers: {
      test: {
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: '',
        model: 'test-model',
        contextWindow: 32768,
      },
    },
  },
  memory: { autoExtract: false },
  trace: { enabled: false },
});

// Un proyecto que NO es el directorio del proceso.
const project = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-env-flow-')));
mkdirSync(join(project, '.stratum', 'agents'), { recursive: true });
mkdirSync(join(project, '.stratum', 'skills', 'env-skill'), { recursive: true });
writeFileSync(join(project, 'STRATUM.md'), 'MEMORIA-DEL-PROYECTO-ENV');
writeFileSync(
  join(project, '.stratum', 'agents', 'env-helper.md'),
  '---\ndescription: Helper only this project has\n---\nYou help.',
);
writeFileSync(
  join(project, '.stratum', 'skills', 'env-skill', 'SKILL.md'),
  '---\nname: env-skill\ndescription: Skill only this project has\n---\nBody.',
);

afterAll(() => rmSync(project, { recursive: true, force: true }));

function probeTool(seen: ToolContext[]): ToolDefinition {
  return {
    name: 'probe',
    description: 'Records the context it runs in.',
    schema: z.object({}),
    execute: async (_params: unknown, ctx: ToolContext) => {
      seen.push(ctx);
      return { ok: true, output: 'ok' };
    },
  } as ToolDefinition;
}

describe('SessionEnv a través de StratumAgent', () => {
  it('compone prompt, memoria, perfiles y skills desde el cwd de la sesión', () => {
    expect(project).not.toBe(process.cwd());
    // Si algo cayese al entorno del proceso, este test lo delata.
    const fallback = vi.spyOn(sessionEnv, 'processSessionEnv');

    const agent = new StratumAgent(config, new ProviderRouter(config), new ToolRegistry(), {
      env: createSessionEnv({ cwd: project, env: {} }),
    });
    const prompt = agent.getMessages()[0]?.content ?? '';

    expect(prompt).toContain(project);
    expect(prompt).not.toContain(process.cwd());
    expect(prompt).toContain('MEMORIA-DEL-PROYECTO-ENV');
    expect(prompt).toContain('env-helper');
    expect(prompt).toContain('env-skill');
    // El índice de skills se materializa en el proyecto, no en el directorio del proceso.
    expect(existsSync(join(project, '.stratum', 'skill-registry.md'))).toBe(true);
    expect(fallback).not.toHaveBeenCalled();

    // Control: sin `env`, el agente sí recurre al del proceso (y el espía lo ve).
    new StratumAgent(config, new ProviderRouter(config), new ToolRegistry());
    expect(fallback).toHaveBeenCalled();
    fallback.mockRestore();
  });

  it('las tools reciben el cwd y las variables de la sesión', async () => {
    const seen: ToolContext[] = [];
    const registry = new ToolRegistry();
    registry.register(probeTool(seen));
    const router = new ProviderRouter(config);
    vi.spyOn(router, 'getActive').mockReturnValue(
      new MockProvider([makeToolCallRound('c1', 'probe', {}), makeTextRound('listo')]),
    );
    const agent = new StratumAgent(config, router, registry, {
      env: createSessionEnv({ cwd: project, env: { STRATUM_ENV_PROBE: 'solo-esta-sesion' } }),
    });

    for await (const _ev of agent.run('usa probe')) {
      /* drenar */
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.cwd).toBe(project);
    expect(seen[0]!.env?.STRATUM_ENV_PROBE).toBe('solo-esta-sesion');
  });
});
