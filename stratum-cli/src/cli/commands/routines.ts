import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import { fileDiscovery } from '../../client/discovery.js';
import { ProtocolError } from '../../ipc/codec.js';
import type { ProtocolRoutine, ProtocolRoutineLimits, Role } from '../../protocol/index.js';
import { locateLiveDaemon } from '../daemon-link.js';
import { cliVersion } from '../version.js';

/**
 * M16 — `stratum routines list|add|rm|run|enable|disable`: las rutinas del
 * asistente (`routines.*` del Stratum Protocol). Es un cliente más de
 * `stratumd`: nunca lee ni escribe `routines.json`, y sin daemon no hace nada.
 * Rol `observer` para `list`, `operator` para mutar.
 */

export const NOT_RUNNING_MESSAGE = 'stratumd is not running. Start it with `stratum daemon start`.';

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm` en la hora local. */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Cuándo vence la próxima vez, o por qué no. */
export function nextLabel(r: ProtocolRoutine): string {
  if (!r.enabled) return 'disabled';
  if (r.scheduleError) return `invalid: ${clip(r.scheduleError, 30)}`;
  return r.nextFireAt === null ? '-' : formatLocalTime(r.nextFireAt);
}

/** El último resultado (o disparo fallido) en una palabra y una hora. */
export function lastLabel(r: ProtocolRoutine): string {
  if (r.running) return 'running';
  if (r.lastResult) {
    const at = r.lastResult.endedAt;
    return at === undefined ? r.lastResult.status : `${r.lastResult.status} ${formatLocalTime(at)}`;
  }
  if (r.lastFire && r.lastFire.outcome !== 'started') {
    return `${r.lastFire.outcome} ${formatLocalTime(r.lastFire.at)}`;
  }
  return '-';
}

/** Tabla de rutinas. Pura: los datos son DTOs del protocolo. */
export function formatRoutinesTable(routines: readonly ProtocolRoutine[]): string {
  if (routines.length === 0) return 'No routines.\n';
  const rows = [
    ['NAME', 'ID', 'SCHEDULE', 'ENABLED', 'NEXT', 'LAST'],
    ...routines.map((r) => [
      clip(r.name, 30),
      r.id,
      clip(r.schedule, 30),
      r.enabled ? 'yes' : 'no',
      nextLabel(r),
      lastLabel(r),
    ]),
  ];
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  return (
    rows
      .map((row) =>
        row
          .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!)))
          .join('  ')
          .trimEnd(),
      )
      .join('\n') + '\n'
  );
}

export type RoutineRef = { ok: true; routine: ProtocolRoutine } | { ok: false; error: string };

/** `<routine>` es el id o el nombre exacto (sin distinguir mayúsculas); el id gana al nombre. */
export function resolveRoutine(routines: readonly ProtocolRoutine[], ref: string): RoutineRef {
  const byId = routines.find((r) => r.id === ref);
  if (byId) return { ok: true, routine: byId };
  const key = ref.trim().toLowerCase();
  const byName = routines.filter((r) => r.name.trim().toLowerCase() === key);
  if (byName.length === 1) return { ok: true, routine: byName[0]! };
  if (byName.length > 1) {
    return { ok: false, error: `"${ref}" matches several routines; use the id.` };
  }
  return { ok: false, error: `No routine "${ref}". See \`stratum routines list\`.` };
}

/** Un error del protocolo en una línea clara. */
export function describeError(err: unknown): string {
  if (err instanceof ProtocolError) {
    const issues = Array.isArray(err.data?.issues)
      ? (err.data.issues as { path?: string; message?: string }[])
      : [];
    if (issues.length > 0) {
      return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : String(i.message))).join('; ');
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function withClient(
  role: Extract<Role, 'observer' | 'operator'>,
  fn: (client: StratumClient) => Promise<void>,
): Promise<void> {
  const found = await locateLiveDaemon();
  if (found.status !== 'found') {
    process.stderr.write(`${NOT_RUNNING_MESSAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum routines', version: cliVersion(), roles: [role] },
    reconnect: false,
    requestTimeoutMs: 20_000,
  });
  try {
    await client.connect();
  } catch (err) {
    process.stderr.write(`Cannot reach stratumd: ${describeError(err)}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    await fn(client);
  } catch (err) {
    process.stderr.write(`${describeError(err)}\n`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

/** Resuelve `<routine>` contra `routines.list`; imprime el error y devuelve `null` si no hay. */
async function resolveOnDaemon(
  client: StratumClient,
  ref: string,
): Promise<ProtocolRoutine | null> {
  const { routines } = await client.request('routines.list', {});
  const found = resolveRoutine(routines, ref);
  if (!found.ok) {
    process.stderr.write(`${found.error}\n`);
    process.exitCode = 1;
    return null;
  }
  return found.routine;
}

function positiveInt(label: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  return Number(value);
}

const list = new Command('list')
  .description('List the routines of the assistant')
  .option('--json', 'machine-readable output: protocol DTOs')
  .action((opts: { json?: boolean }) =>
    withClient('observer', async (client) => {
      const result = await client.request('routines.list', {});
      process.stdout.write(
        opts.json ? JSON.stringify(result, null, 2) + '\n' : formatRoutinesTable(result.routines),
      );
      if (result.readOnly && !opts.json) {
        process.stderr.write('The routines file is read-only: it cannot be modified.\n');
      }
    }),
  );

interface AddOptions {
  name: string;
  schedule: string;
  prompt: string;
  model?: string;
  maxIterations?: string;
  timeoutMinutes?: string;
  disabled?: boolean;
}

const add = new Command('add')
  .description('Add a routine')
  .requiredOption('--name <name>', 'unique name')
  .requiredOption('--schedule <schedule>', 'for example "30m", "every day at 09:00"')
  .requiredOption('--prompt <prompt>', 'what the assistant does each time')
  .option('--model <model>', 'model for the routine (default: the assistant one)')
  .option('--max-iterations <n>', 'iteration cap of each run')
  .option('--timeout-minutes <n>', 'cancel a run that lasts longer than this')
  .option('--disabled', 'create it disabled')
  .action((opts: AddOptions) =>
    withClient('operator', async (client) => {
      const limits: ProtocolRoutineLimits = {};
      if (opts.maxIterations !== undefined) {
        limits.maxIterations = positiveInt('--max-iterations', opts.maxIterations);
      }
      if (opts.timeoutMinutes !== undefined) {
        limits.timeoutMinutes = positiveInt('--timeout-minutes', opts.timeoutMinutes);
      }
      const { routine } = await client.request('routines.add', {
        name: opts.name,
        schedule: opts.schedule,
        prompt: opts.prompt,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.disabled ? { enabled: false } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
      });
      process.stdout.write(
        `Added routine "${routine.name}" (${routine.id}). Next: ${nextLabel(routine)}\n`,
      );
    }),
  );

const rm = new Command('rm')
  .description('Remove a routine and its session')
  .argument('<routine>', 'id or name')
  .action((ref: string) =>
    withClient('operator', async (client) => {
      const routine = await resolveOnDaemon(client, ref);
      if (!routine) return;
      await client.request('routines.remove', { routineId: routine.id });
      process.stdout.write(`Removed routine "${routine.name}" (${routine.id}).\n`);
    }),
  );

const run = new Command('run')
  .description('Run a routine now, even if it is disabled')
  .argument('<routine>', 'id or name')
  .action((ref: string) =>
    withClient('operator', async (client) => {
      const routine = await resolveOnDaemon(client, ref);
      if (!routine) return;
      const { fire } = await client.request('routines.run', { routineId: routine.id });
      if (fire.outcome === 'started') {
        process.stdout.write(`Started "${routine.name}" (session ${fire.sessionId}).\n`);
        return;
      }
      process.stderr.write(
        `"${routine.name}" did not start: ${fire.outcome}${fire.error ? ` (${fire.error})` : ''}\n`,
      );
      process.exitCode = 1;
    }),
  );

function toggle(enabled: boolean): Command {
  const verb = enabled ? 'enable' : 'disable';
  return new Command(verb)
    .description(`${enabled ? 'Enable' : 'Disable'} a routine`)
    .argument('<routine>', 'id or name')
    .action((ref: string) =>
      withClient('operator', async (client) => {
        const routine = await resolveOnDaemon(client, ref);
        if (!routine) return;
        const { routine: updated } = await client.request('routines.update', {
          routineId: routine.id,
          patch: { enabled },
        });
        process.stdout.write(
          `${enabled ? 'Enabled' : 'Disabled'} "${updated.name}" (${updated.id}). Next: ${nextLabel(updated)}\n`,
        );
      }),
    );
}

export const routinesCommand = new Command('routines')
  .description('Manage the routines of the assistant (run by stratumd on a schedule)')
  .addCommand(list)
  .addCommand(add)
  .addCommand(rm)
  .addCommand(run)
  .addCommand(toggle(true))
  .addCommand(toggle(false));
