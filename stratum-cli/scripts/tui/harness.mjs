/**
 * Arnés para manejar la TUI de Stratum como la vería un usuario: lanza
 * `dist/index.js` en un pseudo-terminal real (ConPTY en Windows) y pasa su
 * salida por un emulador de terminal sin ventana, del que se lee la pantalla
 * ya renderizada (texto y color de cada celda).
 *
 * HOME y proyecto son temporales: no toca `~/.stratum` ni la config real.
 * Lanza el build (`npm run build` antes, tras cualquier cambio en `src/`).
 * Uso y trampas en `README.md`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from '@lydell/node-pty';
import xterm from '@xterm/headless';

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(CLI_ROOT, 'dist', 'index.js');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const KEYS = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  space: ' ',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl+c': '\x03',
  'ctrl+l': '\x0c',
  'ctrl+t': '\x14',
  'ctrl+u': '\x15',
};

/**
 * Lanza `stratum <args>` en un terminal de `cols`×`rows`.
 * - `config`: objeto que se escribe como `.stratumrc.json` global (o `null`).
 * - `files`: `{ 'ruta/relativa': 'contenido' }` a crear en el proyecto temporal.
 * - `env`: variables extra para el proceso.
 */
export function launch({
  config = null,
  args = ['chat'],
  cols = 110,
  rows = 40,
  files = {},
  env = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stratum-tui-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.stratum'), { recursive: true });
  mkdirSync(project, { recursive: true });
  if (config) {
    writeFileSync(join(home, '.stratum', '.stratumrc.json'), JSON.stringify(config, null, 2));
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(project, rel)), { recursive: true });
    writeFileSync(join(project, rel), content);
  }

  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    ...env,
  };
  delete childEnv.NO_COLOR;

  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  const child = pty.spawn(process.execPath, [ENTRY, ...args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: project,
    env: childEnv,
  });
  let raw = '';
  let exited = null;
  let closed = false;
  child.onData((d) => {
    raw += d;
    term.write(d);
  });
  child.onExit((e) => {
    exited = e;
  });
  // Respuestas del emulador a las consultas del terminal (DSR, DA…).
  term.onData((d) => {
    if (!exited) child.write(d);
  });

  const lines = (all) => {
    const buf = term.buffer.active;
    const from = all ? 0 : buf.viewportY;
    const to = all ? buf.length : buf.viewportY + term.rows;
    const out = [];
    for (let y = from; y < to; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '');
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  };

  const t = {
    root,
    home,
    project,
    /** Lo que se ve ahora mismo en la ventana del terminal. */
    screen: () => lines(false).join('\n'),
    /** Las últimas `n` líneas de la pantalla. */
    tail: (n) => lines(false).slice(-n).join('\n'),
    /** Pantalla + todo lo que ya subió al scrollback. */
    scrollback: () => lines(true).join('\n'),
    /** Bytes crudos emitidos por el proceso (secuencias ANSI incluidas). */
    raw: () => raw,
    /** `{ exitCode }` cuando el proceso ha terminado; `null` mientras vive. */
    exited: () => exited,

    /** Estilo de la primera celda de `needle` en pantalla, o `null` si no está. */
    styleOf(needle) {
      const buf = term.buffer.active;
      for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
        const line = buf.getLine(y);
        const x = line ? line.translateToString(false).indexOf(needle) : -1;
        if (x < 0) continue;
        const c = line.getCell(x);
        const hex = (n) => '#' + n.toString(16).padStart(6, '0');
        return {
          fg: c.isFgRGB() ? hex(c.getFgColor()) : c.isFgPalette() ? c.getFgColor() : 'default',
          bg: c.isBgRGB() ? hex(c.getBgColor()) : c.isBgPalette() ? c.getBgColor() : 'default',
          bold: !!c.isBold(),
          dim: !!c.isDim(),
          inverse: !!c.isInverse(),
        };
      }
      return null;
    },

    /** Teclea carácter a carácter: Ink trata un bloque de bytes como un pegado. */
    async type(value, delay = 30) {
      for (const ch of value) {
        child.write(ch);
        await sleep(delay);
      }
    },
    /** Pulsa una tecla de `KEYS` (o una secuencia cruda) `times` veces. */
    async key(name, times = 1) {
      for (let i = 0; i < times; i++) {
        child.write(KEYS[name] ?? name);
        await sleep(120);
      }
    },
    /** Teclea y pulsa Enter. */
    async submit(value) {
      await t.type(value);
      await sleep(150);
      await t.key('enter');
    },
    /** Pega un bloque de una vez (lo que hace el terminal con un pegado real). */
    paste(value) {
      child.write(value);
    },
    resize(c, r) {
      child.resize(c, r);
      term.resize(c, r);
    },

    /** Espera a que la pantalla case con `re`. Lanza con la pantalla si no llega. */
    async waitFor(re, ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (re.test(t.screen())) return;
        if (exited) break;
        await sleep(50);
      }
      const why = exited ? `el proceso terminó (${JSON.stringify(exited)})` : `timeout de ${ms} ms`;
      throw new Error(`waitFor ${re}: ${why}\n--- pantalla ---\n${t.screen()}`);
    },
    /** Espera a que `re` deje de estar en pantalla. */
    async waitGone(re, ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (!re.test(t.screen())) return;
        await sleep(50);
      }
      throw new Error(`waitGone ${re}: timeout de ${ms} ms\n--- pantalla ---\n${t.screen()}`);
    },
    /** Espera a que el proceso termine y devuelve su exit code. */
    async waitExit(ms = 15000) {
      const t0 = Date.now();
      while (!exited && Date.now() - t0 < ms) await sleep(50);
      if (!exited)
        throw new Error(`waitExit: sigue vivo tras ${ms} ms\n--- pantalla ---\n${t.screen()}`);
      return exited.exitCode;
    },
    /** Espera al prompt de la pantalla de bienvenida. */
    waitForBanner: (ms) => t.waitFor(/Type your first message/, ms),
    /** Espera a que el turno termine y el input vuelva a estar libre. */
    async waitForIdle(ms = 30000) {
      await sleep(150);
      await t.waitGone(/Stratum is thinking\.\.\./, ms);
    },

    /** Imprime la pantalla con una etiqueta (para mirarla desde un script). */
    shot(label, { last } = {}) {
      const body = last ? t.tail(last) : t.screen();
      console.log(`\n┌───── ${label}\n${body}\n└─────`);
    },
    /** Líneas del log JSONL (`logging.file.enabled` en la config), ya parseadas. */
    logs() {
      const dir = join(home, '.stratum', 'logs');
      let names = [];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      } catch {
        return [];
      }
      return names.flatMap((n) =>
        readFileSync(join(dir, n), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return { raw: l };
            }
          }),
      );
    },

    /** Mata el proceso y borra el directorio temporal. */
    async close() {
      if (closed) return;
      closed = true;
      if (!exited) {
        try {
          child.kill();
        } catch {
          // ya había muerto
        }
        const t0 = Date.now();
        while (!exited && Date.now() - t0 < 3000) await sleep(50);
      }
      term.dispose();
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(root, { recursive: true, force: true });
          return;
        } catch {
          await sleep(200); // Windows: el proceso tarda en soltar el cwd
        }
      }
    },
  };
  return t;
}
