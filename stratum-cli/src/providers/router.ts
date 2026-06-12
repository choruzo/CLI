import type { StratumConfig, ProviderConfig } from '../config/schema.js';
import type { IProvider } from './base.js';
import { OpenAICompatible } from './openai-compatible.js';

export class ProviderRouter {
  private activeKey: string;
  private activeConfig: ProviderConfig;
  private provider: IProvider;

  constructor(config: StratumConfig, providerOverride?: string) {
    if (!config.provider) {
      throw new Error(
        'No provider configured. Run `stratum init` or add a provider to .stratumrc.json',
      );
    }

    this.activeKey = providerOverride ?? config.provider.default;
    const provCfg = config.provider.providers[this.activeKey];
    if (!provCfg) {
      throw new Error(
        `Provider "${this.activeKey}" not found in config. ` +
          `Available: ${Object.keys(config.provider.providers).join(', ')}`,
      );
    }

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
   * Reaplica la configuración del provider activo en caliente
   * (comando `/config_provider`, Hito 3.5). Recrea el cliente HTTP.
   */
  reconfigure(cfg: ProviderConfig): void {
    this.activeConfig = { ...cfg };
    this.provider = new OpenAICompatible(cfg.baseUrl, cfg.apiKey, cfg.model);
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
