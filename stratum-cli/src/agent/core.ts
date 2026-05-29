import type { StratumConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { IProvider } from '../providers/base.js';
import type { AgentEvent, Message, RunOptions } from './types.js';
import { ReactLoop } from './harness.js';
import { buildSystemPrompt } from './system-prompt.js';
import { MemoryManager } from '../memory/manager.js';

export interface StratumAgentOptions {
  /** Mensajes iniciales para reanudar una sesión guardada (incluye el system prompt original). */
  initialMessages?: Message[];
}

export class StratumAgent {
  private messages: Message[];
  private currentLoop: ReactLoop | null = null;
  private readonly memoryManager: MemoryManager;
  private _toolCallCount = 0;

  constructor(
    private readonly config: StratumConfig,
    private readonly router: ProviderRouter,
    private readonly registry: ToolRegistry,
    options?: StratumAgentOptions,
  ) {
    this.memoryManager = new MemoryManager(config);

    if (options?.initialMessages && options.initialMessages.length > 0) {
      // Reanudar sesión: usar historial completo tal como fue guardado
      this.messages = [...options.initialMessages];
    } else {
      // Nueva sesión: construir system prompt con memoria del proyecto
      const memory = this.memoryManager.getInjectableMemory();
      this.messages = [
        {
          role: 'system',
          content: buildSystemPrompt(config, memory || undefined),
        },
      ];
    }
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

    for await (const event of this.currentLoop.run(opts)) {
      if (event.type === 'tool_result') this._toolCallCount++;
      yield event;
    }
    this.currentLoop = null;
  }

  /**
   * Recarga la memoria del proyecto desde disco y reconstruye el system prompt.
   * Usado tras `/init` para que el STRATUM.md regenerado entre en el contexto.
   */
  reloadMemory(): void {
    this.memoryManager.reload();
    const memory = this.memoryManager.getInjectableMemory();
    const newSystemContent = buildSystemPrompt(this.config, memory || undefined);
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = { role: 'system', content: newSystemContent };
    } else {
      this.messages.unshift({ role: 'system', content: newSystemContent });
    }
  }

  getContextUsage(): { used: number; max: number; pct: number; estimated: boolean } {
    if (this.currentLoop) return this.currentLoop.getContextUsage();
    const chars = this.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const used = Math.ceil(chars / 3.5);
    const max = this.router.contextWindow;
    return { used, max, pct: Math.round((used / max) * 100), estimated: true };
  }

  /** Devuelve una copia del historial de mensajes (para persistir la sesión). */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Total de tool calls ejecutados exitosamente en esta sesión. */
  get toolCallCount(): number {
    return this._toolCallCount;
  }

  get providerName(): string {
    return this.router.providerName;
  }

  get model(): string {
    return this.router.model;
  }

  /** Expone el provider activo para que el InitAgent pueda hacer LLM calls. */
  getProvider(): IProvider {
    return this.router.getActive();
  }

  /** Expone la config para que comandos internos del chat puedan cargar rutas de memoria. */
  getConfig(): StratumConfig {
    return this.config;
  }
}
