import { describe, it, expect } from 'vitest';
import {
  BOX_LABEL,
  BOX_SPEC_LABEL,
  boxContainerName,
  boxCreateArgs,
  boxSpecHash,
  boxVolumeName,
  isNoSuchObject,
  parseInspect,
  type BoxSpec,
} from './spec.js';

const spec = (over: Partial<BoxSpec> = {}): BoxSpec => ({
  name: 'box',
  image: 'stratum-box:1',
  network: true,
  exchangeDir: '/home/u/.stratum/companion/exchange',
  runtime: 'docker',
  platform: 'linux',
  ...over,
});

describe('boxCreateArgs (M13)', () => {
  it('monta solo su volumen y la carpeta de intercambio; nada privilegiado', () => {
    const args = boxCreateArgs(spec());
    const joined = args.join(' ');
    const mounts = args.filter((_, i) => args[i - 1] === '--mount');
    expect(mounts).toEqual([
      `type=volume,source=${boxVolumeName('box')},target=/home/stratum`,
      'type=bind,source=/home/u/.stratum/companion/exchange,target=/exchange',
    ]);
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--volume');
    expect(joined).not.toMatch(
      /privileged|docker\.sock|podman\.sock|--cap-add|--device|--pid\b|--ipc\b|--network host/,
    );
    expect(args).toContain('--init');
    expect(args.slice(0, 3)).toEqual(['create', '--name', boxContainerName('box')]);
    expect(args.at(-1)).toBe('stratum-box:1');
    expect(args).toContain(`${BOX_LABEL}=box`);
  });

  it('red: por defecto con salida; network false → --network none', () => {
    expect(boxCreateArgs(spec())).not.toContain('--network');
    const off = boxCreateArgs(spec({ network: false }));
    expect(off[off.indexOf('--network') + 1]).toBe('none');
  });

  it('Podman en Linux mapea el usuario; Docker o Windows no', () => {
    expect(boxCreateArgs(spec({ runtime: 'podman', platform: 'linux' }))).toContain('--userns');
    expect(boxCreateArgs(spec({ runtime: 'podman', platform: 'win32' }))).not.toContain('--userns');
    expect(boxCreateArgs(spec({ runtime: 'docker', platform: 'linux' }))).not.toContain('--userns');
  });

  it('una carpeta de intercambio con coma no se puede montar: lanza', () => {
    expect(() => boxCreateArgs(spec({ exchangeDir: '/tmp/a,b' }))).toThrow(/comma/);
  });

  it('la huella cambia con lo que define la caja y va en su etiqueta', () => {
    const base = boxSpecHash(spec());
    expect(boxSpecHash(spec())).toBe(base);
    expect(boxSpecHash(spec({ network: false }))).not.toBe(base);
    expect(boxSpecHash(spec({ image: 'stratum-box:2' }))).not.toBe(base);
    expect(boxCreateArgs(spec())).toContain(`${BOX_SPEC_LABEL}=${base}`);
  });
});

describe('parseInspect / isNoSuchObject', () => {
  it('lee estado y etiquetas de Docker y Podman', () => {
    const out = JSON.stringify([
      {
        Id: 'x',
        State: { Status: 'running', Running: true },
        Config: { Labels: { [BOX_LABEL]: 'box', [BOX_SPEC_LABEL]: 'abc', other: '1' } },
      },
    ]);
    expect(parseInspect(out)).toEqual({ running: true, label: 'box', spec: 'abc' });
    const noLabels = JSON.stringify([{ State: { Running: false }, Config: { Labels: null } }]);
    expect(parseInspect(noLabels)).toEqual({ running: false });
  });

  it('una salida inesperada lanza', () => {
    expect(() => parseInspect('[]')).toThrow();
    expect(() => parseInspect('not json')).toThrow();
  });

  it('reconoce "no existe" en los dos runtimes', () => {
    expect(isNoSuchObject('Error: No such container: stratum-box-box')).toBe(true);
    expect(isNoSuchObject('Error: no such container stratum-box-box')).toBe(true);
    expect(isNoSuchObject('Error: no container with name or ID "x" found')).toBe(true);
    expect(isNoSuchObject('Error: no such volume x')).toBe(true);
    expect(isNoSuchObject('permission denied')).toBe(false);
  });
});
