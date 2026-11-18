/**
 * Utilidades para los tests del conector CRTM: el zip de cada modo armado con
 * los recortes de `fixtures/<modo>/`, sus índices construidos en un directorio
 * y un contexto de tools con reloj fijo. Nunca entra en el server de la caja
 * (`server.ts`).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../renfe/test-helpers.js';
import { MODE_IDS, type ModeId } from './feeds.js';
import { buildModeIndex, indexFile } from './index-build.js';
import { ModeIndex } from './queries.js';
import type { CrtmContext } from './tools.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** `modified` de ArcGIS de cada modo en los tests (ms epoch). */
export const FIXTURE_MODIFIED: Record<ModeId, string> = {
  metro: String(Date.parse('2025-05-27T08:00:00Z')),
  ml: String(Date.parse('2026-10-28T10:00:00Z')),
  emt: String(Date.parse('2026-10-30T07:00:00Z')),
  urbano: String(Date.parse('2026-11-05T09:00:00Z')),
  interurbano: String(Date.parse('2026-11-05T09:00:00Z')),
};

/** El GTFS recortado de un modo empaquetado en un zip. */
export function fixtureZip(mode: ModeId, fixtures = FIXTURES): Buffer {
  const dir = join(fixtures, mode);
  const entries: Record<string, string> = {};
  for (const f of readdirSync(dir)) entries[f] = readFileSync(join(dir, f), 'utf8');
  return makeZip(entries);
}

/** Construye el índice de un modo en `dir` y devuelve su ruta. */
export async function buildFixtureIndex(
  mode: ModeId,
  dir: string,
  opts: { feedModified?: string } = {},
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, `fixture-${mode}.zip`);
  writeFileSync(zipPath, fixtureZip(mode));
  const r = await buildModeIndex({
    mode,
    zipPath,
    dir,
    feedModified: opts.feedModified ?? FIXTURE_MODIFIED[mode],
    now: () => new Date('2026-11-17T08:00:00Z'),
    warn: () => undefined,
  });
  return r.path;
}

export async function buildAllFixtureIndexes(dir: string): Promise<void> {
  for (const m of MODE_IDS) await buildFixtureIndex(m, dir);
}

/** Contexto de tools sobre los índices de `dir` con un reloj fijo (hora de Madrid, ISO con zona). */
export function fixtureContext(
  dir: string,
  nowIso: string,
  only: readonly ModeId[] = MODE_IDS,
): CrtmContext {
  return {
    open: async (mode) => (only.includes(mode) ? ModeIndex.open(join(dir, indexFile(mode))) : null),
    unavailable: (mode) => `Estoy preparando los horarios de ${mode} (test).`,
    now: () => new Date(nowIso),
  };
}
