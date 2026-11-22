import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BoxConfigSchema } from '../config/schema.js';
import { connectorExecArgs } from '../box/spec.js';
import type { RuntimeDetection } from '../box/runtime.js';
import { resolveActiveConnectors } from './active.js';
import { loadConnectorCatalog } from './catalog.js';
import { connectorSecretsPath, setConnectorSecrets } from './secrets.js';
import { connectorsFile, enableConnector } from './store.js';

let dir: string;
let catalogDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-active-'));
  catalogDir = join(dir, 'catalog');
  mkdirSync(catalogDir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function addConnector(
  id: string,
  tools: { name: string; readOnly: boolean; forced?: boolean }[],
  skill = true,
  secrets: string[] = [],
) {
  mkdirSync(join(catalogDir, id), { recursive: true });
  writeFileSync(
    join(catalogDir, id, 'connector.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      version: '1.0.0',
      name: id,
      description: 'x',
      agents: ['companion'],
      hosts: [],
      secrets: secrets.map((name) => ({ name, description: 'd' })),
      tools: tools.map((t) => ({ ...t, summary: 's' })),
    }),
  );
  if (skill) {
    writeFileSync(
      join(catalogDir, id, 'SKILL.md'),
      `---\nname: connector-${id}\ndescription: Skill de ${id}.\n---\n\n# ${id}\n`,
    );
  }
}

function launchDeps(detection: RuntimeDetection) {
  const state = { detects: 0 };
  return {
    state,
    deps: {
      detect: async () => {
        state.detects++;
        return detection;
      },
    },
  };
}

const RUNTIME: RuntimeDetection = { ok: true, runtime: { kind: 'podman', bin: 'podman' } };

describe('resolveActiveConnectors (M20)', () => {
  it('sin connectors.json: nada y sin detectar el runtime', async () => {
    addConnector('uno-dos', [{ name: 'leer', readOnly: true }]);
    const { state, deps } = launchDeps(RUNTIME);
    const r = await resolveActiveConnectors({
      dataDir: dir,
      box: undefined,
      catalog: loadConnectorCatalog(catalogDir),
      launch: deps,
    });
    expect(r).toEqual({ servers: [], readOnlyTools: {}, skills: [], warnings: [] });
    expect(state.detects).toBe(0);
  });

  it('fichero vacío de activos: nada y sin detectar', async () => {
    writeFileSync(connectorsFile(dir), JSON.stringify({ schemaVersion: 1, enabled: [] }));
    const { state, deps } = launchDeps(RUNTIME);
    const r = await resolveActiveConnectors({ dataDir: dir, box: undefined, launch: deps });
    expect(r.servers).toEqual([]);
    expect(state.detects).toBe(0);
  });

  it('un fichero de un Stratum más nuevo o inválido no activa nada y avisa', async () => {
    const { state, deps } = launchDeps(RUNTIME);
    writeFileSync(connectorsFile(dir), JSON.stringify({ schemaVersion: 99, enabled: [] }));
    const newer = await resolveActiveConnectors({ dataDir: dir, box: undefined, launch: deps });
    expect(newer.servers).toEqual([]);
    expect(newer.warnings).toHaveLength(1);
    expect(newer.warnings[0]).toMatch(/newer/);

    writeFileSync(connectorsFile(dir), '{ roto');
    const bad = await resolveActiveConnectors({ dataDir: dir, box: undefined, launch: deps });
    expect(bad.servers).toEqual([]);
    expect(bad.warnings[0]).toMatch(/not valid/);
    expect(state.detects).toBe(0);
  });

  it('un id fuera del catálogo avisa; sin ninguno válido no detecta runtime', async () => {
    addConnector('uno-dos', [{ name: 'leer', readOnly: true }]);
    enableConnector(connectorsFile(dir), 'fantasma');
    const { state, deps } = launchDeps(RUNTIME);
    const r = await resolveActiveConnectors({
      dataDir: dir,
      box: undefined,
      catalog: loadConnectorCatalog(catalogDir),
      launch: deps,
    });
    expect(r.servers).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/"fantasma".*not in this Stratum's catalog/);
    expect(state.detects).toBe(0);
  });

  it('sin runtime: aviso y ningún server', async () => {
    addConnector('uno-dos', [{ name: 'leer', readOnly: true }]);
    enableConnector(connectorsFile(dir), 'uno-dos');
    const { deps } = launchDeps({ ok: false, reason: 'No container runtime available' });
    const r = await resolveActiveConnectors({
      dataDir: dir,
      box: undefined,
      catalog: loadConnectorCatalog(catalogDir),
      launch: deps,
    });
    expect(r.servers).toEqual([]);
    expect(r.skills).toEqual([]);
    expect(r.warnings).toEqual(['Connectors are unavailable: No container runtime available']);
  });

  it('con runtime: servers con la orden del runtime, readOnlyTools del manifiesto y skills', async () => {
    addConnector('uno-dos', [
      { name: 'leer', readOnly: true },
      { name: 'escribir', readOnly: false },
    ]);
    addConnector('solo-escritura', [{ name: 'escribir', readOnly: false }], false);
    const file = connectorsFile(dir);
    enableConnector(file, 'uno-dos');
    enableConnector(file, 'solo-escritura');
    const { deps } = launchDeps(RUNTIME);
    const r = await resolveActiveConnectors({
      dataDir: dir,
      box: BoxConfigSchema.parse({ name: 'mia' }),
      catalog: loadConnectorCatalog(catalogDir),
      launch: deps,
    });
    expect(r.warnings).toEqual([]);
    expect(r.servers.map((s) => s.config.name)).toEqual(['uno-dos', 'solo-escritura']);
    for (const s of r.servers) {
      expect(s.config.command).toBe('podman');
      expect(s.config.args).toEqual(connectorExecArgs('mia', s.config.name));
      expect(typeof s.beforeConnect).toBe('function');
    }
    // Lo que no se declara de solo lectura no aparece: se confirmará.
    expect(r.readOnlyTools).toEqual({ 'uno-dos': ['leer'] });
    expect(r.skills.map((s) => s.id)).toEqual(['uno-dos']);
    expect(r.skills[0]!.skill.name).toBe('connector-uno-dos');
  });

  it('M27: un server lleva sus tools forzadas; uno sin ninguna, nada', async () => {
    addConnector('uno-dos', [
      { name: 'leer', readOnly: true },
      { name: 'proponer', readOnly: false, forced: true },
    ]);
    addConnector('tres-cuatro', [{ name: 'escribir', readOnly: false }]);
    const file = connectorsFile(dir);
    enableConnector(file, 'uno-dos');
    enableConnector(file, 'tres-cuatro');
    const { deps } = launchDeps(RUNTIME);
    const r = await resolveActiveConnectors({
      dataDir: dir,
      box: undefined,
      catalog: loadConnectorCatalog(catalogDir),
      launch: deps,
    });
    const byName = new Map(r.servers.map((s) => [s.config.name, s]));
    expect(byName.get('uno-dos')!.forcedTools).toEqual(['proponer']);
    expect(byName.get('tres-cuatro')).not.toHaveProperty('forcedTools');
  });

  describe('secretos (fase 4)', () => {
    function setup() {
      addConnector('casa', [{ name: 'leer', readOnly: true }], true, ['CASA_URL', 'CASA_TOKEN']);
      addConnector('libre', [{ name: 'leer', readOnly: true }]);
      enableConnector(connectorsFile(dir), 'casa');
      enableConnector(connectorsFile(dir), 'libre');
      const secretsDir = join(dir, 'daemon');
      const catalog = loadConnectorCatalog(catalogDir);
      return { secretsDir, catalog };
    }

    it('sin sus secretos no se lanza, avisa con la orden y el resto sigue', async () => {
      const { secretsDir, catalog } = setup();
      const { deps } = launchDeps(RUNTIME);
      const r = await resolveActiveConnectors({
        dataDir: dir,
        box: undefined,
        secretsDir,
        catalog,
        launch: deps,
      });
      expect(r.servers.map((s) => s.config.name)).toEqual(['libre']);
      expect(r.servers[0]!.config.env).toBeUndefined();
      expect(r.warnings).toEqual([
        'Connector "casa" needs setup (CASA_URL, CASA_TOKEN): run "stratum connectors setup casa".',
      ]);
      expect(r.skills.map((s) => s.id)).toEqual(['libre']);
      // A medias tampoco.
      setConnectorSecrets(secretsDir, catalog.get('casa')!.manifest, { CASA_URL: 'http://x' });
      const half = await resolveActiveConnectors({
        dataDir: dir,
        box: undefined,
        secretsDir,
        catalog,
        launch: deps,
      });
      expect(half.servers.map((s) => s.config.name)).toEqual(['libre']);
      expect(half.warnings[0]).toMatch(/needs setup \(CASA_TOKEN\)/);
    });

    it('con todos: -e NOMBRE sin valor en la orden y el valor solo en env', async () => {
      const { secretsDir, catalog } = setup();
      setConnectorSecrets(secretsDir, catalog.get('casa')!.manifest, {
        CASA_URL: 'http://casa.home:8123',
        CASA_TOKEN: 'tok-muy-secreto',
      });
      const { deps } = launchDeps(RUNTIME);
      const r = await resolveActiveConnectors({
        dataDir: dir,
        box: BoxConfigSchema.parse({ name: 'mia' }),
        secretsDir,
        catalog,
        launch: deps,
      });
      expect(r.warnings).toEqual([]);
      const casa = r.servers.find((s) => s.config.name === 'casa')!;
      expect(casa.config.args).toEqual(
        connectorExecArgs('mia', 'casa', ['CASA_URL', 'CASA_TOKEN']),
      );
      expect(casa.config.args.join(' ')).not.toContain('tok-muy-secreto');
      expect(casa.config.env).toEqual({
        CASA_URL: 'http://casa.home:8123',
        CASA_TOKEN: 'tok-muy-secreto',
      });
    });

    it('un fichero de secretos roto apaga solo los que los piden', async () => {
      const { secretsDir, catalog } = setup();
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(connectorSecretsPath(secretsDir), '{ roto');
      const { deps } = launchDeps(RUNTIME);
      const r = await resolveActiveConnectors({
        dataDir: dir,
        box: undefined,
        secretsDir,
        catalog,
        launch: deps,
      });
      expect(r.servers.map((s) => s.config.name)).toEqual(['libre']);
      expect(r.warnings).toEqual(['Connector "casa" is off: connector-secrets.json is not valid.']);
    });
  });
});
