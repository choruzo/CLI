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
  it('crea las seis, con los nombres de SCREEN_TOOLS y en su orden', () => {
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
