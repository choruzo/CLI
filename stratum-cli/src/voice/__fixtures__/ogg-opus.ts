/**
 * M25 fase 3 — dos notas de voz de verdad para los tests del decodificador.
 *
 * Son 2 s de un tono de 440 Hz en OGG/Opus a 8 kbps, **generadas con ffmpeg** y
 * pegadas aquí en base64 para que el test no dependa de tener ffmpeg:
 *
 * ```
 * ffmpeg -f lavfi -i "sine=frequency=440:duration=2" \
 *   -c:a libopus -b:a 8k -ac 1 -ar 48000 -application voip mono2s.ogg
 * ffmpeg -f lavfi -i "sine=frequency=440:duration=2" \
 *   -af "pan=stereo|c0=c0|c1=0*c0" \
 *   -c:a libopus -b:a 8k -ac 2 -ar 48000 -application voip stereo2s.ogg
 * ```
 *
 * La estéreo lleva el tono en el canal izquierdo y el derecho en silencio: la
 * mezcla a mono sale a la mitad de amplitud.
 */

/** Bytes de un base64. */
export function bytesOfBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** 2 s de un tono, **mono**. */
export const MONO_2S_OGG = bytesOfBase64(
  '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',
);

/** Los mismos 2 s, **estéreo** (izquierdo con el tono, derecho en silencio). */
export const STEREO_2S_OGG = bytesOfBase64(
  'T2dnUwACAAAAAAAAAABKn3BkAAAAAHOs00EBE09wdXNIZWFkAQI4AYC7AAAAAABPZ2dTAAAAAAAAAA' +
    'AAAEqfcGQBAAAAghCbaQE9T3B1c1RhZ3MMAAAATGF2ZjYxLjcuMTAwAQAAAB0AAABlbmNvZGVyPUxh' +
    'dmM2MS4xOS4xMDEgbGlib3B1c09nZ1MAAIC7AAAAAAAASp9wZAIAAAAeQ0k5MhcZERIREhARFBQNEx' +
    'IPDgwQDg4NDg4QDRANEQwQEgwRDhAQDBAMDxENEA0RDwwQDA0QCIIBjWCKUOu+iVYBFyR4jo/GFdXt' +
    'SB0InNcH/y/8jzPrh/PZUVEY0MEWdXip5Vt0CJqvK+NOWn4eSsVskICjQ0AImq8r405aeBzAaTz0Mw' +
    'm5ETAImq8r405aeBDiLpJCw1f51wiatnjgh1Z9GalXE+8mEfQnbAiaryvjTlp4D23UEVrdgOQImq8r' +
    '405aegTP56cGvUmbwAiaryvjTlp6TU32kRl5yzoz25XwCJqvK+NOWnoFSWWR98wUYE7sVIAImq8r40' +
    '5aevsfFI6ECJqvK1hwzmjp27KjZLcBywCDQAiaryvjTlp6+pwQKs+TKLYUywiaryvjTlp6TH49bAeN' +
    'YAiaryvjTlp6+wkauc+JCJqvK+NNHRCcxSZ6CJqxdprZ7ldnvJKvCKmKCAiaryvjTlp+DejRKFwxCJ' +
    'qvK+NOWnfwb1YOUoAImq8r405aewX1y21wCJqvK+NNHRBdryGejKAImq8r405aeBEVIDey4Aiaryvj' +
    'Tlp1WRDAEkDuhKAIMWOsNJWzKb3mbpegCDMvkcLl1qSdizbi2jmZNggzNy5F4QI4h8SEsxgIMy+Rwu' +
    'XWpJ2PsX42M3XUtAgzNy5F5cPkTrvO0AgzNy5F5c+UwC5NM+E51IAIMy+RwuWUghTUBQ0CjYIdWSAI' +
    'MzcuReD/n8ncMeAIMy+RwuX4dKBDMFLr0Dpq5AgzNy5F5cQ7Ai6LafzACDM3LkXlse1lHaEkMp3RYA' +
    'gzL5HC5dakBu6sUXXLwNcIMzcuReD/n34TsXQIMy+RwuWTT2C+9IvIYzY4CDM3LkXlw5ktqDalCDM3' +
    'LkXlz5TN9y88T3LgCDMvkcLl1pUarTVvmlEDiYAIMzcuReEBzqSJfoUMCDMvkcLllJbkFW1ptXmCvA' +
    'gzNy5F5cOlQNeGUrgIMzcuReXPlMBAJcOqUjh5cAgzL5HC5ZMLAVP0IZ7RwAgzNy5F4P+dQxXq0Agz' +
    'L5HC5fh0omd8a1hEhk8IMzcuReXD302ldIUIMzcuReWwR0eyrilQCDMvkcLl1pK699aXR+7nfE9nZ1' +
    'MAAAB3AQAAAAAASp9wZAMAAADQvqpxMg4SDg4PDRELEA8PEQ0PEQwRDQ4RDRANEBANEQwPEQ4SDg8P' +
    'DBEODxINEQ4OEA8RDA8RCDM3LkXhAxGx120RWoAIMy+RwuWbqI824/SYfNbvUNEIMzcuReXEIipRSZ' +
    'vJCAgzNy5F5c6eV7OfkCowCDMvkcLlk2tR5Y8brrPYCDM3LkXhAjhIyaxsQAgzL5HC5daknY+xfjYz' +
    'dffYCDM3LkXlw7tNlD0IMzcuReWxSZDIUrCsHqiACDM3LkXhBHrsMKiHgatgCDM3LkXg6ipBrq1kn4' +
    'vPCDMvkcLl1pmk2L9athNxekAIMzcuReXDp6zS/w+ACDM3LkXhJYpYCFUVSEy8CDMvkcLl1pYBa8iw' +
    'BWoVXIAIMzcuReE+PBlrhcYIMy+RwuWUmv7StOUZEVDKwAgzNy5F5cOn2reBn7wIMzcuReWxY4U/bd' +
    'kxyAgzL5HC5dbpKEDugKyaI6eACDM3LkXhAjc//5VdsAgzL5HC5daknqmLXt1vpcgIMzcuReXNrLPN' +
    'CoEwCDM3LkXlu1yPQFbbsUYmwAgzL5HC5fnrx11SeW+PDEAIMzcuReECP6chLsTgCDMvkcLlk0/dC/' +
    'EtKRkNbBwIMzcuReWwO2ILeGAIMzcuReWx7TdRyr0nUSYIMy+RwuXWkrsPQYCDMMF9fAgzNy5F4WIo' +
    'p1Bu+T0gCDMvkcLlm0a4E291gxIK7YvGCDM3LkXlsPiob+hhwpkIMzcuReWxdbqEfhBN5ygIMy+Rwu' +
    'XWpLGFYEGBJusIMzcuReE+PBlrhcYIMy+RwuWUdeBbvuPEHgZneAgzNy5F5cQpqVaabteACDM3LkXl' +
    'se03Ucq9J1EmCDMvkcLllJ1d2/kMnxGeS/2YCDM3LkXhAjhkUaX/rQgzL5HC5ZNP3QAXyp7YlEEYCD' +
    'M3LkXlxCjSA6jHTOgIMzcuReECB0gpViQrNggzL5HC5daSuvfWl0fu53wIMzcuReEBNJIT/aet7cAI' +
    'My+RwuWTT90L8S0pGQ1sHAgzNy5F5bBB/IYNAwgzNy5F5bFogxw+oU3iYAgzL5HC5dappzatQmjZHC' +
    'lgT2dnUwAEOHgBAAAAAABKn3BkBAAAAGIrK2IBEAgFvQdT4DDXYjTF9xEpUKA=',
);
