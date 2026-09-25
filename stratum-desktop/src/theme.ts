import { theme as cliTheme } from '../../stratum-cli/src/cli/ui/theme';

/**
 * Paleta de Stratum Desktop: la de la CLI (`stratum-cli/src/cli/ui/theme.ts`,
 * reexportada, no copiada) más los fondos que la terminal no necesita porque los
 * pone el emulador. Ver §5 de STRATUM_DESKTOP_PROJECT_DEFINITION.md.
 *
 * D7: `textFaint` se aclara para llegar a 4,5:1 (WCAG AA) sobre todos los
 * fondos de la ventana; en la terminal manda el fondo del emulador, así que la
 * CLI se queda con el suyo. `textDisabled` no se toca: solo pinta lo
 * deshabilitado, que WCAG exime.
 */
export const A11Y_OVERRIDES = {
  textFaint: '#7C8493',
} as const;

export const theme = {
  ...cliTheme,
  ...A11Y_OVERRIDES,
  bgApp: '#0D0D0D',
  bgPanel: '#111111',
} as const;

export type Theme = typeof theme;

/** Nombre de la variable CSS de un token: `accent` → `--color-accent`. */
export function cssVar(token: keyof Theme): string {
  return `--color-${token}`;
}

/** Vuelca la paleta como variables CSS en `:root`. Se llama una vez al arrancar. */
export function injectCssVars(t: Theme = theme, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(t)) {
    root.style.setProperty(cssVar(k as keyof Theme), v);
  }
}
