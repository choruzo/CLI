import { describe, it, expect } from 'vitest';
import { theme as cliTheme } from '../../stratum-cli/src/cli/ui/theme';
import { cssVar, injectCssVars, theme } from './theme';

describe('theme', () => {
  it('reexporta la paleta de la CLI sin alterarla y añade los fondos de ventana', () => {
    for (const [k, v] of Object.entries(cliTheme)) {
      expect(theme[k as keyof typeof theme]).toBe(v);
    }
    expect(theme.bgApp).toBe('#0D0D0D');
    expect(theme.bgPanel).toBe('#111111');
  });

  it('injectCssVars vuelca cada token como --color-<token> en :root', () => {
    injectCssVars();
    const style = getComputedStyle(document.documentElement);
    for (const [k, v] of Object.entries(theme)) {
      expect(style.getPropertyValue(cssVar(k as keyof typeof theme))).toBe(v);
    }
    expect(style.getPropertyValue('--color-accent')).toBe('#F59E0B');
  });
});
