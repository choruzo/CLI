import { describe, it, expect, beforeEach } from 'vitest';
import { migrateLegacyKeys, mergeConfigs, takeConfigDeprecations } from './loader.js';
import { StratumConfigSchema } from './schema.js';

beforeEach(() => {
  takeConfigDeprecations();
});

describe('migración de ssh.auditLog → tools.auditLog (Hito 16)', () => {
  it('una capa con solo el alias lo copia a tools.auditLog y avisa', () => {
    const out = migrateLegacyKeys({ ssh: { auditLog: false, hosts: {} } }, 'proyecto');
    expect(out).toEqual({ ssh: { hosts: {} }, tools: { auditLog: false } });
    expect(takeConfigDeprecations()).toHaveLength(1);
  });

  it('dentro de la misma capa gana tools.auditLog', () => {
    const out = migrateLegacyKeys(
      { ssh: { auditLog: false }, tools: { auditLog: '/x.jsonl' } },
      'p',
    );
    expect((out.tools as Record<string, unknown>).auditLog).toBe('/x.jsonl');
  });

  it('entre capas manda la precedencia normal: el alias del proyecto gana al global', () => {
    const global = migrateLegacyKeys({ tools: { auditLog: true } }, 'global');
    const project = migrateLegacyKeys({ ssh: { auditLog: false } }, 'proyecto');
    const config = StratumConfigSchema.parse(mergeConfigs(global, project));
    expect(config.tools.auditLog).toBe(false);
  });

  it('una capa sin el alias no cambia ni avisa', () => {
    const layer = { tools: { bashTimeout: 1000 } };
    expect(migrateLegacyKeys(layer, 'p')).toBe(layer);
    expect(takeConfigDeprecations()).toEqual([]);
  });
});
