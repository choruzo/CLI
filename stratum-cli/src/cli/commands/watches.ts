import { createInterface } from 'readline';
import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import { fileDiscovery } from '../../client/discovery.js';
import { ProtocolError } from '../../ipc/codec.js';
import type {
  ProtocolWatch,
  ProtocolWatchArgs,
  ProtocolWatchCheck,
  ProtocolWatchCondition,
  Role,
} from '../../protocol/index.js';
import { WATCH_LIMITS } from '../../protocol/index.js';
import { locateLiveDaemon } from '../daemon-link.js';
import { askLine } from '../readline-prompt.js';
import { cliVersion } from '../version.js';
import { approver } from './approvals.js';
import { NOT_RUNNING_MESSAGE, describeError as describeBaseError } from './routines.js';

/**
 * M22 — `stratum watches list|checks|add|pause|resume|remove`: los vigilantes
 * del asistente (`watches.*` del Stratum Protocol). Cliente de `stratumd`:
 * nunca lee ni escribe `watches.json` y el daemon es la autoridad de lo que
 * vale (sus `INVALID_PARAMS` se enseñan tal cual). `list` y `checks` son
 * `observer`; `pause|resume|remove` solo restan (`operator`); `add` suma algo
 * que corre solo, así que enseña lo que crea, pregunta y solo entonces se
 * conecta como aprobador (la clave, por terminal).
 */

type Requester = Pick<StratumClient, 'request'>;

type WatchAddParams = {
  name: string;
  connector: string;
  check: string;
  args?: ProtocolWatchArgs;
  condition: ProtocolWatchCondition;
  intervalSec?: number;
  cooldownMinutes?: number;
  notifyResolved?: boolean;
};

/** Un error del protocolo en una línea clara, con los motivos propios de los vigilantes. */
export function describeError(err: unknown): string {
  if (err instanceof ProtocolError && err.code === 'UNAVAILABLE') {
    if (err.data?.reason === 'watches-disabled') return 'Watches are not enabled in this daemon.';
    if (err.data?.reason === 'read-only') {
      return 'The watches file is read-only: it comes from a newer Stratum or is damaged, so it cannot be modified.';
    }
  }
  return describeBaseError(err);
}

// ── Formato ─────────────────────────────────────────────────────────────────

/** La condición en una frase, en inglés. */
export function describeCondition(c: ProtocolWatchCondition): string {
  const quoted = (values: string[]) => values.map((v) => `"${v}"`).join(' or ');
  let text: string;
  switch (c.kind) {
    case 'state-is':
      text = `state is ${quoted(c.values)}`;
      break;
    case 'state-is-not':
      text = `state is not ${quoted(c.values)}`;
      break;
    case 'above':
      text = `value above ${c.threshold}`;
      break;
    case 'below':
      text = `value below ${c.threshold}`;
      break;
    case 'changes':
      text = 'state changes';
      break;
  }
  return c.forMinutes !== undefined && c.forMinutes > 0
    ? `${text} for at least ${c.forMinutes} min`
    : text;
}

/** Lista legible de los vigilantes. Pura: los datos son DTOs del protocolo. */
export function formatWatchesList(list: { watches: readonly ProtocolWatch[] }): string {
  if (list.watches.length === 0) return 'No watches.\n';
  const lines: string[] = [];
  for (const w of list.watches) {
    lines.push(`${w.id}  ${w.status}  ${w.name}`);
    const parts = [
      `${w.connector}/${w.check} ${JSON.stringify(w.args)} — ${describeCondition(w.condition)}`,
      `every ${w.intervalSec}s`,
      `cooldown ${w.cooldownMinutes} min`,
    ];
    if (w.notifyResolved) parts.push('notifies when resolved');
    if (w.firing) parts.push('firing');
    if (w.health === 'failing') parts.push('failing (cannot check)');
    if (w.health === 'suspended') parts.push('suspended');
    if (w.lastFiredAt !== null) parts.push(`last fired ${new Date(w.lastFiredAt).toISOString()}`);
    if (w.origin === 'agent') parts.push('by the assistant');
    lines.push(`    ${parts.join(' · ')}`);
  }
  return lines.join('\n') + '\n';
}

/** Las comprobaciones del catálogo, con sus argumentos. */
export function formatChecks(checks: readonly ProtocolWatchCheck[]): string {
  if (checks.length === 0) return 'No checks available.\n';
  const lines: string[] = [];
  for (const c of checks) {
    const name = c.connectorEnabled ? c.connectorName : `${c.connectorName}, disabled`;
    lines.push(
      `${c.connector}/${c.tool} (${name}) — ${c.summary} · min every ${c.minIntervalSec}s`,
    );
    for (const a of c.args) {
      const bits: string[] = [a.type];
      if (a.required) bits.push('required');
      if (a.enum && a.enum.length > 0) bits.push(`one of ${a.enum.join('|')}`);
      if (a.minimum !== undefined || a.maximum !== undefined) {
        bits.push(`${a.minimum ?? ''}..${a.maximum ?? ''}`);
      }
      lines.push(`    ${a.name}: ${bits.join(', ')} — ${a.description}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Lo que se va a crear, para decidir antes de dar la clave. */
export function formatWatchPreview(params: WatchAddParams, check: ProtocolWatchCheck): string {
  const interval =
    params.intervalSec === undefined
      ? `the check minimum (${check.minIntervalSec}s)`
      : `${params.intervalSec}s`;
  const lines = [
    `Watch "${params.name}"`,
    `  checks: ${params.connector}/${params.check} ${JSON.stringify(params.args ?? {})}`,
    `  fires when: ${describeCondition(params.condition)}`,
    `  every: ${interval}`,
    `  cooldown: ${params.cooldownMinutes ?? WATCH_LIMITS.defaultCooldownMinutes} min`,
    `  notifies when resolved: ${params.notifyResolved ? 'yes' : 'no'}`,
    'It will check on its own and notify you in Dot and Telegram; it runs nothing.',
  ];
  return lines.join('\n') + '\n';
}

// ── Opciones de `add` ───────────────────────────────────────────────────────

export interface WatchAddOptions {
  name?: string;
  connector?: string;
  check?: string;
  arg?: string[];
  stateIs?: string;
  stateIsNot?: string;
  above?: string;
  below?: string;
  changes?: boolean;
  for?: string;
  every?: string;
  cooldown?: string;
  notifyResolved?: boolean;
}

export type ParsedWatchAdd = { ok: true; params: WatchAddParams } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function parseNonNegativeInt(text: string, flag: string): number | string {
  if (!/^\d+$/.test(text.trim())) return `${flag} must be a whole number of minutes (0 or more).`;
  return Number(text.trim());
}

/** `90`, `90s`, `5m`, `1h` → segundos enteros. */
function parseDuration(text: string): number | string {
  const m = /^(\d+)\s*([smh]?)$/.exec(text.trim());
  if (!m) return '--every must look like 90, 90s, 5m or 1h.';
  const n = Number(m[1]);
  const seconds = n * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  if (seconds <= 0) return '--every must be greater than zero.';
  return seconds;
}

function parseStrictNumber(text: string, flag: string): number | string {
  const n = text.trim() === '' ? NaN : Number(text);
  return Number.isFinite(n) ? n : `${flag} must be a number.`;
}

function splitValues(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** Pura: de las opciones de la línea de comandos a los parámetros de `watches.add`. */
export function parseWatchAddOptions(
  opts: WatchAddOptions,
  checks: readonly ProtocolWatchCheck[],
): ParsedWatchAdd {
  if (!opts.name) return fail('--name is required.');
  if (!opts.connector) return fail('--connector is required.');
  if (!opts.check) return fail('--check is required.');

  const check = checks.find((c) => c.connector === opts.connector && c.tool === opts.check);
  if (!check) {
    const available = checks.map((c) => `${c.connector}/${c.tool}`).join(', ') || 'none';
    return fail(
      `Unknown check "${opts.connector}/${opts.check}". Available: ${available}. See "stratum watches checks".`,
    );
  }

  const args: ProtocolWatchArgs = {};
  for (const raw of opts.arg ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0) return fail(`--arg must look like key=value (got "${raw}").`);
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    const declared = check.args.find((a) => a.name === key);
    if (!declared) {
      const names = check.args.map((a) => a.name).join(', ') || 'none';
      return fail(`${opts.connector}/${opts.check} has no argument "${key}". Declared: ${names}.`);
    }
    if (declared.type === 'number' || declared.type === 'integer') {
      const n = value.trim() === '' ? NaN : Number(value);
      if (!Number.isFinite(n)) return fail(`Argument "${key}" must be a number (got "${value}").`);
      if (declared.type === 'integer' && !Number.isInteger(n)) {
        return fail(`Argument "${key}" must be a whole number (got "${value}").`);
      }
      args[key] = n;
    } else if (declared.type === 'boolean') {
      if (value !== 'true' && value !== 'false') {
        return fail(`Argument "${key}" must be true or false (got "${value}").`);
      }
      args[key] = value === 'true';
    } else {
      args[key] = value;
    }
  }

  const chosen = [
    opts.stateIs !== undefined,
    opts.stateIsNot !== undefined,
    opts.above !== undefined,
    opts.below !== undefined,
    opts.changes === true,
  ].filter(Boolean).length;
  if (chosen !== 1) {
    return fail(
      'Give exactly one condition: --state-is <v1,v2>, --state-is-not <v1,v2>, --above <n>, --below <n> or --changes.',
    );
  }

  let forMinutes: number | undefined;
  if (opts.for !== undefined) {
    const n = parseNonNegativeInt(opts.for, '--for');
    if (typeof n === 'string') return fail(n);
    forMinutes = n;
  }
  const withFor = <T extends object>(c: T) => (forMinutes === undefined ? c : { ...c, forMinutes });

  let condition: ProtocolWatchCondition;
  if (opts.stateIs !== undefined || opts.stateIsNot !== undefined) {
    const values = splitValues((opts.stateIs ?? opts.stateIsNot) as string);
    condition = withFor({
      kind: opts.stateIs !== undefined ? ('state-is' as const) : ('state-is-not' as const),
      values,
    });
  } else if (opts.above !== undefined || opts.below !== undefined) {
    const flag = opts.above !== undefined ? '--above' : '--below';
    const n = parseStrictNumber((opts.above ?? opts.below) as string, flag);
    if (typeof n === 'string') return fail(n);
    condition = withFor({
      kind: opts.above !== undefined ? ('above' as const) : ('below' as const),
      threshold: n,
    });
  } else {
    condition = withFor({ kind: 'changes' as const });
  }

  const params: WatchAddParams = {
    name: opts.name,
    connector: opts.connector,
    check: opts.check,
    condition,
  };
  if (Object.keys(args).length > 0) params.args = args;
  if (opts.every !== undefined) {
    const s = parseDuration(opts.every);
    if (typeof s === 'string') return fail(s);
    params.intervalSec = s;
  }
  if (opts.cooldown !== undefined) {
    const n = parseNonNegativeInt(opts.cooldown, '--cooldown');
    if (typeof n === 'string') return fail(n);
    params.cooldownMinutes = n;
  }
  if (opts.notifyResolved) params.notifyResolved = true;
  return { ok: true, params };
}

// ── Cuerpos de los subcomandos ──────────────────────────────────────────────

export interface WatchDeps {
  /** Conexión `observer`: `watches.list`. */
  observer: Requester;
  /** Conexión `operator`: `watches.pause|resume|remove`. */
  operator: Requester;
  /** Pide la autoridad de aprobador (la clave, por terminal); `null` si no hay. */
  approver: () => Promise<(Requester & { close?: () => void }) | null>;
  ask: (question: string) => Promise<string>;
  isTTY: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

const isYes = (answer: string) => ['y', 'yes'].includes(answer.trim().toLowerCase());

/**
 * El cuerpo de `add`, con las dependencias inyectadas para los tests.
 * @returns `false` si no se creó nada.
 */
export async function runAdd(deps: WatchDeps, opts: WatchAddOptions): Promise<boolean> {
  const { checks } = await deps.observer.request('watches.list', {});
  const parsed = parseWatchAddOptions(opts, checks);
  if (!parsed.ok) {
    deps.err(`${parsed.error}\n`);
    return false;
  }
  if (!deps.isTTY) {
    deps.err('Creating a watch needs an interactive terminal: the approver key is typed.\n');
    return false;
  }
  const { params } = parsed;
  const check = checks.find((c) => c.connector === params.connector && c.tool === params.check)!;
  deps.out(formatWatchPreview(params, check));
  const answer = await deps.ask(`Create watch "${params.name}"? [y/N] `);
  if (!isYes(answer)) {
    deps.err('Cancelled.\n');
    return false;
  }
  const authority = await deps.approver();
  if (!authority) return false;
  try {
    const { watch } = await authority.request('watches.add', params);
    deps.out(`Created watch ${watch.id} (${watch.name}).\n`);
    return true;
  } finally {
    authority.close?.();
  }
}

/** `pause` y `resume`: solo restan o devuelven lo ya aprobado, sin clave ni pregunta. */
async function runToggle(
  deps: WatchDeps,
  method: 'watches.pause' | 'watches.resume',
  id: string,
  past: string,
): Promise<boolean> {
  const { watch } = await deps.operator.request(method, { watchId: id });
  deps.out(`${past} ${watch.id} (${watch.name}).\n`);
  return true;
}

export const runPause = (deps: WatchDeps, id: string) =>
  runToggle(deps, 'watches.pause', id, 'Paused');
export const runResume = (deps: WatchDeps, id: string) =>
  runToggle(deps, 'watches.resume', id, 'Resumed');

/** `remove`: pide confirmación; sin terminal exige `--yes`. */
export async function runRemove(
  deps: WatchDeps,
  id: string,
  opts: { yes?: boolean } = {},
): Promise<boolean> {
  if (!opts.yes) {
    if (!deps.isTTY) {
      deps.err('Removing a watch without a terminal needs --yes.\n');
      return false;
    }
    const { watches } = await deps.observer.request('watches.list', {});
    const found = watches.find((w) => w.id === id);
    if (!found) {
      deps.err(`Unknown watch "${id}". Run "stratum watches list".\n`);
      return false;
    }
    const answer = await deps.ask(`Remove watch "${found.name}" (${id})? [y/N] `);
    if (!isYes(answer)) {
      deps.err('Cancelled.\n');
      return false;
    }
  }
  const { watch } = await deps.operator.request('watches.remove', { watchId: id });
  deps.out(`Removed ${watch.id} (${watch.name}).\n`);
  return true;
}

// ── Conexión real ───────────────────────────────────────────────────────────

async function connect(
  role: Extract<Role, 'observer' | 'operator'>,
): Promise<StratumClient | null> {
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum watches', version: cliVersion(), roles: [role] },
    reconnect: false,
    requestTimeoutMs: 20_000,
  });
  try {
    await client.connect();
  } catch (err) {
    process.stderr.write(`Cannot reach stratumd: ${describeError(err)}\n`);
    process.exitCode = 1;
    return null;
  }
  return client;
}

/** Prepara las dependencias reales, ejecuta `fn` y cierra lo abierto. */
async function withDeps(fn: (deps: WatchDeps) => Promise<boolean>): Promise<void> {
  const found = await locateLiveDaemon();
  if (found.status !== 'found') {
    process.stderr.write(`${NOT_RUNNING_MESSAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const observer = await connect('observer');
  if (!observer) return;
  let operator: StratumClient | null = null;
  try {
    const deps: WatchDeps = {
      observer,
      // El de operador solo se abre si se usa (`pause`, `resume`, `remove`).
      operator: {
        request: async (method, params) => {
          operator ??= await connect('operator');
          if (!operator) throw new Error('Cannot reach stratumd.');
          return operator.request(method, params);
        },
      },
      approver: () => approver('stratum watches'),
      ask: async (question) => {
        // El readline solo mientras se pregunta: abierto, se quedaría con el Ctrl+C.
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return (await askLine(rl, question)) ?? '';
        } finally {
          rl.close();
        }
      },
      isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    };
    if (!(await fn(deps))) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`${describeError(err)}\n`);
    process.exitCode = 1;
  } finally {
    observer.close();
    (operator as StratumClient | null)?.close();
  }
}

const list = new Command('list')
  .description('List the watches of the assistant')
  .option('--json', 'machine-readable output: protocol DTOs')
  .action((opts: { json?: boolean }) =>
    withDeps(async (deps) => {
      const result = await deps.observer.request('watches.list', {});
      deps.out(opts.json ? JSON.stringify(result, null, 2) + '\n' : formatWatchesList(result));
      if (result.readOnly && !opts.json) {
        deps.err(
          'The watches file is read-only (newer Stratum or damaged): it cannot be modified.\n',
        );
      }
      return true;
    }),
  );

const checks = new Command('checks')
  .description('List the checks a watch can be declared on, with their arguments')
  .option('--json', 'machine-readable output: protocol DTOs')
  .action((opts: { json?: boolean }) =>
    withDeps(async (deps) => {
      const result = await deps.observer.request('watches.list', {});
      deps.out(
        opts.json ? JSON.stringify(result.checks, null, 2) + '\n' : formatChecks(result.checks),
      );
      return true;
    }),
  );

const collect = (value: string, previous: string[]) => [...previous, value];

const add = new Command('add')
  .description('Create a watch (asks for the approver key)')
  .option('--name <text>', 'name of the watch')
  .option('--connector <id>', 'connector id, as "checks" shows it')
  .option('--check <tool>', 'check (tool) of the connector')
  .option('--arg <key=value>', 'fixed argument of the check (repeatable)', collect, [] as string[])
  .option('--state-is <values>', 'fires when the state is one of these (comma-separated)')
  .option('--state-is-not <values>', 'fires when the state is none of these (comma-separated)')
  .option('--above <n>', 'fires when the value is above n')
  .option('--below <n>', 'fires when the value is below n')
  .option('--changes', 'fires when the state changes')
  .option('--for <min>', 'the condition must hold for at least this many minutes')
  .option('--every <dur>', 'interval between checks: 90, 90s, 5m, 1h')
  .option('--cooldown <min>', 'minimum minutes between two alerts')
  .option('--notify-resolved', 'also notify when the condition clears')
  .action((opts: WatchAddOptions) => withDeps((deps) => runAdd(deps, opts)));

const pause = new Command('pause')
  .description('Pause a watch')
  .argument('<id>', 'watch id, as "list" shows it')
  .action((id: string) => withDeps((deps) => runPause(deps, id)));

const resume = new Command('resume')
  .description('Resume a paused watch')
  .argument('<id>', 'watch id, as "list" shows it')
  .action((id: string) => withDeps((deps) => runResume(deps, id)));

const remove = new Command('remove')
  .description('Remove a watch')
  .argument('<id>', 'watch id, as "list" shows it')
  .option('--yes', 'do not ask for confirmation')
  .action((id: string, opts: { yes?: boolean }) => withDeps((deps) => runRemove(deps, id, opts)));

export const watchesCommand = new Command('watches')
  .description('Manage the watches of the assistant (it checks on its own and notifies you)')
  .addCommand(list)
  .addCommand(checks)
  .addCommand(add)
  .addCommand(pause)
  .addCommand(resume)
  .addCommand(remove);
