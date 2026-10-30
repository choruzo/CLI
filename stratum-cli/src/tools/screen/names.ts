/**
 * M15 — nombres de las tools de computer use en la caja. Sin imports: los leen
 * `callEffects`, los presets y el filtro de toolset sin arrastrar el backend.
 */
export const SCREEN_SCREENSHOT_TOOL = 'screen_screenshot';

/** Todas, en el orden en que se registran (y se ofrecen al modelo). */
export const SCREEN_TOOLS: readonly string[] = [
  SCREEN_SCREENSHOT_TOOL,
  'screen_click',
  'screen_type',
  'screen_key',
  'screen_scroll',
  'screen_wait',
];

/** Solo miran la pantalla (capturar, esperar y capturar): no cambian nada en la caja. */
export const SCREEN_READ_TOOLS: readonly string[] = [SCREEN_SCREENSHOT_TOOL, 'screen_wait'];

export function isScreenTool(name: string): boolean {
  return SCREEN_TOOLS.includes(name);
}
