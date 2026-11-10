import type { StratumConfig } from '../../config/schema.js';
import { locateBrowser } from '../../browser/locate.js';
import type { ToolRegistry } from '../registry.js';
import { createBrowserTools } from './browser.js';

/**
 * El navegador del agente: el ejecutable que usará la sesión, o `null` si está
 * apagado (`tools.browser.enabled`) o no hay ninguno instalado.
 * `STRATUM_NO_BROWSER=1` lo apaga también (lo pone `vitest.config.ts`: el
 * toolset de un test no puede depender de lo instalado en la máquina).
 */
export function browserExecutable(
  config: Pick<StratumConfig, 'tools'>,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string | null {
  const browser = config.tools.browser;
  if (!browser.enabled || env['STRATUM_NO_BROWSER'] === '1') return null;
  return locateBrowser(browser);
}

/**
 * Registra las tools `browser_*` si hay navegador. Quién las ofrece (el agente
 * de código y el asistente, no el `companion` ni los subagentes) lo decide
 * `StratumAgent`, que además crea el `BrowserManager` de la sesión.
 */
export function registerBrowserTools(registry: ToolRegistry, config: StratumConfig): void {
  if (browserExecutable(config) === null) return;
  for (const tool of createBrowserTools()) registry.register(tool);
}
