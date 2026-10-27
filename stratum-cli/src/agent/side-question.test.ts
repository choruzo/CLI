import { describe, it, expect, vi } from 'vitest';
import { sideQuestionMessages } from './side-question.js';
import { StratumAgent } from './core.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import type { CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { Message } from './types.js';
import type { TraceScope } from '../trace/recorder.js';

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
});

/** MockProvider que además guarda cada petición. */
class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push(req);
    yield* super.complete(req);
  }
}

function agentWith(provider: MockProvider, initialMessages: Message[]): StratumAgent {
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(provider);
  return new StratumAgent(config, router, new ToolRegistry(), { initialMessages });
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const text of gen) out += text;
  return out;
}

describe('sideQuestionMessages (/btw)', () => {
  it('añade la pregunta como un user nuevo tras la respuesta del asistente', () => {
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'arregla el test' },
      { role: 'assistant', content: 'hecho' },
    ];
    const out = sideQuestionMessages(history, '¿qué fichero tocaste?');
    expect(out).toHaveLength(4);
    expect(out[3]?.role).toBe('user');
    expect(out[3]?.content).toContain('¿qué fichero tocaste?');
    expect(out[3]?.content).toContain('<side_question>');
    expect(history).toHaveLength(3);
  });

  it('con el turno a medias, la anexa al último user en vez de abrir otro', () => {
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'arregla el test' },
    ];
    const out = sideQuestionMessages(history, '¿cuánto falta?');
    expect(out).toHaveLength(2);
    expect(out[1]?.content).toMatch(/^arregla el test\n\n<side_question>/);
    expect(history[1]?.content).toBe('arregla el test');
  });

  it('cierra en la copia las tool calls sin respuesta, no en el historial', () => {
    const history: Message[] = [
      { role: 'user', content: 'lee a.ts' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
    ];
    const out = sideQuestionMessages(history, '¿qué haces?');
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(history).toHaveLength(2);
  });
});

describe('StratumAgent.askSideQuestion (/btw)', () => {
  it('responde sin tools y sin tocar historial ni uso de la sesión', async () => {
    const provider = new RecordingProvider([makeTextRound('el fichero es a.ts')]);
    const initial: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'arregla a.ts' },
      { role: 'assistant', content: 'listo' },
    ];
    const agent = agentWith(provider, initial);
    const before = agent.getMessages();

    const answer = await collect(agent.askSideQuestion('¿qué fichero?'));

    expect(answer).toBe('el fichero es a.ts');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(agent.getMessages()).toEqual(before);
    expect(agent.getSessionUsage().turns).toBe(0);
    expect(agent.getTokenUsage()).toEqual({ status: 'unavailable' });
  });

  it('se registra en la traza con el origen side-question', async () => {
    const provider = new MockProvider([makeTextRound('sí')]);
    const agent = agentWith(provider, [{ role: 'system', content: 'sys' }]);
    const end = vi.fn();
    const modelStart = vi.fn(() => ({ firstChunk: vi.fn(), usage: vi.fn(), end }));
    const trace = { modelStart } as unknown as TraceScope;

    await collect(agent.askSideQuestion('¿vale?', { trace }));

    expect(modelStart).toHaveBeenCalledWith(expect.objectContaining({ origin: 'side-question' }));
    expect(end).toHaveBeenCalledOnce();
  });
});
