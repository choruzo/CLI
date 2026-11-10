import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyUrl,
  documentStanding,
  inspectUrl,
  subresourceAllowed,
  type UrlClass,
  type UrlPolicyContext,
} from './policy.js';

let root: string;
let cwd: string;
let outside: string;
let junction: string | null = null;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'stratum-browser-policy-'));
  cwd = join(root, 'project');
  outside = join(root, 'outside');
  mkdirSync(join(cwd, 'dist'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(cwd, 'dist', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  // Un enlace dentro de la carpeta que apunta fuera (junction en Windows: no pide privilegios).
  try {
    symlinkSync(outside, join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    junction = join(cwd, 'link');
  } catch {
    junction = null;
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<UrlPolicyContext> = {}): UrlPolicyContext {
  return { cwd, approvedOrigins: new Set(), allowHosts: [], ...overrides };
}

const fileUrl = (path: string) => pathToFileURL(path).href;

describe('classifyUrl', () => {
  const table: Array<[string, UrlClass]> = [
    // Loopback v4/v6 y nombres que nunca salen de la máquina.
    ['http://localhost:3000/', 'local'],
    ['https://localhost/', 'local'],
    ['http://LOCALHOST./x', 'local'],
    ['http://app.localhost:5173/', 'local'],
    ['http://127.0.0.1:8080/api', 'local'],
    ['http://127.12.0.3/', 'local'],
    ['http://[::1]:3000/', 'local'],
    ['http://[::ffff:127.0.0.1]/', 'local'],
    ['http://2130706433/', 'local'],
    ['about:blank', 'local'],
    // Red local: se confirma, no se veta.
    ['http://192.168.1.10/', 'external'],
    ['http://10.0.0.5:8000/', 'external'],
    ['http://[fd00::1]/', 'external'],
    // Internet.
    ['https://example.com/', 'external'],
    ['http://example.com:8080/a?b=c', 'external'],
    // Metadatos y link-local: siempre vetado.
    ['http://169.254.169.254/latest/meta-data/', 'blocked'],
    ['http://[fe80::1]/', 'blocked'],
    ['http://[::ffff:169.254.169.254]/', 'blocked'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'blocked'],
    // Esquemas raros.
    ['chrome://settings', 'blocked'],
    ['edge://settings', 'blocked'],
    ['devtools://devtools/bundled/inspector.html', 'blocked'],
    ['javascript:alert(1)', 'blocked'],
    ['data:text/html,<h1>x</h1>', 'blocked'],
    ['view-source:https://example.com/', 'blocked'],
    ['ftp://example.com/', 'blocked'],
    ['about:settings', 'blocked'],
    ['blob:https://example.com/123', 'blocked'],
    // Credenciales y URLs que no parsean.
    ['http://user:pass@localhost:3000/', 'blocked'],
    ['https://user@example.com/', 'blocked'],
    ['not a url', 'blocked'],
    ['', 'blocked'],
    ['http://', 'blocked'],
  ];
  it.each(table)('%s → %s', (url, expected) => {
    expect(classifyUrl(url, ctx())).toBe(expected);
  });

  it('allowHosts hace local un host (con o sin puerto), nunca lo vetado', () => {
    const c = ctx({ allowHosts: ['dev.internal:8080', '*.corp.example', '169.254.169.254'] });
    expect(classifyUrl('http://dev.internal:8080/', c)).toBe('local');
    expect(classifyUrl('http://dev.internal:9090/', c)).toBe('external');
    expect(classifyUrl('https://wiki.corp.example/', c)).toBe('local');
    expect(classifyUrl('http://169.254.169.254/', c)).toBe('blocked');
  });

  it('un origen aprobado en la sesión es approved, y solo ese origen', () => {
    const c = ctx({ approvedOrigins: new Set(['https://example.com']) });
    expect(classifyUrl('https://example.com/docs', c)).toBe('approved');
    expect(classifyUrl('http://example.com/docs', c)).toBe('external');
    expect(classifyUrl('https://example.com:8443/', c)).toBe('external');
    expect(classifyUrl('https://sub.example.com/', c)).toBe('external');
    expect(inspectUrl('https://example.com/x', c).origin).toBe('https://example.com');
  });

  describe('file:', () => {
    it('dentro de la carpeta de la sesión es local', () => {
      expect(classifyUrl(fileUrl(join(cwd, 'dist', 'index.html')), ctx())).toBe('local');
      // Lo que aún no existe, también (dentro).
      expect(classifyUrl(fileUrl(join(cwd, 'dist', 'nuevo.html')), ctx())).toBe('local');
    });

    it('fuera, o saliendo con `..`, se veta', () => {
      expect(classifyUrl(fileUrl(join(outside, 'secret.txt')), ctx())).toBe('blocked');
      const escaping = `${pathToFileURL(cwd).href}/../outside/secret.txt`;
      expect(classifyUrl(escaping, ctx())).toBe('blocked');
      expect(classifyUrl('file://servidor/compartido/x.html', ctx())).toBe('blocked');
    });

    it('un enlace dentro que apunta fuera se veta por su ruta real', () => {
      if (!junction) return;
      expect(classifyUrl(fileUrl(join(junction, 'secret.txt')), ctx())).toBe('blocked');
    });

    it('falla cerrado si la carpeta de la sesión no existe', () => {
      const missing = join(root, 'no-existe');
      expect(classifyUrl(fileUrl(join(missing, 'a.html')), ctx({ cwd: missing }))).toBe('blocked');
    });
  });
});

describe('subrecursos', () => {
  const c = ctx({ approvedOrigins: new Set(['https://example.com', 'http://192.168.1.10']) });

  it('lo vetado no pasa nunca, ni desde un documento local', () => {
    expect(subresourceAllowed('http://169.254.169.254/x', 'local', c)).toBe(false);
    expect(subresourceAllowed('chrome://settings', 'local', c)).toBe(false);
  });

  it('lo privado solo desde un documento local o privado aprobado', () => {
    expect(subresourceAllowed('http://localhost:3000/api', 'local', c)).toBe(true);
    expect(subresourceAllowed('http://192.168.1.20/', 'local', c)).toBe(true);
    expect(subresourceAllowed('http://localhost:3000/api', 'other', c)).toBe(false);
    expect(subresourceAllowed('http://10.0.0.1/', 'other', c)).toBe(false);
    expect(subresourceAllowed('http://localhost:3000/api', 'private-approved', c)).toBe(true);
  });

  it('internet público pasa desde cualquier documento', () => {
    expect(subresourceAllowed('https://cdn.example.org/lib.js', 'other', c)).toBe(true);
    expect(subresourceAllowed('https://cdn.example.org/lib.js', 'local', c)).toBe(true);
  });

  it('la posición del documento sale de su clase', () => {
    expect(documentStanding(inspectUrl('http://localhost/', c), [])).toBe('local');
    expect(documentStanding(inspectUrl('http://192.168.1.10/', c), [])).toBe('private-approved');
    expect(documentStanding(inspectUrl('https://example.com/', c), [])).toBe('other');
  });
});
