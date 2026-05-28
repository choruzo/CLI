import type { StratumConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentEvent, Message, RunOptions } from './types.js';
import { ReactLoop } from './harness.js';
import { buildSystemPrompt } from './system-prompt.js';

export class StratumAgent {
  private messages: Message[] = [];
  private currentLoop: ReactLoop | null = null;

  constructor(
    private readonly config: StratumConfig,
    private readonly router: ProviderRouter,
    private readonly registry: ToolRegistry,
  ) {
    this.messages.push({
      role: 'system',
      content: buildSystemPrompt(config),
    });
  }

  async *run(input: string, opts?: RunOptions): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: 'user', content: input });

    this.currentLoop = new ReactLoop(
      this.router.getActive(),
      this.registry,
      this.messages,
      this.config,
      this.router.model,
      this.router.contextWindow,
    );

    yield* this.currentLoop.run(opts);
    this.currentLoop = null;
  }

  getContextUsage(): { used: number; max: number; pct: number } {
    if (this.currentLoop) return this.currentLoop.getContextUsage();
    const chars = this.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const used = Math.ceil(chars / 3.5);
    const max = this.router.contextWindow;
    return { used, max, pct: Math.round((used / max) * 100) };
  }

  get providerName(): string {
    return this.router.providerName;
  }

  get model(): string {
    return this.router.model;
  }
}
