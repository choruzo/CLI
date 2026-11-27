import { describe, expect, it } from 'vitest';
import {
  CANARY_LANGUAGES,
  isCanaryLanguage,
  VOICE_MODEL_FILES,
  VOICE_MODEL_ID,
  VOICE_MODEL_TOTAL_BYTES,
} from './manifest.js';

describe('manifiesto del modelo de voz (M25)', () => {
  it('son los seis ficheros de Canary-1B-v2, cada uno con su suma de 64 hex', () => {
    expect(VOICE_MODEL_FILES).toHaveLength(6);
    for (const file of VOICE_MODEL_FILES) {
      expect(file.path).toMatch(/^[\w.-]+$/);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.size).toBeGreaterThan(0);
    }
    expect(VOICE_MODEL_FILES.map((f) => f.path).sort()).toEqual([
      'config.json',
      'decoder-model.onnx',
      'encoder-model.onnx',
      'encoder-model.onnx.data',
      'nemo128.onnx',
      'vocab.txt',
    ]);
  });

  it('la suma de tamaños es la medida en la fase 1 (3 966 054 682 bytes)', () => {
    expect(VOICE_MODEL_TOTAL_BYTES).toBe(3_966_054_682);
  });

  it('cada fichero se baja de una revisión fijada de Hugging Face', () => {
    for (const file of VOICE_MODEL_FILES) {
      expect(file.url).toMatch(
        /^https:\/\/huggingface\.co\/[\w-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//,
      );
      expect(file.url.endsWith(`/${file.path}`)).toBe(true);
    }
    // El preprocesador no está en el repo de Canary: sale del de Parakeet TDT v3.
    const nemo = VOICE_MODEL_FILES.find((f) => f.path === 'nemo128.onnx')!;
    expect(nemo.url).toContain('istupakov/parakeet-tdt-0.6b-v3-onnx');
    expect(nemo.url).toContain('8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce');
    for (const file of VOICE_MODEL_FILES.filter((f) => f !== nemo)) {
      expect(file.url).toContain('istupakov/canary-1b-v2-onnx');
      expect(file.url).toContain('5ebc1520cef7b6b318b3526ad17adbfe00bc1bfc');
    }
  });

  it('el id del modelo es el del directorio', () => {
    expect(VOICE_MODEL_ID).toBe('canary-1b-v2');
  });

  it('los 25 idiomas de Canary-1B-v2, con es entre ellos', () => {
    expect(CANARY_LANGUAGES).toHaveLength(25);
    expect(CANARY_LANGUAGES).toContain('es');
    expect(isCanaryLanguage('es')).toBe(true);
    expect(isCanaryLanguage('gl')).toBe(false);
  });
});
