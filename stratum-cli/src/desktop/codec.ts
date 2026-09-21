/**
 * Codificación NDJSON del canal del sidecar. Separado de `protocol.ts` porque
 * usa `Buffer`, y `protocol.ts` lo importa también el frontend de Desktop.
 */
import type { InboundFrame, OutboundFrame } from './protocol.js';

export function encodeFrame(frame: OutboundFrame): string {
  // JSON.stringify nunca emite un salto de línea literal: los de los strings
  // salen escapados, así que la línea es la frontera de trama.
  return JSON.stringify(frame) + '\n';
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
 * entre dos chunks no se corrompe.
 */
export class LineDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private limit: number) {}

  /** Sube el tope (tras autenticar). */
  setLimit(limit: number): void {
    this.limit = limit;
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

/** Parsea una línea como trama de entrada. Devuelve `null` si no tiene forma válida. */
export function parseInboundFrame(line: string): InboundFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case 'handshake':
      return typeof frame.token === 'string' ? { type: 'handshake', token: frame.token } : null;
    case 'ping':
      if (frame.id !== undefined && typeof frame.id !== 'string') return null;
      return frame.id === undefined ? { type: 'ping' } : { type: 'ping', id: frame.id };
    default:
      return null;
  }
}
