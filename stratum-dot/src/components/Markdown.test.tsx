import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown, parseBlocks } from './Markdown';

afterEach(cleanup);

describe('Markdown: tablas', () => {
  it('cabecera, separadora y filas → una tabla, con el formato de cada celda', () => {
    const { container } = render(
      <Markdown
        text={'Antes:\n| Proyecto | Estado |\n|---|:-:|\n| **Renfe** | `listo` |\n| Destilación | a \\| b |\n\nDespués'}
      />,
    );
    const table = container.querySelector('.md-table table')!;
    expect([...table.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Proyecto', 'Estado']);
    const rows = [...table.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ['Renfe', 'listo'],
      ['Destilación', 'a | b'],
    ]);
    expect(table.querySelector('td strong')?.textContent).toBe('Renfe');
    expect(table.querySelector('td code')?.textContent).toBe('listo');
    expect(container.querySelectorAll('p')[0]?.textContent).toBe('Antes:');
    expect(container.querySelectorAll('p')[1]?.textContent).toBe('Después');
  });

  it('una fila corta se rellena hasta el ancho de la tabla', () => {
    const { container } = render(<Markdown text={'| A | B | C |\n|---|---|---|\n| 1 |'} />);
    expect(container.querySelectorAll('tbody td')).toHaveLength(3);
  });

  it('sin fila separadora (o mientras aún se escribe) no es tabla', () => {
    expect(parseBlocks('| A | B |\n| 1 | 2 |').map((b) => b.kind)).toEqual(['para']);
    expect(parseBlocks('| A | B |').map((b) => b.kind)).toEqual(['para']);
  });

  it('una etiqueta dentro de una celda se ve como texto', () => {
    const { container } = render(<Markdown text={'| A |\n|---|\n| <img src=x onerror=alert(1)> |'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('td')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
