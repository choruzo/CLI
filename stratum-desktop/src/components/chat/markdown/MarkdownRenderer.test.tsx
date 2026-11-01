import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const renders = vi.hoisted(() => [] as string[]);
vi.mock('react-markdown', async (importOriginal) => {
  const mod = await importOriginal<typeof import('react-markdown')>();
  const Original = mod.default;
  return {
    ...mod,
    default: (props: Parameters<typeof Original>[0]) => {
      renders.push(String(props.children));
      return Original(props);
    },
  };
});
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { openUrl } from '@tauri-apps/plugin-opener';
import { MarkdownRenderer, safeUrl } from './MarkdownRenderer';
import { VISUAL_CSP, VISUAL_SANDBOX } from './VisualBlock';

afterEach(() => {
  cleanup();
  renders.length = 0;
});

describe('MarkdownRenderer', () => {
  it('no interpreta HTML crudo', () => {
    const { container } = render(
      <MarkdownRenderer text={'hola <img src=x onerror="alert(1)"> <script>alert(1)</script>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  it('neutraliza enlaces que no son http(s) ni mailto', () => {
    const { container } = render(
      <MarkdownRenderer text={'[a](javascript:alert(1)) [b](https://example.com) [c](file:///etc/passwd)'} />,
    );
    const links = [...container.querySelectorAll('[role="link"]')].map((a) => a.getAttribute('title'));
    expect(links).toEqual(['https://example.com']);
    expect(safeUrl('JavaScript:alert(1)')).toBe('');
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
  });

  it('un enlace no deja ninguna URL navegable en el DOM y se abre fuera', () => {
    const { container } = render(<MarkdownRenderer text={'[docs](https://example.com/docs)'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs');
  });


  it('sustituye las imágenes por un enlace', () => {
    const { container } = render(<MarkdownRenderer text={'![gato](https://example.com/g.png)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[imagen: gato]');
  });

  it('resalta un bloque de código cerrado y no uno abierto en streaming', () => {
    const closed = render(<MarkdownRenderer text={'```ts\nconst a = 1;\n```\n'} streaming />);
    expect(closed.container.querySelector('code.hljs')).not.toBeNull();
    cleanup();
    // Sin salto tras la valla, un delta aún podría convertirla en texto (```x).
    const pending = render(<MarkdownRenderer text={'```ts\nconst a = 1;\n```'} streaming />);
    expect(pending.container.querySelector('code.hljs')).toBeNull();
    cleanup();
    const open = render(<MarkdownRenderer text={'```ts\nconst a = 1;\n'} streaming />);
    expect(open.container.querySelector('code.hljs')).toBeNull();
  });

  describe('vallas ```visual', () => {
    const VISUAL = '```visual\n<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>\n<script>parent.alert(1)</script>\n```\n';

    it('con `visuals`, se pintan en un iframe sin scripts y con CSP propia', () => {
      const { container } = render(<MarkdownRenderer text={VISUAL} visuals />);
      const frame = container.querySelector('iframe');
      expect(frame).not.toBeNull();
      // Sin `allow-scripts`: ni el <script> ni un on*= se ejecutan dentro.
      expect(frame!.getAttribute('sandbox')).toBe(VISUAL_SANDBOX);
      expect(frame!.getAttribute('sandbox')).not.toContain('allow-scripts');
      const doc = frame!.getAttribute('srcdoc') ?? '';
      expect(doc.indexOf(VISUAL_CSP)).toBeGreaterThan(-1);
      expect(doc.indexOf(VISUAL_CSP)).toBeLessThan(doc.indexOf('<rect'));
      expect(doc).toContain('--viz-1:');
      expect(doc).toContain('--color-accent:');
      // Nada del visual entra en el DOM de la app.
      expect(container.querySelector('svg rect')).toBeNull();
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('.code-block')).toBeNull();
    });

    it('«Ver HTML» enseña el fuente como texto', () => {
      const { container } = render(<MarkdownRenderer text={VISUAL} visuals />);
      fireEvent.click(screen.getByRole('button', { name: 'Ver HTML' }));
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('.visual-block__source')?.textContent).toContain('<script>parent.alert(1)</script>');
      expect(container.querySelector('script')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Ver visual' }));
      expect(container.querySelector('iframe')).not.toBeNull();
    });

    it('mientras la valla sigue abierta no se monta el marco', () => {
      const open = render(<MarkdownRenderer text={'```visual\n<div>a</div>\n'} streaming visuals />);
      expect(open.container.querySelector('iframe')).toBeNull();
      expect(open.container.textContent).toContain('Preparando visual');
      cleanup();
      const closed = render(<MarkdownRenderer text={'```visual\n<div>a</div>\n```\n'} streaming visuals />);
      expect(closed.container.querySelector('iframe')).not.toBeNull();
    });

    it('sin `visuals` (vista previa de un fichero) es un bloque de código', () => {
      const { container } = render(<MarkdownRenderer text={VISUAL} />);
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('.code-block')).not.toBeNull();
    });

    it('otras vallas siguen siendo código aunque haya `visuals`', () => {
      const { container } = render(<MarkdownRenderer text={'```html\n<b>x</b>\n```\n'} visuals />);
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('code.hljs')).not.toBeNull();
    });
  });

  it('en streaming solo re-renderiza el último bloque', () => {
    const { rerender } = render(<MarkdownRenderer text={'# A\n\nUno.\n\nDos'} streaming />);
    renders.length = 0;
    rerender(<MarkdownRenderer text={'# A\n\nUno.\n\nDos y tres'} streaming />);
    expect(renders).toEqual(['Dos y tres']);
  });
});
