/**
 * `JobManager` — jobs en segundo plano de una sesión.
 *
 * Es el único dueño de esos procesos: los lanza (con el mismo shell y el mismo
 * entorno que un `exec` normal), guarda su salida ya redactada, los cancela
 * cerrando el árbol entero y no deja ninguno vivo al terminar. Un job no
 * sobrevive a la sesión: no se persiste ni se reanuda.
 *
 * Quién puede tocar qué lo decide el *scope*: cada job es del agente o
 * subagente que lo creó (`JobOwner.scope`). El principal ve y cancela todos los
 * de su sesión; un subagente, solo los suyos, salvo que `tools.jobs.subagentAccess`
 * diga otra cosa. Cuando un subagente termina, sus jobs vivos se cancelan
 * (`closeScope`): nadie quedaría para leerlos.
 *
 * Los cambios de estado salen por dos vías. `subscribe` avisa en el acto (UI,
 * y el día de mañana un despertador del agente). `takeNotifications` entrega,
 * una sola vez, los jobs terminados que su dueño aún no conoce: el loop la
 * consulta en un punto seguro y lo cuenta en el contexto del modelo.
 */
import type { StratumConfig } from '../config/schema.js';
import { getLogger } from '../logging/index.js';
import { redactText } from '../security/redact-output.js';
import {
  killProcessTreeSync,
  signalProcessTree,
  sweepProcessDescendants,
  spawnLocalShell,
  type LocalSubprocess,
} from '../tools/exec/backends/local.js';
import { ExecSpawnError, KILL_GRACE_MS, SETTLE_GRACE_MS } from '../tools/exec/backend.js';
import { getExecAuditLog } from '../tools/exec/runtime.js';
import type { TraceScope } from '../trace/recorder.js';
import { JobOutput } from './output.js';
import { registerJobManager, unregisterJobManager } from './registry.js';
import {
  MAIN_JOB_SCOPE,
  type BackgroundJob,
  type JobEndReason,
  type JobEvent,
  type JobListener,
  type JobNotification,
  type JobOutputSlice,
  type JobOwner,
} from './types.js';

const log = getLogger('jobs');

/** Tope del cierre de un job que matamos (orden al árbol + barrido de descendientes). */
const REAP_CAP_MS = 25_000;

/** Tras salir el proceso, margen para que sus pipes terminen de vaciarse. */
const DRAIN_GRACE_MS = 1000;

export type JobAccess = 'read' | 'cancel';

export interface JobLimits {
  maxRunning: number;
  maxRetained: number;
  maxOutputChars: number;
  maxTotalOutputChars: number;
  maxRuntimeMs: number;
  subagentAccess: 'own' | 'read' | 'manage';
}

export interface StartJobRequest {
  command: string;
  cwd: string;
  owner: JobOwner;
  stdin?: string;
  /** Tiempo máximo; por defecto `limits.maxRuntimeMs`. */
  timeoutMs?: number;
  /** Traza del scope que lo crea: ahí queda todo su ciclo de vida. */
  trace?: TraceScope;
}

export interface JobManagerOptions {
  /** Margen entre SIGTERM y SIGKILL. Los tests lo acortan. */
  killGraceMs?: number;
  spawn?: (command: string, cwd: string, stdin?: string) => LocalSubprocess;
}

/** No se pudo crear el job por un límite de la sesión (no es un fallo del comando). */
export class JobLimitError extends Error {
  override readonly name = 'JobLimitError';
}

/**
 * El manager ya se cerró (`shutdown`). Es definitivo: un manager cerrado no
 * vuelve a lanzar jobs ni a entrar en el registro del proceso.
 */
export class JobManagerClosedError extends Error {
  override readonly name = 'JobManagerClosedError';
  constructor() {
    super('The session has been closed: background jobs can no longer be started.');
  }
}

export class JobNotFoundError extends Error {
  override readonly name = 'JobNotFoundError';
}

interface JobRecord {
  job: BackgroundJob;
  output: JobOutput;
  subprocess?: LocalSubprocess;
  trace?: TraceScope;
  /** Motivo de la cancelación pedida; decide el estado final. */
  cancelReason?: JobEndReason;
  timedOut: boolean;
  killing: boolean;
  /** La orden de cierre del árbol ya se entregó (en Windows, `taskkill` terminó). */
  treeSignalled?: Promise<void>;
  /** El cierre de un job que matamos ya está en marcha (se hace una sola vez). */
  reaping: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  ended: Promise<void>;
  resolveEnded: () => void;
  /** Esperas de `waitFor`: se despiertan con salida nueva o con el final. */
  waiters: Set<() => void>;
  /** El dueño ya sabe que terminó (se lo dijo el loop o lo vio él con una tool). */
  ownerInformed: boolean;
  /** Hasta dónde leyó cada scope: una lectura sin `offset` sigue desde ahí. */
  cursors: Map<string, number>;
}

export class JobManager {
  private readonly records = new Map<string, JobRecord>();
  private readonly listeners = new Set<JobListener>();
  private readonly limits: JobLimits;
  private readonly killGraceMs: number;
  private readonly spawn: NonNullable<JobManagerOptions['spawn']>;
  private seq = 0;
  /** `shutdown()` es terminal: una vez a true, nunca vuelve a false. */
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  /** `start()` en vuelo: `shutdown` los espera para no dejar un proceso recién nacido sin dueño. */
  private readonly starting = new Set<Promise<unknown>>();

  constructor(
    private readonly config: StratumConfig,
    options: JobManagerOptions = {},
  ) {
    const jobs = config.tools.jobs;
    this.limits = {
      maxRunning: jobs.maxRunning,
      maxRetained: jobs.maxRetained,
      maxOutputChars: jobs.maxOutputChars,
      maxTotalOutputChars: jobs.maxTotalOutputChars,
      maxRuntimeMs: jobs.maxRuntimeMs,
      subagentAccess: jobs.subagentAccess,
    };
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.spawn = options.spawn ?? spawnLocalShell;
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  /** Snapshot del job, o `undefined` si no existe (o ya se olvidó). */
  get(id: string): BackgroundJob | undefined {
    const rec = this.records.get(normalizeJobId(id));
    return rec ? this.snapshot(rec) : undefined;
  }

  /** Jobs visibles para `scope` (todos si se omite), del más antiguo al más nuevo. */
  list(scope?: string): BackgroundJob[] {
    return [...this.records.values()]
      .filter((rec) => scope === undefined || this.canAccess(scope, rec.job, 'read'))
      .map((rec) => this.snapshot(rec));
  }

  get runningCount(): number {
    let n = 0;
    for (const rec of this.records.values()) if (rec.job.status === 'running') n++;
    return n;
  }

  /** ¿Puede `scope` hacer `action` sobre el job? */
  canAccess(scope: string, job: Pick<BackgroundJob, 'owner'>, action: JobAccess): boolean {
    if (job.owner.scope === scope) return true;
    // La sesión es del principal: lo que lance un hijo suyo sigue siendo suyo.
    if (scope === MAIN_JOB_SCOPE) return true;
    if (this.limits.subagentAccess === 'manage') return true;
    return this.limits.subagentAccess === 'read' && action === 'read';
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Creación
  // -------------------------------------------------------------------------

  /** `shutdown()` ya se llamó: el manager no admite más jobs. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Lanza el comando y devuelve en cuanto el proceso existe. Rechaza con
   * `JobManagerClosedError` (el manager se cerró), `JobLimitError` (límite de
   * la sesión) o `ExecSpawnError` (no arrancó).
   */
  start(req: StartJobRequest): Promise<BackgroundJob> {
    // La comprobación va antes de cualquier efecto: un manager cerrado ni crea
    // el registro del job ni vuelve a apuntarse en el registro del proceso.
    if (this.closed) return Promise.reject(new JobManagerClosedError());
    const pending = this.launch(req);
    this.starting.add(pending);
    const forget = (): void => void this.starting.delete(pending);
    pending.then(forget, forget);
    return pending;
  }

  private async launch(req: StartJobRequest): Promise<BackgroundJob> {
    if (this.runningCount >= this.limits.maxRunning) {
      throw new JobLimitError(
        `There are already ${this.limits.maxRunning} background jobs running ` +
          '(tools.jobs.maxRunning). Wait for one to finish or cancel one with cancel_job.',
      );
    }

    // Solo un manager con jobs entra en el registro del proceso (cierre y
    // gancho de `exit`): la mayoría de las sesiones nunca lanza ninguno.
    registerJobManager(this);
    const id = String(++this.seq);
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
    const rec: JobRecord = {
      job: {
        id,
        command: redactText(req.command, this.config),
        cwd: req.cwd,
        status: 'running',
        startedAt: Date.now(),
        owner: { ...req.owner },
        stdoutBytes: 0,
        stderrBytes: 0,
        outputChars: 0,
        droppedChars: 0,
        outputRead: false,
      },
      output: new JobOutput(this.limits.maxOutputChars, (text) => redactText(text, this.config)),
      trace: req.trace,
      timedOut: false,
      killing: false,
      reaping: false,
      timers: new Set(),
      ended,
      resolveEnded,
      waiters: new Set(),
      ownerInformed: false,
      cursors: new Map(),
    };
    this.records.set(id, rec);
    rec.trace?.runtime({
      event: 'job',
      phase: 'created',
      jobId: id,
      command: rec.job.command,
      cwd: rec.job.cwd,
      scope: rec.job.owner.scope,
    });
    this.emit({ type: 'created', job: this.snapshot(rec) });

    let subprocess: LocalSubprocess;
    try {
      subprocess = this.spawn(req.command, req.cwd, req.stdin);
      await spawned(subprocess);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.records.delete(id);
      this.finishRecord(rec, null, 'spawn-error');
      throw new ExecSpawnError(message);
    }

    rec.subprocess = subprocess;
    rec.job.pid = subprocess.pid;
    // Cancelado mientras nacía (un cierre o un `closeScope` a la vez): aquella
    // orden no tenía proceso al que llegar. Se repite ahora que lo hay.
    if (rec.killing) {
      rec.killing = false;
      this.kill(rec);
    }
    subprocess.stdout?.on('data', (chunk: Buffer | string) => this.onData(rec, 'stdout', chunk));
    subprocess.stderr?.on('data', (chunk: Buffer | string) => this.onData(rec, 'stderr', chunk));

    // El final se decide con `exit` (el proceso murió) y no con el cierre de
    // los pipes: un nieto que los herede los mantendría abiertos y el job no
    // terminaría nunca. Tras `exit` se da un margen corto para vaciar lo escrito.
    let exitCode: number | null = null;
    subprocess.once('exit', (code) => {
      exitCode = code;
      this.timer(rec, DRAIN_GRACE_MS, () => this.finish(rec, exitCode));
    });
    subprocess.once('close', (code) => this.finish(rec, exitCode ?? code));
    // Red de seguridad: execa resuelve aunque no llegase ningún evento.
    void Promise.resolve(subprocess).then(
      (result) => this.finish(rec, exitCode ?? (result as { exitCode?: number }).exitCode ?? null),
      () => this.finish(rec, exitCode),
    );

    const timeoutMs = req.timeoutMs ?? this.limits.maxRuntimeMs;
    this.timer(rec, timeoutMs, () => {
      rec.timedOut = true;
      this.kill(rec);
    });

    getExecAuditLog(this.config).write({
      timestamp: new Date(rec.job.startedAt).toISOString(),
      ...(rec.job.owner.sessionId ? { sessionId: rec.job.owner.sessionId } : {}),
      target: 'local',
      command: rec.job.command,
      cwd: rec.job.cwd,
      status: 'background_started',
      exitCode: null,
      durationMs: 0,
      truncated: false,
      background: true,
      jobId: id,
      ...(rec.job.pid !== undefined ? { pid: rec.job.pid } : {}),
    });
    rec.trace?.runtime({ event: 'job', phase: 'started', jobId: id, pid: rec.job.pid ?? null });
    log.info('job started', { id, pid: rec.job.pid, scope: rec.job.owner.scope });
    this.emit({ type: 'started', job: this.snapshot(rec) });
    return this.snapshot(rec);
  }

  // -------------------------------------------------------------------------
  // Salida
  // -------------------------------------------------------------------------

  private onData(rec: JobRecord, stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    if (rec.job.status !== 'running') return;
    const fresh = rec.output.push(stream, chunk);
    this.enforceTotalLimit(rec);
    if (fresh) this.wake(rec);
  }

  /** Límite global: libera primero la salida de los jobs terminados más antiguos. */
  private enforceTotalLimit(current: JobRecord): void {
    let total = 0;
    for (const rec of this.records.values()) total += rec.output.retainedChars;
    let excess = total - this.limits.maxTotalOutputChars;
    if (excess <= 0) return;
    const all = [...this.records.values()];
    const order = [
      ...all.filter((r) => r.job.status !== 'running' && r !== current),
      ...all.filter((r) => r.job.status === 'running' && r !== current),
      current,
    ];
    for (const rec of order) {
      if (excess <= 0) break;
      excess -= rec.output.release(excess);
    }
  }

  /**
   * Lee salida. Sin `offset` continúa donde este `scope` lo dejó; con `tail`,
   * los últimos `maxChars`. Anota la lectura (`outputRead`, traza).
   */
  readOutput(
    id: string,
    scope: string,
    opts: { offset?: number; maxChars: number; tail?: boolean },
  ): { job: BackgroundJob; slice: JobOutputSlice } {
    const rec = this.require(id);
    const from = opts.tail
      ? rec.output.tailOffset(opts.maxChars)
      : (opts.offset ?? rec.cursors.get(scope) ?? 0);
    const slice = rec.output.read(from, opts.maxChars);
    rec.cursors.set(scope, slice.nextOffset);
    rec.job.outputRead = true;
    if (rec.job.status !== 'running' && rec.job.owner.scope === scope) rec.ownerInformed = true;
    rec.trace?.runtime({
      event: 'job',
      phase: 'read',
      jobId: rec.job.id,
      scope,
      offset: slice.offset,
      chars: slice.nextOffset - slice.offset,
      finished: rec.job.status !== 'running',
    });
    return { job: this.snapshot(rec), slice };
  }

  /** Offset desde el que leería `scope` si no indica uno. */
  cursor(id: string, scope: string): number {
    return this.require(id).cursors.get(scope) ?? 0;
  }

  /**
   * Espera, sin sondear, a que el job termine (`until: 'end'`) o a que haya
   * salida más allá de `offset` (`until: 'output'`; el final también la
   * despierta). Vuelve al vencer `timeoutMs` o al abortar `signal`; nunca rechaza.
   */
  async waitFor(
    id: string,
    opts: { until: 'end' | 'output'; offset?: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<void> {
    const rec = this.records.get(normalizeJobId(id));
    if (!rec) return;
    const satisfied = (): boolean =>
      rec.job.status !== 'running' ||
      (opts.until === 'output' && rec.output.totalChars > (opts.offset ?? 0));
    if (satisfied() || opts.timeoutMs <= 0 || opts.signal?.aborted) return;

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        rec.waiters.delete(check);
        opts.signal?.removeEventListener('abort', done);
        resolve();
      };
      const check = (): void => {
        if (satisfied()) done();
      };
      const timer = setTimeout(done, opts.timeoutMs);
      rec.waiters.add(check);
      opts.signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** El dueño ya ha visto el estado final por sí mismo: no hace falta avisarle. */
  markSeen(id: string, scope: string): void {
    const rec = this.records.get(normalizeJobId(id));
    if (rec && rec.job.status !== 'running' && rec.job.owner.scope === scope) {
      rec.ownerInformed = true;
    }
  }

  // -------------------------------------------------------------------------
  // Notificación al agente
  // -------------------------------------------------------------------------

  /** ¿Hay jobs de `scope` terminados que su agente aún no conoce? */
  hasNotifications(scope: string): boolean {
    for (const rec of this.records.values()) {
      if (this.pendingFor(rec, scope)) return true;
    }
    return false;
  }

  /**
   * Los jobs de `scope` que terminaron y su agente aún no conoce. Se entregan
   * una sola vez: quien los recoge se compromete a contárselo al modelo.
   */
  takeNotifications(scope: string): JobNotification[] {
    const out: JobNotification[] = [];
    for (const rec of this.records.values()) {
      if (!this.pendingFor(rec, scope)) continue;
      out.push(this.notify(rec, scope));
    }
    return out;
  }

  /**
   * Como `takeNotifications`, pero de un solo job: lo usa la Runtime Inbox, que
   * ya sabe en qué orden terminó cada uno. `null` si no existe, sigue vivo, no
   * es de `scope` o su dueño ya lo conoce.
   */
  claimNotification(id: string, scope: string): JobNotification | null {
    const rec = this.records.get(normalizeJobId(id));
    if (!rec || !this.pendingFor(rec, scope)) return null;
    return this.notify(rec, scope);
  }

  private notify(rec: JobRecord, scope: string): JobNotification {
    rec.ownerInformed = true;
    const job = rec.job;
    const notification: JobNotification = {
      id: job.id,
      command: job.command,
      status: job.status as JobNotification['status'],
      exitCode: job.exitCode ?? null,
      endReason: job.endReason ?? 'exit',
      durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
      unreadChars: Math.max(0, rec.output.totalChars - (rec.cursors.get(scope) ?? 0)),
    };
    rec.trace?.runtime({
      event: 'job',
      phase: 'notified',
      jobId: job.id,
      status: job.status,
      scope,
    });
    return notification;
  }

  private pendingFor(rec: JobRecord, scope: string): boolean {
    return rec.job.status !== 'running' && rec.job.owner.scope === scope && !rec.ownerInformed;
  }

  // -------------------------------------------------------------------------
  // Cancelación y cierre
  // -------------------------------------------------------------------------

  /**
   * Cancela un job y espera a que su árbol de procesos haya terminado. Sobre
   * un job ya terminado no hace nada. `by` es el scope que lo pide (traza).
   */
  async cancel(
    id: string,
    by: string = MAIN_JOB_SCOPE,
    reason: JobEndReason = 'cancelled',
  ): Promise<BackgroundJob> {
    const rec = this.require(id);
    if (rec.job.status === 'running') {
      rec.cancelReason ??= reason;
      rec.trace?.runtime({ event: 'job', phase: 'cancel', jobId: rec.job.id, scope: by, reason });
      log.info('job cancel', { id: rec.job.id, by, reason });
      this.kill(rec);
      await rec.ended;
    }
    return this.snapshot(rec);
  }

  /** Termina un subagente: sus jobs vivos se cancelan (nadie quedaría para leerlos). */
  async closeScope(scope: string): Promise<void> {
    if (scope === MAIN_JOB_SCOPE) return;
    const running = [...this.records.values()].filter(
      (rec) => rec.job.status === 'running' && rec.job.owner.scope === scope,
    );
    await Promise.allSettled(running.map((rec) => this.cancel(rec.job.id, scope, 'scope-closed')));
  }

  /**
   * Cierre de la sesión: cancela todo lo vivo y espera a que muera. Nunca lanza.
   *
   * **Terminal.** El manager queda cerrado para siempre: `start()` rechaza con
   * `JobManagerClosedError` y no vuelve a registrarse. Lo ya terminado sigue
   * consultable (estado y salida). Llamarlo otra vez devuelve el mismo cierre.
   */
  shutdown(): Promise<void> {
    this.closed = true;
    this.shutdownPromise ??= this.closeAll();
    return this.shutdownPromise;
  }

  private async closeAll(): Promise<void> {
    try {
      // Un `start()` que ya había pasado la comprobación termina de nacer (o de
      // fallar) antes de cancelar: así su proceso entra en la lista de abajo.
      await Promise.allSettled([...this.starting]);
      const running = [...this.records.values()].filter((rec) => rec.job.status === 'running');
      await Promise.allSettled(
        running.map((rec) => this.cancel(rec.job.id, MAIN_JOB_SCOPE, 'session-closed')),
      );
    } finally {
      unregisterJobManager(this);
    }
  }

  /**
   * Último recurso, síncrono, para el `exit` del proceso: mata a la fuerza el
   * árbol de cada job vivo. No actualiza estado ni traza: ya no hay quien lo lea.
   */
  killAllSync(): void {
    for (const rec of this.records.values()) {
      if (rec.job.status !== 'running' || rec.job.pid === undefined) continue;
      killProcessTreeSync(rec.job.pid, rec.job.startedAt);
    }
  }

  /** §12.12: SIGTERM al árbol, SIGKILL tras el margen, y cierre forzado si ni así termina. */
  private kill(rec: JobRecord): void {
    if (rec.killing || rec.job.status !== 'running') return;
    rec.killing = true;
    const sub = rec.subprocess;
    const signalTree = (sig: NodeJS.Signals): Promise<void> =>
      signalProcessTree(sub?.pid, sig, () => sub?.kill(sig));
    rec.treeSignalled = signalTree('SIGTERM');
    this.timer(rec, this.killGraceMs, () => void signalTree('SIGKILL'));
    // Ni así salió el shell: se cierra el job igualmente, barriendo su árbol.
    this.timer(rec, this.killGraceMs + SETTLE_GRACE_MS, () => this.reap(rec));
  }

  private timer(rec: JobRecord, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      rec.timers.delete(t);
      fn();
    }, ms);
    rec.timers.add(t);
  }

  /** Cierre único de un job que llegó a arrancar. */
  private finish(rec: JobRecord, exitCode: number | null): void {
    if (rec.job.status !== 'running') return;
    if (!rec.killing) {
      this.finishRecord(rec, exitCode, this.reasonOf(rec));
      return;
    }
    this.reap(rec);
  }

  /**
   * Cierre de un job que matamos nosotros. Que el shell haya salido no dice que
   * su árbol también: el job no se da por terminado —ni `cancel()` ni
   * `shutdown()` vuelven— hasta que la orden de cierre está entregada y, en
   * Windows, hasta barrer los descendientes que `taskkill` no llegó a ver
   * (`sweepProcessDescendants`). Un tope acota la espera. El exit code es un
   * artefacto de la muerte (`taskkill /F` deja 1), no del comando: queda `null`.
   */
  private reap(rec: JobRecord): void {
    if (rec.reaping || rec.job.status !== 'running') return;
    rec.reaping = true;
    for (const t of rec.timers) clearTimeout(t);
    rec.timers.clear();
    const done = (): void => this.finishRecord(rec, null, this.reasonOf(rec));
    this.timer(rec, REAP_CAP_MS, done);
    const pid = rec.job.pid;
    void (rec.treeSignalled ?? Promise.resolve())
      .then(() => (pid === undefined ? 0 : sweepProcessDescendants(pid, rec.job.startedAt)))
      .then((swept) => {
        if (swept > 0) log.warn('job descendants swept', { id: rec.job.id, pid, swept });
      })
      .then(done, done);
  }

  private reasonOf(rec: JobRecord): JobEndReason {
    return rec.cancelReason ?? (rec.timedOut ? 'timeout' : 'exit');
  }

  private finishRecord(rec: JobRecord, exitCode: number | null, reason: JobEndReason): void {
    if (rec.job.status !== 'running') return;
    for (const t of rec.timers) clearTimeout(t);
    rec.timers.clear();

    const sub = rec.subprocess;
    if (sub) {
      // En POSIX el grupo puede conservar miembros aunque el shell haya salido
      // (un hijo que quedó atrás): se cierran aquí, que es su último dueño.
      if (process.platform !== 'win32' && sub.pid !== undefined) {
        void signalProcessTree(sub.pid, 'SIGKILL', () => undefined);
      }
      sub.stdout?.destroy();
      sub.stderr?.destroy();
    }
    rec.output.close();

    const job = rec.job;
    job.endedAt = Date.now();
    job.exitCode = exitCode;
    job.endReason = reason;
    job.status =
      reason === 'exit'
        ? exitCode === 0
          ? 'completed'
          : 'failed'
        : reason === 'timeout' || reason === 'spawn-error'
          ? 'failed'
          : 'cancelled';
    const durationMs = job.endedAt - job.startedAt;

    getExecAuditLog(this.config).write({
      timestamp: new Date(job.endedAt).toISOString(),
      ...(job.owner.sessionId ? { sessionId: job.owner.sessionId } : {}),
      target: 'local',
      command: job.command,
      cwd: job.cwd,
      status:
        reason === 'spawn-error'
          ? 'spawn_error'
          : reason === 'timeout'
            ? 'timeout'
            : job.status === 'cancelled'
              ? 'cancelled'
              : 'exited',
      exitCode,
      durationMs,
      truncated: rec.output.droppedChars > 0,
      background: true,
      jobId: job.id,
      ...(job.pid !== undefined ? { pid: job.pid } : {}),
    });
    rec.trace?.runtime({
      event: 'job',
      phase: 'ended',
      jobId: job.id,
      status: job.status,
      exitCode,
      reason,
      durationMs,
      stdoutBytes: rec.output.bytes.stdout,
      stderrBytes: rec.output.bytes.stderr,
      droppedChars: rec.output.droppedChars,
      outputRead: job.outputRead,
    });
    log.info('job ended', { id: job.id, status: job.status, exitCode, reason, durationMs });

    rec.resolveEnded();
    this.wake(rec);
    this.emit({ type: 'ended', job: this.snapshot(rec) });
    this.evictFinished();
  }

  /** Olvida los jobs terminados más antiguos pasado `maxRetained`. */
  private evictFinished(): void {
    const finished = [...this.records.values()].filter((rec) => rec.job.status !== 'running');
    for (const rec of finished.slice(0, Math.max(0, finished.length - this.limits.maxRetained))) {
      this.records.delete(rec.job.id);
    }
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private require(id: string): JobRecord {
    const rec = this.records.get(normalizeJobId(id));
    if (!rec) throw new JobNotFoundError(`No background job with id "${id}".`);
    return rec;
  }

  private wake(rec: JobRecord): void {
    for (const waiter of [...rec.waiters]) waiter();
  }

  private snapshot(rec: JobRecord): BackgroundJob {
    return {
      ...rec.job,
      owner: { ...rec.job.owner },
      stdoutBytes: rec.output.bytes.stdout,
      stderrBytes: rec.output.bytes.stderr,
      outputChars: rec.output.totalChars,
      droppedChars: rec.output.droppedChars,
    };
  }

  private emit(event: JobEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        log.debug('job listener threw', { err });
      }
    }
  }
}

/** `"#3"`, `" 3 "` y `3` son el mismo job. */
export function normalizeJobId(id: string | number): string {
  return String(id).trim().replace(/^#/, '');
}

/** Resuelve cuando el proceso existe; rechaza si no llegó a crearse. */
function spawned(subprocess: LocalSubprocess): Promise<void> {
  if (subprocess.pid !== undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    subprocess.once('spawn', () => resolve());
    subprocess.once('error', (err) => reject(err));
    void Promise.resolve(subprocess).then(
      (result) => {
        const r = result as { shortMessage?: string; message?: string };
        reject(new Error(r.shortMessage ?? r.message ?? 'spawn failed'));
      },
      (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}
