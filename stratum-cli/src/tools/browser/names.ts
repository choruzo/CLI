/**
 * Nombres de las tools del navegador del agente. Sin imports: los leen
 * `callEffects`, los presets, el filtro de toolset y el prompt sin arrastrar el
 * cliente CDP.
 */
export const BROWSER_NAVIGATE_TOOL = 'browser_navigate';
export const BROWSER_SCREENSHOT_TOOL = 'browser_screenshot';

/** Todas, en el orden en que se registran (y se ofrecen al modelo). */
export const BROWSER_TOOLS: readonly string[] = [
  BROWSER_NAVIGATE_TOOL,
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_console',
  'browser_eval',
  BROWSER_SCREENSHOT_TOOL,
];

/** Solo miran: en una sesión read-only siguen disponibles. */
export const BROWSER_READ_TOOLS: readonly string[] = [
  BROWSER_NAVIGATE_TOOL,
  'browser_snapshot',
  'browser_console',
  BROWSER_SCREENSHOT_TOOL,
];

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOLS.includes(name);
}
