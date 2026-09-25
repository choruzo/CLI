#!/usr/bin/env node
/**
 * Manifiesto del auto-update de Stratum Desktop (D7): `latest.json` en el
 * formato de `tauri-plugin-updater` v2, a partir de los paquetes firmados de
 * una release (`*.sig` junto a cada instalador).
 *
 *   node scripts/updater-manifest.mjs <dir> --version 0.2.0 \
 *     --base-url https://github.com/choruzo/CLI/releases/download/desktop-v0.2.0 \
 *     [--notes-file notas.md] [--pub-date 2026-09-25T10:00:00Z] > latest.json
 *
 * Plataformas: el plugin busca primero `<os>-<arch>-<instalador>` (la app sabe
 * con qué se instaló) y después `<os>-<arch>`. En Windows el genérico apunta
 * al instalador NSIS; en Linux, al AppImage (un .deb se actualiza con su
 * propia clave si la release trae su firma).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Qué paquete va a qué claves del manifiesto. */
const RULES = [
  { test: /_x64-setup\.exe$/, keys: ['windows-x86_64-nsis', 'windows-x86_64'] },
  { test: /_x64_[^_]+\.msi$|_x64\.msi$/, keys: ['windows-x86_64-msi'] },
  { test: /_amd64\.AppImage$/, keys: ['linux-x86_64-appimage', 'linux-x86_64'] },
  { test: /_amd64\.deb$/, keys: ['linux-x86_64-deb'] },
];

/**
 * @param {Array<{ name: string, signature: string }>} packages paquetes con su firma
 * @param {{ version: string, baseUrl: string, notes?: string, pubDate?: string }} opts
 */
export function buildManifest(packages, opts) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(opts.version)) {
    throw new Error(`Versión no válida: ${opts.version}`);
  }
  const base = opts.baseUrl.replace(/\/+$/, '');
  const platforms = {};
  for (const pkg of packages) {
    const rule = RULES.find((r) => r.test.test(pkg.name));
    if (!rule) continue;
    const entry = {
      signature: pkg.signature.trim(),
      url: `${base}/${encodeURIComponent(pkg.name)}`,
    };
    for (const key of rule.keys) {
      if (platforms[key]) throw new Error(`Dos paquetes para ${key}: revisa la release`);
      platforms[key] = entry;
    }
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error('Ningún paquete firmado: ¿se construyó con createUpdaterArtifacts y la clave?');
  }
  return {
    version: opts.version,
    notes: opts.notes ?? '',
    pub_date: opts.pubDate ?? new Date().toISOString(),
    platforms,
  };
}

/**
 * Paquetes firmados de un directorio: uno por cada `<paquete>.sig`. El paquete
 * en sí no hace falta (el workflow solo descarga las firmas de la release).
 */
export function readPackages(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sig'))
    .map((sig) => ({ name: sig.slice(0, -4), signature: readFileSync(join(dir, sig), 'utf8') }));
}

function parseArgs(argv) {
  const [dir, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    opts[key] = rest[i + 1];
  }
  if (!dir || !opts.version || !opts['base-url']) {
    throw new Error('Uso: updater-manifest.mjs <dir> --version X.Y.Z --base-url URL [--notes-file f] [--pub-date iso]');
  }
  return { dir, opts };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { dir, opts } = parseArgs(process.argv.slice(2));
    const manifest = buildManifest(readPackages(dir), {
      version: opts.version,
      baseUrl: opts['base-url'],
      notes: opts['notes-file'] ? readFileSync(opts['notes-file'], 'utf8').trim() : undefined,
      pubDate: opts['pub-date'],
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    console.error(`updater-manifest: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
