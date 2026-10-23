import { open, stat } from 'fs/promises';

const READ_CHUNK = 256 * 1024;

/**
 * Sigue un fichero que solo crece y entrega sus líneas completas. Por sondeo
 * (`poll()` lo llama quien lo usa): `fs.watch` no es fiable en todas las
 * plataformas y la traza cambia como mucho unas decenas de veces por segundo.
 */
export class FileTail {
  private offset = 0;
  private partial = '';
  private busy = false;
  /**
   * Uno por fichero, no por lectura: con un presupuesto, un carácter multibyte
   * puede quedar partido entre dos sondeos.
   */
  private decoder = new TextDecoder('utf-8');

  constructor(
    private readonly file: string,
    private readonly onLine: (line: string) => void,
    private readonly onReset: () => void,
  ) {}

  /**
   * Lee lo nuevo, hasta `maxBytes` (de más, en el siguiente sondeo). Devuelve
   * los bytes leídos, o `null` si ya había otro sondeo en curso.
   */
  async poll(maxBytes = Infinity): Promise<number | null> {
    if (this.busy) return null;
    this.busy = true;
    let read = 0;
    try {
      let size: number;
      try {
        size = (await stat(this.file)).size;
      } catch {
        return 0; // todavía no existe: la sesión no ha tenido ningún turno
      }
      if (size < this.offset) {
        // Truncado o sustituido: se vuelve a empezar.
        this.offset = 0;
        this.partial = '';
        this.decoder = new TextDecoder('utf-8');
        this.onReset();
      }
      if (size === this.offset) return 0;
      const handle = await open(this.file, 'r');
      try {
        const buf = Buffer.alloc(READ_CHUNK);
        while (this.offset < size && read < maxBytes) {
          const want = Math.min(READ_CHUNK, size - this.offset, maxBytes - read);
          const { bytesRead } = await handle.read(buf, 0, want, this.offset);
          if (bytesRead === 0) break;
          this.offset += bytesRead;
          read += bytesRead;
          this.partial += this.decoder.decode(buf.subarray(0, bytesRead), { stream: true });
          const lines = this.partial.split('\n');
          this.partial = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) this.onLine(line);
        }
      } finally {
        await handle.close();
      }
    } catch {
      /* lectura fallida: se reintenta en el siguiente sondeo */
    } finally {
      this.busy = false;
    }
    return read;
  }
}
