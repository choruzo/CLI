import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { activeGuides, buildGuideIndex, prepareGuideIndex, writeGuideFile } from './guides.js';
import { buildSystemPrompt } from './system-prompt.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';

function config(overrides: Record<string, unknown> = {}): StratumConfig {
  return StratumConfigSchema.parse(overrides);
}

describe('activeGuides', () => {
  it('la guía de enrutado requiere perfiles y no llega a los subagentes', () => {
    expect(activeGuides({ agentProfiles: [] }).map((g) => g.name)).toEqual([]);
    expect(activeGuides({ agentProfiles: ['code'] }).map((g) => g.name)).toEqual(['work-routing']);
    // Un subagente no delega: la guía de enrutado no le dice nada aplicable.
    expect(activeGuides({ agentProfiles: ['code'], isSubagent: true })).toEqual([]);
  });

  it('la guía de TDD requiere comando de tests', () => {
    expect(activeGuides({ testCommand: '' })).toEqual([]);
    expect(activeGuides({ testCommand: 'npm test' }).map((g) => g.name)).toEqual([
      'testing-discipline',
    ]);
    // A un subagente sí le llega: el perfil `tdd` es precisamente un subagente.
    expect(activeGuides({ testCommand: 'npm test', isSubagent: true }).map((g) => g.name)).toEqual([
      'testing-discipline',
    ]);
  });

  it('el cuerpo es exactamente el bloque que iría inline', () => {
    const [guide] = activeGuides({ agentProfiles: ['code', 'research'] });
    expect(guide!.body).toContain('# Work routing');
    expect(guide!.body).toContain('code, research');
  });
});

describe('writeGuideFile', () => {
  it('escribe el cuerpo con fingerprint y no reescribe si no cambió', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-guides-'));
    const [guide] = activeGuides({ agentProfiles: ['code'] });
    const path = writeGuideFile(dir, guide!)!;
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toMatch(/<!-- stratum-guide v\d+ fingerprint: [0-9a-f]+ -->/);
    expect(content).toContain('# Work routing');

    const before = statSync(path).mtimeMs;
    // Marca de agua intacta → misma huella → no se toca el fichero.
    const again = writeGuideFile(dir, guide!)!;
    expect(again).toBe(path);
    expect(statSync(again).mtimeMs).toBe(before);
  });

  it('reescribe cuando el cuerpo cambia', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-guides-'));
    const [one] = activeGuides({ agentProfiles: ['code'] });
    const path = writeGuideFile(dir, one!)!;
    const [two] = activeGuides({ agentProfiles: ['code', 'tdd'] });
    writeGuideFile(dir, two!);
    expect(readFileSync(path, 'utf-8')).toContain('code, tdd');
  });
});

describe('buildGuideIndex', () => {
  it('la tabla lleva el trigger antes de la ruta', () => {
    const [guide] = activeGuides({ agentProfiles: ['code'] });
    const index = buildGuideIndex([{ guide: guide!, path: './.stratum/guides/work-routing.md' }]);
    expect(index).toContain('# Operating guides');
    expect(index).toContain('| Guide | Read it when | File |');
    expect(index).toContain('`./.stratum/guides/work-routing.md`');
    // El índice es el puntero: nunca lleva el cuerpo.
    expect(index).not.toContain('Four-file rule');
  });

  it('sin guías activas no hay tabla', () => {
    expect(buildGuideIndex([])).toBe('');
  });
});

describe('prepareGuideIndex', () => {
  it('en modo inline (default) no materializa nada', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stratum-guides-'));
    const index = prepareGuideIndex(config(), { agentProfiles: ['code'] }, cwd);
    expect(index).toBe('');
    expect(existsSync(join(cwd, '.stratum/guides'))).toBe(false);
  });

  it('en modo pointers materializa y devuelve la tabla', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stratum-guides-'));
    const index = prepareGuideIndex(
      config({ prompt: { guides: 'pointers' }, tools: { testCommand: 'npm test' } }),
      { agentProfiles: ['code'], testCommand: 'npm test' },
      cwd,
    );
    expect(index).toContain('# Operating guides');
    expect(existsSync(join(cwd, '.stratum/guides/work-routing.md'))).toBe(true);
    expect(existsSync(join(cwd, '.stratum/guides/testing-discipline.md'))).toBe(true);
    // Rutas relativas con separadores POSIX: es como el agente las escribe.
    expect(index).toContain('`./.stratum/guides/work-routing.md`');
  });

  it('si una guía no se puede escribir, cae a inline en vez de apuntar al vacío', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stratum-guides-'));
    // Un fichero donde debería ir el directorio: mkdir falla para todas.
    writeFileSync(join(cwd, '.stratum'), 'no soy un directorio', 'utf-8');
    const index = prepareGuideIndex(
      config({ prompt: { guides: 'pointers' } }),
      { agentProfiles: ['code'] },
      cwd,
    );
    expect(index).toBe('');
  });
});

describe('buildSystemPrompt — punteros vs inline', () => {
  it('inline lleva los cuerpos y ninguna tabla de punteros', () => {
    const prompt = buildSystemPrompt(config({ tools: { testCommand: 'npm test' } }), undefined, {
      agentProfiles: ['code'],
    });
    expect(prompt).toContain('# Work routing');
    expect(prompt).toContain('# Testing discipline');
    expect(prompt).not.toContain('# Operating guides');
  });

  it('con env.guides lleva la tabla y ningún cuerpo', () => {
    const prompt = buildSystemPrompt(config({ tools: { testCommand: 'npm test' } }), undefined, {
      agentProfiles: ['code'],
      guides: '# Operating guides\n| x | y | z |',
    });
    expect(prompt).toContain('# Operating guides');
    expect(prompt).not.toContain('# Work routing');
    expect(prompt).not.toContain('# Testing discipline');
  });
});

describe('buildSystemPrompt — identidad y gate de preguntas (§3)', () => {
  it('el contrato de identidad está siempre', () => {
    const prompt = buildSystemPrompt(config(), undefined, {});
    expect(prompt).toContain('# Identity');
    expect(prompt).toContain('Never introduce yourself as "your assistant"');
  });

  it('el bloque de preguntas solo va al agente principal', () => {
    const main = buildSystemPrompt(config(), undefined, {});
    expect(main).toContain('# Asking the user');
    expect(main).toContain('A question about the blocker is not an answer to the blocker');
    expect(buildSystemPrompt(config(), undefined, { isSubagent: true })).not.toContain(
      '# Asking the user',
    );
  });
});
