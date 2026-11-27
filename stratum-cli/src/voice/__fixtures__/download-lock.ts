/**
 * Fixture del test **entre procesos** del cerrojo (`model-store.test.ts`).
 *
 * Llama a `downloadVoiceModel` de verdad, con un `fetch` falso lento para que el
 * cerrojo dure lo suficiente, y cuenta por la salida estándar qué pasó:
 *
 *   `ok`                     → descargó el modelo
 *   `VoiceModelBusyError`    → otro proceso lo tenía tomado
 *   cualquier otro nombre    → un fallo que no se esperaba
 *
 * Los dos hijos esperan a que exista el fichero `go` para empezar **a la vez**:
 * el módulo ya está cargado cuando llegan ahí, así que la carrera es real y no
 * una cuestión de quién arranca antes.
 *
 * argv[2] = directorio raíz (el modelo va a `<raíz>/canary-1b-v2`)
 * argv[3] = fichero `go`
 * argv[4] = fichero `ready` que se escribe al estar listo
 */

import { createHash } from 'crypto';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { downloadVoiceModel } from '../model-store.js';
import type { VoiceModelFile } from '../manifest.js';

const root = process.argv[2]!;
const go = process.argv[3]!;
const ready = process.argv[4]!;
const dir = join(root, 'canary-1b-v2');

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Los mismos dos ficheros que el manifiesto pequeño de los tests. */
const MANIFEST: readonly VoiceModelFile[] = [
  {
    path: 'a.bin',
    size: 4,
    sha256: sha('aaaa'),
    url: 'https://huggingface.co/istupakov/test/a.bin',
  },
  {
    path: 'b.bin',
    size: 8,
    sha256: sha('bbbbbbbb'),
    url: 'https://huggingface.co/istupakov/test/b.bin',
  },
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Lento a propósito: cada fichero tarda en llegar, y el cerrojo sigue tomado. */
const slowFetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input.toString();
  await sleep(600);
  return new Response(url.endsWith('/a.bin') ? 'aaaa' : 'bbbbbbbb');
}) as unknown as typeof fetch;

const enoughSpace = async (): Promise<{ bavail: number; bsize: number }> => ({
  bavail: 4_000_000,
  bsize: 4096,
});

writeFileSync(ready, 'ok');
while (!existsSync(go)) await sleep(10);

try {
  await downloadVoiceModel({ dir, manifest: MANIFEST, fetch: slowFetch, statfs: enoughSpace });
  process.stdout.write('ok\n');
} catch (err) {
  process.stdout.write(`${err instanceof Error ? err.name : String(err)}\n`);
}
