/**
 * Worker de voz **falso** para los tests del cliente (`client.test.ts`).
 *
 * Habla el mismo protocolo que `worker.ts` y decide qué hacer por el contenido
 * del PCM, para no necesitar el modelo ni onnxruntime:
 *
 *   pcm[0] = 1 → responde ya (por defecto)
 *   pcm[0] = 2 → responde a los 250 ms (para probar el `close()` a media petición)
 *   pcm[0] = 3 → se cae (sale con código 1)
 *   pcm[0] = 4 → no contesta nunca (para probar el plazo)
 *   pcm[0] = 5 → contesta un `error` con código `too_long`
 *   pcm[0] = 6 → contesta un `error` **fatal** (motor roto) y tarda 1,5 s en
 *                salir; si mientras tanto le llega otra nota, la contesta con un
 *                error `zombi` (el cliente no debería mandársela)
 *
 *   pcm[1]     → índice que se devuelve en el texto (`nota-<n>`), para comprobar
 *                el orden de la cola.
 *
 * En el `init`:
 *   `language: 'aviso'`      → el `ready` y el `result` llevan un `warning`;
 *   `language: 'falla-init'` → contesta un `error` (el modelo no está listo);
 *   `language: 'sin-ready'`  → no manda nunca el `ready` (arranque que se cuelga).
 *
 * El `ready` dice `gpu-unconfirmed` con WebGPU: es uno de los valores que da el
 * worker de verdad cuando su sonda de carga no confirma la GPU. Al cliente le
 * basta con que el dispositivo llegue tal cual en el `ready` y en el `result`.
 */

let readyDevice = 'cpu';
let zombie = false;
let readyWarning;

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  if (message.t === 'init') {
    if (message.language === 'falla-init') {
      process.send({ t: 'error', code: 'model_not_ready', message: 'sin modelo en el fixture' });
      return;
    }
    if (message.language === 'sin-ready') return;
    readyDevice = message.device === 'gpu' ? 'gpu' : 'cpu';
    const ready = {
      t: 'ready',
      device: readyDevice === 'gpu' ? 'gpu-unconfirmed' : 'cpu',
      loadMs: 3,
    };
    if (message.language === 'aviso') {
      readyWarning = 'aviso del fixture';
      ready.warning = readyWarning;
    }
    process.send(ready);
    return;
  }

  if (message.t !== 'transcribe') return;
  const pcm = message.pcm ?? new Float32Array(0);
  const mode = Math.round(pcm[0] ?? 1);
  const id = message.id;
  const transcript = {
    text: `nota-${Math.round(pcm[1] ?? 0)}`,
    durationSec: pcm.length / 16000,
    capped: false,
    ms: 1,
    device: readyDevice,
    chunks: [],
  };
  if (readyWarning !== undefined) transcript.warning = readyWarning;

  if (zombie) {
    process.send({ t: 'error', id, code: 'failed', message: 'zombi' });
    return;
  }
  if (mode === 6) {
    zombie = true;
    process.send({ t: 'error', id, code: 'failed', message: 'motor roto', fatal: true });
    setTimeout(() => process.exit(1), 1500);
    return;
  }
  if (mode === 3) {
    process.exit(1);
  }
  if (mode === 4) return;
  if (mode === 5) {
    process.send({ t: 'error', id, code: 'too_long', message: 'demasiado largo' });
    return;
  }
  const reply = () => process.send({ t: 'result', id, transcript });
  if (mode === 2) setTimeout(reply, 250);
  else reply();
});

process.on('disconnect', () => process.exit(0));
