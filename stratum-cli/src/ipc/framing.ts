/**
 * Framing NDJSON de los canales locales de Stratum: un valor JSON por línea,
 * UTF-8. Es el mismo del canal del sidecar de Desktop (`desktop/codec.ts`, que
 * lo reexporta) y del Stratum Protocol (`ipc/codec.ts`).
 */

/** Una línea: `JSON.stringify` nunca emite un salto literal, así que la línea es la frontera. */
export function encodeLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

export class FrameTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`La trama supera el límite de ${limit} bytes.`);
    this.name = 'FrameTooLargeError';
  }
}

/**
 * Acumula bytes del socket y devuelve líneas completas. Mide en bytes y no en
 * caracteres, y decodifica solo líneas completas: un carácter multibyte partido
 * entre dos chunks no se corrompe. Da igual cómo lleguen troceados los bytes —
 * de uno en uno o varias líneas juntas—: el resultado es el mismo.
 */
export class LineDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private limit: number) {}

  /** Sube el tope (tras autenticar). */
  setLimit(limit: number): void {
    this.limit = limit;
  }

  /** Bytes de una línea aún sin terminar. Lo que quede al cerrarse la conexión se descarta. */
  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  /** @throws FrameTooLargeError si una línea (completa o en curso) excede el tope. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl);
      this.assertFits(this.pendingBytes + piece.length);
      const line = Buffer.concat([...this.pending, piece]).toString('utf8');
      this.pending = [];
      this.pendingBytes = 0;
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.trim() !== '') lines.push(trimmed);
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.assertFits(this.pendingBytes + rest.length);
      this.pending.push(rest);
      this.pendingBytes += rest.length;
    }
    return lines;
  }

  private assertFits(bytes: number): void {
    if (bytes > this.limit) throw new FrameTooLargeError(this.limit);
  }
}
