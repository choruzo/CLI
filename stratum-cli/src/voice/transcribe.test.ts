/**
 * Tests de `transcribePcm` con un motor falso: no hace falta el modelo para
 * probar el troceo, el filtro de casi mudo, la unión del texto y el tope.
 */
import { describe, expect, it } from 'vitest';
import {
  transcribePcm,
  VOICE_MAX_SECONDS,
  VOICE_SAMPLE_RATE,
  VoiceTooLongError,
  type TranscribeEngine,
} from './transcribe.js';
import type { VoiceDeviceInUse } from './worker-protocol.js';

const SR = VOICE_SAMPLE_RATE;

function tone(sec: number, freq = 220, amp = 0.3): Float32Array {
  const n = Math.round(sec * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}
const silence = (sec: number): Float32Array => new Float32Array(Math.round(sec * SR));
const concat = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Motor falso: cuenta llamadas y contesta lo que se le diga. */
function fakeEngine(
  opts: {
    texts?: string[];
    capped?: boolean;
    device?: VoiceDeviceInUse;
  } = {},
): TranscribeEngine & { calls: Float32Array[] } {
  const calls: Float32Array[] = [];
  return {
    calls,
    device: opts.device ?? 'cpu',
    async transcribe(pcm) {
      const index = calls.length;
      calls.push(pcm);
      return {
        text: opts.texts?.[index] ?? `trozo ${index}`,
        encMs: 1,
        decMs: 1,
        outputTokens: 10,
        capped: opts.capped ?? false,
      };
    },
  };
}

describe('transcribePcm', () => {
  it('un audio corto: un trozo, y el texto con su duración y su dispositivo', async () => {
    const engine = fakeEngine({ texts: ['hola'], device: 'gpu' });
    const result = await transcribePcm(engine, tone(3), { language: 'es' });
    expect(result.text).toBe('hola');
    expect(result.durationSec).toBeCloseTo(3, 5);
    expect(result.device).toBe('gpu');
    expect(result.capped).toBe(false);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({ reason: 'end', skipped: false, capped: false });
    expect(result.chunks[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.length).toBe(tone(3).length);
  });

  it('los trozos casi mudos se saltan sin llamar al motor', async () => {
    // 30 s de silencio (primer trozo, 0-30 s, corte forzado) y 10 s de voz.
    const pcm = concat(silence(30), tone(10));
    const engine = fakeEngine({ texts: ['la voz'] });
    const result = await transcribePcm(engine, pcm, { language: 'es' });

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).toMatchObject({ skipped: true });
    expect(result.chunks[0]!.ms).toBeUndefined();
    expect(result.chunks[1]).toMatchObject({ skipped: false });
    // El silencio no llegó al modelo: una sola llamada.
    expect(engine.calls).toHaveLength(1);
    expect(result.text).toBe('la voz');
  });

  it('junta los trozos con un solo espacio, sin espacios dobles', async () => {
    // 27 s de voz, 1,2 s de pausa, 27 s de voz: el corte cae en la pausa.
    const pcm = concat(tone(27), silence(1.2), tone(27));
    const engine: TranscribeEngine = {
      device: 'cpu',
      async transcribe(pcm16k) {
        // Texto con espacios de más a propósito, como los deja el decoder.
        return {
          text: pcm16k[100]! >= 0 ? '  uno  ' : ' dos ',
          encMs: 1,
          decMs: 1,
          outputTokens: 1,
          capped: false,
        };
      },
    };
    const result = await transcribePcm(engine, pcm, { language: 'es' });
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    expect(result.chunks[0]!.reason).toBe('silence');
    expect(result.text).not.toMatch(/ {2}/);
    expect(result.text.startsWith(' ')).toBe(false);
    expect(result.text.endsWith(' ')).toBe(false);
    expect(result.text.split(' ').length).toBe(result.chunks.length);
  });

  it('si un trozo llega al tope, el resultado sale recortado', async () => {
    const engine = fakeEngine({ texts: ['uno', 'dos'], capped: true });
    const pcm = concat(tone(27), silence(1.2), tone(27));
    const result = await transcribePcm(engine, pcm, { language: 'es' });
    expect(result.capped).toBe(true);
    expect(result.chunks.filter((c) => c.capped === true).length).toBeGreaterThanOrEqual(1);
  });

  it('300 s justos entran; una muestra más no', async () => {
    const exact = new Float32Array(VOICE_MAX_SECONDS * SR);
    const engine = fakeEngine();
    const result = await transcribePcm(engine, exact, { language: 'es' });
    expect(result.durationSec).toBe(300);
    // Todo mudo: no se llama al motor, pero la transcripción termina.
    expect(result.text).toBe('');
    expect(engine.calls).toHaveLength(0);
    // Y sin encoder no hay dispositivo que confirmar: ni `gpu` ni `cpu`.
    expect(result.device).toBe('unconfirmed');
    expect(result.warning).toBeUndefined();

    const over = new Float32Array(VOICE_MAX_SECONDS * SR + 1);
    await expect(transcribePcm(engine, over, { language: 'es' })).rejects.toBeInstanceOf(
      VoiceTooLongError,
    );
  });

  it('el aviso del motor (la GPU no se confirmó) viaja en el resultado', async () => {
    const engine: TranscribeEngine = {
      device: 'cpu',
      warning: 'la GPU no se ha confirmado',
      async transcribe() {
        return { text: 'hola', encMs: 1, decMs: 1, outputTokens: 1, capped: false };
      },
    };
    const result = await transcribePcm(engine, tone(2), { language: 'es' });
    expect(result.device).toBe('cpu');
    expect(result.warning).toBe('la GPU no se ha confirmado');
  });

  it('el máximo se puede bajar, y un valor imposible se rechaza', async () => {
    const engine = fakeEngine();
    await expect(transcribePcm(engine, tone(2), { language: 'es', maxSeconds: 1 })).rejects.toThrow(
      /máximo son 1 s/,
    );
    await expect(transcribePcm(engine, tone(1), { language: 'es', maxSeconds: 0 })).rejects.toThrow(
      /maxSeconds/,
    );
  });

  it('el umbral de casi mudo se puede ajustar por llamada', async () => {
    // Voz baja: con el umbral de fábrica se transcribe; con uno muy alto, se tira.
    const pcm = tone(3, 220, 0.02);
    const withVoice = fakeEngine({ texts: ['bajito'] });
    expect((await transcribePcm(withVoice, pcm, { language: 'es' })).text).toBe('bajito');
    const dropped = fakeEngine({ texts: ['no debería'] });
    const result = await transcribePcm(dropped, pcm, { language: 'es', nearSilentDbfs: -10 });
    expect(dropped.calls).toHaveLength(0);
    expect(result.text).toBe('');
    expect(result.chunks[0]!.skipped).toBe(true);
  });
});
