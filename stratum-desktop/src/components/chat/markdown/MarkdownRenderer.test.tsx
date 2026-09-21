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

  it('en streaming solo re-renderiza el último bloque', () => {
    const { rerender } = render(<MarkdownRenderer text={'# A\n\nUno.\n\nDos'} streaming />);
    renders.length = 0;
    rerender(<MarkdownRenderer text={'# A\n\nUno.\n\nDos y tres'} streaming />);
    expect(renders).toEqual(['Dos y tres']);
  });
});
