/**
 * Salida de un job: stdout y stderr en un único registro con offsets absolutos,
 * para leerlo por partes.
 *
 * **Qué orden se conserva y cuál no.** Por dentro los trozos se guardan en el
 * orden en que Stratum los fue recibiendo, y el offset avanza sobre ese
 * registro común: por eso basta un solo cursor para los dos streams. Pero
 * `read()` devuelve `stdout` y `stderr` **por separado**: dentro de cada uno el
 * orden es exacto; entre los dos, quien lee no puede reconstruir cómo se
 * intercalaron. Tampoco el orden interno es el de escritura del proceso: son
 * dos pipes distintos, cada uno se entrega por líneas completas, y lo que el
 * proceso escribió primero puede llegar después. Quien necesite la secuencia
 * exacta tiene que unirla en el propio comando (`2>&1`).
 *
 * Dos decisiones:
 *
 *  - **Se redacta al entrar.** Lo que se guarda ya pasó por la redacción de
 *    secretos, así que nada de lo que salga de aquí (lectura del agente, UI,
 *    traza) puede llevar uno, y los offsets son estables. Para que un secreto
 *    no se libre por caer entre dos trozos del stream, solo se redactan líneas
 *    completas: la línea a medias espera a su salto (o a un tope), y un bloque
 *    PEM abierto espera a su cierre.
 *  - **Se conserva la cola.** Pasado el límite se descarta lo más antiguo: en
 *    un build o una batería de tests lo que importa está al final. Un offset
 *    que apunte a lo descartado se sirve desde lo primero que queda, diciendo
 *    cuánto falta.
 */
import { StringDecoder } from 'node:string_decoder';
import type { JobOutputSlice } from './types.js';

export type JobStream = 'stdout' | 'stderr';

/** Una línea sin terminar se retiene hasta aquí; después se entrega igualmente. */
const LINE_HOLD_CHARS = 8 * 1024;
/** Un bloque PEM abierto se retiene hasta aquí (el núcleo ya tacha uno sin END). */
const PEM_HOLD_CHARS = 32 * 1024;
/** Los trozos contiguos del mismo stream se funden hasta este tamaño. */
const CHUNK_CHARS = 16 * 1024;

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

interface Chunk {
  stream: JobStream;
  text: string;
}

export class JobOutput {
  private readonly chunks: Chunk[] = [];
  private readonly pending: Record<JobStream, string> = { stdout: '', stderr: '' };
  private readonly decoders: Record<JobStream, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  /** Offset absoluto del primer carácter conservado. */
  private base = 0;
  /** Offset absoluto del final. */
  private end = 0;
  private closed = false;
  readonly bytes: Record<JobStream, number> = { stdout: 0, stderr: 0 };

  constructor(
    private maxChars: number,
    private readonly redact: (text: string) => string,
  ) {}

  /** Caracteres en memoria (lo conservado más lo que espera a completar línea). */
  get retainedChars(): number {
    return this.end - this.base + this.pending.stdout.length + this.pending.stderr.length;
  }

  get totalChars(): number {
    return this.end;
  }

  get droppedChars(): number {
    return this.base;
  }

  /** Devuelve true si la llamada dejó salida nueva disponible para leer. */
  push(stream: JobStream, data: Buffer | string): boolean {
    if (this.closed) return false;
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    this.bytes[stream] += buf.length;
    this.pending[stream] += this.decoders[stream].write(buf);
    return this.flush(stream, false);
  }

  /** Fin del proceso: se entrega lo que quedase a medias. */
  close(): void {
    if (this.closed) return;
    for (const stream of ['stdout', 'stderr'] as const) {
      this.pending[stream] += this.decoders[stream].end();
      this.flush(stream, true);
    }
    this.closed = true;
  }

  private flush(stream: JobStream, all: boolean): boolean {
    const text = this.pending[stream];
    if (!text) return false;
    let cut = all ? text.length : safeCut(text);
    if (cut <= 0) return false;
    // No partir un par sustituto: la mitad suelta rompería la redacción y el JSON.
    if (cut < text.length && isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
    if (cut <= 0) return false;
    this.pending[stream] = text.slice(cut);
    this.append(stream, this.redact(text.slice(0, cut)));
    return true;
  }

  private append(stream: JobStream, text: string): void {
    if (!text) return;
    const last = this.chunks.at(-1);
    if (last && last.stream === stream && last.text.length + text.length <= CHUNK_CHARS) {
      last.text += text;
    } else {
      this.chunks.push({ stream, text });
    }
    this.end += text.length;
    this.trimTo(this.maxChars);
  }

  /** Descarta por la cabeza hasta dejar como mucho `maxChars` conservados. */
  trimTo(maxChars: number): number {
    let excess = this.end - this.base - Math.max(0, maxChars);
    if (excess <= 0) return 0;
    const dropped = excess;
    while (excess > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (first.text.length <= excess) {
        excess -= first.text.length;
        this.chunks.shift();
      } else {
        let cut = excess;
        if (isHighSurrogate(first.text.charCodeAt(cut - 1))) cut++;
        first.text = first.text.slice(cut);
        this.base += cut - excess;
        excess = 0;
      }
    }
    this.base += dropped;
    return dropped;
  }

  /** Libera `chars` caracteres de lo más antiguo (límite global). Devuelve lo liberado. */
  release(chars: number): number {
    return this.trimTo(this.end - this.base - chars);
  }

  /**
   * Lee hasta `maxChars` del registro común desde `offset`, y lo devuelve
   * repartido en `stdout` y `stderr` (ver la cabecera: el intercalado entre
   * los dos no se conserva en el resultado). `maxChars` cuenta la suma de
   * ambos. Si el corte cae a mitad de una línea y hay un salto antes, se corta
   * en el salto: el resto llega entero en la lectura siguiente.
   */
  read(offset: number, maxChars: number): JobOutputSlice {
    const wanted = Math.max(0, Math.floor(offset));
    const from = Math.min(Math.max(wanted, this.base), this.end);
    const limit = Math.max(1, Math.floor(maxChars));
    const out: Record<JobStream, string> = { stdout: '', stderr: '' };

    let pos = this.base;
    let taken = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = pos + chunk.text.length;
      if (chunkEnd > from && taken < limit) {
        const start = Math.max(0, from - pos);
        let piece = chunk.text.slice(start, start + (limit - taken));
        if (start + piece.length < chunk.text.length) {
          // Se corta dentro del trozo: mejor en un salto de línea, y nunca en
          // mitad de un par sustituto.
          const newline = piece.lastIndexOf('\n');
          if (newline > 0) piece = piece.slice(0, newline + 1);
          else if (piece.length > 1 && isHighSurrogate(piece.charCodeAt(piece.length - 1))) {
            piece = piece.slice(0, -1);
          }
          out[chunk.stream] += piece;
          taken += piece.length;
          break;
        }
        out[chunk.stream] += piece;
        taken += piece.length;
      }
      pos = chunkEnd;
    }

    const nextOffset = from + taken;
    return {
      stdout: out.stdout,
      stderr: out.stderr,
      offset: from,
      nextOffset,
      totalChars: this.end,
      droppedChars: Math.max(0, this.base - wanted),
      more: nextOffset < this.end,
    };
  }

  /** Offset desde el que leer los últimos `maxChars`, alineado al inicio de una línea si puede. */
  tailOffset(maxChars: number): number {
    const start = Math.max(this.base, this.end - Math.max(1, Math.floor(maxChars)));
    if (start === this.base) return start;
    let pos = this.base;
    for (const chunk of this.chunks) {
      const chunkEnd = pos + chunk.text.length;
      if (chunkEnd > start) {
        const newline = chunk.text.indexOf('\n', start - pos);
        if (newline >= 0 && pos + newline + 1 < this.end) return pos + newline + 1;
        return start;
      }
      pos = chunkEnd;
    }
    return start;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Hasta dónde se puede entregar ya: el final de la última línea completa, sin
 * partir un bloque PEM que sigue abierto. Sin salto de línea se espera, salvo
 * que lo retenido pase del tope.
 */
function safeCut(text: string): number {
  let cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
  if (cut === 0) return text.length >= LINE_HOLD_CHARS ? text.length : 0;

  // Último BEGIN dentro de lo que se iba a entregar: si su END no ha llegado,
  // el bloque se entrega entero más tarde.
  let begin = -1;
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(text); m && m.index < cut; m = PEM_BEGIN.exec(text)) {
    begin = m.index;
  }
  if (begin >= 0 && !PEM_END.test(text.slice(begin)) && text.length - begin < PEM_HOLD_CHARS) {
    cut = begin;
  }
  return cut;
}
