/**
 * Tests del cliente del worker de voz. Se usa un worker falso de verdad
 * (`__fixtures__/fake-worker.mjs`, lanzado con `execa` e IPC) para la cola, el
 * tope, la caída y el relanzamiento, el plazo y `close()`; la inactividad se
 * prueba con temporizadores falsos y un hijo de mentira (un proceso real no se
 * deja medir con el reloj parado).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'url';
import {
  VoiceQueueFullError,
  VoiceTimeoutError,
  VoiceWorkerClient,
  VoiceWorkerCrashedError,
  VoiceWorkerError,
  type VoiceWorkerChild,
  type VoiceWorkerClientOptions,
} from './client.js';

const fixture = fileURLToPath(new URL('./__fixtures__/fake-worker.mjs', import.meta.url));

/** `pcm[0]` elige el comportamiento del fixture; `pcm[1]`, el texto que devuelve. */
const pcm = (mode: number, index = 0): Float32Array => Float32Array.from([mode, index]);

let clients: VoiceWorkerClient[] = [];

afterEach(() => {
  for (const client of clients) client.close();
  clients = [];
  vi.useRealTimers();
});

function makeClient(
  extra: Partial<VoiceWorkerClientOptions> = {},
  spawns = { count: 0 },
): { client: VoiceWorkerClient; spawns: { count: number } } {
  const client = new VoiceWorkerClient({
    dir: '/no/existe/el/modelo',
    language: 'es',
    idleUnloadMinutes: 10,
    spawnWorker: () => {
      spawns.count++;
      return execa(process.execPath, [fixture], {
        ipc: true,
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe'],
      }) as unknown as VoiceWorkerChild;
    },
    ...extra,
  });
  clients.push(client);
  return { client, spawns };
}

describe('VoiceWorkerClient con un worker de verdad (falso)', () => {
  it('transcribe, y deja el dispositivo y el aviso del último ready', async () => {
    const { client } = makeClient({ language: 'aviso', device: 'cpu' });
    const transcript = await client.transcribe(pcm(1, 7));
    expect(transcript.text).toBe('nota-7');
    expect(client.device).toBe('cpu');
    expect(client.warning).toBe('aviso del fixture');
    expect(client.loadMs).toBe(3);
  });

  it('el dispositivo pedido se le pasa al worker (gpu cuando se pide gpu)', async () => {
    const { client } = makeClient({ device: 'gpu' });
    await client.transcribe(pcm(1));
    expect(client.device).toBe('gpu');
    expect(client.warning).toBeUndefined();
  });

  it('atiende una petición a la vez y en orden, con un solo worker', async () => {
    const { client, spawns } = makeClient();
    const texts = await Promise.all([
      client.transcribe(pcm(1, 1)),
      client.transcribe(pcm(1, 2)),
      client.transcribe(pcm(1, 3)),
    ]);
    expect(texts.map((t) => t.text)).toEqual(['nota-1', 'nota-2', 'nota-3']);
    expect(spawns.count).toBe(1);
  });

  it('con más de 3 esperando, la siguiente se rechaza en el acto', async () => {
    const { client } = makeClient({ maxQueue: 3 });
    const first = client.transcribe(pcm(2, 1));
    const rest = [
      client.transcribe(pcm(2, 2)),
      client.transcribe(pcm(2, 3)),
      client.transcribe(pcm(2, 4)),
    ];
    await expect(client.transcribe(pcm(2, 5))).rejects.toBeInstanceOf(VoiceQueueFullError);
    expect(client.pending).toBe(3);
    await Promise.all([first, ...rest]);
  });

  it('si el worker se cae, rechaza la petición en curso y las encoladas; la siguiente lo relanza', async () => {
    const { client, spawns } = makeClient();
    const crashed = client.transcribe(pcm(3, 1));
    const queued = client.transcribe(pcm(1, 2));
    await expect(crashed).rejects.toBeInstanceOf(VoiceWorkerCrashedError);
    await expect(queued).rejects.toBeInstanceOf(VoiceWorkerCrashedError);
    expect(client.running).toBe(false);

    const after = await client.transcribe(pcm(1, 9));
    expect(after.text).toBe('nota-9');
    expect(spawns.count).toBe(2);
  });

  it('un error del worker llega con su código', async () => {
    const { client } = makeClient();
    await expect(client.transcribe(pcm(5))).rejects.toMatchObject({
      code: 'too_long',
      name: 'VoiceWorkerError',
    });
    // El worker sigue vivo: un fallo de una nota no lo tira.
    expect(client.running).toBe(true);
    expect((await client.transcribe(pcm(1, 4))).text).toBe('nota-4');
  });

  it('un error fatal tira ese worker antes de mandar la siguiente nota', async () => {
    const { client, spawns } = makeClient();
    // La segunda ya está en cola cuando llega el error fatal de la primera.
    const first = client.transcribe(pcm(6, 1));
    const second = client.transcribe(pcm(1, 2));
    await expect(first).rejects.toThrow(/motor roto/);
    // Si se la hubiera mandado al worker roto, volvería «zombi».
    await expect(second).resolves.toMatchObject({ text: 'nota-2' });
    expect(spawns.count).toBe(2);
  });

  it('un fallo de init rechaza y no deja el worker colgado', async () => {
    const { client, spawns } = makeClient({ language: 'falla-init' });
    await expect(client.transcribe(pcm(1))).rejects.toBeInstanceOf(VoiceWorkerError);
    expect(client.running).toBe(false);
    // Otra petición vuelve a intentarlo (aquí también fallará, pero arranca otro).
    await expect(client.transcribe(pcm(1))).rejects.toBeInstanceOf(VoiceWorkerError);
    expect(spawns.count).toBe(2);
  });

  it('con el plazo vencido rechaza y mata el worker', async () => {
    // El plazo cuenta también el arranque del hijo, así que tiene que dar tiempo
    // a lanzar un proceso de verdad (~400 ms); el primer audio no contesta nunca.
    const { client, spawns } = makeClient({ requestTimeoutMs: 1_500 });
    await expect(client.transcribe(pcm(4))).rejects.toBeInstanceOf(VoiceTimeoutError);
    expect(client.running).toBe(false);
    expect((await client.transcribe(pcm(1, 8))).text).toBe('nota-8');
    expect(spawns.count).toBe(2);
  });

  it('close() mata el worker y rechaza lo pendiente', async () => {
    const { client } = makeClient();
    const inflight = client.transcribe(pcm(2, 1));
    const queued = client.transcribe(pcm(2, 2));
    client.close();
    await expect(inflight).rejects.toBeInstanceOf(VoiceWorkerCrashedError);
    await expect(queued).rejects.toBeInstanceOf(VoiceWorkerCrashedError);
    expect(client.running).toBe(false);
    // Ya cerrado, no se acepta nada más.
    await expect(client.transcribe(pcm(1))).rejects.toBeInstanceOf(VoiceWorkerCrashedError);
  });
});

// ---------------------------------------------------------------------------
// Inactividad (con temporizadores falsos)
// ---------------------------------------------------------------------------

/** Hijo de mentira: responde por microtareas y apunta si le matan. */
class ManualChild implements VoiceWorkerChild {
  readonly sent: unknown[] = [];
  killed = 0;
  private buffer: unknown[] = [];
  private wake?: () => void;
  private ended = false;

  async sendMessage(message: unknown): Promise<void> {
    this.sent.push(message);
    const m = message as { t?: string; id?: number };
    if (m.t === 'init') {
      this.push({ t: 'ready', device: 'cpu', loadMs: 2 });
      return;
    }
    this.push({
      t: 'result',
      id: m.id,
      transcript: {
        text: `eco-${m.id}`,
        durationSec: 1,
        capped: false,
        ms: 1,
        device: 'cpu',
        chunks: [],
      },
    });
  }

  getEachMessage(): AsyncIterableIterator<unknown> {
    return this.iterate();
  }

  kill(): boolean {
    this.killed++;
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
    return true;
  }

  private push(value: unknown): void {
    this.buffer.push(value);
    this.wake?.();
    this.wake = undefined;
  }

  private async *iterate(): AsyncGenerator<unknown> {
    for (;;) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

describe('VoiceWorkerClient: inactividad', () => {
  it('mata el worker tras los minutos sin uso y lo relanza con la siguiente nota', async () => {
    vi.useFakeTimers();
    const children: ManualChild[] = [];
    const client = new VoiceWorkerClient({
      dir: '/no/existe',
      language: 'es',
      idleUnloadMinutes: 1,
      spawnWorker: () => {
        const child = new ManualChild();
        children.push(child);
        return child;
      },
    });
    clients.push(client);

    expect((await client.transcribe(pcm(1))).text).toBe('eco-1');
    expect(children).toHaveLength(1);
    expect(client.running).toBe(true);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(children[0]!.killed).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children[0]!.killed).toBe(1);
    expect(client.running).toBe(false);

    // La siguiente petición arranca otro worker.
    expect((await client.transcribe(pcm(1))).text).toBe('eco-2');
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[1]!.killed).toBe(1);
  });

  it('cada petición rearma el temporizador', async () => {
    vi.useFakeTimers();
    const children: ManualChild[] = [];
    const client = new VoiceWorkerClient({
      dir: '/no/existe',
      language: 'es',
      idleUnloadMinutes: 1,
      spawnWorker: () => {
        const child = new ManualChild();
        children.push(child);
        return child;
      },
    });
    clients.push(client);

    await client.transcribe(pcm(1));
    await vi.advanceTimersByTimeAsync(50_000);
    await client.transcribe(pcm(1));
    await vi.advanceTimersByTimeAsync(50_000);
    // 100 s desde la primera, pero solo 50 desde la última respuesta.
    expect(children[0]!.killed).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0]!.killed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Arranque y generación (hijo controlable, sin procesos de verdad)
// ---------------------------------------------------------------------------

/** Hijo de mentira que decide cuándo manda el `ready`, contesta y muere. */
class ControlledChild implements VoiceWorkerChild {
  readonly sent: unknown[] = [];
  killed = 0;
  private readonly outbox: unknown[] = [];
  private wake?: () => void;
  private ended = false;

  constructor(private readonly opts: { ready: boolean; autoReply?: boolean }) {}

  async sendMessage(message: unknown): Promise<void> {
    this.sent.push(message);
    const m = message as { t?: string; id?: number };
    if (m.t === 'init') {
      if (this.opts.ready) this.push({ t: 'ready', device: 'cpu', loadMs: 1 });
      return;
    }
    if (this.opts.autoReply !== false) this.answer(m.id);
  }

  /** Contesta la petición que se le pasó (o la última que recibió). */
  answer(id?: number): void {
    const last = this.sent.at(-1) as { id?: number } | undefined;
    this.push({
      t: 'result',
      id: id ?? last?.id,
      transcript: {
        text: `eco-${id ?? last?.id}`,
        durationSec: 1,
        capped: false,
        ms: 1,
        device: 'cpu',
        chunks: [],
      },
    });
  }

  getEachMessage(): AsyncIterableIterator<unknown> {
    return this.iterate();
  }

  /** El `kill` no termina el iterador al instante, como un proceso de verdad. */
  kill(): boolean {
    this.killed++;
    return true;
  }

  /** El proceso muere (el cierre llega tarde, cuando le toca). */
  die(): void {
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }

  private push(value: unknown): void {
    this.outbox.push(value);
    this.wake?.();
    this.wake = undefined;
  }

  private async *iterate(): AsyncGenerator<unknown> {
    for (;;) {
      const next = this.outbox.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/** Espera a que se cumpla algo (los hijos falsos van por microtareas). */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('no se cumplió a tiempo');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('VoiceWorkerClient: el plazo cubre el arranque y la generación del hijo', () => {
  it('un hijo que no manda `ready` se rechaza por plazo, muere, y el siguiente arranca otro', async () => {
    const children: ControlledChild[] = [];
    const client = new VoiceWorkerClient({
      dir: '/no/existe',
      language: 'es',
      idleUnloadMinutes: 10,
      requestTimeoutMs: 50,
      spawnWorker: () => {
        // El primero se cuelga al arrancar; los siguientes van bien.
        const child = new ControlledChild({ ready: children.length > 0 });
        children.push(child);
        return child;
      },
    });
    clients.push(client);

    await expect(client.transcribe(pcm(1))).rejects.toBeInstanceOf(VoiceTimeoutError);
    // El plazo vence antes del `ready`: el hijo se mata y no queda ninguno vivo.
    expect(children[0]!.killed).toBeGreaterThanOrEqual(1);
    expect(client.running).toBe(false);

    // La siguiente petición arranca un hijo nuevo y transcribe.
    await expect(client.transcribe(pcm(1, 2))).resolves.toMatchObject({ text: 'eco-2' });
    expect(children).toHaveLength(2);

    children[0]!.die();
    client.close();
  });

  it('un cierre tardío del hijo viejo no rechaza la petición del nuevo', async () => {
    const children: ControlledChild[] = [];
    const client = new VoiceWorkerClient({
      dir: '/no/existe',
      language: 'es',
      idleUnloadMinutes: 10,
      // Holgado: el mismo plazo cubre también la petición del hijo nuevo, que con
      // la suite entera en paralelo puede tardar más de 50 ms en llegar al `die`.
      requestTimeoutMs: 1_000,
      spawnWorker: () => {
        const child =
          children.length === 0
            ? new ControlledChild({ ready: false })
            : // El segundo no contesta solo: se cierra el viejo con la petición en curso.
              new ControlledChild({ ready: true, autoReply: false });
        children.push(child);
        return child;
      },
    });
    clients.push(client);

    await expect(client.transcribe(pcm(1))).rejects.toBeInstanceOf(VoiceTimeoutError);
    const oldChild = children[0]!;
    const next = client.transcribe(pcm(1, 7));
    const fresh = children[1]!;
    await until(
      () => fresh.sent.filter((m) => (m as { t?: string }).t === 'transcribe').length > 0,
    );

    // El hijo viejo termina ahora: su cierre no puede tocar al que lo reemplaza.
    oldChild.die();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.running).toBe(true);

    fresh.answer();
    await expect(next).resolves.toMatchObject({ text: 'eco-2' });
  });
});
