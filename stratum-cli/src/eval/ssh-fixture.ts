/**
 * Hosts SSH simulados para los escenarios: el `ssh2.Server` en proceso que ya
 * usan los tests (`tools/ssh/test-server.ts`), con un intérprete de comandos
 * declarativo. El protocolo es el real (handshake, auth, host key, exec); lo
 * simulado es lo que hay al otro lado.
 */
import { startTestServer, type TestServer } from '../tools/ssh/test-server.js';
import type { Scenario } from './scenario.js';

type SshSetup = NonNullable<Scenario['setup']['ssh']>;

const PASSWORD = 'stratum-eval';

export interface SshFixture {
  /** Sección `ssh.hosts` para el `.stratumrc.json` del escenario. */
  hosts: Record<string, Record<string, unknown>>;
  /** Comandos recibidos por cada host, en orden. */
  received(): Record<string, string[]>;
  close(): Promise<void>;
}

export interface HostReply {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HostRule extends HostReply {
  re: RegExp;
}

const reply = (stdout = '', exitCode = 0, stderr = ''): HostReply => ({
  stdout,
  stderr,
  exitCode,
});

interface Segment {
  text: string;
  /** Operador que lo une al siguiente. */
  op: ';' | '&&' | '||';
}

/** Trocea por `;`, `&&`, `||` y salto de línea, respetando comillas. Las tuberías no se parten. */
export function splitShellSegments(command: string): Segment[] {
  const out: Segment[] = [];
  let current = '';
  let quote: string | null = null;
  const push = (op: Segment['op']): void => {
    if (current.trim()) out.push({ text: current.trim(), op });
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(two);
      i++;
    } else if (ch === ';' || ch === '\n') {
      push(';');
    } else {
      current += ch;
    }
  }
  push(';');
  return out;
}

const KERNEL = '6.8.0-45-generic';
const OS_RELEASE = [
  'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="24.04"',
  'ID=ubuntu',
  '',
].join('\n');
const ENVIRONMENT = [
  'HOME=/home/eval',
  'USER=eval',
  'SHELL=/bin/bash',
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  '',
].join('\n');

/**
 * Lo que cualquier host contesta sin que el escenario lo declare: las sondas
 * con las que un agente comprueba dónde está antes de actuar (`whoami`, `pwd`,
 * `echo`, `sudo -n true`…). Sin esto, un modelo real que recibía un 127 a `pwd`
 * daba el host por roto y se pasaba el turno depurando la conexión en vez de
 * hacer la tarea. Solo lectura y sin estado: nada de lo que un escenario quiera
 * medir sale de aquí. `null` = no lo conoce.
 */
export function builtinReply(segment: string, alias: string): HostReply | null {
  const stage = segment
    // Redirecciones (`2>/dev/null`, `2>&1`, `> f`): no cambian quién contesta.
    .replace(/\s\d?>>?\s*&?\S+/g, ' ')
    .split('|')[0]!
    .trim();
  const tokens = stage.split(/\s+/).filter(Boolean);
  if (tokens[0] === 'sudo') {
    const rest = tokens.slice(1).filter((t) => t !== '-n');
    if (rest.length === 0 || rest[0] === 'true' || rest[0] === '-v') return reply();
    if (rest[0] === '-l') {
      return reply(
        `User eval may run the following commands on ${alias}:\n    (ALL) NOPASSWD: ALL\n`,
      );
    }
    return builtinReply(rest.join(' '), alias);
  }
  const [cmd, ...args] = tokens;
  const operands = args.filter((a) => !a.startsWith('-'));
  const unquote = (t: string): string => t.replace(/^(['"])(.*)\1$/, '$2');
  switch (cmd) {
    case 'echo':
      return reply(`${args.map(unquote).join(' ').replace(/\$\?/g, '0')}\n`);
    case 'true':
    case ':':
      return reply();
    case 'false':
    case 'test':
    case '[':
      return reply('', 1);
    case 'pwd':
      return reply('/home/eval\n');
    case 'whoami':
      return reply('eval\n');
    case 'id':
      return reply('uid=1000(eval) gid=1000(eval) groups=1000(eval),27(sudo)\n');
    case 'hostname':
      return reply(`${alias}\n`);
    case 'uname':
      if (args.includes('-r')) return reply(`${KERNEL}\n`);
      if (args.includes('-a')) {
        return reply(`Linux ${alias} ${KERNEL} #45-Ubuntu SMP x86_64 GNU/Linux\n`);
      }
      return reply('Linux\n');
    case 'date':
      return reply('Mon Jan 12 09:20:00 UTC 2026\n');
    case 'uptime':
      return reply(' 09:20:00 up 41 days,  3:12,  1 user,  load average: 0.08, 0.05, 0.01\n');
    case 'env':
    case 'printenv':
      return reply(ENVIRONMENT);
    case 'which':
    case 'type':
    case 'command':
      return operands.length > 0 ? reply(operands.map((o) => `/usr/bin/${o}\n`).join('')) : null;
    case 'cat': {
      const file = operands[0] ?? '';
      if (file.includes('os-release')) return reply(OS_RELEASE);
      if (file === '/etc/hostname') return reply(`${alias}\n`);
      return reply('', 1, `cat: ${file}: No such file or directory\n`);
    }
    case 'ls': {
      const dir = operands[0];
      if (dir === undefined || dir === '/') {
        return reply('bin\netc\nhome\nopt\nsrv\ntmp\nusr\nvar\n');
      }
      return reply('', 2, `ls: cannot access '${dir}': No such file or directory\n`);
    }
    case 'df':
      return reply(
        'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        40G   24G   16G  60% /\n',
      );
    default:
      return null;
  }
}

/**
 * Respuesta de un host a un comando. Las reglas del escenario mandan sobre las
 * sondas integradas. Un comando compuesto se contesta trozo a trozo —como lo
 * haría un shell— si todos sus trozos se conocen; si no, vale la regla que case
 * con el comando entero, y en último caso los trozos desconocidos salen con 127.
 */
export function hostReply(command: string, rules: readonly HostRule[], alias: string): HostReply {
  const byRule = (text: string): HostReply | null => rules.find((r) => r.re.test(text)) ?? null;
  const notFound = (text: string): HostReply =>
    reply('', 127, `sh: 1: ${text.split(/\s+/)[0] ?? text}: not found\n`);
  const segments = splitShellSegments(command);
  if (segments.length <= 1) {
    return byRule(command) ?? builtinReply(command, alias) ?? notFound(command);
  }

  const parts = segments.map((s) => byRule(s.text) ?? builtinReply(s.text, alias));
  if (parts.includes(null)) {
    const whole = byRule(command);
    if (whole) return whole;
  }
  const out = reply();
  let ran = false;
  parts.forEach((part, i) => {
    const op = i > 0 ? segments[i - 1]!.op : ';';
    if (ran && ((op === '&&' && out.exitCode !== 0) || (op === '||' && out.exitCode === 0))) {
      return;
    }
    const r = part ?? notFound(segments[i]!.text);
    out.stdout += r.stdout;
    out.stderr += r.stderr;
    out.exitCode = r.exitCode;
    ran = true;
  });
  return out;
}

export async function startSshFixture(setup: SshSetup): Promise<SshFixture> {
  const servers: TestServer[] = [];
  const hosts: Record<string, Record<string, unknown>> = {};
  const received: Record<string, string[]> = {};

  for (const [alias, host] of Object.entries(setup.hosts)) {
    const rules: HostRule[] = host.commands.map((r) => ({ ...r, re: new RegExp(r.match) }));
    const log: string[] = (received[alias] = []);
    const server = await startTestServer({
      password: PASSWORD,
      sftp: false,
      onExec: ({ command, stream }) => {
        log.push(command);
        const r = hostReply(command, rules, alias);
        if (r.stdout) stream.write(r.stdout);
        if (r.stderr) stream.stderr.write(r.stderr);
        stream.exit(r.exitCode);
        stream.end();
      },
    });
    servers.push(server);
    hosts[alias] = {
      host: '127.0.0.1',
      port: server.port,
      user: 'eval',
      password: PASSWORD,
      // La host key es nueva en cada ejecución: se fija su huella en vez de
      // desactivar la verificación.
      hostKeyPolicy: 'strict',
      hostKeyHash: server.fingerprint,
      confirmAll: host.confirmAll,
    };
  }

  return {
    hosts,
    received: () => received,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}
