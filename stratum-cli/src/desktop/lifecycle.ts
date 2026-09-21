/**
 * Ciclo de vida del sidecar (15.11): un único apagado ordenado, lo dispare quien
 * lo dispare (señal, cierre de stdin porque el proceso Tauri murió, o error).
 *
 * Los subsistemas registran su limpieza con `onShutdown`. Hoy son el runtime de
 * `exec` (sockets SSH y auditoría) y el logging; en D1 cada `StratumAgent`
 * registrará aquí el `McpManager.shutdownAll()` de sus servers MCP, que son
 * procesos hijos y quedarían huérfanos si el sidecar saliese sin cerrarlos.
 *
 * Los ganchos corren en orden inverso al de registro (lo último en abrirse, lo
 * primero en cerrarse), cada uno aislado de los fallos de los demás, y el total
 * está acotado: Tauri espera 2 s antes de matar el proceso.
 */

export type ShutdownReason = 'signal' | 'parent_gone' | 'fatal';

export type ShutdownHook = () => Promise<void> | void;

export interface ShutdownResult {
  /** Nombres de los ganchos que fallaron o no terminaron a tiempo. */
  failed: string[];
  timedOut: boolean;
}

export class ShutdownRegistry {
  private readonly hooks: Array<{ name: string; fn: ShutdownHook }> = [];
  private running: Promise<ShutdownResult> | null = null;

  constructor(private readonly budgetMs = 1_500) {}

  onShutdown(name: string, fn: ShutdownHook): void {
    this.hooks.push({ name, fn });
  }

  get started(): boolean {
    return this.running !== null;
  }

  /** Idempotente: las llamadas posteriores reciben la misma promesa. */
  run(): Promise<ShutdownResult> {
    this.running ??= this.runOnce();
    return this.running;
  }

  private async runOnce(): Promise<ShutdownResult> {
    const failed: string[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const all = (async () => {
      for (const { name, fn } of [...this.hooks].reverse()) {
        try {
          await fn();
        } catch {
          failed.push(name);
        }
      }
    })();

    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.budgetMs);
      timer.unref();
    });

    await Promise.race([all, deadline]);
    clearTimeout(timer);
    return { failed, timedOut };
  }
}
