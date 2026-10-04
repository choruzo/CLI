import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { TraceRecorder } from '../trace/recorder.js';
import { FileTail } from '../trace/tail.js';
import type { TraceRecord } from '../trace/records.js';
import { getLogger } from '../logging/index.js';
import type { ConversationOutboundFrame } from './protocol.js';

const log = getLogger('desktop.trace');

/** Tope de registros y de caracteres de una trama `trace_records`. */
const BATCH_RECORDS = 200;
const BATCH_CHARS = 256 * 1024;

/**
 * Trazas de las conversaciones de Desktop (protocolo v9): un JSONL por
 * conversación en `<datos>/traces/`, que graba el runtime de cada
 * `ConversationSession`, y el panel de trayectoria, que sigue **uno** a la vez.
 *
 * El panel lee siempre del fichero (lo ya grabado y lo que se va añadiendo),
 * igual que el visor de la CLI: así da lo mismo que la conversación esté
 * abierta, cerrada o a mitad de un turno.
 */
export class TraceFeed {
  private watching: { conversationId: string; timer: NodeJS.Timeout } | null = null;

  constructor(
    private readonly dir: string,
    private readonly emit: (frame: ConversationOutboundFrame) => void,
    private readonly pollMs = 250,
  ) {}

  file(conversationId: string): string {
    return join(this.dir, `${conversationId}.jsonl`);
  }

  /** Recorder de una conversación; null con `trace.enabled: false`. */
  recorder(conversationId: string, config: StratumConfig): TraceRecorder | null {
    const trace = (config as Partial<StratumConfig>).trace;
    if (!trace?.enabled) return null;
    return new TraceRecorder({
      file: this.file(conversationId),
      sessionId: conversationId,
      config,
    });
  }

  /** Empieza a retransmitir la traza de `conversationId` desde el principio. */
  subscribe(conversationId: string): void {
    this.unsubscribe();
    let batch: TraceRecord[] = [];
    let chars = 0;
    let reset = true;
    const flush = (): void => {
      if (batch.length === 0 && !reset) return;
      this.emit({ type: 'trace_records', conversationId, reset, records: batch });
      batch = [];
      chars = 0;
      reset = false;
    };
    const tail = new FileTail(
      this.file(conversationId),
      (line) => {
        let record: TraceRecord;
        try {
          record = JSON.parse(line) as TraceRecord;
        } catch {
          return; // línea a medio escribir de un proceso que murió
        }
        batch.push(record);
        chars += line.length;
        if (batch.length >= BATCH_RECORDS || chars >= BATCH_CHARS) flush();
      },
      () => {
        batch = [];
        chars = 0;
        reset = true;
      },
    );
    const poll = (): void => {
      void tail.poll().then(flush, (err) => log.debug('trace poll failed', { err }));
    };
    const timer = setInterval(poll, this.pollMs);
    timer.unref();
    this.watching = { conversationId, timer };
    poll();
  }

  unsubscribe(): void {
    if (!this.watching) return;
    clearInterval(this.watching.timer);
    this.watching = null;
  }

  /** La conversación se eliminó: su traza va con ella. */
  remove(conversationId: string): void {
    if (this.watching?.conversationId === conversationId) this.unsubscribe();
    const file = this.file(conversationId);
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch (err) {
      log.warn('trace delete failed', { conversationId, err });
    }
  }
}
