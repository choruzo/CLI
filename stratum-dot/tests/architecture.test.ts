/**
 * Invariantes de arquitectura de Stratum Dot, comprobadas sobre el código:
 * Dot es un cliente del Stratum Protocol y nada más.
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(DOT, 'src');
const CLI_SRC = resolve(DOT, '..', 'stratum-cli', 'src');
const CLI_PROTOCOL = join(CLI_SRC, 'protocol');

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name === 'gen') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const isTest = (file: string) => /\.test\.tsx?$/.test(file) || file.includes(`${sep}testing${sep}`);
const frontend = walk(SRC, (f) => /\.tsx?$/.test(f));
const shipped = frontend.filter((f) => !isTest(f));
const rust = [...walk(join(DOT, 'crates'), (f) => f.endsWith('.rs')), ...walk(join(DOT, 'src-tauri', 'src'), (f) => f.endsWith('.rs'))];
const rustShipped = rust.filter((f) => !f.includes(`${sep}tests${sep}`));
const read = (file: string) => readFileSync(file, 'utf-8');
const rel = (file: string) => relative(DOT, file).split(sep).join('/');

/** Código sin comentarios: las reglas van sobre lo que se ejecuta, no sobre lo que se explica. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Rust sin su módulo de tests (que va al final del fichero). */
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

describe('Dot solo conoce el contrato', () => {
  it('lo único que importa de stratum-cli es `src/protocol/`', () => {
    const outside: string[] = [];
    for (const file of frontend) {
      for (const spec of imports(file)) {
        const target = resolveImport(file, spec);
        if (!target || !target.startsWith(resolve(DOT, '..', 'stratum-cli'))) continue;
        if (!target.startsWith(CLI_PROTOCOL + sep)) outside.push(`${rel(file)} → ${spec}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('lo que entra en la app es `protocol/index` y `protocol/schemas`, nada más', () => {
    const used = new Set<string>();
    for (const file of shipped) {
      for (const spec of imports(file)) {
        const target = resolveImport(file, spec);
        if (target?.startsWith(CLI_PROTOCOL + sep)) used.add(relative(CLI_PROTOCOL, target));
      }
    }
    expect([...used].sort()).toEqual(['index.ts', 'schemas.ts']);
  });

  it('y desde ahí no se alcanza el runtime, ni de forma transitiva', () => {
    const seen = new Set<string>();
    const queue = [join(CLI_PROTOCOL, 'index.ts'), join(CLI_PROTOCOL, 'schemas.ts')];
    const bare = new Set<string>();
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of imports(file)) {
        const target = resolveImport(file, spec);
        if (!target) bare.add(spec);
        else queue.push(target);
      }
    }
    const escaped = [...seen].filter((f) => !f.startsWith(CLI_PROTOCOL + sep));
    expect(escaped).toEqual([]);
    // Ni Node ni nada más que la librería de validación.
    expect([...bare]).toEqual(['zod']);
  });

  it('ningún fichero nombra el interior del harness', () => {
    const forbidden = /\b(SessionHost|StratumAgent|ReactLoop|ToolDispatcher|RunRegistry|EventHub|ApprovalCenter|PauseController|Stratumd|SessionPublisher)\b/;
    const hits = [...shipped.filter((f) => forbidden.test(code(f))), ...rustShipped.filter((f) => forbidden.test(rustCode(f)))];
    expect(hits.map(rel)).toEqual([]);
  });

  it('el reductor es el del contrato: Dot no tiene otro', () => {
    const apply = code(join(SRC, 'protocol', 'apply.ts'));
    expect(apply).toContain('applySessionEvent(');
    // Un reductor propio tendría un `switch` por tipo de evento que toca la foto.
    const reducers = shipped.filter((f) => {
      const text = code(f);
      return /case '(run|tool|session|approval|message)\.[a-z_]+'/.test(text) && /\b(toolCalls|approvals|partial)\s*[:=]/.test(text);
    });
    expect(reducers.map(rel)).toEqual([]);
    // En Rust tampoco: ni se nombra un tipo de evento de run, tool o mensaje.
    const rustReducers = rustShipped.filter((f) => /"(run|tool|message|approval)\.[a-z_]+"/.test(rustCode(f)));
    expect(rustReducers.map(rel)).toEqual([]);
  });
});

describe('la frontera con el lado nativo', () => {
  const native = join(SRC, 'bridge', 'native.ts');

  it('solo `bridge/native.ts` habla con Tauri', () => {
    const users = shipped.filter((f) => imports(f).some((spec) => spec.startsWith('@tauri-apps/')));
    expect(users.map(rel)).toEqual(['src/bridge/native.ts']);
  });

  it('no hay RPC genérico: cada comando es un literal, y son los que Rust registra', () => {
    const text = code(native);
    const calls = [...text.matchAll(/\binvoke(?:<[^>]*>)?\(\s*([^,)]+)/g)].map((m) => m[1]!.trim());
    expect(calls.length).toBeGreaterThan(0);
    // Todos literales: no hay `invoke(method, …)` con un nombre que venga de fuera.
    expect(calls.filter((c) => !/^'dot_[a-z_]+'$/.test(c))).toEqual([]);
    const invoked = [...new Set(calls.map((c) => c.slice(1, -1)))].sort();

    const lib = code(join(DOT, 'src-tauri', 'src', 'lib.rs'));
    const registered = [...lib.matchAll(/commands::(dot_[a-z_]+)/g)].map((m) => m[1]!).sort();
    expect(invoked).toEqual(registered);
    expect(registered).toEqual([
      'dot_attach',
      'dot_cancel_run',
      'dot_focus_session',
      'dot_hide',
      'dot_list_agents',
      'dot_list_models',
      'dot_open_session',
      'dot_pause_run',
      'dot_quit',
      'dot_resume_run',
      'dot_resync_session',
      'dot_retry',
      'dot_start_run',
      'dot_steer_run',
    ]);
  });

  it('una sesión se abre sin entorno, sin `resume` y sin nada del sistema de ficheros', () => {
    const commands = rustCode(join(DOT, 'src-tauri', 'src', 'commands.rs'));
    const open = /pub async fn dot_open_session\(([\s\S]*?)\) ->/.exec(commands)?.[1] ?? '';
    const params = [...open.matchAll(/(\w+): (?:Option<String>|String)/g)].map((m) => m[1]);
    // Lo que el webview puede pedir al abrir: cuatro textos opcionales, y ninguno es un `env`.
    expect(params).toEqual(['cwd', 'agent', 'provider', 'model']);
    for (const file of rustShipped) {
      const text = rustCode(file);
      expect(/"env"|"resume"\s*:|"readOnly"|"sessionProfile"/.test(text), rel(file)).toBe(false);
      // El directorio viaja como texto: Dot no lo abre, no lo lista y no lo comprueba.
      if (!file.endsWith(`${sep}discovery.rs`) && !file.endsWith(`${sep}log.rs`) && !file.endsWith(`${sep}launcher.rs`)) {
        expect(/std::fs::|read_dir|tokio::fs::/.test(text), `${rel(file)} toca el sistema de ficheros`).toBe(false);
      }
    }
    const native = code(join(SRC, 'bridge', 'native.ts'));
    expect(native).not.toMatch(/\benv\b/);
  });

  it('el webview no tiene más permisos que los de por defecto', () => {
    const capability = JSON.parse(read(join(DOT, 'src-tauri', 'capabilities', 'default.json')));
    expect(capability.permissions).toEqual(['core:default']);
    const conf = JSON.parse(read(join(DOT, 'src-tauri', 'tauri.conf.json')));
    // Sin red: el webview solo habla con el lado nativo.
    expect(conf.app.security.csp).toContain("default-src 'self'");
    expect(conf.app.security.csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
    // Sin sidecar ni binarios externos: Dot no empaqueta un runtime.
    expect(conf.bundle.externalBin).toBeUndefined();
    expect(conf.bundle.resources).toBeUndefined();
  });

  it('el frontend no lee el endpoint, ni conoce credenciales, ni usa Node', () => {
    const banned: Array<[RegExp, string]> = [
      [/endpoint\.json|ipcPath|endpointDir/, 'el endpoint del daemon'],
      [/approverKey|approver_key/, 'la clave de aprobador'],
      [/core\.shutdown|core\.hello/, 'métodos que solo envía (o nunca envía) el lado nativo'],
      [/sessions\.close|sessions\.set/, 'cerrar o reconfigurar una sesión'],
      [/apiKey|baseUrl|api_key|base_url/, 'la configuración de un provider'],
      [/\.stratumrc|STRATUM\.md|\.stratum[/\\]/, 'ficheros de configuración de Stratum'],
      [/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/, 'HTML sin escapar'],
      [/\bprocess\.env\b|\brequire\(|from 'node:|from 'fs'|from 'net'|from 'os'|from 'path'/, 'Node'],
      [/\bfetch\(|XMLHttpRequest|WebSocket/, 'red'],
    ];
    const hits: string[] = [];
    for (const file of shipped) {
      const text = code(file);
      for (const [pattern, what] of banned) if (pattern.test(text)) hits.push(`${rel(file)}: ${what}`);
    }
    expect(hits).toEqual([]);
    // «token» solo aparece como uso de tokens del modelo (un contador), nunca como credencial.
    for (const file of shipped) {
      const stripped = code(file).replace(/tokensLabel|session\.tokens|tokens\.(status|total)|\{ tokens \}|Tokens/g, '');
      expect(/token/i.test(stripped), rel(file)).toBe(false);
    }
  });

  it('lo único que se guarda entre arranques son dos preferencias de interfaz', () => {
    const users = shipped.filter((f) => /localStorage|sessionStorage|indexedDB/.test(code(f)));
    expect(users.map(rel)).toEqual(['src/stores/uiStore.ts']);
    const ui = code(join(SRC, 'stores', 'uiStore.ts'));
    // El almacenamiento solo se toca en dos funciones, y solo con estas dos claves.
    expect(ui.match(/localStorage/g)).toHaveLength(3);
    const written = [...ui.matchAll(/writePreference\(\s*([A-Z_]+)/g)].map((m) => m[1]);
    const read = [...ui.matchAll(/readPreference\(\s*([A-Z_]+)/g)].map((m) => m[1]);
    expect(new Set([...written, ...read])).toEqual(new Set(['SELECTED_KEY', 'LAST_CWD_KEY']));
    const names = [...ui.matchAll(/'(stratum-dot\.[A-Za-z]+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual(['stratum-dot.lastCwd', 'stratum-dot.selectedSession']);
  });

  it('la conversación no se guarda ni se reconstruye en Dot: sale de la foto', () => {
    const ui = code(join(SRC, 'stores', 'uiStore.ts'));
    // Lo que se persiste nunca es un mensaje, un borrador ni una foto.
    for (const m of ui.matchAll(/writePreference\(([^)]*)\)/g)) {
      expect(/draft|message|snapshot|text\b/i.test(m[1]!), m[0]).toBe(false);
    }
    // Nadie trata los eventos de mensaje por su cuenta, salvo el registro de actividad (que solo los nombra).
    const handlers = shipped.filter((f) => /'message\.(delta|completed)'/.test(code(f)));
    expect(handlers.map(rel)).toEqual(['src/protocol/activity.ts']);
    // El transcript se pinta de `snapshot.messages`: no hay un store de mensajes.
    const stores = walk(join(SRC, 'stores'), (f) => f.endsWith('.ts')).map(code).join('\n');
    expect(stores).not.toMatch(/\bmessages\s*[:=]\s*\[/);
    const transcript = code(join(SRC, 'components', 'Transcript.tsx'));
    expect(transcript).toMatch(/const \{ messages, messagesTruncated, partial \} = snapshot;/);
  });
});

describe('el lado nativo', () => {
  const link = join(DOT, 'crates', 'dot-link');

  it('el cliente del protocolo no depende de Tauri', () => {
    const manifest = read(join(link, 'Cargo.toml'));
    expect(manifest).not.toMatch(/tauri/);
    const users = walk(join(link, 'src'), (f) => f.endsWith('.rs')).filter((f) => /\btauri::/.test(code(f)));
    expect(users).toEqual([]);
  });

  it('los nombres de método solo salen de la lista cerrada de `wire.rs`', () => {
    const wire = rustCode(join(link, 'src', 'wire.rs'));
    const names = [...wire.matchAll(/=> "([a-z]+\.[a-zA-Z]+)"/g)].map((m) => m[1]);
    // De `sessions.*` solo abrir; de `runs.*`, iniciar y gobernar. Ni cerrar, ni apagar, ni aprobar.
    expect(names.sort()).toEqual([
      'agents.list',
      'core.hello',
      'events.subscribe',
      'events.unsubscribe',
      'models.list',
      'runs.cancel',
      'runs.pause',
      'runs.resume',
      'runs.start',
      'runs.steer',
      'sessions.open',
    ]);
    // Fuera de `wire.rs` nadie escribe un método a mano.
    const method = /"(core|sessions|runs|approvals|questions|plans|jobs|host|memory|agents|models|trace)\.[a-zA-Z]+"/;
    const strays = rustShipped.filter((f) => !f.endsWith(`${sep}wire.rs`) && method.test(rustCode(f)));
    expect(strays.map(rel)).toEqual([]);
  });

  it('Dot no apaga el daemon, no aprueba y no pide más rol que `operator`', () => {
    for (const file of rustShipped) {
      const text = rustCode(file);
      expect(/core\.shutdown|approvals\.resolve|questions\.answer|plans\.decide/.test(text), rel(file)).toBe(false);
      // Cerrar Dot (o una vista) no cierra sesiones: el método ni existe aquí.
      expect(/"(sessions\.close|sessions\.set\w*|jobs\.cancel)"/.test(text), rel(file)).toBe(false);
      expect(/"approver"|"host"|"broker"|approverKey/.test(text), rel(file)).toBe(false);
    }
    expect(rustCode(join(link, 'src', 'link.rs'))).toContain('"roles": ["operator"]');
  });

  it('sin TCP ni HTTP: el canal es el pipe que publica el daemon', () => {
    const hits = rustShipped.filter((f) => /TcpStream|TcpListener|127\.0\.0\.1|localhost:|reqwest|hyper::/.test(rustCode(f)));
    expect(hits.map(rel)).toEqual([]);
  });

  it('Dot no escribe el endpoint ni lanza un daemon por su cuenta', () => {
    for (const file of rustShipped) {
      const text = rustCode(file);
      // El endpoint solo se lee.
      if (/ENDPOINT_FILE|endpoint\.json/.test(text)) {
        expect(/fs::write|File::create|OpenOptions/.test(text), `${rel(file)} escribe junto al endpoint`).toBe(false);
      }
    }
    const launcher = rustCode(join(link, 'src', 'launcher.rs'));
    // El único arranque es el comando oficial.
    expect(launcher).toContain('"daemon".to_string(), "start".to_string()');
    expect(launcher).not.toMatch(/"run"|daemon run/);
  });
});
