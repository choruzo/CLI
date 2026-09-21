import { createRequire } from 'module';
import { join } from 'path';
import { importOptional, setOptionalModuleLoader } from '../runtime/optional-import.js';
import type { NativeModuleName, NativeProbe } from './protocol.js';

/**
 * Módulos nativos del sidecar empaquetado (15.2).
 *
 * El binario SEA lleva dentro el core en un único script CommonJS, pero los
 * paquetes con binarios `.node` no se pueden incrustar: viajan en los resources
 * de Tauri como un `node_modules` normal (`<resources>/sidecar/node_modules`),
 * compilados para la ABI del Node embebido. `installResourceLoader` apunta la
 * indirección de `runtime/optional-import.ts` a esa carpeta.
 */

/** Subcarpeta de los resources de Tauri donde viaja el `node_modules` del sidecar. */
export const SIDECAR_RESOURCES_SUBDIR = 'sidecar';

export function installResourceLoader(resourcesDir: string): void {
  // `createRequire` resuelve como si el fichero indicado hiciese el require: los
  // paquetes se buscan en `<resources>/sidecar/node_modules`. El fichero no
  // necesita existir.
  const req = createRequire(join(resourcesDir, SIDECAR_RESOURCES_SUBDIR, 'index.cjs'));
  setOptionalModuleLoader((specifier) => req(specifier));
}

type Probe = () => Promise<void>;

const PROBES: Record<NativeModuleName, Probe> = {
  // Abrir una base en memoria ejercita el binding real, no solo el JS del paquete.
  'better-sqlite3': async () => {
    const mod = await importOptional<{ default: new (p: string) => { close(): void } }>(
      'better-sqlite3',
    );
    new mod.default(':memory:').close();
  },
  // Cargar la extensión en una base real es lo que hace `VectorStore`.
  'sqlite-vec': async () => {
    const sqlite = await importOptional<{
      default: new (p: string) => {
        prepare(sql: string): { get(): unknown };
        close(): void;
      };
    }>('better-sqlite3');
    const vec = await importOptional<{ load: (db: unknown) => void }>('sqlite-vec');
    const db = new sqlite.default(':memory:');
    try {
      vec.load(db);
      db.prepare('select vec_version()').get();
    } finally {
      db.close();
    }
  },
  // En Node, `@xenova/transformers` carga onnxruntime-node al importarse: el
  // binding ONNX queda verificado sin descargar ningún modelo.
  '@xenova/transformers': async () => {
    const mod = await importOptional<{ pipeline?: unknown }>('@xenova/transformers');
    if (typeof mod.pipeline !== 'function') throw new Error('export `pipeline` ausente');
  },
};

/**
 * Comprueba que cada módulo nativo carga. Nunca lanza: un módulo que falla
 * degrada la memoria (fallback JS, sin embeddings locales) igual que en la CLI,
 * pero el fallo tiene que ser visible en el handshake y en `--self-test`.
 */
export async function probeNatives(): Promise<NativeProbe[]> {
  const results: NativeProbe[] = [];
  for (const [module, probe] of Object.entries(PROBES) as Array<[NativeModuleName, Probe]>) {
    try {
      await probe();
      results.push({ module, ok: true });
    } catch (err) {
      results.push({ module, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
