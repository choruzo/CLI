import { createInterface } from 'readline';
import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import { fileDiscovery } from '../../client/discovery.js';
import type { ProtocolConnector, ProtocolConnectorsList, Role } from '../../protocol/index.js';
import { locateLiveDaemon } from '../daemon-link.js';
import { askLine } from '../readline-prompt.js';
import { cliVersion } from '../version.js';
import { approver } from './approvals.js';
import { NOT_RUNNING_MESSAGE, describeError } from './routines.js';

/**
 * M20 — `stratum connectors list|enable|disable`: los conectores del asistente
 * (`connectors.*` del Stratum Protocol). Cliente de `stratumd`: nunca lee ni
 * escribe `connectors.json`. `list` es `observer`; `disable` solo resta
 * (`operator`); `enable` suma capacidad, así que enseña lo que activa, pregunta
 * y solo entonces se conecta como aprobador (la clave, por terminal).
 */

export { describeError };

const BOX_LABEL: Record<ProtocolConnectorsList['box']['state'], string> = {
  unavailable: 'unavailable',
  absent: 'not created',
  stopped: 'stopped',
  running: 'running',
};

function toolLines(c: ProtocolConnector): string[] {
  const lines = c.tools.map(
    (t) => `    ${t.name} [${t.readOnly ? 'read-only' : 'asks approval'}] ${t.summary}`,
  );
  for (const n of c.needs) lines.push(`    needs: ${n.name} (${n.description})`);
  return lines;
}

/** Lista legible de los conectores. Pura: los datos son DTOs del protocolo. */
export function formatConnectorsList(list: ProtocolConnectorsList): string {
  const lines: string[] = [];
  if (list.connectors.length === 0) lines.push('No connectors.');
  for (const c of list.connectors) {
    lines.push(`${c.id}  ${c.enabled ? 'enabled' : 'disabled'}  ${c.name} — ${c.description}`);
    lines.push(...toolLines(c));
  }
  const reason = list.box.reason ? ` (${list.box.reason})` : '';
  lines.push(`Connectors box: ${BOX_LABEL[list.box.state]}${reason}`);
  if (list.connectors.some((c) => c.enabled) && list.box.state !== 'running') {
    lines.push(
      'Enabled connectors are not offered to the assistant until the box runs ("stratum box start").',
    );
  }
  return lines.join('\n') + '\n';
}

/** Lo que se va a activar, para decidir antes de dar la clave. */
export function formatConnectorPreview(c: ProtocolConnector): string {
  const lines = [`${c.name} (${c.id} ${c.version}) — ${c.description}`];
  if (c.hosts.length > 0) lines.push(`  connects to: ${c.hosts.join(', ')}`);
  lines.push('  tools:');
  for (const t of c.tools) {
    lines.push(`    ${t.name} [${t.readOnly ? 'read-only' : 'asks approval'}] ${t.summary}`);
  }
  for (const n of c.needs) lines.push(`  needs: ${n.name} (${n.description})`);
  return lines.join('\n') + '\n';
}

type Requester = Pick<StratumClient, 'request'>;

export interface ConnectorDeps {
  /** Conexión `observer`: `connectors.list`. */
  observer: Requester;
  /** Conexión `operator`: `connectors.disable`. */
  operator: Requester;
  /** Pide la autoridad de aprobador (la clave, por terminal); `null` si no hay. */
  approver: () => Promise<(Requester & { close?: () => void }) | null>;
  ask: (question: string) => Promise<string>;
  isTTY: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * El cuerpo de `enable`, con las dependencias inyectadas para los tests.
 * @returns `false` si no se activó nada (o ya estaba activo no cuenta como fallo).
 */
export async function runEnable(deps: ConnectorDeps, id: string): Promise<boolean> {
  const list = await deps.observer.request('connectors.list', {});
  const connector = list.connectors.find((c) => c.id === id);
  if (!connector) {
    deps.err(`Unknown connector "${id}". Run "stratum connectors list".\n`);
    return false;
  }
  if (!deps.isTTY) {
    deps.err('Enabling a connector needs an interactive terminal: the approver key is typed.\n');
    return false;
  }
  deps.out(formatConnectorPreview(connector));
  const answer = (await deps.ask(`Enable connector "${connector.name}" for the assistant? [y/N] `))
    .trim()
    .toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    deps.err('Cancelled.\n');
    return false;
  }
  const authority = await deps.approver();
  if (!authority) return false;
  try {
    const { changed } = await authority.request('connectors.enable', { connectorId: id });
    deps.out(
      changed
        ? `Enabled ${connector.name}. The assistant will have it from its next message.\n`
        : `${connector.name} was already enabled.\n`,
    );
    return true;
  } finally {
    authority.close?.();
  }
}

/** El cuerpo de `disable`: solo resta, sin clave ni pregunta. */
export async function runDisable(deps: ConnectorDeps, id: string): Promise<boolean> {
  const list = await deps.observer.request('connectors.list', {});
  const connector = list.connectors.find((c) => c.id === id);
  if (!connector) {
    deps.err(`Unknown connector "${id}". Run "stratum connectors list".\n`);
    return false;
  }
  const { changed } = await deps.operator.request('connectors.disable', { connectorId: id });
  deps.out(changed ? `Disabled ${connector.name}.\n` : `${connector.name} was not enabled.\n`);
  return true;
}

async function connect(
  role: Extract<Role, 'observer' | 'operator'>,
): Promise<StratumClient | null> {
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum connectors', version: cliVersion(), roles: [role] },
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
async function withDeps(fn: (deps: ConnectorDeps) => Promise<boolean>): Promise<void> {
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
    const deps: ConnectorDeps = {
      observer,
      // El de operador solo se abre si se usa (`disable`).
      operator: {
        request: async (method, params) => {
          operator ??= await connect('operator');
          if (!operator) throw new Error('Cannot reach stratumd.');
          return operator.request(method, params);
        },
      },
      approver: () => approver('stratum connectors'),
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
  .description('List the connectors of the assistant and whether each is enabled')
  .option('--json', 'machine-readable output: protocol DTOs')
  .action(async (opts: { json?: boolean }) => {
    const found = await locateLiveDaemon();
    if (found.status !== 'found') {
      process.stderr.write(`${NOT_RUNNING_MESSAGE}\n`);
      process.exitCode = 1;
      return;
    }
    const client = await connect('observer');
    if (!client) return;
    try {
      const result = await client.request('connectors.list', {});
      process.stdout.write(
        opts.json ? JSON.stringify(result, null, 2) + '\n' : formatConnectorsList(result),
      );
      if (result.readOnly && !opts.json) {
        process.stderr.write('The connectors file is read-only: it cannot be modified.\n');
      }
    } catch (err) {
      process.stderr.write(`${describeError(err)}\n`);
      process.exitCode = 1;
    } finally {
      client.close();
    }
  });

const enable = new Command('enable')
  .description('Enable a connector for the assistant (asks for the approver key)')
  .argument('<id>', 'connector id, as "list" shows it')
  .action((id: string) => withDeps((deps) => runEnable(deps, id)));

const disable = new Command('disable')
  .description('Disable a connector')
  .argument('<id>', 'connector id, as "list" shows it')
  .action((id: string) => withDeps((deps) => runDisable(deps, id)));

export const connectorsCommand = new Command('connectors')
  .description('Manage the connectors of the assistant (services it can reach from its box)')
  .addCommand(list)
  .addCommand(enable)
  .addCommand(disable);
