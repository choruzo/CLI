import { resolve } from 'path';
import { sameVersion, type FileSignature } from './file-io.js';

/**
 * Qué versión de cada fichero vio el agente por última vez (con `read_file`,
 * o al escribirlo él mismo). `write_file` lo consulta antes de sobrescribir:
 * si el fichero cambió desde entonces —el usuario lo editó, un formateador lo
 * reescribió, un subagente lo tocó—, sobrescribirlo desde la versión vieja
 * borraría esos cambios sin que nadie lo viera.
 *
 * Vive en `StratumAgent` (sobrevive entre turnos) y es **por agente**: un
 * subagente lleva el suyo. Compartirlo haría que la escritura de un hijo
 * «refrescase» la vista del padre, que sigue sin haber leído la versión nueva.
 * Un fichero que el agente nunca leyó no se comprueba: no hay versión que
 * contrastar, y exigir lectura previa bloquearía a los modelos pequeños.
 */
export class FileStateTracker {
  private readonly seen = new Map<string, FileSignature>();

  private key(path: string): string {
    const abs = resolve(path);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  record(path: string, signature: FileSignature): void {
    this.seen.set(this.key(path), signature);
  }

  /**
   * `unknown` si el agente no lo ha visto; `fresh` si sigue en la versión
   * vista; `stale` si cambió o desapareció.
   */
  check(path: string, current: FileSignature | null): 'unknown' | 'fresh' | 'stale' {
    const seen = this.seen.get(this.key(path));
    if (!seen) return 'unknown';
    if (!current) return 'stale';
    return sameVersion(seen, current) ? 'fresh' : 'stale';
  }

  forget(path: string): void {
    this.seen.delete(this.key(path));
  }
}
