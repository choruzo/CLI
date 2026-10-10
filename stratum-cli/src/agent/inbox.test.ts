import { describe, it, expect, afterEach } from 'vitest';
import {
  RuntimeInbox,
  formatRuntimeUpdates,
  formatUndeliveredUserMessages,
  isRuntimeUpdatesMessage,
  MAX_STEERING_CHARS,
  type RuntimeInboxChange,
} from './inbox.js';
import { JobManager } from '../jobs/manager.js';
import { MAIN_JOB_SCOPE } from '../jobs/types.js';
import { StratumConfigSchema } from '../config/schema.js';
import { resetExecRuntime } from '../tools/exec/runtime.js';
import type { TraceRuntimeEvent } from '../trace/records.js';
import type { TraceScope } from '../trace/recorder.js';

const config = StratumConfigSchema.parse({ tools: { auditLog: false } });
const node = (script: string): string => `node -e "${script}"`;

/** Scope de traza que solo guarda los eventos del runtime. */
function traceSpy(): { scope: TraceScope; events: TraceRuntimeEvent[] } {
  const events: TraceRuntimeEvent[] = [];
  const scope = { runtime: (ev: TraceRuntimeEvent) => events.push(ev) } as unknown as TraceScope;
  return { scope, events };
}

let managers: JobManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
  resetExecRuntime();
});

describe('RuntimeInbox — cola', () => {
  it('sin turno abierto no encola: el mensaje es un turno nuevo', () => {
    const inbox = new RuntimeInbox();
    expect(inbox.acceptsSteering).toBe(false);
    expect(inbox.enqueueUserMessage('hola')).toBeNull();
    expect(inbox.pending()).toEqual([]);
  });

  it('FIFO, y cada evento se entrega una sola vez', () => {
    let t = 1000;
    const inbox = new RuntimeInbox(() => t++);
    inbox.beginTurn();
    inbox.enqueueUserMessage('uno');
    inbox.enqueueUserMessage('dos');
    inbox.enqueueUserMessage('tres');

    const batch = inbox.drain(MAIN_JOB_SCOPE)!;
    expect(batch.userMessages.map((m) => m.text)).toEqual(['uno', 'dos', 'tres']);
    expect(new Set(batch.userMessages.map((m) => m.id)).size).toBe(3);
    expect(inbox.drain(MAIN_JOB_SCOPE)).toBeNull();
    expect(inbox.hasPendingUserMessages()).toBe(false);
  });

  it('un mensaje vacío no se encola y uno enorme se recorta', () => {
    const inbox = new RuntimeInbox();
    inbox.beginTurn();
    expect(inbox.enqueueUserMessage('   ')).toBeNull();
    const big = inbox.enqueueUserMessage('x'.repeat(MAX_STEERING_CHARS + 50))!;
    expect(big.text).toHaveLength(MAX_STEERING_CHARS);
  });

  it('un subagente no drena el steering del usuario', () => {
    const inbox = new RuntimeInbox();
    inbox.beginTurn();
    inbox.enqueueUserMessage('para el principal');
    expect(inbox.drain('sub_abc')).toBeNull();
    expect(inbox.hasPendingUserMessages()).toBe(true);
    expect(inbox.drain(MAIN_JOB_SCOPE)!.userMessages).toHaveLength(1);
  });

  it('sealIfIdle: con steering pendiente no cierra; sin él, deja de aceptar en el acto', () => {
    const inbox = new RuntimeInbox();
    inbox.beginTurn();
    inbox.enqueueUserMessage('espera');
    expect(inbox.sealIfIdle()).toBe(false);
    expect(inbox.acceptsSteering).toBe(true);

    inbox.drain(MAIN_JOB_SCOPE);
    expect(inbox.sealIfIdle()).toBe(true);
    // El turno ya ha dicho que termina: lo que llegue ahora no se encola.
    expect(inbox.enqueueUserMessage('tarde')).toBeNull();
    expect(inbox.pending()).toEqual([]);
  });

  it('sealIfIdle de un subagente ni espera steering ni cierra el turno del principal', () => {
    const inbox = new RuntimeInbox();
    inbox.beginTurn();
    inbox.enqueueUserMessage('para el principal');
    expect(inbox.sealIfIdle('sub_abc')).toBe(true);
    expect(inbox.acceptsSteering).toBe(true);
  });

  it('lo que un turno cortado dejó sin entregar se recoge al abrir el siguiente', () => {
    const inbox = new RuntimeInbox();
    inbox.beginTurn();
    inbox.enqueueUserMessage('no toques OAuth');
    inbox.endTurn();
    expect(inbox.hasPendingUserMessages()).toBe(true);

    const late = inbox.takeUndeliveredUserMessages();
    expect(late.map((m) => m.text)).toEqual(['no toques OAuth']);
    expect(inbox.takeUndeliveredUserMessages()).toEqual([]);
  });

  it('/clear descarta el steering pendiente y avisa a quien escucha', () => {
    const inbox = new RuntimeInbox();
    const changes: RuntimeInboxChange[] = [];
    inbox.subscribe((c) => changes.push(c));
    inbox.beginTurn();
    inbox.enqueueUserMessage('a');
    inbox.clearUserMessages();
    expect(inbox.pending()).toEqual([]);
    expect(changes.map((c) => c.type)).toEqual(['enqueued', 'dropped']);
  });
});

describe('RuntimeInbox — traza', () => {
  it('enqueue y consume llevan id, scope y tamaño, nunca el texto', () => {
    let t = 0;
    const inbox = new RuntimeInbox(() => (t += 250));
    const { scope, events } = traceSpy();
    inbox.beginTurn(scope);
    const queued = inbox.enqueueUserMessage('no toques OAuth: token SECRETO')!;
    inbox.drain(MAIN_JOB_SCOPE, scope);

    expect(events).toEqual([
      {
        event: 'inbox',
        phase: 'enqueue',
        id: queued.id,
        type: 'user-message',
        scope: MAIN_JOB_SCOPE,
        chars: queued.text.length,
      },
      {
        event: 'inbox',
        phase: 'consume',
        id: queued.id,
        type: 'user-message',
        scope: MAIN_JOB_SCOPE,
        waitMs: 250,
        batch: 1,
        chars: queued.text.length,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('SECRETO');
  });

  it('lo descartado queda como drop con su motivo', () => {
    const inbox = new RuntimeInbox();
    const { scope, events } = traceSpy();
    inbox.beginTurn(scope);
    inbox.enqueueUserMessage('a');
    inbox.clearUserMessages();
    expect(events.at(-1)).toMatchObject({ phase: 'drop', reason: 'history-cleared' });
  });
});

describe('RuntimeInbox — jobs', () => {
  function manager(): JobManager {
    const m = new JobManager(config, { killGraceMs: 300 });
    managers.push(m);
    return m;
  }

  it('el final de un job entra en la cola de su dueño y sale con los mensajes, en orden', async () => {
    const jobs = manager();
    const inbox = new RuntimeInbox();
    inbox.attachJobs(jobs);
    inbox.beginTurn();

    inbox.enqueueUserMessage('antes del job');
    const job = await jobs.start({
      command: node('process.exit(1)'),
      cwd: process.cwd(),
      owner: { scope: MAIN_JOB_SCOPE },
    });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    inbox.enqueueUserMessage('después del job');

    const batch = inbox.drain(MAIN_JOB_SCOPE)!;
    expect(batch.updates.map((u) => u.kind)).toEqual(['user', 'job', 'user']);
    expect(batch.updates[1]).toMatchObject({
      event: { type: 'job-failed', jobId: job.id },
      notification: { status: 'failed', exitCode: 1 },
    });
    // El manager ya lo da por contado: ni la inbox ni la vía antigua lo repiten.
    expect(jobs.hasNotifications(MAIN_JOB_SCOPE)).toBe(false);
    expect(jobs.takeNotifications(MAIN_JOB_SCOPE)).toEqual([]);
  });

  it('un job que su dueño ya conoce no se le cuenta otra vez', async () => {
    const jobs = manager();
    const inbox = new RuntimeInbox();
    inbox.attachJobs(jobs);
    const job = await jobs.start({
      command: node('1'),
      cwd: process.cwd(),
      owner: { scope: MAIN_JOB_SCOPE },
    });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });
    expect(inbox.pending(MAIN_JOB_SCOPE)).toHaveLength(1);

    // El agente lo vio por la vía de siempre (o con una tool).
    expect(jobs.takeNotifications(MAIN_JOB_SCOPE)).toHaveLength(1);
    expect(inbox.drain(MAIN_JOB_SCOPE)).toBeNull();
    expect(inbox.pending()).toEqual([]);
  });

  it('un job terminado no retiene el turno: solo el steering del usuario lo hace', async () => {
    const jobs = manager();
    const inbox = new RuntimeInbox();
    inbox.attachJobs(jobs);
    inbox.beginTurn();
    const job = await jobs.start({
      command: node('1'),
      cwd: process.cwd(),
      owner: { scope: MAIN_JOB_SCOPE },
    });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });

    expect(inbox.sealIfIdle()).toBe(true);
    // Sigue pendiente para el turno siguiente.
    expect(inbox.pending(MAIN_JOB_SCOPE)).toHaveLength(1);
  });

  it('el job de un subagente va a su scope, y al cerrarlo se descarta', async () => {
    const jobs = manager();
    const inbox = new RuntimeInbox();
    inbox.attachJobs(jobs);
    const job = await jobs.start({
      command: node('1'),
      cwd: process.cwd(),
      owner: { scope: 'sub_x' },
    });
    await jobs.waitFor(job.id, { until: 'end', timeoutMs: 20_000 });

    expect(inbox.pending(MAIN_JOB_SCOPE)).toEqual([]);
    expect(inbox.pending('sub_x')).toHaveLength(1);
    inbox.closeScope('sub_x');
    expect(inbox.pending()).toEqual([]);
  });
});

describe('bloque <runtime_updates>', () => {
  it('numera en orden y deja claro que llegó después de la petición', () => {
    const inbox = new RuntimeInbox();
    inbox.beginTurn();
    inbox.enqueueUserMessage('no toques OAuth');
    inbox.enqueueUserMessage('prioriza backend\ny no cambies la API pública');
    const text = formatRuntimeUpdates(inbox.drain(MAIN_JOB_SCOPE)!, () => '');

    expect(isRuntimeUpdatesMessage(text)).toBe(true);
    expect(text).toContain('1. User: no toques OAuth');
    expect(text).toContain('2. User: prioriza backend\n   y no cambies la API pública');
    expect(text).toContain('not part of the original request');
    expect(text.trimEnd().endsWith('</runtime_updates>')).toBe(true);
  });

  it('el steering no entregado dice que es anterior a lo que sigue', () => {
    const inbox = new RuntimeInbox();
    inbox.beginTurn();
    inbox.enqueueUserMessage('no toques OAuth');
    inbox.endTurn();
    const text = formatUndeliveredUserMessages(inbox.takeUndeliveredUserMessages());
    expect(isRuntimeUpdatesMessage(text)).toBe(true);
    expect(text).toContain('older than the message that follows');
    expect(text).toContain('1. User: no toques OAuth');
  });
});
