// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRightPanel, saveRightPanel } from '../components/browser/BrowserPanel';
import type { CommandError, NativeBridge } from '../ipc/native';
import { describeBrowserFailure, describeUnavailable, moveBrowser, normalizeAddress } from './browser';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

beforeEach(() => localStorage.clear());

const rejected = (over: Partial<CommandError>): CommandError => ({
  kind: 'rejected',
  code: null,
  reason: null,
  message: 'no',
  ...over,
});

describe('la barra de dirección', () => {
  it('sin esquema se asume http (lo normal es un servidor local)', () => {
    expect(normalizeAddress('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeAddress(' 127.0.0.1:8080/app?x=1 ')).toBe('http://127.0.0.1:8080/app?x=1');
    expect(normalizeAddress('https://example.com/a')).toBe('https://example.com/a');
  });

  it('lo que no es una dirección http(s) no sale de aquí', () => {
    for (const bad of ['', '   ', 'hola mundo', 'file:///etc/passwd', 'javascript://x', 'chrome://settings', 'http://']) {
      expect(normalizeAddress(bad), bad).toBeNull();
    }
  });
});

describe('errores del navegador, para una persona', () => {
  it('lo externo se explica: lo abre el agente con confirmación', () => {
    expect(describeBrowserFailure('x', rejected({ code: 'INVALID_PARAMS', reason: 'needs-approval' }))).toMatch(
      /solo se abren direcciones locales/,
    );
    expect(describeBrowserFailure('x', rejected({ code: 'INVALID_PARAMS', reason: 'blocked-url' }))).toMatch(/no se puede abrir/);
    expect(describeBrowserFailure('x', rejected({ code: 'BUSY' }))).toMatch(/es suyo hasta que acabe/);
    expect(describeBrowserFailure('x', rejected({ code: 'UNAVAILABLE', reason: 'peer-hosted' }))).toMatch(/terminal/);
  });

  it('cada motivo de «no disponible» tiene su texto, y uno desconocido también', () => {
    expect(describeUnavailable('not-found')).toMatch(/Edge ni Chrome/);
    expect(describeUnavailable('disabled')).toMatch(/desactivado/);
    expect(describeUnavailable('otro')).toMatch(/no está disponible/);
    expect(describeUnavailable(undefined)).toMatch(/no está disponible/);
  });

  it('mover el navegador: una vez, y el fallo vuelve como texto', async () => {
    const browserNavigate = vi.fn(async () => {
      throw rejected({ code: 'BUSY' });
    });
    const native = { browserNavigate } as unknown as NativeBridge;
    const result = await moveBrowser(native, 's', 'reload');
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/es suyo/) });
    expect(browserNavigate).toHaveBeenCalledTimes(1);
    expect(browserNavigate).toHaveBeenCalledWith('s', 'reload', undefined);
  });
});

describe('panel de la derecha recordado', () => {
  it('uno a la vez, y hereda la trayectoria abierta de antes', () => {
    expect(loadRightPanel()).toBeNull();
    localStorage.setItem('stratum.trajectory', '1');
    expect(loadRightPanel()).toBe('trajectory');
    saveRightPanel('browser');
    expect(loadRightPanel()).toBe('browser');
    // Cerrado a propósito: lo antiguo ya no lo reabre.
    saveRightPanel(null);
    expect(loadRightPanel()).toBeNull();
  });
});
