import { describe, it, expect } from 'vitest';
import { ProviderRouter } from './router.js';
import { StratumConfigSchema } from '../config/schema.js';

function makeConfig() {
  return StratumConfigSchema.parse({
    provider: {
      default: 'local-ollama',
      providers: {
        'local-ollama': {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen2.5-coder:32b',
          apiKey: 'ollama',
        },
      },
    },
  });
}

describe('ProviderRouter — cambio de modelo en sesión (Hito 3.5)', () => {
  it('switchModel cambia el modelo activo en caliente', () => {
    const router = new ProviderRouter(makeConfig());
    expect(router.model).toBe('qwen2.5-coder:32b');

    router.switchModel('llama3.1:8b');
    expect(router.model).toBe('llama3.1:8b');
    expect(router.getActiveConfig().model).toBe('llama3.1:8b');
  });

  it('switchModel no muta la config cargada desde disco', () => {
    const config = makeConfig();
    const router = new ProviderRouter(config);
    router.switchModel('otro-modelo');
    expect(config.provider!.providers['local-ollama'].model).toBe('qwen2.5-coder:32b');
  });

  it('reconfigure reemplaza baseUrl/apiKey/model del provider activo', () => {
    const router = new ProviderRouter(makeConfig());
    router.reconfigure({
      type: 'openai-compatible',
      baseUrl: 'http://localhost:4000/v1',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-x',
      contextWindow: 200000,
    });
    expect(router.model).toBe('claude-sonnet-4-5');
    expect(router.contextWindow).toBe(200000);
    expect(router.getActiveConfig().baseUrl).toBe('http://localhost:4000/v1');
  });
});
