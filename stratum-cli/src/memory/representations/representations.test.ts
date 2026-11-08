/**
 * M19 fase 4 — representaciones: páginas con enlaces derivadas de las notas.
 * Deterministas, nunca fuente de verdad, y que no pisan lo que no es suyo.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumConfigSchema } from '../../config/schema.js';
import type { DecisionRecord } from '../decisions.js';
import { buildPages, GENERATED_MARK, INDEX_PAGE, PROFILE_PAGE } from './build.js';
import { syncRepresentations, wikiDir } from './sync.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function note(
  over: Partial<DecisionRecord> & Pick<DecisionRecord, 'id' | 'title'>,
): DecisionRecord {
  return {
    timestamp: '2026-11-01T10:00:00.000Z',
    type: 'topic',
    content: '',
    tags: [],
    importance: 'medium',
    embedding_ref: over.id,
    ...over,
  };
}

const NOTES: DecisionRecord[] = [
  note({
    id: 'd1',
    type: 'person',
    title: 'Lucía',
    content: 'Hermana. Vive en Sevilla y tiene a Miso.',
  }),
  note({ id: 'd2', type: 'topic', title: 'Miso', content: 'El gato naranja.', tags: ['mascotas'] }),
  note({
    id: 'd3',
    type: 'project',
    title: 'Huerto',
    content: 'Tomates en el balcón.',
    tags: ['mascotas'],
  }),
  note({ id: 'd4', type: 'profile', title: 'Trato', content: 'Hablar de tú, frases cortas.' }),
  // Un tipo antiguo se presenta como topic; user_preference, como profile.
  note({ id: 'd5', type: 'architectural' as never, title: 'Banana', content: 'Fruta.' }),
  note({ id: 'd6', type: 'user_preference' as never, title: 'Café', content: 'Solo, sin azúcar.' }),
];

const page = (pages: ReturnType<typeof buildPages>, file: string) =>
  pages.find((p) => p.file === file)?.content ?? '';

describe('buildPages', () => {
  it('genera índice, perfil y una página por entidad, todas marcadas como derivadas', () => {
    const pages = buildPages(NOTES);
    expect(pages.map((p) => p.file)).toEqual([
      'banana.md',
      'huerto.md',
      INDEX_PAGE,
      'lucia.md',
      'miso.md',
      PROFILE_PAGE,
    ]);
    for (const p of pages) expect(p.content.startsWith(GENERATED_MARK)).toBe(true);
    const profile = page(pages, PROFILE_PAGE);
    expect(profile).toContain('Hablar de tú');
    expect(profile).toContain('Solo, sin azúcar.');
    expect(page(pages, INDEX_PAGE)).toContain('[Lucía](lucia.md)');
  });

  it('enlaza por mención y etiqueta compartida, con enlaces de vuelta', () => {
    const pages = buildPages(NOTES);
    const lucia = page(pages, 'lucia.md');
    expect(lucia).toContain('## Mentions');
    expect(lucia).toContain('[Miso](miso.md)');
    const miso = page(pages, 'miso.md');
    expect(miso).toContain('## Mentioned by');
    expect(miso).toContain('[Lucía](lucia.md)');
    expect(miso).toContain('## Shares tags with');
    expect(miso).toContain('[Huerto](huerto.md)');
  });

  it('una mención respeta el límite de palabra y un título corto no enlaza', () => {
    const pages = buildPages([
      note({ id: 'a', type: 'person', title: 'Ana', content: 'Le gusta la banana.' }),
      note({ id: 'b', type: 'topic', title: 'Banana', content: 'Fruta.' }),
      note({ id: 'c', type: 'topic', title: 'Yo', content: 'Ana y yo.' }),
    ]);
    // «Ana» está dentro de «banana», pero no como palabra.
    expect(page(pages, 'banana.md')).not.toMatch(/## Mentions[\s\S]*\[Ana\]/);
    expect(page(pages, 'ana.md')).toContain('[Banana](banana.md)');
    // «Yo» (2 letras) no genera enlaces.
    expect(page(pages, 'ana.md')).not.toMatch(/## Mentions[\s\S]*?\[Yo\][\s\S]*?## Mentioned by/);
    expect(page(pages, 'yo.md')).toContain('[Ana](ana.md)');
  });

  it('es determinista, no depende del orden de entrada y desambigua títulos iguales', () => {
    const twins = [
      note({ id: 'x1', title: 'Plan', content: 'uno' }),
      note({ id: 'x2', title: 'Plan', content: 'dos' }),
    ];
    const a = buildPages(twins);
    const b = buildPages([...twins].reverse());
    expect(a).toEqual(b);
    const files = a.map((p) => p.file).filter((f) => f.startsWith('plan'));
    expect(new Set(files).size).toBe(2);
  });

  it('sin notas, índice y perfil vacíos', () => {
    const pages = buildPages([]);
    expect(pages.map((p) => p.file)).toEqual([INDEX_PAGE, PROFILE_PAGE]);
    expect(page(pages, PROFILE_PAGE)).toContain('Nothing remembered yet.');
  });

  it('un título con markdown o saltos no rompe la página', () => {
    const pages = buildPages([note({ id: 'm', title: 'A\n# B', content: 'x' })]);
    const main = pages.find((p) => p.file.startsWith('a-b'))!;
    expect(main.content).toContain('# A # B');
    expect(main.content.split('\n').filter((l) => l.startsWith('# ')).length).toBe(1);
  });
});

describe('syncRepresentations', () => {
  function config(redact = false) {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-'));
    dirs.push(dir);
    return StratumConfigSchema.parse({
      memory: { decisionsFile: join(dir, 'memory', 'decisions.json') },
      ...(redact ? { security: { redaction: { enabled: true } } } : {}),
    });
  }

  it('escribe en wiki/ junto a decisions.json, solo cambia lo que cambió y retira lo huérfano', () => {
    const cfg = config();
    const first = syncRepresentations(cfg, NOTES, 'sections');
    expect(first.applicable).toBe(true);
    expect(first.written).toBe(6);
    expect(readdirSync(wikiDir(cfg)).sort()).toHaveLength(6);

    const again = syncRepresentations(cfg, NOTES, 'sections');
    expect(again.written).toBe(0);
    expect(again.unchanged).toBe(6);

    // Se olvida «Miso»: su página desaparece y la de Lucía deja de enlazarla.
    const next = syncRepresentations(
      cfg,
      NOTES.filter((n) => n.id !== 'd2'),
      'sections',
    );
    expect(next.removed).toBe(1);
    expect(existsSync(join(wikiDir(cfg), 'miso.md'))).toBe(false);
    expect(readFileSync(join(wikiDir(cfg), 'lucia.md'), 'utf-8')).not.toContain('miso.md');
  });

  it('no toca lo que una persona dejó en esa carpeta, ni pisa su fichero con nombre de página', () => {
    const cfg = config();
    syncRepresentations(cfg, NOTES, 'sections');
    const dir = wikiDir(cfg);
    writeFileSync(join(dir, 'mis-apuntes.md'), 'mío');
    writeFileSync(join(dir, 'lucia.md'), 'editado a mano');
    const res = syncRepresentations(cfg, NOTES, 'sections');
    expect(readFileSync(join(dir, 'mis-apuntes.md'), 'utf-8')).toBe('mío');
    expect(readFileSync(join(dir, 'lucia.md'), 'utf-8')).toBe('editado a mano');
    expect(res.foreign).toBe(2);
    // Y al retirar una huérfana tampoco se lleva lo ajeno.
    const none = syncRepresentations(cfg, [], 'sections');
    expect(readFileSync(join(dir, 'mis-apuntes.md'), 'utf-8')).toBe('mío');
    expect(none.foreign).toBeGreaterThanOrEqual(2);
  });

  it('en una memoria de código no genera nada', () => {
    const cfg = config();
    const res = syncRepresentations(cfg, NOTES, 'code');
    expect(res.applicable).toBe(false);
    expect(existsSync(wikiDir(cfg))).toBe(false);
  });

  it('nunca lanza si no puede escribir', () => {
    const cfg = config();
    // `wiki` existe como fichero: crear la carpeta falla y se cuenta.
    syncRepresentations(cfg, [], 'sections');
    rmSync(wikiDir(cfg), { recursive: true });
    writeFileSync(wikiDir(cfg), 'no soy una carpeta');
    const res = syncRepresentations(cfg, NOTES, 'sections');
    expect(res.errors).toBeGreaterThan(0);
  });

  it('redacta secretos antes de escribir', () => {
    const cfg = config(true);
    const secret = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
    syncRepresentations(
      cfg,
      [note({ id: 's', title: 'Clave', content: `La clave es ${secret}` })],
      'sections',
    );
    const text = readFileSync(join(wikiDir(cfg), 'clave.md'), 'utf-8');
    expect(text).not.toContain(secret);
  });
});
