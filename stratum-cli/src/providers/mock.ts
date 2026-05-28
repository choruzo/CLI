import type { IProvider, CompletionRequest, OpenAIStreamChunk } from './base.js';

export class MockProvider implements IProvider {
  private callIndex = 0;

  constructor(
    private readonly rounds: OpenAIStreamChunk[][],
    private readonly healthResult = true,
  ) {}

  async *complete(_req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    const chunks = this.rounds[this.callIndex % this.rounds.length] ?? [];
    this.callIndex++;
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.healthResult;
  }

  reset(): void {
    this.callIndex = 0;
  }
}

export function makeTextRound(text: string): OpenAIStreamChunk[] {
  return [
    {
      choices: [{
        delta: { content: text },
        finish_reason: null,
        index: 0,
      }],
    },
    {
      choices: [{
        delta: { content: '' },
        finish_reason: 'stop',
        index: 0,
      }],
    },
  ];
}

export function makeToolCallRound(
  id: string,
  name: string,
  args: Record<string, unknown>,
): OpenAIStreamChunk[] {
  const argsStr = JSON.stringify(args);
  const half = Math.floor(argsStr.length / 2);
  return [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id,
            type: 'function',
            function: { name, arguments: argsStr.slice(0, half) },
          }],
        },
        finish_reason: null,
        index: 0,
      }],
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: argsStr.slice(half) },
          }],
        },
        finish_reason: null,
        index: 0,
      }],
    },
    {
      choices: [{
        delta: {},
        finish_reason: 'tool_calls',
        index: 0,
      }],
    },
  ];
}
