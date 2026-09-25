import { describe, it, expect } from 'vitest';
import { theme as cliTheme } from '../../stratum-cli/src/cli/ui/theme';
import { A11Y_OVERRIDES, cssVar, injectCssVars, theme } from './theme';

/** Contraste WCAG 2.x entre dos colores `#RRGGBB`. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme', () => {
  it('reexporta la paleta de la CLI (salvo los ajustes de contraste) y añade los fondos de ventana', () => {
    for (const [k, v] of Object.entries(cliTheme)) {
      const override = A11Y_OVERRIDES[k as keyof typeof A11Y_OVERRIDES];
      expect(theme[k as keyof typeof theme]).toBe(override ?? v);
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

  it('todo color de texto llega a 4,5:1 sobre cada fondo (D7, WCAG AA)', () => {
    const texts = [
      'textPrimary',
      'textResponse',
      'textMuted',
      'textFaint',
      'accent',
      'accentBright',
      'success',
      'error',
      'errorMuted',
      'warning',
      'code',
    ] as const;
    const backgrounds = ['bgApp', 'bgPanel', 'bgStatusbar', 'bgDropdown'] as const;
    for (const fg of texts) {
      for (const bg of backgrounds) {
        expect(contrast(theme[fg], theme[bg]), `${fg} sobre ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
