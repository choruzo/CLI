import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { ReactLoop } from './harness.js';
import { ProfileLoader } from './profiles.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { AgentEvent, Message, SubagentRouter, ToolResult } from './types.js';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

async function runWith(result: ToolResult): Promise<{ events: AgentEvent[]; messages: Message[] }> {
  const registry = new ToolRegistry();
  registry.register({
    name: 'leaky',
    description: 'returns a secret',
    schema: z.object({}),
    async execute(): Promise<ToolResult> {
      return result;
    },
  });
  const provider = new MockProvider([makeToolCallRound('c1', 'leaky', {}), makeTextRound('done')]);
  const messages: Message[] = [{ role: 'system', content: 'sys' }];
  const loop = new ReactLoop(
    provider,
    registry,
    messages,
    StratumConfigSchema.parse({}),
    'test-model',
    32768,
  );
  const events: AgentEvent[] = [];
  for await (const ev of loop.run()) events.push(ev);
  return { events, messages };
}

describe('frontera de redacción del loop (Hito 16)', () => {
  it('un tool_result sale redactado igual en el evento y en el historial', async () => {
    const { events, messages } = await runWith({ ok: true, output: `jwt=${JWT}` });
    const ev = events.find((e) => e.type === 'tool_result');
    const msg = messages.find((m) => m.role === 'tool');
    expect(ev).toMatchObject({ result: 'jwt=[redacted: JWT]' });
    expect(msg?.content).toBe('jwt=[redacted: JWT]');
  });

  it('una tool de control (todo) sale redactada en el evento y en el historial', async () => {
    const provider = new MockProvider([
      makeToolCallRound('t1', 'todo', { action: 'write', items: [{ title: `rotar ${JWT}` }] }),
      makeTextRound('ok'),
    ]);
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, StratumConfigSchema.parse({}));
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      provider,
      registry,
      messages,
      StratumConfigSchema.parse({}),
      'test-model',
      32768,
    );
    const events: AgentEvent[] = [];
    for await (const ev of loop.run()) events.push(ev);

    const ev = events.find((e) => e.type === 'tool_result' && e.name === 'todo');
    const msg = messages.find((m) => m.role === 'tool' && m.name === 'todo');
    expect(JSON.stringify(ev)).not.toContain('eyJhbGci');
    expect(msg?.content).toContain('[redacted: JWT]');
  });

  it('delegación: subagent_event, subagent_completed y el tool result del padre salen redactados', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-redact-deleg-'));
    const secretFile = join(dir, 'token.txt');
    writeFileSync(secretFile, `token ${JWT}\n`);

    const config = StratumConfigSchema.parse({});
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, config);
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 'lee el token', profile: 'general' }),
      makeTextRound('hecho'),
    ]);
    const child = new MockProvider([
      makeToolCallRound('r1', 'read_file', { path: secretFile }),
      makeTextRound(`El token es ${JWT}`),
    ]);
    const router: SubagentRouter = {
      getActive: () => child,
      model: 'mock',
      providerName: 'mock',
      contextWindow: 32768,
      hasFallback: false,
      advanceProvider: () => null,
      switchModel: () => {},
    };
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, registry, messages, config, 'm', 32768, undefined, {
      profiles: new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-noprofiles-'))),
    });
    const events: AgentEvent[] = [];
    for await (const ev of loop.run({ makeSubagentRouter: () => router })) events.push(ev);

    const childResult = events.find(
      (e) => e.type === 'subagent_event' && e.event.type === 'tool_result',
    );
    expect(childResult).toBeDefined();
    // El texto libre del modelo (text_delta) queda fuera de alcance: la frontera
    // cubre lo que las tools devuelven y lo que se persiste o se reinyecta.
    const nonText = events.filter(
      (e) =>
        e.type !== 'text_delta' && !(e.type === 'subagent_event' && e.event.type === 'text_delta'),
    );
    expect(JSON.stringify(nonText)).not.toContain('eyJhbGci');
    expect(JSON.stringify(messages)).not.toContain('eyJhbGci');
    const completed = events.find((e) => e.type === 'subagent_completed');
    expect(JSON.stringify(completed)).toContain('[redacted: JWT]');
  });

  it('un error de parseo de argumentos sale redactado igual en el evento y en el historial', async () => {
    const badArgs = `{"token": "${JWT}", broken`;
    const provider = new MockProvider([
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'p1',
                    type: 'function' as const,
                    function: { name: 'leaky', arguments: badArgs },
                  },
                ],
              },
              finish_reason: null,
              index: 0,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
      ],
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      provider,
      new ToolRegistry(),
      messages,
      StratumConfigSchema.parse({}),
      'test-model',
      32768,
    );
    const events: AgentEvent[] = [];
    for await (const ev of loop.run()) events.push(ev);
    const errorEvents = events.filter((e) => e.type === 'tool_error');
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(errorEvents).toHaveLength(1);
    expect(JSON.stringify(errorEvents)).not.toContain('eyJhbGci');
    expect(JSON.stringify(toolMessages)).not.toContain('eyJhbGci');
    // Los argumentos que escribió el modelo siguen en su mensaje `assistant`:
    // son salida del propio modelo, fuera del alcance de la redacción de tools.
  });

  it('un tool_error ejecutado propaga executed y sale redactado', async () => {
    const { events, messages } = await runWith({
      ok: false,
      error: `exit 1 ${JWT}`,
      recoverable: true,
      countsAsFailure: false,
      executed: true,
    });
    const ev = events.find((e) => e.type === 'tool_error');
    expect(ev).toMatchObject({ executed: true, error: 'exit 1 [redacted: JWT]' });
    expect(JSON.stringify(messages)).not.toContain('eyJhbGci');
  });
});
