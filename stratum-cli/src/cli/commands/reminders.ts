import { Command } from 'commander';
import { StratumClient, type StratumClientOptions } from '../../client/client.js';
import { fileDiscovery } from '../../client/discovery.js';
import { ProtocolError } from '../../ipc/codec.js';
import type { ProtocolReminder, Role } from '../../protocol/index.js';
import { locateLiveDaemon } from '../daemon-link.js';
import { cliVersion } from '../version.js';
import { formatLocalTime, NOT_RUNNING_MESSAGE } from './routines.js';

/**
 * M21 — `stratum reminders list|cancel`: los recordatorios del asistente
 * (`reminders.*` del Stratum Protocol). Es un cliente más de `stratumd`: nunca
 * lee ni escribe `reminders.json`, y los crea el agente con su tool (no hay
 * `reminders.add` en v1). Rol `observer` para `list`, `operator` para cancelar.
 */

/** `PENDING`/`DELIVERED`/`CANCELLED`, en una columna. */
function statusLabel(reminder: ProtocolReminder): string {
  if (reminder.status === 'pending') return 'pending';
  const at = reminder.endedAt;
  const late = reminder.late ? ' late' : '';
  return at === undefined
    ? `${reminder.status}${late}`
    : `${reminder.status}${late} ${formatLocalTime(at)}`;
}

/** Tabla de recordatorios. Pura: los datos son DTOs del protocolo. */
export function formatRemindersTable(reminders: readonly ProtocolReminder[]): string {
  if (reminders.length === 0) return 'No reminders.\n';
  const rows = [
    ['ID', 'STATUS', 'DUE', 'TEXT'],
    ...reminders.map((r) => [
      r.id,
      statusLabel(r),
      formatLocalTime(r.dueAt),
      r.text.replace(/\s+/g, ' '),
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

/** Un error del protocolo en una línea clara (los del almacén llegan con `issues`). */
export function describeReminderError(err: unknown): string {
  if (err instanceof ProtocolError) {
    const issues = Array.isArray(err.data?.issues)
      ? (err.data.issues as { path?: string; message?: string }[])
      : [];
    if (issues.length > 0) {
      return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : String(i.message))).join('; ');
    }
    if (err.code === 'UNAVAILABLE' && err.data?.reason === 'reminders-disabled') {
      return 'Reminders are disabled in this daemon (no scheduler).';
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
  const options: StratumClientOptions = {
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum reminders', version: cliVersion(), roles: [role] },
    reconnect: false,
    requestTimeoutMs: 20_000,
  };
  const client = new StratumClient(options);
  try {
    await client.connect();
  } catch (err) {
    process.stderr.write(`Cannot reach stratumd: ${describeReminderError(err)}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    await fn(client);
  } catch (err) {
    process.stderr.write(`${describeReminderError(err)}\n`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

const list = new Command('list')
  .description('List the reminders of the assistant')
  .option('--json', 'machine-readable output: protocol DTOs')
  .action((opts: { json?: boolean }) =>
    withClient('observer', async (client) => {
      const result = await client.request('reminders.list', {});
      process.stdout.write(
        opts.json ? JSON.stringify(result, null, 2) + '\n' : formatRemindersTable(result.reminders),
      );
      if (result.readOnly && !opts.json) {
        process.stderr.write('The reminders file is read-only: it cannot be modified.\n');
      }
    }),
  );

const cancel = new Command('cancel')
  .description('Cancel a pending reminder')
  .argument('<id>', 'reminder id, as shown by `stratum reminders list`')
  .action((id: string) =>
    withClient('operator', async (client) => {
      const { reminder } = await client.request('reminders.cancel', { reminderId: id });
      process.stdout.write(`Cancelled reminder ${reminder.id}: ${reminder.text}\n`);
    }),
  );

export const remindersCommand = new Command('reminders')
  .description('Manage the reminders the assistant leaves for you (delivered by stratumd)')
  .addCommand(list)
  .addCommand(cancel);
