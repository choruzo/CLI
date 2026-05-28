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

    this.activeConfig = provCfg;
    this.provider = new OpenAICompatible(
      provCfg.baseUrl,
      provCfg.apiKey,
      provCfg.model,
    );
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
