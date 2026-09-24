import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ACCELERATOR_KEYS,
  DEFAULT_GLOBAL_HOTKEY,
  acceleratorFromEvent,
  keyFromCode,
  parseAccelerator,
} from '../config/accelerator.js';
import { StratumConfigSchema } from '../config/schema.js';
import { ConfigPanel } from './config-panel.js';
import { DesktopSettings, hasUsableProvider, osPrefsOf } from './settings.js';
import type { ConversationOutboundFrame } from './protocol.js';

const root = mkdtempSync(join(tmpdir(), 'stratum-desktop-d6-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PROVIDER = {
  provider: {
    default: 'local',
    providers: {
      local: { type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', model: 'gemma' },
    },
  },
};

describe('parseAccelerator (D6)', () => {
  it('normaliza alias, mayúsculas y orden de modificadores', () => {
    expect(parseAccelerator('shift+ctrl+space')).toEqual({
      ok: true,
      accelerator: 'Control+Shift+Space',
    });
    expect(parseAccelerator('CmdOrCtrl + Shift + k')).toEqual({
      ok: true,
      accelerator: 'CommandOrControl+Shift+K',
    });
    expect(parseAccelerator('Option+F5')).toEqual({ ok: true, accelerator: 'Alt+F5' });
    expect(parseAccelerator(DEFAULT_GLOBAL_HOTKEY)).toEqual({
      ok: true,
      accelerator: DEFAULT_GLOBAL_HOTKEY,
    });
  });

  it('exige un modificador que no sea solo Shift', () => {
    expect(parseAccelerator('Space').ok).toBe(false);
    expect(parseAccelerator('Shift+A').ok).toBe(false);
    expect(parseAccelerator('Alt+Shift+A').ok).toBe(true);
  });

  it('rechaza teclas desconocidas, modificadores repetidos y combinaciones sin tecla', () => {
    expect(parseAccelerator('Ctrl+Hyper+A')).toMatchObject({ ok: false });
    expect(parseAccelerator('Ctrl+Ñ')).toMatchObject({
      ok: false,
      error: expect.stringContaining('Ñ'),
    });
    expect(parseAccelerator('Ctrl+Control+A')).toMatchObject({ ok: false });
    expect(parseAccelerator('Ctrl+Shift')).toMatchObject({
      ok: false,
      error: expect.stringContaining('Falta'),
    });
    expect(parseAccelerator('CommandOrControl+Ctrl+A').ok).toBe(false);
    expect(parseAccelerator('   ').ok).toBe(false);
  });

  it('cada tecla admitida forma un atajo válido', () => {
    for (const key of ACCELERATOR_KEYS) {
      expect(parseAccelerator(`Alt+${key}`)).toEqual({ ok: true, accelerator: `Alt+${key}` });
    }
  });

  it('captura desde un KeyboardEvent', () => {
    const ev = { ctrlKey: true, altKey: false, shiftKey: true, metaKey: false };
    expect(acceleratorFromEvent({ ...ev, code: 'Space' })).toBe('CommandOrControl+Shift+Space');
    expect(acceleratorFromEvent({ ...ev, code: 'KeyJ' })).toBe('CommandOrControl+Shift+J');
    expect(acceleratorFromEvent({ ...ev, code: 'ArrowUp' })).toBe('CommandOrControl+Shift+Up');
    // Solo modificadores, o sin modificador válido: todavía no es un atajo.
    expect(acceleratorFromEvent({ ...ev, code: 'ShiftLeft' })).toBeNull();
    expect(acceleratorFromEvent({ ...ev, ctrlKey: false, code: 'KeyJ' })).toBeNull();
    expect(keyFromCode('Digit7')).toBe('7');
    expect(keyFromCode('NumpadEnter')).toBeNull();
  });
});

describe('schema desktop.notifications / desktop.globalHotkey (D6)', () => {
  it('defaults', () => {
    const c = StratumConfigSchema.parse({});
    expect(c.desktop.notifications).toEqual({ enabled: true, minSeconds: 10 });
    expect(c.desktop.globalHotkey).toBe(DEFAULT_GLOBAL_HOTKEY);
    expect(osPrefsOf(c)).toEqual({
      notifications: { enabled: true, minSeconds: 10 },
      globalHotkey: DEFAULT_GLOBAL_HOTKEY,
    });
  });

  it('cadena vacía desactiva el atajo; uno inválido es un problema con su ruta', () => {
    expect(StratumConfigSchema.parse({ desktop: { globalHotkey: '' } }).desktop.globalHotkey).toBe(
      '',
    );
    const bad = StratumConfigSchema.safeParse({ desktop: { globalHotkey: 'Shift+A' } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].path).toEqual(['desktop', 'globalHotkey']);
    expect(
      StratumConfigSchema.safeParse({ desktop: { notifications: { minSeconds: -1 } } }).success,
    ).toBe(false);
  });

  it('hasUsableProvider exige que el default exista', () => {
    expect(hasUsableProvider(StratumConfigSchema.parse({}))).toBe(false);
    expect(hasUsableProvider(StratumConfigSchema.parse(PROVIDER))).toBe(true);
    const dangling = { provider: { ...PROVIDER.provider, default: 'otro' } };
    expect(hasUsableProvider(StratumConfigSchema.parse(dangling))).toBe(false);
  });
});

describe('DesktopSettings: applied.os y providerReady (D6)', () => {
  function setup() {
    const home = join(root, `h${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(home, '.stratum'), { recursive: true });
    const path = join(home, '.stratum', '.stratumrc.json');
    const panel = new ConfigPanel(path, home);
    const frames: ConversationOutboundFrame[] = [];
    const load = () => ({
      config: StratumConfigSchema.parse(
        existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {},
      ),
      error: null,
    });
    const settings = new DesktopSettings({
      panel,
      load,
      apply: () => undefined,
      startup: load().config,
      dataDir: join(home, 'data'),
    });
    settings.attach((f) => frames.push(f));
    return { panel, frames, settings };
  }

  it('primer arranque sin config: sin provider; tras el wizard, listo y con las prefs guardadas', async () => {
    const t = setup();
    expect(t.panel.snapshot().exists).toBe(false);
    await t.settings.handle({ type: 'config_get' });
    const first = t.frames.at(-1);
    expect(first?.type === 'config_state' && first.applied.providerReady).toBe(false);

    await t.settings.handle({
      type: 'config_save',
      text: JSON.stringify({
        ...PROVIDER,
        desktop: { notifications: { enabled: false, minSeconds: 30 }, globalHotkey: 'alt+shift+s' },
      }),
      baseHash: t.panel.snapshot().hash,
    });
    const saved = t.frames.at(-1);
    if (saved?.type !== 'config_state') throw new Error('sin config_state');
    expect(saved.reason).toBe('saved');
    expect(saved.applied.providerReady).toBe(true);
    // Se entrega tal cual está escrito: lo normaliza quien lo registra (Rust).
    expect(saved.applied.os).toEqual({
      notifications: { enabled: false, minSeconds: 30 },
      globalHotkey: 'alt+shift+s',
    });
  });
});
