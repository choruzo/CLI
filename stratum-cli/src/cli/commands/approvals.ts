import { Command } from 'commander';
import { createInterface } from 'readline';
import { StratumClient } from '../../client/client.js';
import { defaultEndpointDir, fileDiscovery } from '../../client/discovery.js';
import { APPROVER_KEY_MIN_CHARS, writeApproverKey } from '../../daemon/approver-key.js';
import { ProtocolError } from '../../ipc/codec.js';
import type {
  ProtocolApproval,
  ProtocolPlanRequest,
  ProtocolQuestionAnswer,
  ProtocolQuestionRequest,
} from '../../protocol/index.js';
import { askLine } from '../readline-prompt.js';
import { cliVersion } from '../version.js';

/**
 * `stratum approvals`: lo que las sesiones tienen pendiente de una persona
 * —aprobaciones, preguntas y planes—, y la forma de contestarlo desde otra
 * terminal. Es un cliente más del Stratum Protocol.
 *
 * Listar es de cualquiera que pueda observar. **Resolver** exige la capacidad
 * `approve`, y esa no la da el token del daemon: hay que teclear la clave de
 * aprobador (`stratum approvals set-key`). Se pide siempre por la terminal, con
 * el eco apagado; no hay flag ni variable de entorno que la sustituya, a
 * propósito: un comando lanzado por el agente no tiene terminal en la que
 * teclearla.
 */

type Pending = {
  approvals: ProtocolApproval[];
  questions: ProtocolQuestionRequest[];
  plans: ProtocolPlanRequest[];
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Tabla de lo pendiente. Pura: los datos son DTOs del protocolo. */
export function formatPendingTable(pending: Pending, now: number = Date.now()): string {
  const rows: string[][] = [];
  const when = (r: { requestedAt: number; expiresAt: number | null }): string[] => [
    span(now - r.requestedAt),
    r.expiresAt === null ? '-' : span(r.expiresAt - now),
  ];
  for (const a of pending.approvals) {
    const flags = [
      a.environment ? `${a.environment.name}/${a.environment.tier}` : '',
      a.forced ? 'forced' : '',
      a.confirmPhrase !== undefined ? 'phrase' : '',
      a.resolvable === 'origin' ? 'origin-only' : '',
    ].filter(Boolean);
    rows.push([
      a.id,
      'approval',
      a.sessionId,
      ...when(a),
      `${a.tool}${a.target ? ` @${a.target}` : ''}${flags.length ? ` [${flags.join(', ')}]` : ''}: ${clip(a.description, 70)}`,
    ]);
  }
  for (const q of pending.questions) {
    rows.push([
      q.id,
      'question',
      q.sessionId,
      ...when(q),
      clip(q.questions.map((x) => x.question).join(' · '), 80),
    ]);
  }
  for (const p of pending.plans) {
    rows.push([
      p.id,
      'plan',
      p.sessionId,
      ...when(p),
      `${p.plan.steps.length} steps: ${clip(p.plan.summary, 70)}`,
    ]);
  }
  if (rows.length === 0) return 'Nothing pending.\n';
  const table = [['ID', 'KIND', 'SESSION', 'AGE', 'EXPIRES', 'WHAT'], ...rows];
  const widths = table[0]!.map((_, col) => Math.max(...table.map((r) => r[col]!.length)));
  return (
    table
      .map((r) =>
        r
          .map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]!)))
          .join('  ')
          .trimEnd(),
      )
      .join('\n') + '\n'
  );
}

/**
 * Lee una línea de la terminal sin eco. `null` si se cancela (Ctrl+C, Ctrl+D)
 * o si no hay terminal: una clave nunca se lee de una tubería.
 */
export function askSecret(prompt: string): Promise<string | null> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    let value = '';
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const finish = (result: string | null): void => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      resolve(result);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\u0003' || ch === '\u0004') return finish(null);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function explain(err: unknown): string {
  if (err instanceof ProtocolError) {
    switch (err.code) {
      case 'ALREADY_RESOLVED':
        return `Already resolved (${String(err.data?.resolution ?? 'by someone else')}).`;
      case 'NOT_FOUND':
        return 'No such pending request.';
      case 'FORBIDDEN':
        return 'This client is not allowed to resolve that request.';
      case 'UNAUTHORIZED':
        return 'Invalid approver key (or remote approvals are not enabled on this daemon).';
      case 'UNAVAILABLE':
        return err.data?.reason === 'host-unavailable'
          ? 'The process that hosts that session is not connected: answer it in its terminal.'
          : err.message;
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

async function observe(): Promise<StratumClient> {
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: {
      kind: 'cli',
      name: 'stratum approvals',
      version: cliVersion(),
      roles: ['observer'],
    },
    reconnect: false,
    requestTimeoutMs: 10_000,
  });
  await client.connect();
  return client;
}

/** Conexión de aprobador: pide la clave por la terminal. `null` si no se pudo. */
async function approver(): Promise<StratumClient | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail('Resolving a pending request needs an interactive terminal: the approver key is typed.');
    return null;
  }
  const approverKey = await askSecret('Approver key: ');
  if (!approverKey) {
    fail('Cancelled.');
    return null;
  }
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: {
      kind: 'cli',
      name: 'stratum approvals',
      version: cliVersion(),
      roles: ['approver'],
      approverKey,
    },
    reconnect: false,
    requestTimeoutMs: 15_000,
  });
  try {
    await client.connect();
  } catch (err) {
    fail(explain(err));
    return null;
  }
  if (!client.capabilities.includes('approve')) {
    client.close();
    fail('The daemon did not grant the approve capability.');
    return null;
  }
  return client;
}

type Found =
  | { kind: 'approval'; item: ProtocolApproval }
  | { kind: 'question'; item: ProtocolQuestionRequest }
  | { kind: 'plan'; item: ProtocolPlanRequest };

function find(pending: Pending, id: string): Found | null {
  const approval = pending.approvals.find((a) => a.id === id);
  if (approval) return { kind: 'approval', item: approval };
  const question = pending.questions.find((q) => q.id === id);
  if (question) return { kind: 'question', item: question };
  const plan = pending.plans.find((p) => p.id === id);
  return plan ? { kind: 'plan', item: plan } : null;
}

function show(found: Found): void {
  const out = process.stderr;
  if (found.kind === 'approval') {
    const a = found.item;
    out.write(`\nSession  ${a.sessionId}\nTool     ${a.tool}${a.target ? ` @${a.target}` : ''}\n`);
    if (a.environment) out.write(`Env      ${a.environment.name} (${a.environment.tier})\n`);
    out.write(`Action   ${a.description}\n\n`);
  } else if (found.kind === 'plan') {
    out.write(`\nSession  ${found.item.sessionId}\nPlan     ${found.item.plan.summary}\n`);
    found.item.plan.steps.forEach((s, i) => out.write(`  ${i + 1}. ${s.title}\n`));
    out.write('\n');
  } else {
    out.write(`\nSession  ${found.item.sessionId}\n`);
  }
}

async function askAnswers(
  request: ProtocolQuestionRequest,
): Promise<ProtocolQuestionAnswer[] | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answers: ProtocolQuestionAnswer[] = [];
    for (const [i, q] of request.questions.entries()) {
      process.stderr.write(`\n(${i + 1}/${request.questions.length}) ${q.question}\n`);
      const options = q.options ?? [];
      options.forEach((o, j) => process.stderr.write(`  ${j + 1}) ${o.label}\n`));
      for (;;) {
        const raw = (await askLine(rl, '> '))?.trim();
        if (raw === undefined) return null;
        const n = Number.parseInt(raw, 10);
        if (options.length > 0 && String(n) === raw && n >= 1 && n <= options.length) {
          const option = options[n - 1]!;
          answers.push({ question: q.question, answer: option.label, optionId: option.id });
          break;
        }
        if (raw && (options.length === 0 || q.allowCustom)) {
          answers.push({ question: q.question, answer: raw });
          break;
        }
        process.stderr.write(
          options.length > 0
            ? `  Choose a number between 1 and ${options.length}.\n`
            : '  Type an answer.\n',
        );
      }
    }
    return answers;
  } finally {
    rl.close();
  }
}

async function resolve(
  id: string,
  action: 'approve' | 'deny' | 'answer',
  opts: { all?: boolean },
): Promise<void> {
  const client = await approver();
  if (!client) return;
  try {
    const found = find(await client.request('approvals.list', {}), id);
    if (!found) return fail('No such pending request.');
    show(found);

    if (found.kind === 'approval') {
      if (action === 'answer') return fail('That is an approval: use approve or deny.');
      if (action === 'deny') {
        await client.request('approvals.resolve', { approvalId: id, decision: 'deny' });
        process.stdout.write('Denied.\n');
        return;
      }
      const { item } = found;
      if (opts.all && (item.forced || item.confirmPhrase !== undefined)) {
        return fail('This request must be approved on its own: --all does not apply to it.');
      }
      let phrase: string | undefined;
      if (item.confirmPhrase !== undefined) {
        // Confirmación con nombre: hay que teclear el texto exacto.
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          phrase = (await askLine(rl, `Type "${item.confirmPhrase}" to approve: `))?.trim();
        } finally {
          rl.close();
        }
        if (phrase !== item.confirmPhrase)
          return fail('The phrase does not match. Nothing changed.');
      }
      await client.request('approvals.resolve', {
        approvalId: id,
        decision: opts.all ? 'allow-all' : 'approve',
        ...(phrase !== undefined ? { phrase } : {}),
      });
      process.stdout.write(opts.all ? 'Approved (and the rest of this session).\n' : 'Approved.\n');
      return;
    }

    if (found.kind === 'plan') {
      if (action === 'answer') return fail('That is a plan: use approve or deny.');
      await client.request('plans.decide', {
        requestId: id,
        decision: action === 'approve' ? 'approve' : 'reject',
      });
      process.stdout.write(action === 'approve' ? 'Plan approved.\n' : 'Plan rejected.\n');
      return;
    }

    if (action === 'approve') return fail('Those are questions: use answer, or deny to skip them.');
    const answers = action === 'deny' ? null : await askAnswers(found.item);
    if (action === 'answer' && answers === null) return fail('Cancelled. Nothing changed.');
    await client.request('questions.answer', { requestId: id, answers });
    process.stdout.write(answers === null ? 'Skipped.\n' : 'Answered.\n');
  } catch (err) {
    fail(explain(err));
  } finally {
    client.close();
  }
}

const list = new Command('list')
  .description('List what the live sessions are waiting on: approvals, questions and plans')
  .option('--json', 'machine-readable output: protocol DTOs')
  .action(async (opts: { json?: boolean }) => {
    let client: StratumClient;
    try {
      client = await observe();
    } catch (err) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ running: false, approvals: [], questions: [], plans: [] }) + '\n',
        );
      } else {
        process.stderr.write(`${explain(err)}\n`);
      }
      process.exitCode = 1;
      return;
    }
    try {
      const pending = await client.request('approvals.list', {});
      process.stdout.write(
        opts.json
          ? JSON.stringify({ running: true, ...pending }) + '\n'
          : formatPendingTable(pending),
      );
    } catch (err) {
      fail(explain(err));
    } finally {
      client.close();
    }
  });

const approve = new Command('approve')
  .description('Approve a pending approval or plan (asks for the approver key)')
  .argument('<id>', 'id of the pending request')
  .option('--all', 'also allow the rest of the destructive operations of that session')
  .action((id: string, opts: { all?: boolean }) => resolve(id, 'approve', opts));

const deny = new Command('deny')
  .description('Deny an approval, reject a plan or skip a batch of questions')
  .argument('<id>', 'id of the pending request')
  .action((id: string) => resolve(id, 'deny', {}));

const answer = new Command('answer')
  .description('Answer a pending batch of questions')
  .argument('<id>', 'id of the pending request')
  .action((id: string) => resolve(id, 'answer', {}));

const setKey = new Command('set-key')
  .description('Set the approver key that clients must type to resolve pending requests')
  .action(async () => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      return fail('Setting the approver key needs an interactive terminal.');
    }
    const first = await askSecret(
      `New approver key (at least ${APPROVER_KEY_MIN_CHARS} characters): `,
    );
    if (!first) return fail('Cancelled.');
    const second = await askSecret('Type it again: ');
    if (second !== first) return fail('The two keys do not match. Nothing changed.');
    try {
      const path = await writeApproverKey(defaultEndpointDir(), first);
      process.stdout.write(
        `Approver key saved (only a salted derivation of it): ${path}\n` +
          'A running daemon keeps the previous one: restart it (stratum daemon stop && stratum daemon start).\n',
      );
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

export const approvalsCommand = new Command('approvals')
  .description('See and resolve what the live sessions are waiting on')
  .addCommand(list, { isDefault: true })
  .addCommand(approve)
  .addCommand(deny)
  .addCommand(answer)
  .addCommand(setKey);
