import type { StratumConfig, ProviderConfig } from '../config/schema.js';
import type { IProvider } from './base.js';
import { OpenAICompatible } from './openai-compatible.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('provider');

export class ProviderRouter {
  private activeKey: string;
  private activeConfig: ProviderConfig;
  private provider: IProvider;

  /** Catálogo completo de providers (alias → config), para switch y fallback. */
  private readonly providers: Record<string, ProviderConfig>;

  /**
   * Orden de fallback (§Hito 6): el provider por defecto primero, luego el
   * resto en el orden en que aparecen en `.stratumrc.json`. El fallback es
   * "automático por orden": si el activo falla se prueba el siguiente que no
   * haya fallado ya en este run.
   */
  private readonly fallbackOrder: string[];

  /** Providers que ya han fallado en el run actual; se reinicia con `resetFallback()`. */
  private readonly failedKeys = new Set<string>();

  constructor(config: StratumConfig, providerOverride?: string) {
    if (!config.provider) {
      throw new Error(
        'No provider configured. Run `stratum init` or add a provider to .stratumrc.json',
      );
    }

    this.providers = config.provider.providers;
    this.activeKey = providerOverride ?? config.provider.default;
    const provCfg = this.providers[this.activeKey];
    if (!provCfg) {
      throw new Error(
        `Provider "${this.activeKey}" not found in config. ` +
          `Available: ${Object.keys(this.providers).join(', ')}`,
      );
    }

    // Orden de fallback: activo primero, luego el resto en orden de declaración.
    const rest = Object.keys(this.providers).filter((k) => k !== this.activeKey);
    this.fallbackOrder = [this.activeKey, ...rest];

    // Copia propia: los cambios en caliente (switchModel/reconfigure) no deben
    // mutar el objeto de config cargado desde disco.
    this.activeConfig = { ...provCfg };
    this.provider = new OpenAICompatible(provCfg.baseUrl, provCfg.apiKey, provCfg.model);
  }

  /**
   * Cambia el modelo activo en caliente (comando `/model`, Hito 3.5).
   * Solo afecta a la sesión en curso — no persiste en `.stratumrc.json`.
   */
  switchModel(model: string): void {
    this.activeConfig = { ...this.activeConfig, model };
  }

  /**
   * Cambia el provider activo en caliente (comando `/provider <name>`, Hito 6).
   * Recrea el cliente HTTP con la config del alias indicado. Solo afecta a la
   * sesión en curso. Lanza si el alias no existe.
   */
  switchProvider(name: string): void {
    const cfg = this.providers[name];
    if (!cfg) {
      throw new Error(
        `Provider "${name}" no existe. Disponibles: ${Object.keys(this.providers).join(', ')}`,
      );
    }
    this.activeKey = name;
    this.activeConfig = { ...cfg };
    this.provider = new OpenAICompatible(cfg.baseUrl, cfg.apiKey, cfg.model);
    // El cambio manual reinicia el estado de fallback: el nuevo activo deja de
    // considerarse "fallido" aunque lo hubiera estado antes.
    this.failedKeys.clear();
  }

  /**
   * Reaplica la configuración del provider activo en caliente
   * (comando `/config_provider`, Hito 3.5). Recrea el cliente HTTP.
   */
  reconfigure(cfg: ProviderConfig): void {
    this.activeConfig = { ...cfg };
    this.provider = new OpenAICompatible(cfg.baseUrl, cfg.apiKey, cfg.model);
  }

  // -------------------------------------------------------------------------
  // Fallback automático por orden (§Hito 6)
  // -------------------------------------------------------------------------

  /** Reinicia el estado de fallback. Llamar al inicio de cada run del agente. */
  resetFallback(): void {
    this.failedKeys.clear();
  }

  /** ¿Hay más de un provider configurado? (si no, el fallback es no-op). */
  get hasFallback(): boolean {
    return this.fallbackOrder.length > 1;
  }

  /**
   * Marca el provider activo como fallido y conmuta al siguiente del orden de
   * fallback que aún no haya fallado en este run. Devuelve el descriptor del
   * nuevo provider activo, o `null` si no quedan alternativas.
   *
   * Solo debe invocarse cuando el provider activo falla ANTES de emitir tokens
   * (no se puede hacer fallback a mitad de stream).
   */
  advanceProvider(): { name: string; model: string } | null {
    this.failedKeys.add(this.activeKey);
    const next = this.fallbackOrder.find((k) => !this.failedKeys.has(k));
    if (!next) {
      log.error('fallback exhausted', { tried: [...this.failedKeys] });
      return null;
    }
    const cfg = this.providers[next];
    log.warn('provider fallback', { from: this.activeKey, to: next, model: cfg.model });
    this.activeKey = next;
    this.activeConfig = { ...cfg };
    this.provider = new OpenAICompatible(cfg.baseUrl, cfg.apiKey, cfg.model);
    return { name: next, model: cfg.model };
  }

  /** Alias de los providers configurados (para autocompletado y validación). */
  get providerNames(): string[] {
    return Object.keys(this.providers);
  }

  getActive(): IProvider {
    return this.provider;
  }

  getActiveConfig(): ProviderConfig {
    return this.activeConfig;
  }

  get providerName(): string {
    return this.activeKey;
  }

  get model(): string {
    return this.activeConfig.model;
  }

  get contextWindow(): number {
    return this.activeConfig.contextWindow;
  }

  async healthCheck(): Promise<boolean> {
    return this.provider.healthCheck();
  }
}
