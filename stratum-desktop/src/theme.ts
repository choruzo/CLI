import { theme as cliTheme } from '../../stratum-cli/src/cli/ui/theme';

/**
 * Paleta de Stratum Desktop: la de la CLI (`stratum-cli/src/cli/ui/theme.ts`,
 * reexportada, no copiada) más los fondos que la terminal no necesita porque los
 * pone el emulador. Ver §5 de STRATUM_DESKTOP_PROJECT_DEFINITION.md.
 */
export const theme = {
  ...cliTheme,
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
