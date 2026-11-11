import { describe, it, expect } from 'vitest';
import {
  BOX_CONNECTORS_LABEL,
  BOX_LABEL,
  BOX_ROLE_LABEL,
  BOX_SPEC_LABEL,
  DEFAULT_BOX_IMAGE,
  boxContainerName,
  boxCreateArgs,
  boxSpecHash,
  boxVolumeName,
  connectorExecArgs,
  connectorsContainerName,
  connectorsCreateArgs,
  connectorsSpecHash,
  connectorsVolumeName,
  isNoSuchObject,
  parseInspect,
  type BoxSpec,
  type ConnectorsBoxSpec,
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

const cspec = (over: Partial<ConnectorsBoxSpec> = {}): ConnectorsBoxSpec => ({
  name: 'box',
  image: DEFAULT_BOX_IMAGE,
  network: true,
  runtime: 'docker',
  platform: 'linux',
  ...over,
});

describe('connectorsCreateArgs (M20)', () => {
  it('nombres y etiquetas: papel connectors, sin io.stratum.box', () => {
    expect(connectorsContainerName('box')).toBe('stratum-box-box-connectors');
    expect(connectorsVolumeName('box')).toBe('stratum-box-box-connectors-data');
    const args = connectorsCreateArgs(cspec());
    expect(args.slice(0, 3)).toEqual(['create', '--name', 'stratum-box-box-connectors']);
    const labels = args.filter((_, i) => args[i - 1] === '--label');
    expect(labels).toContain(`${BOX_ROLE_LABEL}=connectors`);
    expect(labels).toContain(`${BOX_CONNECTORS_LABEL}=box`);
    expect(labels).toContain(`${BOX_SPEC_LABEL}=${connectorsSpecHash(cspec())}`);
    // `exec` (container:<n>) busca `io.stratum.box`: esta caja no la lleva.
    expect(labels.some((l) => l.startsWith(`${BOX_LABEL}=`))).toBe(false);
    expect(args).toContain('STRATUM_BOX_ROLE=connectors');
  });

  it('monta solo su volumen en /home/stratum; nada del anfitrión ni privilegiado', () => {
    const args = connectorsCreateArgs(cspec());
    const mounts = args.filter((_, i) => args[i - 1] === '--mount');
    expect(mounts).toEqual([
      `type=volume,source=${connectorsVolumeName('box')},target=/home/stratum`,
    ]);
    const joined = args.join(' ');
    expect(joined).not.toMatch(/type=bind|\/exchange/);
    expect(joined).not.toMatch(
      /privileged|docker\.sock|podman\.sock|--cap-add|--device|--pid\b|--ipc\b|--network host/,
    );
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--volume');
    expect(args).toContain('--init');
  });

  it('siempre la imagen que se le da (la de Stratum) al final', () => {
    expect(connectorsCreateArgs(cspec()).at(-1)).toBe(DEFAULT_BOX_IMAGE);
  });

  it('red: por defecto con salida; network false → --network none', () => {
    expect(connectorsCreateArgs(cspec())).not.toContain('--network');
    const off = connectorsCreateArgs(cspec({ network: false }));
    expect(off[off.indexOf('--network') + 1]).toBe('none');
  });

  it('Podman en Linux mapea el usuario; Docker o Windows no', () => {
    expect(connectorsCreateArgs(cspec({ runtime: 'podman', platform: 'linux' }))).toContain(
      '--userns',
    );
    expect(connectorsCreateArgs(cspec({ runtime: 'podman', platform: 'win32' }))).not.toContain(
      '--userns',
    );
    expect(connectorsCreateArgs(cspec({ runtime: 'docker', platform: 'linux' }))).not.toContain(
      '--userns',
    );
  });

  it('la huella cambia con la red y la imagen, y no coincide con la de la caja del agente', () => {
    const base = connectorsSpecHash(cspec());
    expect(connectorsSpecHash(cspec())).toBe(base);
    expect(connectorsSpecHash(cspec({ network: false }))).not.toBe(base);
    expect(connectorsSpecHash(cspec({ image: 'stratum-box:99' }))).not.toBe(base);
    expect(base).not.toBe(boxSpecHash(spec({ image: DEFAULT_BOX_IMAGE })));
  });
});

describe('connectorExecArgs (M20)', () => {
  it('compone exec -i <caja de conectores> node server.mjs', () => {
    expect(connectorExecArgs('box', 'open-meteo')).toEqual([
      'exec',
      '-i',
      'stratum-box-box-connectors',
      'node',
      '/opt/stratum/connectors/open-meteo/server.mjs',
    ]);
  });

  it('los secretos van como -e NOMBRE, sin valor', () => {
    const args = connectorExecArgs('box', 'open-meteo', ['API_KEY', 'OTHER_TOKEN']);
    expect(args).toEqual([
      'exec',
      '-i',
      '-e',
      'API_KEY',
      '-e',
      'OTHER_TOKEN',
      'stratum-box-box-connectors',
      'node',
      '/opt/stratum/connectors/open-meteo/server.mjs',
    ]);
    expect(args.some((a) => a.includes('='))).toBe(false);
  });

  it('un id o un nombre de secreto inválido lanza', () => {
    for (const id of ['', 'A', '../x', 'a b', 'x;rm', 'a/b', '-evil', 'Open-Meteo']) {
      expect(() => connectorExecArgs('box', id)).toThrow(/Invalid connector id/);
    }
    for (const name of ['api_key', 'A', 'KEY=1', 'A B', '-X', 'KEY;ls']) {
      expect(() => connectorExecArgs('box', 'open-meteo', [name])).toThrow(/Invalid secret name/);
    }
  });
});

describe('parseInspect: etiquetas de la caja de conectores (M20)', () => {
  it('lee el papel y la caja a la que acompaña', () => {
    const out = JSON.stringify([
      {
        State: { Running: true },
        Config: { Labels: { [BOX_ROLE_LABEL]: 'connectors', [BOX_CONNECTORS_LABEL]: 'box' } },
      },
    ]);
    expect(parseInspect(out)).toEqual({ running: true, role: 'connectors', connectorsOf: 'box' });
  });
});
