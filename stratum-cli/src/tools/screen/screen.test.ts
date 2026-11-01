import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StratumConfigSchema } from '../../config/schema.js';
import type { ToolContext, ToolDefinition } from '../../agent/types.js';
import type { ExecOutcome, ExecRequest } from '../exec/backend.js';
import { ExecConnectError } from '../exec/backend.js';

const runs: ExecRequest[] = [];
let respond: (req: ExecRequest) => ExecOutcome | Error;

vi.mock('../exec/backends/container.js', () => ({
  containerBackend: {
    kind: 'container',
    run: async (_target: unknown, req: ExecRequest) => {
      runs.push(req);
      const r = respond(req);
      if (r instanceof Error) throw r;
      return r;
    },
  },
}));

const { createScreenTools } = await import('./screen.js');
const { ScreenLocks } = await import('./lock.js');
const { SCREEN_TOOLS } = await import('./names.js');

function fakePng(width: number, height: number): string {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
  ]).toString('base64');
}

function outcome(stdout: string, exitCode = 0, stderr = ''): ExecOutcome {
  return { stdout, stderr, exitCode, status: 'exited' };
}

const config = StratumConfigSchema.parse({ box: { enabled: true } });

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: process.cwd(),
    config,
    vision: { coordinates: 'pixels' },
    ...overrides,
  };
}

let tools: Map<string, ToolDefinition>;
const tool = (name: string): ToolDefinition => tools.get(name)!;

beforeEach(() => {
  runs.length = 0;
  respond = (req) =>
    req.command.includes('getdisplaygeometry')
      ? outcome('1280 800\n')
      : outcome(fakePng(1280, 800));
  tools = new Map(createScreenTools({ kind: 'container', name: 'box' }).map((t) => [t.name, t]));
});

describe('createScreenTools', () => {
  it('crea las siete, con los nombres de SCREEN_TOOLS y en su orden', () => {
    expect([...tools.keys()]).toEqual(SCREEN_TOOLS);
  });

  it('sin visión declarada, preflight veta sin preguntar y sin contar como fallo', () => {
    for (const t of tools.values()) {
      const veto = t.preflight!({}, ctx({ vision: undefined }));
      expect(veto).toMatchObject({ ok: false, countsAsFailure: false });
    }
    expect(tool('screen_click').preflight!({ x: 1, y: 1 }, ctx())).toBeNull();
  });

  it('una captura devuelve la imagen aparte y solo metadatos en el texto', async () => {
    const r = await tool('screen_screenshot').execute({}, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.image).toMatchObject({ mime: 'image/png', width: 1280, height: 800 });
    expect(r.output).toContain('1280×800');
    expect(r.output).not.toContain(r.image!.data);
    expect(runs[0]!.command).toContain('import -window root png:-');
  });

  it('clic en píxeles: el punto entra como enteros y se captura en el mismo exec', async () => {
    const r = await tool('screen_click').execute({ x: 100.4, y: 200 }, ctx());
    expect(r.ok).toBe(true);
    expect(runs).toHaveLength(2); // geometría (primera vez) + acción con captura
    expect(runs[1]!.command).toContain('xdotool mousemove --sync 100 200 click 1');
    expect(runs[1]!.command).toMatch(/click 1 && sleep [\d.]+ && import/);
  });

  it('la geometría de la última captura se reutiliza: no se pregunta en cada clic', async () => {
    await tool('screen_screenshot').execute({}, ctx());
    await tool('screen_click').execute({ x: 5, y: 5 }, ctx());
    expect(runs.filter((r) => r.command.includes('getdisplaygeometry'))).toHaveLength(0);
  });

  it('clic norm1000: reescala a píxeles de la pantalla', async () => {
    const r = await tool('screen_click').execute(
      { x: 750, y: 250, button: 'right', double: true },
      ctx({ vision: { coordinates: 'norm1000' } }),
    );
    expect(r.ok).toBe(true);
    expect(runs.at(-1)!.command).toContain(
      'mousemove --sync 960 200 click --repeat 2 --delay 120 3',
    );
    if (r.ok) expect(r.output).toContain('(750, 250) → pixel (960, 200)');
  });

  it('un punto fuera de la pantalla no ejecuta la acción', async () => {
    const r = await tool('screen_click').execute({ x: 5000, y: 10 }, ctx());
    expect(r).toMatchObject({ ok: false, recoverable: true });
    expect(runs.some((q) => q.command.includes('mousemove'))).toBe(false);
  });

  it('el texto a escribir va por stdin, nunca en la línea de órdenes', async () => {
    const text = `hola'; rm -rf / #\n$(whoami)`;
    await tool('screen_type').execute({ text }, ctx());
    const run = runs.at(-1)!;
    expect(run.stdin).toBe(text);
    expect(run.command).not.toContain('whoami');
    expect(run.command).toContain('xdotool type --clearmodifiers --delay 12 --file -');
  });

  it('teclas: solo keysyms; cualquier otra cosa se rechaza sin ejecutar', async () => {
    const ok = await tool('screen_key').execute({ keys: 'ctrl+a BackSpace' }, ctx());
    expect(ok.ok).toBe(true);
    expect(runs.at(-1)!.command).toContain('xdotool key --clearmodifiers ctrl+a BackSpace');
    runs.length = 0;
    for (const keys of ['Return; reboot', 'ctrl+$(id)', 'a  b', '']) {
      const r = await tool('screen_key').execute({ keys }, ctx());
      expect(r.ok).toBe(false);
    }
    expect(runs).toHaveLength(0);
  });

  it('scroll: sobre un punto, o sin punto; nunca con solo una coordenada', async () => {
    await tool('screen_scroll').execute({ direction: 'down', x: 10, y: 20, amount: 3 }, ctx());
    expect(runs.at(-1)!.command).toContain(
      'mousemove --sync 10 20 && xdotool click --repeat 3 --delay 40 5',
    );
    await tool('screen_scroll').execute({ direction: 'up' }, ctx());
    expect(runs.at(-1)!.command).toContain('xdotool click --repeat 5 --delay 40 4');
    const r = await tool('screen_scroll').execute({ direction: 'up', x: 10 }, ctx());
    expect(r.ok).toBe(false);
  });

  it('wait: espera y captura', async () => {
    const r = await tool('screen_wait').execute({ seconds: 2 }, ctx());
    expect(r.ok).toBe(true);
    expect(runs.at(-1)!.command).toMatch(/sleep 2 && import/);
  });

  it('caja parada o ausente: error recuperable con el motivo del backend', async () => {
    respond = () => new ExecConnectError('The box "box" is stopped.');
    const r = await tool('screen_screenshot').execute({}, ctx());
    expect(r).toMatchObject({ ok: false, recoverable: true, error: 'The box "box" is stopped.' });
  });

  it('sin escritorio en la caja: el fallo dice qué falta', async () => {
    respond = () => outcome('', 1, "import: unable to open X server `:99'");
    const r = await tool('screen_screenshot').execute({}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Xvfb');
  });

  it('lo que no es un PNG no se pasa como imagen', async () => {
    respond = () => outcome('esto no es base64 de un png');
    const r = await tool('screen_screenshot').execute({}, ctx());
    expect(r.ok).toBe(false);
  });

  it('cancelado: no recuperable', async () => {
    respond = () => ({ stdout: '', stderr: '', exitCode: null, status: 'cancelled' });
    const r = await tool('screen_screenshot').execute({}, ctx());
    expect(r).toMatchObject({ ok: false, recoverable: false });
  });
});

describe('screen_zoom (A8)', () => {
  beforeEach(() => {
    respond = (req) => {
      if (req.command.includes('getdisplaygeometry')) return outcome('1280 800\n');
      if (req.command.includes('-crop')) return outcome(fakePng(640, 400));
      return outcome(fakePng(1280, 800));
    };
  });

  const zoomIn = (c: ToolContext = ctx()) =>
    tool('screen_zoom').execute({ x1: 100, y1: 100, x2: 259, y2: 199 }, c);

  it('recorta y amplía con enteros calculados, y devuelve la imagen de la zona', async () => {
    const r = await zoomIn();
    expect(r.ok).toBe(true);
    expect(runs.at(-1)!.command).toContain(
      'import -window root png:- | convert png:- -crop 160x100+100+100 +repage -resize 640x400! png:-',
    );
    if (!r.ok) return;
    expect(r.image).toMatchObject({ width: 640, height: 400 });
    expect(r.output).toContain('Zoomed 4×');
    expect(r.output).toContain('zoom: true');
  });

  it('un clic con zoom: true se traduce al píxel de la pantalla', async () => {
    await zoomIn();
    const r = await tool('screen_click').execute({ x: 320, y: 200, zoom: true }, ctx());
    expect(r.ok).toBe(true);
    expect(runs.at(-1)!.command).toContain('xdotool mousemove --sync 180 150 click 1');
    if (r.ok) expect(r.output).toContain('(320, 200) in the zoom → pixel (180, 150)');
  });

  it('norm1000 sobre la imagen ampliada', async () => {
    const norm = ctx({ vision: { coordinates: 'norm1000' } });
    await tool('screen_zoom').execute({ x1: 78.125, y1: 125, x2: 202.344, y2: 248.75 }, norm);
    await tool('screen_click').execute({ x: 500, y: 500, zoom: true }, norm);
    expect(runs.at(-1)!.command).toMatch(/mousemove --sync 1\d\d 1\d\d click 1/);
  });

  it('la ampliación no cambia la geometría de la pantalla: un clic normal sigue en pantalla completa', async () => {
    await zoomIn();
    const r = await tool('screen_click').execute({ x: 1000, y: 700 }, ctx());
    expect(r.ok).toBe(true);
    expect(runs.at(-1)!.command).toContain('mousemove --sync 1000 700');
  });

  it('zoom: true sin ampliación previa, o tras otra acción, no actúa', async () => {
    const none = await tool('screen_click').execute({ x: 5, y: 5, zoom: true }, ctx());
    expect(none).toMatchObject({ ok: false, recoverable: true });
    await zoomIn();
    await tool('screen_key').execute({ keys: 'Tab' }, ctx());
    runs.length = 0;
    const stale = await tool('screen_click').execute({ x: 5, y: 5, zoom: true }, ctx());
    expect(stale).toMatchObject({ ok: false, recoverable: true });
    expect(runs.some((q) => q.command.includes('mousemove'))).toBe(false);
  });

  it('la ampliación es de cada sesión', async () => {
    await zoomIn(ctx({ sessionId: 'A' }));
    const r = await tool('screen_click').execute(
      { x: 5, y: 5, zoom: true },
      ctx({ sessionId: 'B' }),
    );
    expect(r.ok).toBe(false);
  });

  it('un punto fuera de la imagen ampliada no actúa', async () => {
    await zoomIn();
    runs.length = 0;
    const r = await tool('screen_click').execute({ x: 700, y: 10, zoom: true }, ctx());
    expect(r).toMatchObject({ ok: false, recoverable: true });
    expect(runs).toHaveLength(0);
  });
});

describe('cerrojo de la pantalla', () => {
  const BUSY = /being used by another session/;

  function pair() {
    const locks = new ScreenLocks();
    const mk = () =>
      new Map(createScreenTools({ kind: 'container', name: 'box' }, locks).map((t) => [t.name, t]));
    return { locks, mk };
  }

  it('una acción de otra sesión con el cerrojo vigente falla recuperable y sin tocar la caja', async () => {
    const { locks, mk } = pair();
    locks.claim('box', 'A');
    const t = mk();
    const calls: [string, Record<string, unknown>][] = [
      ['screen_click', { x: 5, y: 5 }],
      ['screen_type', { text: 'hola' }],
      ['screen_key', { keys: 'Return' }],
      ['screen_scroll', { direction: 'down' }],
    ];
    for (const [name, params] of calls) {
      const r = await t.get(name)!.execute(params, ctx({ sessionId: 'B' }));
      expect(r).toMatchObject({ ok: false, recoverable: true, countsAsFailure: false });
      if (!r.ok) {
        expect(r.error).toMatch(BUSY);
        expect(r.error).not.toContain('A');
      }
    }
    // Solo puede haber la lectura del tamaño (la necesita el clic para validar su punto).
    expect(runs.every((q) => q.command.includes('getdisplaygeometry'))).toBe(true);
  });

  it('mirar no toma el cerrojo: la captura y la espera de B funcionan', async () => {
    const { locks, mk } = pair();
    locks.claim('box', 'A');
    const t = mk();
    expect((await t.get('screen_screenshot')!.execute({}, ctx({ sessionId: 'B' }))).ok).toBe(true);
    expect(
      (await t.get('screen_wait')!.execute({ seconds: 0.1 }, ctx({ sessionId: 'B' }))).ok,
    ).toBe(true);
    expect(
      (
        await t
          .get('screen_zoom')!
          .execute({ x1: 0, y1: 0, x2: 100, y2: 100 }, ctx({ sessionId: 'B' }))
      ).ok,
    ).toBe(true);
    expect(locks.holderOf('box')).toBe('A');
  });

  it('tras release(A), B puede actuar y queda como dueño', async () => {
    const { locks, mk } = pair();
    locks.claim('box', 'A');
    const t = mk();
    locks.release('A');
    const r = await t.get('screen_click')!.execute({ x: 5, y: 5 }, ctx({ sessionId: 'B' }));
    expect(r.ok).toBe(true);
    expect(locks.holderOf('box')).toBe('B');
  });

  it('una acción con parámetros inválidos no toma el cerrojo', async () => {
    const { locks, mk } = pair();
    const r = await mk()
      .get('screen_key')!
      .execute({ keys: 'no; valid' }, ctx({ sessionId: 'B' }));
    expect(r.ok).toBe(false);
    expect(locks.holderOf('box')).toBeNull();
  });
});
