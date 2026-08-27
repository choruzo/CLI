import { describe, it, expect } from 'vitest';
import { StratumConfigSchema } from '../../config/schema.js';
import { ToolRegistry } from '../registry.js';
import { registerSshTools } from './index.js';
import { describeCall } from '../registry.js';

function parse(hosts: Record<string, Record<string, unknown>>) {
  return StratumConfigSchema.safeParse({ ssh: { hosts } });
}

describe('schema del inventario SSH', () => {
  it('acepta un host con clave privada y aplica los defaults', () => {
    const result = parse({ dev: { host: '10.0.0.5', user: 'javi', privateKey: '~/.ssh/id' } });
    expect(result.success).toBe(true);
  });

  it('rechaza un host sin ningún método de autenticación', () => {
    const result = parse({ dev: { host: '10.0.0.5', user: 'javi' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('no declara ningún método de autenticación');
  });

  it('rechaza hostKeyPolicy strict sin hostKeyHash', () => {
    const result = parse({
      prod: { host: '10.0.0.5', user: 'javi', useAgent: true, hostKeyPolicy: 'strict' },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('no define hostKeyHash');
  });

  it('acepta strict cuando hay hostKeyHash', () => {
    const result = parse({
      prod: {
        host: '10.0.0.5',
        user: 'javi',
        useAgent: true,
        hostKeyPolicy: 'strict',
        hostKeyHash: 'SHA256:abc',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rechaza un jumpHost que no existe en el inventario', () => {
    const result = parse({
      web: { host: '10.0.0.5', user: 'javi', useAgent: true, jumpHost: 'fantasma' },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('que no existe en ssh.hosts');
  });

  it('rechaza un ciclo de jump hosts', () => {
    const result = parse({
      a: { host: '1', user: 'u', useAgent: true, jumpHost: 'b' },
      b: { host: '2', user: 'u', useAgent: true, jumpHost: 'a' },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('Ciclo de jumpHost');
  });

  it('rechaza una cadena de jump hosts de más de 2 saltos', () => {
    const result = parse({
      a: { host: '1', user: 'u', useAgent: true, jumpHost: 'b' },
      b: { host: '2', user: 'u', useAgent: true, jumpHost: 'c' },
      c: { host: '3', user: 'u', useAgent: true, jumpHost: 'd' },
      d: { host: '4', user: 'u', useAgent: true },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('profundidad máxima de 2');
  });

  it('acepta una cadena de exactamente 2 saltos', () => {
    const result = parse({
      a: { host: '1', user: 'u', useAgent: true, jumpHost: 'b' },
      b: { host: '2', user: 'u', useAgent: true, jumpHost: 'c' },
      c: { host: '3', user: 'u', useAgent: true },
    });
    expect(result.success).toBe(true);
  });
});

describe('registro condicional de las tools SSH', () => {
  it('no registra nada cuando no hay sección ssh en la config', () => {
    const registry = new ToolRegistry();
    registerSshTools(registry, StratumConfigSchema.parse({}));
    expect(registry.get('ssh_exec')).toBeUndefined();
    expect(registry.toToolSchemas().map((s) => s.function.name)).not.toContain('ssh_exec');
  });

  it('no registra nada cuando el inventario está vacío', () => {
    const registry = new ToolRegistry();
    registerSshTools(registry, StratumConfigSchema.parse({ ssh: { hosts: {} } }));
    expect(registry.get('ssh_exec')).toBeUndefined();
  });

  it('registra las tres tools cuando hay al menos un host', () => {
    const registry = new ToolRegistry();
    registerSshTools(
      registry,
      StratumConfigSchema.parse({
        ssh: { hosts: { dev: { host: '1', user: 'u', useAgent: true } } },
      }),
    );
    expect(registry.get('ssh_exec')).toBeDefined();
    expect(registry.get('ssh_upload')).toBeDefined();
    expect(registry.get('ssh_download')).toBeDefined();
  });
});

describe('describeCall para tools SSH', () => {
  it('antepone el host al comando en el prompt de confirmación', () => {
    const description = describeCall({
      id: '1',
      name: 'ssh_exec',
      input: { host: 'prod-web', command: 'rm -rf /var/cache' },
    });
    expect(description).toBe('ssh_exec [prod-web]: rm -rf /var/cache');
  });

  it('describe las transferencias con origen y destino', () => {
    const description = describeCall({
      id: '1',
      name: 'ssh_upload',
      input: { host: 'dev', localPath: './app.tar', remotePath: '/srv/app.tar' },
    });
    expect(description).toBe('ssh_upload [dev]: ./app.tar → /srv/app.tar');
  });
});
