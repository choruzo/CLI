import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { grepTool } from './grep.js';
import type { ToolContext } from '../../agent/types.js';
import { StratumConfigSchema } from '../../config/schema.js';

const config = StratumConfigSchema.parse({});
let dir: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, cwd: dir, config, ...overrides };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-grep-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, '.ssh'));
  writeFileSync(join(dir, 'src', 'app.ts'), 'const marker = "TOKEN_MARK";\n');
  writeFileSync(join(dir, '.ssh', 'config'), 'IdentityFile TOKEN_MARK\n');
  writeFileSync(join(dir, 'deploy.pem'), '-----BEGIN TOKEN_MARK-----\n');
  writeFileSync(join(dir, '.env'), 'API=TOKEN_MARK\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('grep — rutas sensibles (capa 3)', () => {
  it('nunca devuelve contenido de claves, .ssh ni .env, y dice que los omitió', async () => {
    const res = await grepTool.execute({ pattern: 'TOKEN_MARK' }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output).toContain('app.ts');
    expect(res.output).not.toContain('IdentityFile');
    expect(res.output).not.toContain('BEGIN');
    expect(res.output).not.toContain('API=');
    // ripgrep ignora los ocultos (.ssh, .env) por defecto; el .pem cae siempre.
    expect(res.output).toMatch(/\d+ sensitive file\(s\)/);
  });

  it('la allowlist de config levanta el nivel confirm (.env) pero no el blocked', async () => {
    const allowCfg = StratumConfigSchema.parse({ tools: { sensitivePathAllowlist: ['.env'] } });
    const res = await grepTool.execute(
      { pattern: 'TOKEN_MARK', cwd: '.' },
      ctx({ config: allowCfg }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output).not.toContain('BEGIN');
  });

  it('veta en preflight una búsqueda cuya raíz es ~/.ssh', () => {
    const veto = grepTool.preflight!({ pattern: '.', cwd: '.ssh' }, ctx());
    expect(veto?.ok).toBe(false);
  });

  it('una raíz normal pasa el preflight', () => {
    expect(grepTool.preflight!({ pattern: '.', cwd: 'src' }, ctx())).toBeNull();
  });
});
