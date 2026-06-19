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

function makeMultiConfig() {
  return StratumConfigSchema.parse({
    provider: {
      default: 'primary',
      providers: {
        primary: {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen2.5-coder:32b',
          apiKey: 'ollama',
        },
        secondary: {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:8000/v1',
          model: 'vllm-model',
          apiKey: '',
        },
        tertiary: {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:4000/v1',
          model: 'claude-sonnet-4-5',
          apiKey: 'sk-x',
          contextWindow: 200000,
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

describe('ProviderRouter — fallback automático por orden (Hito 6)', () => {
  it('hasFallback es false con un solo provider, true con varios', () => {
    expect(new ProviderRouter(makeConfig()).hasFallback).toBe(false);
    expect(new ProviderRouter(makeMultiConfig()).hasFallback).toBe(true);
  });

  it('advanceProvider conmuta al siguiente del orden (default primero)', () => {
    const router = new ProviderRouter(makeMultiConfig());
    expect(router.providerName).toBe('primary');

    const next = router.advanceProvider();
    expect(next).toEqual({ name: 'secondary', model: 'vllm-model' });
    expect(router.providerName).toBe('secondary');
    expect(router.model).toBe('vllm-model');
  });

  it('advanceProvider salta providers ya fallidos y agota la lista', () => {
    const router = new ProviderRouter(makeMultiConfig());
    expect(router.advanceProvider()?.name).toBe('secondary');
    expect(router.advanceProvider()?.name).toBe('tertiary');
    expect(router.advanceProvider()).toBeNull(); // sin alternativas
  });

  it('resetFallback permite reintentar el primario tras un fallback', () => {
    const router = new ProviderRouter(makeMultiConfig());
    router.advanceProvider(); // → secondary (primary marcado fallido)
    router.resetFallback();
    // tras el reset, advanceProvider vuelve a marcar el activo (secondary) y
    // puede elegir primary de nuevo porque su flag de fallo se limpió.
    const next = router.advanceProvider();
    expect(next?.name).toBe('primary');
  });

  it('switchProvider cambia el activo y limpia el estado de fallback', () => {
    const router = new ProviderRouter(makeMultiConfig());
    router.advanceProvider(); // marca primary fallido
    router.switchProvider('tertiary');
    expect(router.providerName).toBe('tertiary');
    expect(router.contextWindow).toBe(200000);
    // el fallback se limpió: primary vuelve a ser candidato
    const next = router.advanceProvider();
    expect(next?.name).toBe('primary');
  });

  it('switchProvider lanza si el alias no existe', () => {
    const router = new ProviderRouter(makeMultiConfig());
    expect(() => router.switchProvider('inexistente')).toThrow('no existe');
  });

  it('providerNames lista todos los alias configurados', () => {
    const router = new ProviderRouter(makeMultiConfig());
    expect(router.providerNames).toEqual(['primary', 'secondary', 'tertiary']);
  });
});
