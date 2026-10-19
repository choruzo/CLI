/**
 * Invariantes de arquitectura de Stratum Desktop desde M12, comprobadas sobre
 * el código (`docs/STRATUM_CLIENT_ARCHITECTURE.md`): Desktop es un **cliente**
 * de `stratumd`, hermano de la CLI y de Dot.
 *
 *   interfaz ≠ runtime ≠ autoridad · cliente pide → stratumd arbitra → SessionHost ejecuta
 *
 * Que no vuelva a aparecer un runtime de agente, un plano de control propio,
 * un sidecar, un RPC genérico, acceso directo al almacén del daemon ni
 * autoridad de aprobar sin el broker nativo.
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(DESKTOP, '..');
const SRC = join(DESKTOP, 'src');
const TAURI = join(DESKTOP, 'src-tauri');
const CLI = join(REPO, 'stratum-cli');
const CLI_SRC = join(CLI, 'src');

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'target', 'gen', 'dist'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const isTest = (file: string) => /\.test\.tsx?$/.test(file);
const frontend = walk(SRC, (f) => /\.tsx?$/.test(f));
const shipped = frontend.filter((f) => !isTest(f));
const rust = walk(join(TAURI, 'src'), (f) => f.endsWith('.rs'));
const read = (file: string) => readFileSync(file, 'utf-8');
const rel = (file: string) => relative(REPO, file).split(sep).join('/');

/** Código sin comentarios: las reglas van sobre lo que se ejecuta. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Rust sin su módulo de tests. */
function rustCode(file: string): string {
  return code(file).replace(/#\[cfg\(test\)\][\s\S]*$/, '');
}

function imports(file: string): string[] {
  const text = code(file);
  const out: string[] = [];
  for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of text.matchAll(/import\s+['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base;
}

/** Lo que el webview usa del core, por fichero (sin los tests). */
function coreImports(files: string[]): Set<string> {
  const used = new Set<string>();
  for (const file of files) {
    for (const spec of imports(file)) {
      const target = resolveImport(file, spec);
      if (target?.startsWith(CLI + sep)) used.add(relative(CLI_SRC, target).split(sep).join('/'));
    }
  }
  return used;
}

describe('el webview solo conoce el contrato', () => {
  it('del core importa el Stratum Protocol (y la paleta del tema), nada del runtime', () => {
    expect([...coreImports(shipped)].sort()).toEqual([
      'cli/ui/theme.ts',
      'protocol/index.ts',
      'protocol/schemas.ts',
    ]);
    // Los tests, además, los ejemplos del contrato.
    const inTests = [...coreImports(frontend.filter(isTest))].filter(
      (p) => !p.startsWith('protocol/') && p !== 'cli/ui/theme.ts',
    );
    expect(inTests).toEqual([]);
  });

  it('ningún fichero nombra el interior del harness ni el del sidecar retirado', () => {
    const forbidden =
      /\b(SessionHost|StratumAgent|ReactLoop|ToolDispatcher|RunRegistry|EventHub|ApprovalCenter|PauseController|Stratumd|SessionPublisher|ConversationStore|SessionMemory|ConversationHost|TurnScheduler|DesktopSessionStore)\b/;
    const hits = [...shipped, ...rust.map((f) => f)].filter((f) =>
      forbidden.test(f.endsWith('.rs') ? rustCode(f) : code(f)),
    );
    expect(hits.map(rel)).toEqual([]);
  });

  it('no lee el almacén del daemon: lo de M11 llega por `sessions.history|context|memory`', () => {
    const daemonStore = /\.stratum[\\/]+daemon|daemon[\\/]+sessions|endpoint\.json|approver\.json/;
    const hits = [...shipped.filter((f) => daemonStore.test(code(f))), ...rust.filter((f) => daemonStore.test(rustCode(f)))];
    expect(hits.map(rel)).toEqual([]);
  });

  it('el estado de las sesiones sale del reductor del contrato: Desktop no tiene otro', () => {
    // Un reductor propio tendría un `switch` por tipo de evento que toca la foto.
    const reducers = shipped.filter((f) => {
      const text = code(f);
      return /case '(run|tool|message)\.[a-z_]+'/.test(text);
    });
    expect(reducers.map(rel)).toEqual([]);
    const store = code(join(SRC, 'client', 'protocol-store.ts'));
    expect(store).toContain('followSession(');
    expect(store).toContain('applyOverviewEvent(');
  });

  it('una sola frontera con Rust para el daemon, tipada y sin método genérico', () => {
    const native = code(join(SRC, 'ipc', 'native.ts'));
    const commands = [...native.matchAll(/invoke(?:<[^>]*>)?\('([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(commands).toEqual([
      'desktop_attach',
      'desktop_cancel_run',
      'desktop_close_session',
      'desktop_context',
      'desktop_focus_session',
      'desktop_history',
      'desktop_list_models',
      'desktop_memory',
      'desktop_new_chat',
      'desktop_open_config',
      'desktop_pause_run',
      'desktop_prefs',
      'desktop_resume_run',
      'desktop_resync_session',
      'desktop_retry',
      'desktop_set_model',
      'desktop_start_run',
      'desktop_steer_run',
    ]);
    // Nadie más habla con Rust de sesiones; nadie envía «un método cualquiera».
    for (const file of shipped) {
      if (file.endsWith(`${sep}native.ts`)) continue;
      expect(/invoke\(\s*['"]desktop_/.test(code(file)), rel(file)).toBe(false);
      expect(/sidecar_|send_frame|sendFrame|\bmethod:\s*string/.test(code(file)), rel(file)).toBe(false);
    }
    // Las credenciales y el canal son de Rust: el webview no los nombra.
    const leaks = shipped.filter((f) => /(endpoint|ipcPath|approverKey|connectionToken)/.test(code(f)));
    expect(leaks.map(rel)).toEqual([]);
  });
});

describe('el lado nativo es un cliente, no un runtime', () => {
  const lib = rustCode(join(TAURI, 'src', 'lib.rs'));

  it('no hay sidecar: ni módulos, ni binario empaquetado, ni procesos propios', () => {
    for (const gone of ['sidecar.rs', 'supervisor.rs', 'transport.rs', 'ipc.rs']) {
      expect(existsSync(join(TAURI, 'src', gone)), gone).toBe(false);
    }
    const conf = JSON.parse(read(join(TAURI, 'tauri.conf.json')));
    expect(conf.bundle.externalBin).toBeUndefined();
    expect(conf.bundle.resources).toBeUndefined();
    // Ningún proceso propio: el daemon lo arranca el comando oficial (`dot_link::launcher`).
    for (const file of rust) {
      expect(/std::process::Command|tokio::process|Command::new/.test(rustCode(file)), rel(file)).toBe(false);
    }
    expect(existsSync(join(CLI_SRC, 'desktop'))).toBe(false);
    expect(existsSync(join(CLI_SRC, 'desktop-server.ts'))).toBe(false);
    expect(existsSync(join(DESKTOP, 'scripts', 'build-sea.mjs'))).toBe(false);
  });

  it('el enlace es el compartido con Dot, con el perfil de Desktop', () => {
    const manifest = read(join(TAURI, 'Cargo.toml'));
    expect(manifest).toMatch(/dot-link\s*=\s*\{\s*path\s*=\s*"\.\.\/\.\.\/stratum-dot\/crates\/dot-link"/);
    expect(lib).toContain('ClientProfile::DESKTOP');
    expect(lib).not.toContain('ClientProfile::DOT');
    // El mecanismo oficial de los clientes: descubrir y, si no hay, `stratum daemon start`.
    expect(lib).toContain('default_endpoint_dir()');
    expect(lib).toContain('CliLauncher::from_env_var');
  });

  it('cerrar Desktop no apaga el daemon ni cierra sesiones; no hay nada que apruebe', () => {
    for (const file of rust) {
      const text = rustCode(file);
      expect(/core\.shutdown|"core\.|"runs\.|"sessions\.|"approvals\./.test(text), rel(file)).toBe(false);
      expect(/approver|ApproverSecret|spawn_broker|ApproverAction|ConfirmGate/.test(text), rel(file)).toBe(false);
      expect(/"host"|"broker"/.test(text), rel(file)).toBe(false);
    }
    // En la salida se suelta el enlace, y nada más.
    const exit = lib.slice(lib.indexOf('RunEvent::Exit'));
    expect(exit).toContain('link.shutdown()');
  });

  it('cada comando que pide el webview está registrado y es uno de la lista blanca', () => {
    const registered = [...lib.matchAll(/commands::(desktop_[a-z_]+)/g)].map((m) => m[1]!).sort();
    const declared = [...rustCode(join(TAURI, 'src', 'commands.rs')).matchAll(/pub (?:async )?fn (desktop_[a-z_]+)/g)]
      .map((m) => m[1]!)
      .sort();
    expect(registered).toEqual(declared);
    const native = code(join(SRC, 'ipc', 'native.ts'));
    const asked = [...native.matchAll(/'(desktop_[a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(asked).toEqual(declared);
  });
});
