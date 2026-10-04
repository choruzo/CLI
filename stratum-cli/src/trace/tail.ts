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

  constructor(
    private readonly file: string,
    private readonly onLine: (line: string) => void,
    private readonly onReset: () => void,
  ) {}

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let size: number;
      try {
        size = (await stat(this.file)).size;
      } catch {
        return; // todavía no existe: la sesión no ha tenido ningún turno
      }
      if (size < this.offset) {
        // Truncado o sustituido: se vuelve a empezar.
        this.offset = 0;
        this.partial = '';
        this.onReset();
      }
      if (size === this.offset) return;
      const handle = await open(this.file, 'r');
      try {
        // Un decoder por tanda: un carácter multibyte puede caer entre dos lecturas.
        const decoder = new TextDecoder('utf-8');
        const buf = Buffer.alloc(READ_CHUNK);
        while (this.offset < size) {
          const { bytesRead } = await handle.read(buf, 0, READ_CHUNK, this.offset);
          if (bytesRead === 0) break;
          this.offset += bytesRead;
          this.partial += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
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
  }
}
