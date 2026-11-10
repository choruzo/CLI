import { describe, expect, it } from 'vitest';
import { candidatePaths, locateBrowser, type LocateDeps } from './locate.js';

function deps(platform: NodeJS.Platform, files: string[], env: NodeJS.ProcessEnv = {}): LocateDeps {
  const set = new Set(files);
  return { platform, env, isFile: (p) => set.has(p) };
}

describe('locateBrowser', () => {
  const winEnv = {
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  };

  it('Windows: Edge antes que Chrome, en Program Files (x86) y luego Program Files', () => {
    const edge = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    const chrome = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    expect(locateBrowser({}, deps('win32', [chrome, edge], winEnv))).toBe(edge);
    expect(locateBrowser({}, deps('win32', [chrome], winEnv))).toBe(chrome);
    expect(candidatePaths({ platform: 'win32', env: winEnv })[0]).toBe(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  });

  it('macOS: las apps de /Applications', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(locateBrowser({}, deps('darwin', [chrome]))).toBe(chrome);
  });

  it('Linux: los nombres conocidos en el PATH', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin' };
    expect(locateBrowser({}, deps('linux', ['/usr/bin/chromium'], env))).toBe('/usr/bin/chromium');
    expect(
      locateBrowser({}, deps('linux', ['/usr/bin/google-chrome', '/usr/bin/chromium'], env)),
    ).toBe('/usr/bin/google-chrome');
  });

  it('el configurado manda; si no existe, no se busca otro', () => {
    const custom = '/opt/browser/chrome';
    const env = { PATH: '/usr/bin' };
    expect(
      locateBrowser({ executable: custom }, deps('linux', [custom, '/usr/bin/chromium'], env)),
    ).toBe(custom);
    expect(
      locateBrowser({ executable: custom }, deps('linux', ['/usr/bin/chromium'], env)),
    ).toBeNull();
  });

  it('sin navegador, null', () => {
    expect(locateBrowser({}, deps('linux', [], { PATH: '/usr/bin' }))).toBeNull();
    expect(locateBrowser({}, deps('win32', [], winEnv))).toBeNull();
  });
});
