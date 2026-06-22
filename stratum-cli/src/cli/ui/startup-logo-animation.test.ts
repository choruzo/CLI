import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAsciiArt, getAsciiArtWidth } from './ascii-art.js';
import {
  animateStartupLogo,
  supportsStartupLogoAnimation,
  type StartupLogoEnvironment,
  type StartupLogoStdout,
} from './startup-logo-animation.js';

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

class FakeStdout implements StartupLogoStdout {
  readonly writes: string[] = [];

  constructor(
    public isTTY = true,
    public columns = 80,
    public rows = 30,
  ) {}

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
}

function windowsTerminalEnv(extra: StartupLogoEnvironment = {}): StartupLogoEnvironment {
  return { WT_SESSION: 'test-session', ...extra };
}

function visiblePayload(write: string): string {
  return write.replace(ANSI_PATTERN, '').replaceAll('\r', '');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('supportsStartupLogoAnimation', () => {
  it('accepts modern VT terminals with sufficient dimensions', () => {
    expect(
      supportsStartupLogoAnimation(new FakeStdout(), windowsTerminalEnv(), 'win32'),
    ).toBe(true);
    expect(supportsStartupLogoAnimation(new FakeStdout(), {}, 'linux')).toBe(true);
  });

  it.each([
    ['non-TTY stdout', new FakeStdout(false), windowsTerminalEnv(), 'win32'],
    ['TERM=dumb', new FakeStdout(), windowsTerminalEnv({ TERM: 'dumb' }), 'win32'],
    ['CI', new FakeStdout(), windowsTerminalEnv({ CI: '1' }), 'win32'],
    ['disabled by env', new FakeStdout(), windowsTerminalEnv({ STRATUM_NO_ANIMATION: '1' }), 'win32'],
    ['insufficient columns', new FakeStdout(true, 5, 30), windowsTerminalEnv(), 'win32'],
    ['insufficient rows', new FakeStdout(true, 80, 6), windowsTerminalEnv(), 'win32'],
    ['legacy Windows console', new FakeStdout(), {}, 'win32'],
  ] as const)('rejects %s', (_label, stdout, env, platform) => {
    expect(supportsStartupLogoAnimation(stdout, env, platform)).toBe(false);
  });
});

describe('animateStartupLogo', () => {
  it('performs no animated writes when compatibility checks require fallback', async () => {
    const stdout = new FakeStdout(false);

    await expect(
      animateStartupLogo({ stdout, env: windowsTerminalEnv(), platform: 'win32' }),
    ).resolves.toBe(false);
    expect(stdout.writes).toEqual([]);
  });

  it('writes each new two-column frame once in one grouped stdout write', async () => {
    const stdout = new FakeStdout();
    const art = getAsciiArt(stdout.columns);
    const rows = art.split('\n');
    const width = getAsciiArtWidth(art);

    await expect(
      animateStartupLogo({
        stdout,
        env: windowsTerminalEnv(),
        platform: 'win32',
        sleep: async () => {},
      }),
    ).resolves.toBe(true);

    const frameWrites = stdout.writes.slice(1, -1);
    expect(frameWrites).toHaveLength(Math.ceil(width / 2));

    const expectedFrames: string[] = [];
    for (let start = 0; start < width; start += 2) {
      expectedFrames.push(rows.map((row) => row.slice(start, start + 2)).join(''));
    }

    expect(frameWrites.map(visiblePayload)).toEqual(expectedFrames);
    expect(frameWrites.map(visiblePayload).join('')).toBe(expectedFrames.join(''));
  });

  it('leaves the cursor immediately below the reserved logo', async () => {
    const stdout = new FakeStdout();
    const rowCount = getAsciiArt(stdout.columns).split('\n').length;

    await animateStartupLogo({
      stdout,
      env: windowsTerminalEnv(),
      platform: 'win32',
      sleep: async () => {},
    });

    expect(stdout.writes.at(-1)).toContain(`${ESC}[${rowCount}B\r${ESC}[?25h`);
  });

  it('clears its timer after normal completion', async () => {
    vi.useFakeTimers();
    const stdout = new FakeStdout(true, 20, 10);
    const animation = animateStartupLogo({ stdout, env: {}, platform: 'linux' });

    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();

    await expect(animation).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer and completes statically when cancelled', async () => {
    vi.useFakeTimers();
    const stdout = new FakeStdout(true, 20, 10);
    const controller = new AbortController();
    const animation = animateStartupLogo({
      stdout,
      env: {},
      platform: 'linux',
      signal: controller.signal,
    });

    expect(vi.getTimerCount()).toBe(1);
    controller.abort();

    await expect(animation).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(visiblePayload(stdout.writes.slice(1, -1).join(''))).toContain('Stratum CLI');
  });
});
