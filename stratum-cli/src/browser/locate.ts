/**
 * Dónde está el navegador que Stratum maneja: un Edge, Chrome o Chromium **ya
 * instalado** (no se descarga ninguno). `tools.browser.executable` (solo de la
 * config global) manda; si no, rutas conocidas de cada plataforma. Sin
 * navegador, `null`: las tools `browser_*` no se ofrecen.
 *
 * Solo mira el disco y el `PATH`; las dependencias se inyectan para los tests.
 */
import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface LocateDeps {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  /** ¿Existe un fichero ejecutable en esa ruta? */
  isFile(path: string): boolean;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export const defaultLocateDeps: LocateDeps = {
  platform: process.platform,
  env: process.env,
  isFile,
};

/** Rutas absolutas candidatas, en orden de preferencia (Edge primero). */
export function candidatePaths(deps: Pick<LocateDeps, 'platform' | 'env'>): string[] {
  const { platform, env } = deps;
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env['ProgramFiles'], env['LOCALAPPDATA']].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    const apps = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ];
    return apps.flatMap((app) => roots.map((root) => win32.join(root, ...app)));
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const names = ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'];
  const dirs = (env['PATH'] ?? '').split(':').filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => posix.join(dir, name)));
}

/**
 * El ejecutable del navegador, o `null`. Uno configurado que no existe es
 * `null`: no se busca otro a sus espaldas.
 */
export function locateBrowser(
  options: { executable?: string | undefined },
  deps: LocateDeps = defaultLocateDeps,
): string | null {
  const configured = options.executable?.trim();
  if (configured) return deps.isFile(configured) ? configured : null;
  for (const path of candidatePaths(deps)) if (deps.isFile(path)) return path;
  return null;
}
