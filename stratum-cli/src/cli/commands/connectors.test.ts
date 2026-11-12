import { describe, expect, it, vi } from 'vitest';
import type { ProtocolConnector, ProtocolConnectorsList } from '../../protocol/index.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConnectorCatalog } from '../../connectors/catalog.js';
import { connectorSecretsPath, readConnectorSecrets } from '../../connectors/secrets.js';
import {
  formatConnectorsList,
  runDisable,
  runEnable,
  runSecret,
  type ConnectorDeps,
  type SecretDeps,
} from './connectors.js';

function connector(over: Partial<ProtocolConnector> = {}): ProtocolConnector {
  return {
    id: 'github',
    version: '1.0.0',
    name: 'GitHub',
    description: 'Issues and pull requests',
    hosts: ['api.github.com'],
    needs: [],
    tools: [
      { name: 'gh_list', readOnly: true, summary: 'List issues' },
      { name: 'gh_comment', readOnly: false, summary: 'Comment on an issue' },
    ],
    enabled: false,
    enabledAt: null,
    ...over,
  };
}

function list(
  connectors: ProtocolConnector[],
  box: ProtocolConnectorsList['box'] = { state: 'running', reason: null },
): ProtocolConnectorsList {
  return { connectors, box, readOnly: false };
}

describe('formatConnectorsList', () => {
  it('una línea por conector con su estado y sus tools marcadas', () => {
    const out = formatConnectorsList(list([connector(), connector({ id: 'b', enabled: true })]));
    expect(out).toContain('github  disabled  GitHub — Issues and pull requests');
    expect(out).toContain('b  enabled  GitHub');
    expect(out).toContain('gh_list [read-only] List issues');
    expect(out).toContain('gh_comment [asks approval] Comment on an issue');
    expect(out).toContain('Connectors box: running');
    expect(out).not.toContain('not offered');
  });

  it('enseña lo que necesita', () => {
    const out = formatConnectorsList(
      list([
        connector({
          needs: [{ name: 'GH_TOKEN', description: 'personal token', configured: false }],
        }),
      ]),
    );
    expect(out).toContain('needs: GH_TOKEN (personal token) [missing]');
    expect(out).toContain('stratum connectors setup github');
  });

  it('con un conector activo y la caja parada avisa; con la razón si la hay', () => {
    const out = formatConnectorsList(
      list([connector({ enabled: true })], { state: 'stopped', reason: 'boom' }),
    );
    expect(out).toContain('Connectors box: stopped (boom)');
    expect(out).toContain('not offered to the assistant until the box runs ("stratum box start")');
  });

  it('sin conectores activos y con la caja sin crear no avisa', () => {
    const out = formatConnectorsList(list([connector()], { state: 'absent', reason: null }));
    expect(out).toContain('Connectors box: not created');
    expect(out).not.toContain('not offered');
  });
});

function makeDeps(
  over: Partial<ConnectorDeps> & { connectors?: ProtocolConnector[]; changed?: boolean } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const observer = {
    request: vi.fn(async () => list(over.connectors ?? [connector()])),
  };
  const authorityRequest = vi.fn(async () => ({
    connector: connector(),
    changed: over.changed ?? true,
  }));
  const close = vi.fn();
  const approver = vi.fn(async () => ({ request: authorityRequest, close }));
  const operatorRequest = vi.fn(async () => ({
    connector: connector(),
    changed: over.changed ?? true,
  }));
  const ask = vi.fn(async (_question: string) => 'y');
  const deps = {
    observer,
    operator: { request: operatorRequest },
    approver,
    ask,
    isTTY: true,
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
    ...over,
  } as unknown as ConnectorDeps;
  return { deps, out, err, observer, approver, authorityRequest, close, operatorRequest, ask };
}

describe('runEnable', () => {
  it('enseña lo que activa, pregunta y solo entonces pide la autoridad', async () => {
    const t = makeDeps();
    const order: string[] = [];
    t.ask.mockImplementation(async () => {
      order.push('ask');
      return 'y';
    });
    t.approver.mockImplementation(async () => {
      order.push('approver');
      return { request: t.authorityRequest, close: t.close };
    });
    expect(await runEnable(t.deps, 'github')).toBe(true);
    expect(order).toEqual(['ask', 'approver']);
    expect(t.out.join('')).toContain('gh_comment [asks approval]');
    expect(t.out.join('')).toContain('api.github.com');
    expect(t.ask.mock.calls[0]![0]).toBe('Enable connector "GitHub" for the assistant? [y/N] ');
    expect(t.authorityRequest).toHaveBeenCalledWith('connectors.enable', { connectorId: 'github' });
    expect(t.out.join('')).toContain(
      'Enabled GitHub. The assistant will have it from its next message.',
    );
    expect(t.close).toHaveBeenCalled();
  });

  it('una respuesta que no es sí no se conecta como aprobador', async () => {
    const t = makeDeps();
    t.ask.mockResolvedValue('n');
    expect(await runEnable(t.deps, 'github')).toBe(false);
    expect(t.approver).not.toHaveBeenCalled();
    expect(t.err.join('')).toContain('Cancelled.');
  });

  it('un id desconocido no pide la clave ni pregunta', async () => {
    const t = makeDeps();
    expect(await runEnable(t.deps, 'nope')).toBe(false);
    expect(t.err.join('')).toContain('Unknown connector "nope". Run "stratum connectors list".');
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.approver).not.toHaveBeenCalled();
  });

  it('sin terminal no hace nada', async () => {
    const t = makeDeps({ isTTY: false });
    expect(await runEnable(t.deps, 'github')).toBe(false);
    expect(t.err.join('')).toContain('interactive terminal');
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.approver).not.toHaveBeenCalled();
  });

  it('sin la clave (el aprobador devuelve null) no activa', async () => {
    const t = makeDeps();
    t.approver.mockResolvedValue(null as never);
    expect(await runEnable(t.deps, 'github')).toBe(false);
    expect(t.authorityRequest).not.toHaveBeenCalled();
  });

  it('changed: false dice que ya estaba activo', async () => {
    const t = makeDeps({ changed: false });
    expect(await runEnable(t.deps, 'github')).toBe(true);
    expect(t.out.join('')).toContain('GitHub was already enabled.');
  });
});

describe('runDisable', () => {
  it('desactiva con el operador, sin clave ni pregunta', async () => {
    const t = makeDeps();
    expect(await runDisable(t.deps, 'github')).toBe(true);
    expect(t.operatorRequest).toHaveBeenCalledWith('connectors.disable', {
      connectorId: 'github',
    });
    expect(t.approver).not.toHaveBeenCalled();
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.out.join('')).toContain('Disabled GitHub.');
  });

  it('changed: false dice que no estaba activo', async () => {
    const t = makeDeps({ changed: false });
    await runDisable(t.deps, 'github');
    expect(t.out.join('')).toContain('GitHub was not enabled.');
  });

  it('un id desconocido no toca nada', async () => {
    const t = makeDeps();
    expect(await runDisable(t.deps, 'nope')).toBe(false);
    expect(t.operatorRequest).not.toHaveBeenCalled();
  });
});

describe('runSecret (fase 4)', () => {
  // El catálogo real: home-assistant pide HA_URL (con eco) y HA_TOKEN (sin eco).
  const catalog = loadConnectorCatalog();

  function secretDeps(answers: (string | null)[], over: Partial<SecretDeps> = {}) {
    const dir = join(mkdtempSync(join(tmpdir(), 'stratum-cli-secret-')), 'daemon');
    const asked: { prompt: string; hidden: boolean }[] = [];
    let out = '';
    const next = (prompt: string, hidden: boolean) => {
      asked.push({ prompt, hidden });
      return Promise.resolve(answers.shift() ?? null);
    };
    const deps: SecretDeps = {
      dir,
      catalog,
      askHidden: (p) => next(p, true),
      askVisible: (p) => next(p, false),
      isTTY: true,
      out: (t) => (out += t),
      err: (t) => (out += t),
      ...over,
    };
    return {
      deps,
      asked,
      output: () => out,
      dir,
      done: () => rmSync(join(dir, '..'), { recursive: true, force: true }),
    };
  }

  it('pide la URL con eco y el token sin eco, guarda y nunca escribe un valor', async () => {
    const t = secretDeps(['http://homeassistant.home:8123', 'eyJ.token.secreto']);
    try {
      expect(await runSecret(t.deps, 'home-assistant')).toBe(true);
      expect(t.asked).toEqual([
        { prompt: 'HA_URL: ', hidden: false },
        { prompt: 'HA_TOKEN: ', hidden: true },
      ]);
      expect(t.output()).not.toContain('eyJ.token.secreto');
      expect(t.output()).toContain('Ready');
      const state = readConnectorSecrets(t.dir);
      expect(state.state === 'ok' && state.file.connectors['home-assistant']).toEqual({
        HA_URL: 'http://homeassistant.home:8123',
        HA_TOKEN: 'eyJ.token.secreto',
      });
      // Vacío conserva el que había; --name pide solo ese.
      t.asked.length = 0;
      expect(await runSecret(t.deps, 'home-assistant', { name: 'HA_TOKEN' })).toBe(false);
      expect(t.asked).toEqual([{ prompt: 'HA_TOKEN: ', hidden: true }]);
      expect(readFileSync(connectorSecretsPath(t.dir), 'utf8')).toContain('eyJ.token.secreto');
    } finally {
      t.done();
    }
  });

  it('sin terminal no pide nada; cancelar no guarda; --clear borra', async () => {
    const noTty = secretDeps(['x'], { isTTY: false });
    try {
      expect(await runSecret(noTty.deps, 'home-assistant')).toBe(false);
      expect(noTty.asked).toEqual([]);
      expect(noTty.output()).toMatch(/interactive terminal/);
    } finally {
      noTty.done();
    }
    const t = secretDeps(['http://h:8123', null]);
    try {
      expect(await runSecret(t.deps, 'home-assistant')).toBe(false);
      expect(readConnectorSecrets(t.dir)).toEqual({ state: 'absent' });
      const again = secretDeps(['http://h:8123', 'tok'], { dir: t.dir });
      expect(await runSecret(again.deps, 'home-assistant')).toBe(true);
      expect(await runSecret({ ...t.deps, isTTY: false }, 'home-assistant', { clear: true })).toBe(
        true,
      );
      const state = readConnectorSecrets(t.dir);
      expect(state.state === 'ok' && state.file.connectors).toEqual({});
    } finally {
      t.done();
    }
  });

  it('un conector desconocido, uno sin nada que configurar o un nombre ajeno', async () => {
    const t = secretDeps([]);
    try {
      expect(await runSecret(t.deps, 'nada')).toBe(false);
      expect(await runSecret(t.deps, 'open-meteo')).toBe(false);
      expect(await runSecret(t.deps, 'home-assistant', { name: 'OTRO' })).toBe(false);
      expect(t.output()).toMatch(/Unknown connector[\s\S]*does not need[\s\S]*does not use "OTRO"/);
      expect(t.asked).toEqual([]);
    } finally {
      t.done();
    }
  });
});
