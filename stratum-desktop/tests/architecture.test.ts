/**
 * Invariantes de arquitectura de Stratum Desktop desde M12, comprobadas sobre
 * el código (`docs/STRATUM_CLIENT_ARCHITECTURE.md`): Desktop es un **cliente**
 * de `stratumd`, hermano de la CLI y de Dot.
 *
 *   interfaz ≠ runtime ≠ autoridad · cliente pide → stratumd arbitra → SessionHost ejecuta
 *
 * Que no vuelva a aparecer un runtime de agente, un plano de control propio,
 * un sidecar, un RPC genérico, acceso directo al almacén del daemon ni
 * autoridad de aprobar fuera del broker nativo y su confirmación (las mismas
 * piezas que Stratum Dot: `dot_link::approver` y `dot_link::confirm`).
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
  it('del core importa el Stratum Protocol (y la paleta y las frases de espera), nada del runtime', () => {
    expect([...coreImports(shipped)].sort()).toEqual([
      'cli/ui/theme.ts',
      // Sin imports (ver CLAUDE.md): las frases del indicador, compartidas con la CLI.
      'cli/ui/thinking-phrases.ts',
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
      'desktop_answer_questions',
      'desktop_approve',
      'desktop_approver_lock',
      'desktop_approver_status',
      'desktop_approver_unlock',
      'desktop_attach',
      'desktop_cancel_run',
      'desktop_close_session',
      'desktop_context',
      'desktop_decide_plan',
      'desktop_deny',
      'desktop_focus_session',
      'desktop_history',
      'desktop_list_models',
      'desktop_list_skills',
      'desktop_memory',
      'desktop_memory_decisions',
      'desktop_memory_forget',
      'desktop_new_chat',
      'desktop_open_config',
      'desktop_pause_run',
      'desktop_prefs',
      'desktop_resume_run',
      'desktop_resync_session',
      'desktop_retry',
      'desktop_save_pasted_image',
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

  it('cerrar Desktop no apaga el daemon ni cierra sesiones, y suelta la autoridad de aprobar', () => {
    for (const file of rust) {
      const text = rustCode(file);
      // Los métodos los nombra `dot_link::wire`; aquí ninguno a mano.
      expect(/core\.shutdown|"core\.|"runs\.|"sessions\.|"approvals\./.test(text), rel(file)).toBe(false);
      expect(/"host"|"broker"/.test(text), rel(file)).toBe(false);
    }
    // En la salida se sueltan las dos conexiones y se cancela la confirmación abierta, nada más.
    const exit = lib.slice(lib.indexOf('RunEvent::Exit'));
    expect(exit).toContain('link.shutdown()');
    expect(exit).toContain('broker.shutdown()');
    expect(exit).toContain('invalidate(CancelReason::Closing)');
    // El broker se presenta como Desktop (procedencia), con la misma conexión aparte que Dot.
    expect(lib).toMatch(/spawn_broker\(\s*ApproverConfig \{[\s\S]*?profile: ClientProfile::DESKTOP/);
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

describe('aprobar desde Desktop: las mismas piezas que Dot (M8/M9)', () => {
  const tauriSrc = join(TAURI, 'src');
  const buildCommands = [...rustCode(join(TAURI, 'build.rs')).matchAll(/"([a-z_]+)",/g)].map((m) => m[1]!).sort();

  it('cada comando está declarado en `build.rs` y solo la ventana principal tiene permiso', () => {
    const registered = [...rustCode(join(tauriSrc, 'lib.rs')).matchAll(/(?:commands|files|os|updates)::([a-z]+_[a-z_]+),/g)]
      .map((m) => m[1]!)
      .sort();
    expect(buildCommands).toEqual(registered);
    const dir = join(TAURI, 'capabilities');
    expect(readdirSync(dir)).toEqual(['default.json']);
    const capability = JSON.parse(read(join(dir, 'default.json')));
    expect(capability.windows).toEqual(['main']);
    const allowed = (capability.permissions as unknown[]).filter((p): p is string => typeof p === 'string' && p.startsWith('allow-'));
    expect(allowed.sort()).toEqual(buildCommands.map((c) => `allow-${c.replace(/_/g, '-')}`).sort());
    // Las ventanas de desbloqueo y confirmación no están en ninguna capacidad.
    expect(JSON.stringify(capability.windows)).not.toMatch(/unlock|confirm/);
  });

  it('la clave de aprobador solo la recibe la ventana de desbloqueo, nunca un comando ni el webview', () => {
    const makers = rust.filter((f) => /ApproverSecret::from_bytes/.test(rustCode(f))).map(rel);
    expect(makers).toEqual(['stratum-desktop/src-tauri/src/unlock.rs']);
    const commands = rustCode(join(tauriSrc, 'commands.rs'));
    expect(commands).not.toMatch(/ApproverSecret|\bkey: String|secret|password/i);
    expect(rustCode(join(tauriSrc, 'unlock.rs'))).toMatch(/ctx\.webview_label\(\) != WINDOW/);
    // Ningún campo de contraseña en el webview.
    for (const file of shipped) {
      expect(/type=["']password["']|type:\s*'password'|passphrase/i.test(code(file)), rel(file)).toBe(false);
    }
    // Las páginas nativas no cargan nada de fuera ni llaman a Tauri.
    for (const page of ['unlock/index.html', 'unlock/unlock.js', 'confirm/index.html', 'confirm/confirm.js']) {
      expect(read(join(TAURI, page))).not.toMatch(/https?:\/\/|__TAURI|invoke\(|innerHTML|localStorage/);
    }
  });

  it('lo sensible solo sale confirmado: un único `broker.resolve`, tras `needs_confirmation`', () => {
    const commands = rustCode(join(tauriSrc, 'commands.rs'));
    expect(commands.match(/\bbroker\s*\.resolve\(/g)?.length).toBe(1);
    expect(commands).toMatch(/if !action\.needs_confirmation\(\) \{\s*return state\.broker\.resolve\(action\)/);
    expect(commands).toMatch(/\.confirm\s*\.request\(/);
    expect(commands).toMatch(/resolve_confirmed\(confirmed\)/);
    // La frase no viaja desde el webview, ni una concesión con caducidad (revocarla es de Dot).
    const approve = /pub async fn desktop_approve<R: Runtime>\(([\s\S]*?)\) ->/.exec(commands)?.[1] ?? '';
    expect(approve).not.toMatch(/phrase|grant/);
    expect(commands).toMatch(/grant_minutes: None/);
    // Ningún comando confirma; solo la página nativa, y solo para su ventana.
    expect(commands).not.toMatch(/\.confirm\(&|ConfirmedAction/);
    const confirmers = rust.filter((f) => /\.confirm\(&link, &broker/.test(rustCode(f))).map(rel);
    expect(confirmers).toEqual(['stratum-desktop/src-tauri/src/confirm.rs']);
    const page = rustCode(join(tauriSrc, 'confirm.rs'));
    expect(page).toMatch(/nonce_of\(&label\)/);
    expect(page).toMatch(/current_nonce\(\)/);
    // Cada comando de aprobador se atiende solo desde la ventana principal.
    for (const name of ['desktop_approver_unlock', 'desktop_approver_lock', 'desktop_approve', 'desktop_deny', 'desktop_answer_questions', 'desktop_decide_plan']) {
      const body = new RegExp(`pub (?:async )?fn ${name}[<(][\\s\\S]*?\\{([\\s\\S]*?)\\n\\}`).exec(commands)?.[1] ?? '';
      expect(body, name).toContain('main_window(&window)?');
    }
  });

  it('en el webview, solo `client/approvals.ts` pide resolver, y solo desde un clic', () => {
    const resolvers = shipped.filter((f) => /\bnative\.(approve|deny|answerQuestions|decidePlan)\(/.test(code(f)));
    expect(resolvers.map(rel)).toEqual(['stratum-desktop/src/client/approvals.ts']);
    // Nadie resuelve al llegar algo: el puente solo guarda el estado del broker.
    const bridge = code(join(SRC, 'client', 'bridge.ts'));
    expect(bridge).not.toMatch(/resolver\(|\.approve\(|\.deny\(/);
    // Una sola tarjeta que resuelve.
    const cards = shipped.filter((f) => /\bresolver\(native,/.test(code(f))).map(rel);
    expect(cards).toEqual(['stratum-desktop/src/components/chat/PendingRequests.tsx']);
  });
});

describe('memoria global: la del asistente, y solo esa', () => {
  it('ni el webview ni un comando eligen de quién es la memoria: la fija el perfil del enlace', () => {
    const commands = rustCode(join(TAURI, 'src', 'commands.rs'));
    for (const name of ['desktop_memory_decisions', 'desktop_memory_forget']) {
      const signature = new RegExp(`pub async fn ${name}\\(([\\s\\S]*?)\\) ->`).exec(commands)?.[1] ?? '';
      expect(signature, name).not.toBe('');
      expect(signature, name).not.toMatch(/agent|cwd/);
    }
    const native = code(join(SRC, 'ipc', 'native.ts'));
    for (const call of native.matchAll(/invoke<unknown>\('desktop_memory_(?:decisions|forget)', (\{[^}]*\})\)/g)) {
      expect(call[1]).not.toMatch(/agent|cwd/);
    }
    expect(commands).not.toMatch(/"companion"/);
  });
});
