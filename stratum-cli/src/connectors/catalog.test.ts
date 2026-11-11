import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bundledConnectorsDir, loadConnectorCatalog } from './catalog.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-catalog-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const manifest = (id: string) => ({
  schemaVersion: 1,
  id,
  version: '1.0.0',
  name: id,
  description: 'x',
  agents: ['companion'],
  hosts: [],
  secrets: [],
  tools: [{ name: 'a_tool', readOnly: true, summary: 's' }],
});

function add(folder: string, content: unknown, skill?: string): void {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(
    join(dir, folder, 'connector.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  if (skill) writeFileSync(join(dir, folder, 'SKILL.md'), skill);
}

describe('loadConnectorCatalog (M20)', () => {
  it('carga los válidos y deja fuera, en problems, los inválidos', () => {
    add('bueno-uno', manifest('bueno-uno'));
    add('roto-uno', '{ no json');
    add('distinto', manifest('otro-id'));
    add('malo-dos', { ...manifest('malo-dos'), tools: [] });
    add('bueno-dos', manifest('bueno-dos'));
    const catalog = loadConnectorCatalog(dir);
    expect(catalog.entries.map((e) => e.manifest.id)).toEqual(['bueno-dos', 'bueno-uno']);
    expect(catalog.get('bueno-uno')?.manifest.id).toBe('bueno-uno');
    expect(catalog.get('otro-id')).toBeUndefined();
    expect(catalog.problems).toHaveLength(3);
    const text = catalog.problems.join('\n');
    expect(text).toMatch(/roto-uno/);
    expect(text).toMatch(/distinto: its manifest id is "otro-id"/);
    expect(text).toMatch(/malo-dos/);
  });

  it('ignora carpetas con nombre inválido y las que no tienen connector.json', () => {
    add('Nombre-Malo', manifest('nombre-malo'));
    mkdirSync(join(dir, 'vacia-uno'));
    const catalog = loadConnectorCatalog(dir);
    expect(catalog.entries).toEqual([]);
    expect(catalog.problems).toEqual([]);
  });

  it('su skill se lee para el preset companion; sin SKILL.md queda null', () => {
    add(
      'con-skill',
      manifest('con-skill'),
      '---\nname: connector-con-skill\ndescription: Sirve para algo.\n---\n\n# Hola\n',
    );
    add('sin-skill', manifest('sin-skill'));
    const catalog = loadConnectorCatalog(dir);
    const skill = catalog.get('con-skill')!.skill;
    expect(skill).toMatchObject({ name: 'connector-con-skill', presets: ['companion'] });
    expect(catalog.get('sin-skill')!.skill).toBeNull();
  });

  it('sin carpeta (null) o inexistente: catálogo vacío', () => {
    expect(loadConnectorCatalog(null).entries).toEqual([]);
    expect(loadConnectorCatalog(join(dir, 'no-existe')).entries).toEqual([]);
  });

  it('el catálogo real del paquete trae open-meteo con sus 3 tools de solo lectura y su skill', () => {
    expect(bundledConnectorsDir()).not.toBeNull();
    const catalog = loadConnectorCatalog();
    expect(catalog.problems).toEqual([]);
    const entry = catalog.get('open-meteo');
    expect(entry).toBeDefined();
    expect(entry!.manifest.tools).toHaveLength(3);
    expect(entry!.manifest.tools.every((t) => t.readOnly)).toBe(true);
    expect(entry!.skill?.name).toBe('connector-open-meteo');
  });
});
