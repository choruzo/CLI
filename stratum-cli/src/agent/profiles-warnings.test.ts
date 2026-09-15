import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProfileLoader } from './profiles.js';
import { formatProfilesReport, profilesToJson } from './profiles-report.js';

function projectWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'stratum-h16-profiles-'));
  const dir = join(root, '.stratum', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return root;
}

describe('perfiles con tools retiradas (Hito 16)', () => {
  const root = projectWith({
    'h16-legacy.md':
      '---\ndescription: legacy\nallowedTools: [read_file, bash, ssh_exec]\n---\nBody.',
    'h16-modern.md': '---\ndescription: modern\nallowedTools: [read_file, exec]\n---\nBody.',
  });
  const loader = new ProfileLoader(root);

  it('avisa sin traducir: la tool retirada sigue sin concederse', () => {
    const warning = loader.warnings().find((w) => w.name === 'h16-legacy');
    expect(warning?.message).toContain('bash → exec');
    expect(warning?.message).toContain('ssh_exec → exec');
    expect(loader.resolve('h16-legacy')?.allowedTools).toEqual(['read_file', 'bash', 'ssh_exec']);
    expect(loader.warnings().map((w) => w.name)).not.toContain('h16-modern');
  });

  it('el aviso llega al informe de texto y al JSON', () => {
    const text = formatProfilesReport(loader.list(), loader.invalidProfiles(), {
      warnings: loader.warnings(),
    });
    expect(text).toContain('Avisos (');
    expect(text).toContain('! h16-legacy');

    const json = profilesToJson(loader.list(), loader.invalidProfiles(), loader.warnings()) as {
      warnings: Array<{ name: string }>;
    };
    expect(json.warnings.map((w) => w.name)).toContain('h16-legacy');
  });
});
