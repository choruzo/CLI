import { DEFAULT_CONTEXT_WINDOW } from '../config/schema.js';
import type { StratumConfig, ProviderConfig } from '../config/schema.js';
import type { IProvider } from './base.js';
import { OpenAICompatible } from './openai-compatible.js';
import { classifyBackendByUrl, discoveredContextWindow } from './utils.js';
import { resolveCacheCapabilities, type CacheCapabilities } from './cache.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('provider');

/** Capacidades de caché de un provider: las del backend inferido, con lo que diga su config. */
export function cacheCapabilitiesOf(cfg: ProviderConfig): CacheCapabilities {
  return resolveCacheCapabilities(classifyBackendByUrl(cfg.baseUrl), cfg.cache);
}

function makeClient(cfg: ProviderConfig): IProvider {
  return new OpenAICompatible(cfg.baseUrl, cfg.apiKey, cfg.model, {
    timeouts: cfg.timeouts,
    cache: cacheCapabilitiesOf(cfg),
  });
}

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
    this.provider = makeClient(provCfg);
  }

  /**
   * Cambia el modelo activo en caliente (comando `/model`, Hito 3.5).
   * Solo afecta a la sesión en curso — no persiste en `.stratumrc.json`.
   */
  switchModel(model: string): void {
    this.activeConfig = { ...this.activeConfig, model };
    // Un provider sin `model` en la config queda resuelto para el resto del
    // proceso: los routers de los subagentes y el fallback parten del catálogo.
    const entry = this.providers[this.activeKey];
    if (entry && !entry.model) this.providers[this.activeKey] = { ...entry, model };
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
    this.provider = makeClient(cfg);
    // El cambio manual reinicia el estado de fallback: el nuevo activo deja de
    // considerarse "fallido" aunque lo hubiera estado antes.
    this.failedKeys.clear();
  }

  /**
   * Retira de la sesión un provider eliminado de la config (`/provider remove`):
   * deja de listarse y de servir de fallback. El activo no se puede retirar.
   */
  forgetProvider(name: string): void {
    if (name === this.activeKey) {
      throw new Error(`"${name}" es el provider activo: cambia antes a otro.`);
    }
    delete this.providers[name];
    const index = this.fallbackOrder.indexOf(name);
    if (index !== -1) this.fallbackOrder.splice(index, 1);
    this.failedKeys.delete(name);
  }

  /**
   * Reaplica la configuración del provider activo en caliente
   * (comando `/config_provider`, Hito 3.5). Recrea el cliente HTTP.
   */
  reconfigure(cfg: ProviderConfig): void {
    this.activeConfig = { ...cfg };
    this.provider = makeClient(cfg);
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
    // Un provider sin modelo resuelto no sirve de fallback: no hay a quién
    // preguntar a mitad de turno.
    const next = this.fallbackOrder.find((k) => !this.failedKeys.has(k) && this.providers[k].model);
    if (!next) {
      log.error('fallback exhausted', { tried: [...this.failedKeys] });
      return null;
    }
    const cfg = this.providers[next];
    log.warn('provider fallback', { from: this.activeKey, to: next, model: cfg.model });
    this.activeKey = next;
    this.activeConfig = { ...cfg };
    this.provider = makeClient(cfg);
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

  /** Qué admite el provider activo en caché de prompt. */
  get cacheCapabilities(): CacheCapabilities {
    return cacheCapabilitiesOf(this.activeConfig);
  }

  /**
   * Ventana del modelo activo: ajuste por modelo (`models.<id>`) > la del
   * provider si es explícita > la que declaró `/models` > default.
   */
  get contextWindow(): number {
    const cfg = this.activeConfig;
    return (
      cfg.models?.[cfg.model]?.contextWindow ??
      cfg.contextWindow ??
      discoveredContextWindow(cfg.baseUrl, cfg.model) ??
      DEFAULT_CONTEXT_WINDOW
    );
  }

  /** ¿Depende la ventana de lo que declare `/models`? (ni modelo ni provider la fijan). */
  get contextWindowIsDiscoverable(): boolean {
    const cfg = this.activeConfig;
    return cfg.models?.[cfg.model]?.contextWindow === undefined && cfg.contextWindow === undefined;
  }

  async healthCheck(): Promise<boolean> {
    return this.provider.healthCheck();
  }
}
