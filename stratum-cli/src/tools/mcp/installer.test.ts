import { describe, it, expect } from 'vitest';
import { packageNameFromSpec, serverInstallPath } from './installer.js';
import type { McpServer } from '../../config/schema.js';
import { isServerInstalled } from './installer.js';
import { dirname, normalize } from 'path';

describe('packageNameFromSpec', () => {
  it('paquete sin versión', () => {
    expect(packageNameFromSpec('server-filesystem')).toBe('server-filesystem');
  });

  it('paquete con versión', () => {
    expect(packageNameFromSpec('server-filesystem@1.2.3')).toBe('server-filesystem');
  });

  it('paquete con scope y versión', () => {
    expect(packageNameFromSpec('@modelcontextprotocol/server-filesystem@0.6.2')).toBe(
      '@modelcontextprotocol/server-filesystem',
    );
  });

  it('paquete con scope sin versión', () => {
    expect(packageNameFromSpec('@scope/name')).toBe('@scope/name');
  });

  it('tag dist en lugar de versión semántica', () => {
    expect(packageNameFromSpec('chrome-devtools-mcp@latest')).toBe('chrome-devtools-mcp');
  });
});

describe('serverInstallPath', () => {
  it('sanitiza el nombre del server', () => {
    const base = process.platform === 'win32' ? 'C:\\base\\mcp' : '/base/mcp';
    const p = serverInstallPath(base, 'my/server name');
    expect(p.endsWith('my_server_name')).toBe(true);
    expect(normalize(dirname(p))).toBe(normalize(base));
  });
});

describe('isServerInstalled', () => {
  it('false cuando el server no declara package', () => {
    const cfg = { name: 'x', command: 'npx', args: [], startupTimeout: 15000 } as McpServer;
    expect(isServerInstalled(cfg, '/nonexistent')).toBe(false);
  });

  it('false cuando el paquete no está en disco', () => {
    const cfg = {
      name: 'x',
      command: 'node',
      args: [],
      package: 'nope-not-installed@1.0.0',
      startupTimeout: 15000,
    } as McpServer;
    expect(isServerInstalled(cfg, '/nonexistent-dir-xyz')).toBe(false);
  });
});
