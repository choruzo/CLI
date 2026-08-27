import { describe, it, expect } from 'vitest';
import { pushHistory, historyPrev, historyNext } from './input-history.js';

describe('pushHistory (§10)', () => {
  it('añade el input más reciente al principio', () => {
    expect(pushHistory(['b'], 'a')).toEqual(['a', 'b']);
  });

  it('ignora entradas vacías o solo espacios', () => {
    expect(pushHistory(['a'], '')).toEqual(['a']);
    expect(pushHistory(['a'], '   ')).toEqual(['a']);
  });

  it('no duplica la entrada más reciente si se repite', () => {
    expect(pushHistory(['a', 'b'], 'a')).toEqual(['a', 'b']);
    // Pero sí la reintroduce si no era la última
    expect(pushHistory(['b', 'a'], 'a')).toEqual(['a', 'b', 'a']);
  });

  it('recorta el input antes de guardarlo', () => {
    expect(pushHistory([], '  hola  ')).toEqual(['hola']);
  });
});

describe('navegación del historial (§10)', () => {
  const history = ['tercero', 'segundo', 'primero'];

  it('↑ desde el input en curso trae el mensaje más reciente', () => {
    expect(historyPrev(history, null, 'borrador')).toEqual({ index: 0, value: 'tercero' });
  });

  it('↑ sucesivos retroceden hacia mensajes más antiguos', () => {
    expect(historyPrev(history, 0, 'borrador')).toEqual({ index: 1, value: 'segundo' });
    expect(historyPrev(history, 1, 'borrador')).toEqual({ index: 2, value: 'primero' });
  });

  it('↑ en el mensaje más antiguo se queda ahí (sin wrap)', () => {
    expect(historyPrev(history, 2, 'borrador')).toEqual({ index: 2, value: 'primero' });
  });

  it('↓ avanza hacia mensajes más recientes', () => {
    expect(historyNext(history, 2, 'borrador')).toEqual({ index: 1, value: 'segundo' });
  });

  it('↓ desde el más reciente sale de la navegación y restaura el borrador', () => {
    expect(historyNext(history, 0, 'borrador')).toEqual({ index: null, value: 'borrador' });
  });

  it('↓ fuera de la navegación no hace nada', () => {
    expect(historyNext(history, null, 'borrador')).toEqual({ index: null, value: 'borrador' });
  });

  it('con historial vacío ↑ deja el borrador intacto', () => {
    expect(historyPrev([], null, 'borrador')).toEqual({ index: null, value: 'borrador' });
  });
});
