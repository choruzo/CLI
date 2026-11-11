/**
 * Lector de ZIP mínimo y propio (el bundle del conector no lleva dependencias).
 * Lee el directorio central y entrega cada entrada **en streaming**: el
 * `stop_times.txt` de Renfe pesa 270 MB descomprimido y nunca debe estar entero
 * en memoria. Soporta los métodos 0 (stored) y 8 (deflate); ZIP64 no (el feed
 * real no lo usa) y se rechaza con un error claro.
 */
import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Fecha de modificación DOS de la entrada, como `YYYYMMDD`. */
  date: string;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function dosDate(d: number): string {
  const year = ((d >> 9) & 0x7f) + 1980;
  const month = (d >> 5) & 0x0f;
  const day = d & 0x1f;
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

export class ZipArchive {
  private constructor(
    readonly path: string,
    readonly entries: ZipEntry[],
  ) {}

  static async open(path: string): Promise<ZipArchive> {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const tailLen = Math.min(size, 22 + 65535);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIG) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new Error('ZIP inválido: no se encuentra el directorio central');
      const total = tail.readUInt16LE(eocd + 10);
      const cenSize = tail.readUInt32LE(eocd + 12);
      const cenOffset = tail.readUInt32LE(eocd + 16);
      if (total === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
        throw new Error('ZIP64 no soportado');
      }
      const cen = Buffer.alloc(cenSize);
      await fh.read(cen, 0, cenSize, cenOffset);
      const entries: ZipEntry[] = [];
      let p = 0;
      while (p + 46 <= cen.length && cen.readUInt32LE(p) === CEN_SIG) {
        const method = cen.readUInt16LE(p + 10);
        const date = cen.readUInt16LE(p + 14);
        const compressedSize = cen.readUInt32LE(p + 20);
        const usize = cen.readUInt32LE(p + 24);
        const nameLen = cen.readUInt16LE(p + 28);
        const extraLen = cen.readUInt16LE(p + 30);
        const commentLen = cen.readUInt16LE(p + 32);
        const localOffset = cen.readUInt32LE(p + 42);
        if (compressedSize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
          throw new Error('ZIP64 no soportado');
        }
        const name = cen.toString('utf8', p + 46, p + 46 + nameLen);
        entries.push({
          name,
          method,
          compressedSize,
          size: usize,
          date: dosDate(date),
          localOffset,
        });
        p += 46 + nameLen + extraLen + commentLen;
      }
      return new ZipArchive(path, entries);
    } finally {
      await fh.close();
    }
  }

  find(name: string): ZipEntry | undefined {
    return (
      this.entries.find((e) => e.name === name) ??
      this.entries.find((e) => e.name.endsWith(`/${name}`))
    );
  }

  /** Fecha (`YYYYMMDD`) de la entrada más reciente. */
  newestDate(): string | null {
    let best: string | null = null;
    for (const e of this.entries) if (best === null || e.date > best) best = e.date;
    return best;
  }

  /** Contenido de la entrada en streaming; `null` si no existe. */
  async stream(name: string): Promise<Readable | null> {
    const entry = this.find(name);
    if (!entry) return null;
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`Método de compresión ${entry.method} no soportado (${name})`);
    }
    let fh: FileHandle | undefined;
    let start: number;
    try {
      fh = await open(this.path, 'r');
      const head = Buffer.alloc(30);
      await fh.read(head, 0, 30, entry.localOffset);
      if (head.readUInt32LE(0) !== LOC_SIG) throw new Error('ZIP inválido: cabecera local');
      start = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    } finally {
      await fh?.close();
    }
    if (entry.compressedSize === 0) return Readable.from([]);
    const raw = createReadStream(this.path, { start, end: start + entry.compressedSize - 1 });
    if (entry.method === 0) return raw;
    const inflate = createInflateRaw();
    raw.on('error', (err) => inflate.destroy(err));
    return raw.pipe(inflate);
  }

  /** Para entradas pequeñas: el texto UTF-8 completo. */
  async readText(name: string): Promise<string | null> {
    const s = await this.stream(name);
    if (!s) return null;
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
}
