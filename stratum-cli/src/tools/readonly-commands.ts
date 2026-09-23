/**
 * Hito 17 — clasificación read-only de comandos de shell (§5 de
 * `CLI-DOC/Orientacion-Infraestructura.md`). Puro, sin I/O.
 *
 * Es una **allowlist**: un comando es read-only solo si todos sus segmentos son
 * invocaciones conocidas que únicamente observan. Todo lo que no se reconoce
 * —un binario propio, un script, `python -c`— cuenta como mutante. El error en
 * esa dirección cuesta que el modelo tenga que buscar otro comando; el error
 * contrario costaría que el modo read-only dejase de serlo.
 *
 * Best-effort por construcción, como la capa 3 de `guards.ts`: un shell puede
 * esconder una escritura de muchas maneras, así que todo lo que no se puede
 * analizar (sustitución de comandos, redirección a fichero, código inline) se
 * rechaza en vez de adivinarse.
 */
import { parseInvocation, splitCommandSegments, tokenize } from './guards.js';

export type ReadOnlyVerdict = { readOnly: true } | { readOnly: false; reason: string };

const READ_ONLY: ReadOnlyVerdict = { readOnly: true };

function mutating(reason: string): ReadOnlyVerdict {
  return { readOnly: false, reason };
}

/**
 * Comandos que solo observan con cualquier argumento. Los que tienen formas que
 * escriben (`sort -o`, `date -s`, `find -delete`…) tienen su regla en
 * `segmentVerdict`.
 */
const PLAIN_READERS = new Set([
  // ficheros y texto
  'ls',
  'll',
  'dir',
  'cat',
  'bat',
  'tac',
  'head',
  'tail',
  'more',
  'nl',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'stat',
  'file',
  'du',
  'df',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'cut',
  'tr',
  'column',
  'jq',
  'diff',
  'cmp',
  'comm',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'base64',
  'strings',
  'od',
  'hexdump',
  'fold',
  'fmt',
  'expand',
  'paste',
  'join',
  'seq',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  'sleep',
  'pwd',
  'cd',
  'export',
  'set',
  'which',
  'whereis',
  'type',
  'findstr',
  // sistema y procesos
  'ps',
  'pgrep',
  'top',
  'free',
  'uptime',
  'uname',
  'whoami',
  'id',
  'groups',
  'who',
  'w',
  'last',
  'lsof',
  'vmstat',
  'iostat',
  'mpstat',
  'sar',
  'nproc',
  'lsblk',
  'blkid',
  'findmnt',
  'lscpu',
  'lsmem',
  'lspci',
  'lsusb',
  'lsmod',
  'modinfo',
  'getent',
  'env',
  'printenv',
  // red
  'netstat',
  'ping',
  'ping6',
  'traceroute',
  'tracepath',
  'tracert',
  'pathping',
  'mtr',
  'dig',
  'nslookup',
  'host',
  'whois',
  // Windows nativo
  'tasklist',
  'systeminfo',
  'getmac',
  'ver',
  'where',
  // alias de PowerShell que solo leen
  'gci',
  'gc',
  'gl',
  'gps',
  'gsv',
  'gcm',
  'sls',
  'select',
  'measure',
  'sort-object',
  'ft',
  'fl',
  'fw',
]);

/** Alias de PowerShell de la lista de arriba: con `{` llevan un scriptblock. */
const PS_ALIASES = new Set([
  'ls',
  'dir',
  'cat',
  'type',
  'gci',
  'gc',
  'gl',
  'gps',
  'gsv',
  'gcm',
  'sls',
  'select',
  'measure',
  'sort-object',
  'ft',
  'fl',
  'fw',
  'where',
  'echo',
  'ps',
]);

/** Cmdlets de PowerShell de solo observación, además de todo `Get-*` y `Test-*`. */
const PS_READERS = new Set([
  'resolve-dnsname',
  'select-string',
  'select-object',
  'where-object',
  'sort-object',
  'measure-object',
  'group-object',
  'compare-object',
  'format-table',
  'format-list',
  'format-wide',
  'out-string',
  'out-host',
  'convertto-json',
  'convertfrom-json',
  'convertto-csv',
  'convertfrom-csv',
  'write-output',
  'write-host',
]);

/** `Get-Credential` pide datos al usuario y lo demás de `Get-*` solo lee. */
const PS_READ_VERBS = /^(get|test)-[a-z]/;

function positionalsOf(rest: string[]): string[] {
  return rest.filter((t) => !t.startsWith('-'));
}

function hasAnyFlag(rest: string[], flags: readonly string[]): string | null {
  for (const tok of rest) {
    for (const f of flags) {
      if (tok === f || tok.startsWith(`${f}=`)) return f;
      // flags cortos agrupados (`-in` contiene `-i`): solo para flags de una letra
      if (f.length === 2 && !f.startsWith('--') && /^-[a-zA-Z]{2,}$/.test(tok)) {
        if (tok.slice(1).includes(f[1]!)) return f;
      }
    }
  }
  return null;
}

/** Primer argumento no-flag, saltando las opciones globales que consumen valor. */
function subcommandOf(
  rest: string[],
  valueFlags: readonly string[] = [],
): { sub: string | null; after: string[] } {
  let i = 0;
  while (i < rest.length) {
    const tok = rest[i]!;
    if (tok.startsWith('-')) {
      i += valueFlags.includes(tok) ? 2 : 1;
      continue;
    }
    return { sub: tok.toLowerCase(), after: rest.slice(i + 1) };
  }
  return { sub: null, after: [] };
}

const GIT_READ = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'describe',
  'shortlog',
  'grep',
  'cat-file',
  'show-ref',
  'for-each-ref',
  'merge-base',
  'name-rev',
  'count-objects',
  'check-ignore',
  'var',
  'help',
  'version',
  'whatchanged',
]);

function gitVerdict(rest: string[]): ReadOnlyVerdict {
  // `git -c core.pager='…' log` ejecuta lo que se ponga en la clave.
  const { sub, after } = subcommandOf(rest, ['-C', '-c', '--git-dir', '--work-tree']);
  const globals = rest.slice(0, rest.length - after.length - (sub === null ? 0 : 1));
  if (globals.some((t) => t === '-c' || t.startsWith('--config-env') || t === '--exec-path')) {
    return mutating('git -c/--config-env can make git run arbitrary commands');
  }
  if (sub === null)
    return rest.includes('--version') ? READ_ONLY : mutating('git with no subcommand');
  if (GIT_READ.has(sub)) {
    // `git diff --output=f` y `git log --output=f` escriben un fichero.
    return hasAnyFlag(after, ['--output'])
      ? mutating(`git ${sub} --output writes a file`)
      : READ_ONLY;
  }
  const pos = positionalsOf(after);
  switch (sub) {
    case 'branch':
      // listar: sin nombres, o con flags de listado
      return pos.length === 0 &&
        !hasAnyFlag(after, [
          '-d',
          '-D',
          '-m',
          '-M',
          '-c',
          '-C',
          '--delete',
          '--move',
          '--copy',
          '--set-upstream-to',
          '-u',
          '--unset-upstream',
          '--edit-description',
        ])
        ? READ_ONLY
        : mutating('git branch with arguments changes branches');
    case 'tag':
      return pos.length === 0 || hasAnyFlag(after, ['-l', '--list'])
        ? hasAnyFlag(after, ['-d', '--delete', '-a', '-s', '-f', '--force'])
          ? mutating('git tag with -d/-a/-s/-f changes tags')
          : READ_ONLY
        : mutating('git tag <name> creates a tag');
    case 'remote':
      return pos.length === 0 || ['show', 'get-url'].includes(pos[0]!.toLowerCase())
        ? READ_ONLY
        : mutating(`git remote ${pos[0]} changes remotes`);
    case 'config':
      return hasAnyFlag(after, [
        '--get',
        '--get-all',
        '--get-regexp',
        '--list',
        '-l',
        '--show-origin',
      ])
        ? READ_ONLY
        : mutating('git config without --get/--list can change configuration');
    case 'stash':
    case 'worktree':
      return (pos.length > 0 && pos[0]!.toLowerCase() === 'list') ||
        (sub === 'stash' && pos.length > 0 && pos[0]!.toLowerCase() === 'show')
        ? READ_ONLY
        : mutating(`git ${sub} ${pos[0] ?? ''} changes the repository`.trim());
    case 'reflog':
      return pos.length === 0 || pos[0]!.toLowerCase() === 'show'
        ? READ_ONLY
        : mutating(`git reflog ${pos[0]} changes the reflog`);
    case 'submodule':
      return pos.length > 0 && pos[0]!.toLowerCase() === 'status'
        ? READ_ONLY
        : mutating('git submodule can change the working tree');
    default:
      return mutating(`git ${sub} is not a known read-only git subcommand`);
  }
}

const KUBECTL_READ = new Set([
  'get',
  'describe',
  'logs',
  'top',
  'explain',
  'version',
  'api-resources',
  'api-versions',
  'cluster-info',
  'events',
  'diff',
]);

function kubectlVerdict(name: string, rest: string[]): ReadOnlyVerdict {
  const { sub, after } = subcommandOf(rest, [
    '-n',
    '--namespace',
    '--context',
    '--kubeconfig',
    '--cluster',
    '--user',
    '-s',
    '--server',
  ]);
  if (sub === null) return mutating(`${name} with no subcommand`);
  if (KUBECTL_READ.has(sub)) return READ_ONLY;
  const next = positionalsOf(after)[0]?.toLowerCase();
  if (sub === 'auth' && next === 'can-i') return READ_ONLY;
  if (sub === 'rollout' && (next === 'status' || next === 'history')) return READ_ONLY;
  if (
    sub === 'config' &&
    next !== undefined &&
    ['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users'].includes(next)
  ) {
    return READ_ONLY;
  }
  return mutating(`${name} ${sub} is not a known read-only ${name} subcommand`);
}

const DOCKER_READ = new Set([
  'ps',
  'images',
  'inspect',
  'logs',
  'stats',
  'version',
  'info',
  'top',
  'port',
  'diff',
  'history',
  'search',
]);
const DOCKER_GROUP_READ: Record<string, readonly string[]> = {
  image: ['ls', 'list', 'inspect', 'history'],
  container: ['ls', 'list', 'ps', 'inspect', 'logs', 'top', 'port', 'diff', 'stats'],
  network: ['ls', 'list', 'inspect'],
  volume: ['ls', 'list', 'inspect'],
  system: ['df', 'info'],
  context: ['ls', 'list', 'inspect', 'show'],
  compose: ['ps', 'logs', 'config', 'images', 'top', 'ls', 'version'],
  node: ['ls', 'inspect', 'ps'],
  service: ['ls', 'inspect', 'logs', 'ps'],
};

function dockerVerdict(name: string, rest: string[]): ReadOnlyVerdict {
  const { sub, after } = subcommandOf(rest, ['-H', '--host', '--context', '-c', '--config', '-l']);
  if (sub === null)
    return rest.some((t) => t === '--version' || t === '-v')
      ? READ_ONLY
      : mutating(`${name} with no subcommand`);
  if (DOCKER_READ.has(sub)) return READ_ONLY;
  const group = DOCKER_GROUP_READ[sub];
  if (group) {
    const { sub: action } = subcommandOf(after, ['-f', '--file', '-p', '--project-name']);
    if (action !== null && group.includes(action)) return READ_ONLY;
    return mutating(
      `${name} ${sub} ${action ?? ''} is not a known read-only operation`
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return mutating(`${name} ${sub} is not a known read-only ${name} subcommand`);
}

const HELM_READ = new Set([
  'list',
  'ls',
  'status',
  'get',
  'history',
  'show',
  'search',
  'version',
  'env',
  'template',
  'lint',
]);
const TERRAFORM_READ = new Set(['show', 'output', 'validate', 'version', 'providers', 'graph']);

const SYSTEMCTL_READ = new Set([
  'status',
  'show',
  'cat',
  'is-active',
  'is-enabled',
  'is-failed',
  'is-system-running',
  'list-units',
  'list-unit-files',
  'list-timers',
  'list-sockets',
  'list-dependencies',
  'list-jobs',
  'get-default',
  'help',
]);

const SC_READ = new Set([
  'query',
  'queryex',
  'qc',
  'qdescription',
  'qfailure',
  'qprivs',
  'qsidtype',
  'getdisplayname',
  'getkeyname',
  'enumdepend',
]);

/** `ip <objeto> [show|list|get]`: cualquier otro verbo (`set`, `add`, `del`, `flush`) cambia la red. */
function ipVerdict(rest: string[]): ReadOnlyVerdict {
  const pos = positionalsOf(rest);
  if (pos.length <= 1) return READ_ONLY;
  const verb = pos[1]!.toLowerCase();
  if (['show', 'list', 'ls', 'lst', 'get', 'sh', 's', 'l'].includes(verb)) return READ_ONLY;
  // `ip addr show dev eth0` ya salió arriba; `ip link eth0` no es sintaxis válida.
  return mutating(`ip ${pos[0]} ${verb} changes the network configuration`);
}

/** Script de sed sin `w`/`W` (escriben fichero) ni `e` (ejecuta un comando). */
function sedScriptIsSafe(script: string): boolean {
  if (/(^|[;{}\s\d$,/])[wWe](\s|$|;|})/.test(script)) return false;
  // flags de `s///`: `w fichero` y `e`
  if (/s(.).*?\1.*?\1[gpIiMm0-9]*[we]/.test(script)) return false;
  return true;
}

function sedVerdict(rest: string[]): ReadOnlyVerdict {
  if (hasAnyFlag(rest, ['-i', '--in-place'])) return mutating('sed -i edits files in place');
  const scripts: string[] = [];
  let sawScriptFlag = false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok === '-e' || tok === '--expression') {
      sawScriptFlag = true;
      scripts.push(rest[i + 1] ?? '');
      i++;
    } else if (tok === '-f' || tok === '--file') {
      return mutating('sed -f runs a script file that cannot be verified');
    }
  }
  if (!sawScriptFlag) {
    const first = positionalsOf(rest)[0];
    if (first !== undefined) scripts.push(first);
  }
  return scripts.every(sedScriptIsSafe)
    ? READ_ONLY
    : mutating('the sed script writes a file (w) or runs a command (e)');
}

function awkVerdict(rest: string[]): ReadOnlyVerdict {
  if (hasAnyFlag(rest, ['-f', '-i']))
    return mutating('awk -f/-i runs a program that cannot be verified');
  const program = positionalsOf(rest)[0] ?? '';
  if (/system\s*\(|\||>|getline|fflush/.test(program)) {
    return mutating('the awk program runs commands or writes files');
  }
  return READ_ONLY;
}

function curlVerdict(name: string, rest: string[]): ReadOnlyVerdict {
  const upload = hasAnyFlag(rest, [
    '-d',
    '--data',
    '--data-raw',
    '--data-binary',
    '--data-urlencode',
    '--json',
    '-F',
    '--form',
    '-T',
    '--upload-file',
  ]);
  if (upload) return mutating(`${name} ${upload} sends data to the server`);
  const output = hasAnyFlag(rest, ['-o', '--output', '-O', '--remote-name', '--remote-name-all']);
  if (output) return mutating(`${name} ${output} writes a local file`);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    const method =
      tok === '-X' || tok === '--request'
        ? rest[i + 1]
        : tok.startsWith('-X') && tok.length > 2
          ? tok.slice(2)
          : tok.startsWith('--request=')
            ? tok.slice('--request='.length)
            : undefined;
    if (method !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      return mutating(`${name} -X ${method} is not a read-only HTTP method`);
    }
  }
  return READ_ONLY;
}

function wgetVerdict(rest: string[]): ReadOnlyVerdict {
  if (rest.includes('--spider')) return READ_ONLY;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (
      (tok === '-O' || tok === '--output-document' || /^-[a-zA-Z]*O$/.test(tok)) &&
      rest[i + 1] === '-'
    ) {
      return READ_ONLY;
    }
    if (tok === '-O-' || /^-[a-zA-Z]*O-$/.test(tok) || tok === '--output-document=-')
      return READ_ONLY;
  }
  return mutating('wget writes a file (use --spider or -O -)');
}

function cloudVerdict(name: string, rest: string[]): ReadOnlyVerdict {
  const pos = positionalsOf(rest).map((p) => p.toLowerCase());
  if (name === 'aws') {
    if (pos[0] === 's3' && pos[1] === 'ls') return READ_ONLY;
    const op = pos[1];
    return op !== undefined && /^(describe|list|get)-/.test(op)
      ? READ_ONLY
      : mutating(`aws ${pos.slice(0, 2).join(' ')} is not a describe-/list-/get- operation`);
  }
  if (name === 'az') {
    const last = pos[pos.length - 1];
    return last === 'show' ||
      last === 'list' ||
      pos[0] === 'version' ||
      (pos[0] === 'account' && pos[1] === 'show')
      ? READ_ONLY
      : mutating(`az ${pos.join(' ')} is not a show/list operation`);
  }
  // gcloud
  return pos.some((p) => p === 'describe' || p === 'list') ||
    pos[0] === 'version' ||
    (pos[0] === 'config' && pos[1] === 'list')
    ? READ_ONLY
    : mutating(`gcloud ${pos.join(' ')} is not a describe/list operation`);
}

/** Veredicto de un segmento ya tokenizado. */
function segmentVerdict(tokens: string[]): ReadOnlyVerdict {
  const invocation = parseInvocation(tokens);
  // Solo asignaciones o envoltorios sin comando (`FOO=1`, `env`): no ejecuta nada.
  if (!invocation) return READ_ONLY;
  const name = invocation.name.toLowerCase();
  const rest = invocation.rest;

  // `timeout 5 cmd`: se clasifica el comando envuelto.
  if (name === 'timeout') {
    let i = 0;
    while (i < rest.length && rest[i]!.startsWith('-'))
      i += rest[i] === '-s' || rest[i] === '-k' ? 2 : 1;
    return segmentVerdict(rest.slice(i + 1));
  }

  // PowerShell: los cmdlets que aceptan scriptblocks pueden ejecutar cualquier cosa dentro.
  const isCmdlet = name.includes('-') && /^[a-z]+-[a-z]/.test(name);
  if (isCmdlet || PS_READERS.has(name)) {
    if (tokens.some((t) => t.includes('{'))) {
      return mutating(`${invocation.name} with a script block cannot be verified as read-only`);
    }
    if (name === 'get-credential') return mutating('Get-Credential prompts for credentials');
    if (PS_READ_VERBS.test(name) || PS_READERS.has(name)) {
      if (
        name === 'test-path' ||
        name === 'get-content' ||
        name === 'get-childitem' ||
        name === 'get-item'
      )
        return READ_ONLY;
      return READ_ONLY;
    }
    return mutating(`${invocation.name} is not a known read-only cmdlet`);
  }

  if (PLAIN_READERS.has(name)) {
    // Los alias de PowerShell (`select`, `where`, `ft`…) aceptan scriptblocks y
    // propiedades calculadas, que ejecutan código.
    if (PS_ALIASES.has(name) && tokens.some((t) => t.includes('{'))) {
      return mutating(`${invocation.name} with a script block cannot be verified as read-only`);
    }
    return READ_ONLY;
  }

  switch (name) {
    case 'git':
      return gitVerdict(rest);
    case 'kubectl':
    case 'oc':
      return kubectlVerdict(name, rest);
    case 'docker':
    case 'podman':
    case 'nerdctl':
      return dockerVerdict(name, rest);
    case 'helm': {
      const { sub } = subcommandOf(rest, ['-n', '--namespace', '--kube-context', '--kubeconfig']);
      return sub !== null && HELM_READ.has(sub)
        ? READ_ONLY
        : mutating(`helm ${sub ?? ''} is not read-only`.trim());
    }
    case 'terraform':
    case 'tofu': {
      const { sub, after } = subcommandOf(rest, ['-chdir']);
      if (sub === null) return mutating(`${name} with no subcommand`);
      if (TERRAFORM_READ.has(sub)) return READ_ONLY;
      if (sub === 'plan') {
        return hasAnyFlag(after, ['-out'])
          ? mutating(`${name} plan -out writes a plan file`)
          : READ_ONLY;
      }
      if (sub === 'state') {
        const action = positionalsOf(after)[0]?.toLowerCase();
        return action === 'list' || action === 'show'
          ? READ_ONLY
          : mutating(`${name} state ${action ?? ''} changes state`.trim());
      }
      if (sub === 'fmt')
        return hasAnyFlag(after, ['-check']) ? READ_ONLY : mutating(`${name} fmt rewrites files`);
      return mutating(`${name} ${sub} is not read-only`);
    }
    case 'systemctl': {
      const { sub } = subcommandOf(rest, [
        '-H',
        '--host',
        '-M',
        '--machine',
        '-t',
        '--type',
        '--state',
        '-p',
        '--property',
        '-n',
        '--lines',
        '-o',
        '--output',
      ]);
      if (sub === null) return READ_ONLY; // `systemctl` a secas = list-units
      return SYSTEMCTL_READ.has(sub) ? READ_ONLY : mutating(`systemctl ${sub} changes a unit`);
    }
    case 'service': {
      const pos = positionalsOf(rest);
      return rest.includes('--status-all') || pos[1]?.toLowerCase() === 'status'
        ? READ_ONLY
        : mutating('service without "status" controls a service');
    }
    case 'sc': {
      const verb = positionalsOf(rest)[0]?.toLowerCase();
      return verb !== undefined && SC_READ.has(verb)
        ? READ_ONLY
        : mutating(`sc ${verb ?? ''} controls a service`.trim());
    }
    case 'journalctl': {
      const flag = hasAnyFlag(rest, [
        '--vacuum-size',
        '--vacuum-time',
        '--vacuum-files',
        '--rotate',
        '--flush',
        '--sync',
        '--relinquish-var',
        '--smart-relinquish-var',
        '--setup-keys',
        '--update-catalog',
      ]);
      return flag ? mutating(`journalctl ${flag} changes the journal`) : READ_ONLY;
    }
    case 'dmesg':
      return hasAnyFlag(rest, [
        '-c',
        '-C',
        '--clear',
        '--read-clear',
        '-n',
        '--console-level',
        '-D',
        '-E',
      ])
        ? mutating('dmesg with -c/-C/-n/-D/-E changes the kernel ring buffer or console')
        : READ_ONLY;
    case 'sysctl':
      return hasAnyFlag(rest, ['-w', '--write', '-p', '--load', '--system']) ||
        positionalsOf(rest).some((p) => p.includes('='))
        ? mutating('sysctl with -w/-p or key=value changes kernel parameters')
        : READ_ONLY;
    case 'ip':
      return ipVerdict(rest);
    case 'ifconfig':
      return positionalsOf(rest).length <= 1
        ? READ_ONLY
        : mutating('ifconfig <iface> <args> changes an interface');
    case 'route':
      return positionalsOf(rest).every((p) => p.toLowerCase() === 'print')
        ? READ_ONLY
        : mutating('route with arguments changes the routing table');
    case 'arp':
      return hasAnyFlag(rest, ['-d', '-s', '--delete', '--set', '-f', '--file'])
        ? mutating('arp -d/-s changes the ARP cache')
        : READ_ONLY;
    case 'ipconfig':
      return rest.every((t) => ['/all', '/displaydns', '-all'].includes(t.toLowerCase()))
        ? READ_ONLY
        : mutating('ipconfig with /release, /renew or /flushdns changes the network');
    case 'mount':
      return positionalsOf(rest).length === 0 && !hasAnyFlag(rest, ['-a', '--all'])
        ? READ_ONLY
        : mutating('mount with arguments mounts a filesystem');
    case 'hostname':
      return positionalsOf(rest).length === 0 && !hasAnyFlag(rest, ['-F', '--file', '-b', '--boot'])
        ? READ_ONLY
        : mutating('hostname <name> changes the hostname');
    case 'date':
      return hasAnyFlag(rest, ['-s', '--set']) ? mutating('date -s changes the clock') : READ_ONLY;
    case 'sort':
      if (tokens.some((t) => t.includes('{'))) {
        return mutating('sort with a script block (PowerShell) cannot be verified as read-only');
      }
      return hasAnyFlag(rest, ['-o', '--output']) ? mutating('sort -o writes a file') : READ_ONLY;
    case 'tree':
      return hasAnyFlag(rest, ['-o']) ? mutating('tree -o writes a file') : READ_ONLY;
    case 'xxd':
      return positionalsOf(rest).length >= 2 ? mutating('xxd <in> <out> writes a file') : READ_ONLY;
    case 'ss':
      return hasAnyFlag(rest, ['-K', '--kill']) ? mutating('ss -K kills sockets') : READ_ONLY;
    case 'uniq':
      return positionalsOf(rest).length >= 2
        ? mutating('uniq <in> <out> writes a file')
        : READ_ONLY;
    case 'yq':
      return hasAnyFlag(rest, ['-i', '--inplace'])
        ? mutating('yq -i edits files in place')
        : READ_ONLY;
    case 'find': {
      const action = rest.find((t) =>
        [
          '-delete',
          '-exec',
          '-execdir',
          '-ok',
          '-okdir',
          '-fprint',
          '-fprint0',
          '-fprintf',
          '-fls',
        ].includes(t),
      );
      return action ? mutating(`find ${action} changes files or runs commands`) : READ_ONLY;
    }
    case 'sed':
      return sedVerdict(rest);
    case 'awk':
    case 'gawk':
    case 'mawk':
      return awkVerdict(rest);
    case 'curl':
      return curlVerdict(name, rest);
    case 'wget':
      return wgetVerdict(rest);
    case 'aws':
    case 'az':
    case 'gcloud':
      return cloudVerdict(name, rest);
    default:
      return mutating(`\`${invocation.name}\` is not a known read-only command`);
  }
}

/**
 * Redirecciones inocuas que se retiran antes de analizar: duplicar un
 * descriptor (`2>&1`) y descartar a `/dev/null`, `$null` o `NUL`.
 */
const HARMLESS_REDIRECTS = /(?:\d|\*)?>>?\s*(?:&\d+|\/dev\/null\b|\$null\b|NUL\b)|\d?<&\d+/gi;

/** El comando con el contenido entrecomillado vaciado (para buscar operadores reales). */
function unquotedShape(command: string): string {
  let out = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        out += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

/**
 * ¿Solo observa este comando? Todos los segmentos (`;`, `&&`, `|`) tienen que
 * ser lectores conocidos y ninguno puede redirigir a un fichero.
 */
export function readOnlyCommandVerdict(command: string): ReadOnlyVerdict {
  const trimmed = command.trim();
  if (!trimmed) return mutating('empty command');

  // Sustitución de comandos y de procesos: ejecutan algo que no se ve aquí,
  // también dentro de comillas dobles. El backtick es además el escape de
  // PowerShell, así que se rechaza sin distinguir.
  if (/\$\(|`|<\(|>\(/.test(trimmed)) {
    return mutating('command or process substitution cannot be verified as read-only');
  }

  const cleaned = trimmed.replace(HARMLESS_REDIRECTS, ' ');
  if (/>/.test(unquotedShape(cleaned))) {
    return mutating('output redirection writes a file');
  }
  // Heredocs y here-strings alimentan a un comando: se analizan como stdin, no
  // escriben, pero `<<` delante de un intérprete sería código inline.
  if (/<</.test(unquotedShape(cleaned))) {
    return mutating('here-documents cannot be verified as read-only');
  }

  const segments = splitCommandSegments(cleaned);
  if (segments.length === 0) return mutating('empty command');
  for (const segment of segments) {
    const verdict = segmentVerdict(tokenize(segment));
    if (!verdict.readOnly) return verdict;
  }
  return READ_ONLY;
}
