/**
 * Decodificador protobuf mínimo (solo lectura): varint, length-delimited,
 * fixed32 y fixed64; los campos desconocidos se saltan. Basta para el subconjunto
 * de `gtfs-realtime.proto` que usa el conector.
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

export class PbReader {
  pos: number;
  private lo = 0;
  private hi = 0;
  private readonly view: DataView;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get eof(): boolean {
    return this.pos >= this.end;
  }

  /** Lee un varint en `lo`/`hi` (64 bits). */
  private readVarint(): void {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('protobuf truncado (varint)');
      const b = this.buf[this.pos++]!;
      const v = b & 0x7f;
      if (shift < 32) {
        lo |= v << shift;
        if (shift + 7 > 32) hi |= v >>> (32 - shift);
      } else {
        hi |= v << (shift - 32);
      }
      shift += 7;
      if ((b & 0x80) === 0) {
        this.lo = lo >>> 0;
        this.hi = hi >>> 0;
        return;
      }
    }
    throw new Error('protobuf inválido (varint demasiado largo)');
  }

  /** uint32/uint64/enum/bool (los valores por encima de 2^53 pierden precisión). */
  varint(): number {
    this.readVarint();
    return this.hi * 4294967296 + this.lo;
  }

  /** int32 (un negativo viaja extendido a 64 bits: basta el tramo bajo). */
  int32(): number {
    this.readVarint();
    return this.lo | 0;
  }

  /** Campo de longitud delimitada: la vista del contenido. */
  bytes(): Uint8Array {
    const len = this.varint();
    if (this.pos + len > this.end) throw new Error('protobuf truncado (bytes)');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return new TextDecoder('utf-8').decode(this.bytes());
  }

  float(): number {
    if (this.pos + 4 > this.end) throw new Error('protobuf truncado (float)');
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  double(): number {
    if (this.pos + 8 > this.end) throw new Error('protobuf truncado (double)');
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.readVarint();
        return;
      case WIRE_FIXED64:
        this.pos += 8;
        return;
      case WIRE_LEN:
        this.bytes();
        return;
      case WIRE_FIXED32:
        this.pos += 4;
        return;
      default:
        throw new Error(`protobuf inválido (tipo de cable ${wire})`);
    }
  }
}

/**
 * Recorre los campos de un mensaje. `onField` debe consumir el valor y devolver
 * `true`; si devuelve `false` el campo se salta.
 */
export function readMessage(
  buf: Uint8Array,
  onField: (field: number, wire: number, r: PbReader) => boolean,
): void {
  const r = new PbReader(buf);
  while (!r.eof) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!onField(field, wire, r)) r.skip(wire);
  }
}
