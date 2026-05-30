import type { Message } from '../agent/types.js';

export interface ToolFunctionSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolSchema {
  type: 'function';
  function: ToolFunctionSchema;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      role?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason: string | null;
    index: number;
  }>;
  /** Presente solo en el chunk final cuando se solicita `stream_options.include_usage`. */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CompletionRequest {
  messages: Message[];
  tools?: ToolSchema[];
  stream: boolean;
  model: string;
  signal?: AbortSignal;
  /** Temperatura de muestreo (0–2). Si se omite, el provider usa el valor por defecto del backend. */
  temperature?: number;
}

export interface IProvider {
  complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk>;
  healthCheck(): Promise<boolean>;
}
