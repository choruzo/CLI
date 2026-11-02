import { describe, expect, it, vi } from 'vitest';
import { readClipboardImage, type ClipboardRunResult } from './clipboard-image.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function ok(stdout: Uint8Array = new Uint8Array()): ClipboardRunResult {
  return { exitCode: 0, stdout };
}

describe('readClipboardImage', () => {
  it('Windows: powershell escribe un PNG temporal, se lee y se borra', async () => {
    const run = vi.fn(async () => ok());
    const removeFile = vi.fn(async () => undefined);
    const bytes = await readClipboardImage({
      platform: 'win32',
      env: { PATH: 'x' },
      run,
      tempPath: () => 'C:\\tmp\\clip.png',
      readFile: async () => PNG,
      removeFile,
    });
    expect(bytes).toEqual(PNG);
    const [file, args, opts] = run.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(file).toBe('powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-Command']);
    // La ruta viaja por el entorno, nunca dentro del script.
    expect(opts.env.STRATUM_CLIP_OUT).toBe('C:\\tmp\\clip.png');
    expect(args[4]).not.toContain('clip.png');
    expect(removeFile).toHaveBeenCalledWith('C:\\tmp\\clip.png');
  });

  it('Windows: sin imagen (código ≠ 0) → null y borra el temporal', async () => {
    const removeFile = vi.fn(async () => undefined);
    const bytes = await readClipboardImage({
      platform: 'win32',
      env: {},
      run: async () => ({ exitCode: 3, stdout: new Uint8Array() }),
      tempPath: () => 't.png',
      readFile: async () => {
        throw new Error('no debería leerse');
      },
      removeFile,
    });
    expect(bytes).toBeNull();
    expect(removeFile).toHaveBeenCalled();
  });

  it('Windows: powershell ausente → null, sin lanzar', async () => {
    const bytes = await readClipboardImage({
      platform: 'win32',
      env: {},
      run: async () => {
        throw new Error('ENOENT');
      },
      tempPath: () => 't.png',
      removeFile: async () => undefined,
    });
    expect(bytes).toBeNull();
  });

  it('macOS: pngpaste da la imagen por stdout', async () => {
    const run = vi.fn(async () => ok(PNG));
    expect(await readClipboardImage({ platform: 'darwin', env: {}, run })).toEqual(PNG);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual(['pngpaste', ['-'], {}]);
  });

  it('macOS: sin pngpaste cae a osascript con temporal', async () => {
    const calls: string[] = [];
    const bytes = await readClipboardImage({
      platform: 'darwin',
      env: {},
      run: async (file) => {
        calls.push(file);
        if (file === 'pngpaste') throw new Error('ENOENT');
        return ok();
      },
      tempPath: () => '/tmp/c.png',
      readFile: async () => PNG,
      removeFile: async () => undefined,
    });
    expect(calls).toEqual(['pngpaste', 'osascript']);
    expect(bytes).toEqual(PNG);
  });

  it('macOS: ni pngpaste ni imagen → null', async () => {
    const bytes = await readClipboardImage({
      platform: 'darwin',
      env: {},
      run: async (file) => {
        if (file === 'pngpaste') throw new Error('ENOENT');
        return { exitCode: 3, stdout: new Uint8Array() };
      },
      tempPath: () => '/tmp/c.png',
      removeFile: async () => undefined,
    });
    expect(bytes).toBeNull();
  });

  it('Linux con Wayland usa wl-paste', async () => {
    const run = vi.fn(async () => ok(PNG));
    const bytes = await readClipboardImage({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run,
    });
    expect(bytes).toEqual(PNG);
    expect(run.mock.calls[0]).toEqual(['wl-paste', ['--type', 'image/png'], {}]);
  });

  it('Linux sin Wayland usa xclip', async () => {
    const run = vi.fn(async () => ok(PNG));
    await readClipboardImage({ platform: 'linux', env: {}, run });
    expect(run.mock.calls[0]).toEqual([
      'xclip',
      ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      {},
    ]);
  });

  it('Linux: herramienta ausente o salida vacía → null', async () => {
    expect(
      await readClipboardImage({
        platform: 'linux',
        env: {},
        run: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();
    expect(
      await readClipboardImage({ platform: 'linux', env: {}, run: async () => ok() }),
    ).toBeNull();
  });
});
