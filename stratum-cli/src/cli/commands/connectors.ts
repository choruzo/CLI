import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import { defaultEndpointDir, fileDiscovery } from '../../client/discovery.js';
import { bundledCatalog } from '../../connectors/active.js';
import type { ConnectorCatalog } from '../../connectors/catalog.js';
import type { ConnectorManifest, ConnectorOAuth } from '../../connectors/manifest.js';
import {
  OAuthError,
  authorizeGoogle,
  parseGoogleClientJson,
  type GoogleOAuthResult,
} from '../../connectors/oauth-google.js';
import { openInBrowser } from '../../trace/open-browser.js';
import {
  ConnectorSecretsError,
  clearConnectorSecrets,
  readConnectorSecrets,
  secretValueProblem,
  secretsStatusOf,
  setConnectorSecrets,
} from '../../connectors/secrets.js';
import type { ProtocolConnector, ProtocolConnectorsList, Role } from '../../protocol/index.js';
import { locateLiveDaemon } from '../daemon-link.js';
import { askLine } from '../readline-prompt.js';
import { cliVersion } from '../version.js';
import { approver, askSecret } from './approvals.js';
import { NOT_RUNNING_MESSAGE, describeError } from './routines.js';

/**
 * M20 — `stratum connectors list|enable|disable`: los conectores del asistente
 * (`connectors.*` del Stratum Protocol). Cliente de `stratumd`: nunca lee ni
 * escribe `connectors.json`. `list` es `observer`; `disable` solo resta
 * (`operator`); `enable` suma capacidad, así que enseña lo que activa, pregunta
 * y solo entonces se conecta como aprobador (la clave, por terminal).
 *
 * `setup` (fase 4) es la excepción: no habla con el daemon. Como
 * `channels telegram setup`, pide los secretos por terminal (sin eco) y los
 * escribe en `~/.stratum/daemon/connector-secrets.json`; el daemon los lee al
 * empezar el siguiente turno. Un secreto nunca pasa por el protocolo.
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
  for (const n of c.needs) {
    lines.push(`    needs: ${n.name} (${n.description})${n.configured ? ' [set]' : ' [missing]'}`);
  }
  if (c.needs.some((n) => !n.configured)) {
    lines.push(`    set it up with "stratum connectors setup ${c.id}"`);
  }
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
  for (const n of c.needs) {
    lines.push(`  needs: ${n.name} (${n.description})${n.configured ? ' [set]' : ' [missing]'}`);
  }
  if (c.needs.some((n) => !n.configured)) {
    lines.push(`  it will not run until you set it up: "stratum connectors setup ${c.id}"`);
  }
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

export interface SecretDeps {
  /** Carpeta privada del daemon (`connector-secrets.json`). */
  dir: string;
  catalog: ConnectorCatalog;
  /** Pide sin eco; `null` si se cancela. */
  askHidden: (prompt: string) => Promise<string | null>;
  /** Pide con eco (lo que no es secreto, como una URL); `null` si se cancela. */
  askVisible: (prompt: string) => Promise<string | null>;
  isTTY: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  /** M21: la autorización OAuth en el navegador (`authorizeGoogle`). */
  authorize?: (p: {
    clientId: string;
    clientSecret: string;
    scopes: readonly string[];
  }) => Promise<GoogleOAuthResult>;
  /** M21: lee el JSON del cliente que descargó la persona (`--client-file`). */
  readFile?: (path: string) => string;
}

/**
 * M21 — el `setup` de un conector OAuth: el cliente (del JSON de Google con
 * `--client-file`, o tecleado; vacío conserva el guardado), la autorización en
 * el navegador y, solo si todo sale bien, los tres secretos de una vez. Un
 * fallo no cambia nada de lo guardado.
 */
async function runOAuthSetup(
  deps: SecretDeps,
  manifest: ConnectorManifest,
  oauth: ConnectorOAuth,
  opts: { clientFile?: string },
): Promise<boolean> {
  if (!deps.isTTY || !deps.authorize) {
    deps.err(
      `Setting up ${manifest.name} needs an interactive terminal and a browser on this computer.\n`,
    );
    return false;
  }
  const stored = readConnectorSecrets(deps.dir);
  const current = stored.state === 'ok' ? (stored.file.connectors[manifest.id] ?? {}) : {};
  let clientId = current[oauth.clientId] ?? '';
  let clientSecret = current[oauth.clientSecret] ?? '';
  if (opts.clientFile !== undefined) {
    let text: string;
    try {
      text = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(opts.clientFile);
    } catch {
      deps.err(`Cannot read ${opts.clientFile}.\n`);
      return false;
    }
    try {
      ({ clientId, clientSecret } = parseGoogleClientJson(text));
    } catch (err) {
      deps.err(`${(err as Error).message}\n`);
      return false;
    }
    deps.out(`OAuth client read from the file: ${clientId}\n`);
  } else {
    deps.out(
      `${manifest.name} uses your own OAuth client ("Desktop app") from Google Cloud. Tip: "--client-file <downloaded JSON>" reads it without typing.\n`,
    );
    const keep = (has: string) => (has ? ' (empty keeps the current one)' : '');
    const id = await deps.askVisible(`${oauth.clientId}${keep(clientId)}: `);
    if (id === null) {
      deps.err('Cancelled. Nothing changed.\n');
      return false;
    }
    if (id.trim()) clientId = id.trim();
    const secret = await deps.askHidden(`${oauth.clientSecret}${keep(clientSecret)}: `);
    if (secret === null) {
      deps.err('Cancelled. Nothing changed.\n');
      return false;
    }
    if (secret.trim()) clientSecret = secret.trim();
  }
  for (const [name, value] of [
    [oauth.clientId, clientId],
    [oauth.clientSecret, clientSecret],
  ] as const) {
    const problem = value ? secretValueProblem(value) : 'it is missing';
    if (problem) {
      deps.err(`${name} is not valid: ${problem}. Nothing changed.\n`);
      return false;
    }
  }
  let result: GoogleOAuthResult;
  try {
    result = await deps.authorize({ clientId, clientSecret, scopes: oauth.scopes });
  } catch (err) {
    if (err instanceof OAuthError) {
      deps.err(`${err.message} Nothing changed.\n`);
      return false;
    }
    throw err;
  }
  const path = setConnectorSecrets(deps.dir, manifest, {
    [oauth.clientId]: clientId,
    [oauth.clientSecret]: clientSecret,
    [oauth.refreshToken]: result.refreshToken,
  });
  deps.out(`Authorized. Saved in ${path} (never shown again).\n`);
  deps.out(
    `Ready: if ${manifest.name} is enabled, the assistant uses it from its next message (otherwise, "stratum connectors enable ${manifest.id}").\n`,
  );
  return true;
}

/**
 * El cuerpo de `setup`: pide lo que necesita el conector `id` y lo guarda.
 * Nunca escribe un valor en la salida. Una respuesta vacía conserva el que
 * había. Con `clear`, borra los suyos (sin terminal: solo resta).
 * @returns `false` si no se guardó nada.
 */
export async function runSecret(
  deps: SecretDeps,
  id: string,
  opts: { name?: string; clear?: boolean; clientFile?: string } = {},
): Promise<boolean> {
  const entry = deps.catalog.get(id);
  if (!entry) {
    deps.err(`Unknown connector "${id}". Run "stratum connectors list".\n`);
    return false;
  }
  const { manifest } = entry;
  if (manifest.secrets.length === 0) {
    deps.err(`${manifest.name} does not need any setup.\n`);
    return false;
  }
  const wanted = opts.name
    ? manifest.secrets.filter((s) => s.name === opts.name)
    : manifest.secrets;
  if (wanted.length === 0) {
    const uses = manifest.secrets.map((s) => s.name).join(', ');
    deps.err(`${manifest.name} does not use "${opts.name}". It uses: ${uses}.\n`);
    return false;
  }
  try {
    if (opts.clear) {
      const removed = clearConnectorSecrets(deps.dir, id, opts.name);
      deps.out(removed ? `Removed the setup of ${manifest.name}.\n` : 'Nothing to remove.\n');
      return removed;
    }
    if (manifest.oauth) {
      if (opts.name) {
        deps.err(`${manifest.name} is set up as a whole: run it without --name.\n`);
        return false;
      }
      return await runOAuthSetup(deps, manifest, manifest.oauth, opts);
    }
    if (opts.clientFile !== undefined) {
      deps.err(`${manifest.name} does not use an OAuth client: --client-file does not apply.\n`);
      return false;
    }
    if (!deps.isTTY) {
      deps.err(
        'Setting up a connector needs an interactive terminal: secrets are never read from a pipe, a flag or the environment.\n',
      );
      return false;
    }
    const missing = new Set(secretsStatusOf(manifest, readConnectorSecrets(deps.dir)).missing);
    deps.out(
      `${manifest.name} needs this. It is stored only in the private daemon folder and never shown again.\n`,
    );
    const values: Record<string, string> = {};
    for (const s of wanted) {
      const keep = missing.has(s.name) ? '' : ' (empty keeps the current one)';
      deps.out(`${s.name}: ${s.description}${keep}\n`);
      const ask = s.sensitive === false ? deps.askVisible : deps.askHidden;
      const raw = await ask(`${s.name}: `);
      if (raw === null) {
        deps.err('Cancelled. Nothing changed.\n');
        return false;
      }
      const value = raw.trim();
      if (value === '') continue;
      const problem = secretValueProblem(value);
      if (problem) {
        deps.err(`That value of ${s.name} is not valid: ${problem}. Nothing changed.\n`);
        return false;
      }
      values[s.name] = value;
    }
    if (Object.keys(values).length === 0) {
      deps.out('Nothing changed.\n');
      return false;
    }
    const path = setConnectorSecrets(deps.dir, manifest, values);
    const stillMissing = secretsStatusOf(manifest, readConnectorSecrets(deps.dir)).missing;
    deps.out(`Saved ${Object.keys(values).join(', ')} in ${path}.\n`);
    deps.out(
      stillMissing.length > 0
        ? `Still missing: ${stillMissing.join(', ')}.\n`
        : `Ready: if ${manifest.name} is enabled, the assistant uses it from its next message (otherwise, "stratum connectors enable ${id}").\n`,
    );
    return true;
  } catch (err) {
    if (err instanceof ConnectorSecretsError) {
      deps.err(`${err.message}\n`);
      return false;
    }
    throw err;
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

const setup = new Command('setup')
  .description('Set up what a connector needs (tokens, URLs), asked in the terminal without echo')
  .argument('<id>', 'connector id, as "list" shows it')
  .option('--name <NAME>', 'only this one (e.g. HA_TOKEN)')
  .option('--clear', 'remove what is stored for this connector (or only --name)')
  .option(
    '--client-file <path>',
    'OAuth connectors (google): read the client from the JSON downloaded from Google Cloud',
  )
  .action(async (id: string, opts: { name?: string; clear?: boolean; clientFile?: string }) => {
    const err = (text: string) => process.stderr.write(text);
    const ok = await runSecret(
      {
        dir: defaultEndpointDir(),
        catalog: bundledCatalog(),
        askHidden: askSecret,
        askVisible: async (prompt) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return await askLine(rl, prompt);
          } finally {
            rl.close();
          }
        },
        isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
        out: err,
        err,
        authorize: (p) => authorizeGoogle({ ...p, openBrowser: openInBrowser, out: err }),
      },
      id,
      opts,
    );
    if (!ok) process.exitCode = 1;
  });

export const connectorsCommand = new Command('connectors')
  .description('Manage the connectors of the assistant (services it can reach from its box)')
  .addCommand(list)
  .addCommand(enable)
  .addCommand(disable)
  .addCommand(setup);
