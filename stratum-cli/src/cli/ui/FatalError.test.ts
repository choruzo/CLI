import { describe, it, expect } from 'vitest';
import { suggestForError } from './FatalError.js';

describe('suggestForError (§11)', () => {
  it('sugiere arrancar el provider ante una conexión rechazada', () => {
    expect(suggestForError('LLM connection lost: ECONNREFUSED localhost:11434')).toMatch(
      /provider esté en ejecución/,
    );
  });

  it('reconoce un host que no resuelve', () => {
    expect(suggestForError('getaddrinfo ENOTFOUND api.example.com')).toMatch(/No se resuelve/);
  });

  it('reconoce credenciales rechazadas', () => {
    expect(suggestForError('HTTP 401 Unauthorized')).toMatch(/Credenciales/);
    expect(suggestForError('invalid api key provided')).toMatch(/Credenciales/);
  });

  it('reconoce un modelo inexistente', () => {
    expect(suggestForError('HTTP 404: model not found')).toMatch(/\/model/);
  });

  it('reconoce el desbordamiento de contexto y apunta a /compact', () => {
    expect(suggestForError('context_length_exceeded')).toMatch(/\/compact/);
  });

  it('reconoce el rate limit', () => {
    expect(suggestForError('HTTP 429 Too Many Requests')).toMatch(/Límite de peticiones/);
  });

  it('no inventa sugerencia para un error desconocido', () => {
    expect(suggestForError('algo raro pasó')).toBeUndefined();
  });

  it('es insensible a mayúsculas', () => {
    expect(suggestForError('ECONNREFUSED')).toBe(suggestForError('econnrefused'));
  });
});
