import { describe, it, expect } from 'vitest';
import { filterCommands, SESSION_COMMANDS } from './session-commands.js';

describe('filterCommands (panel §5.2)', () => {
  it('"/" solo muestra todos los comandos', () => {
    expect(filterCommands('/')).toEqual(SESSION_COMMANDS);
  });

  it('filtra por substring, no solo prefijo', () => {
    const byPrefix = filterCommands('/mem').map((c) => c.name);
    expect(byPrefix).toEqual(['/memory show']);

    // "/show" también encuentra "/memory show" (substring)
    const bySubstring = filterCommands('/show').map((c) => c.name);
    expect(bySubstring).toContain('/memory show');
  });

  it('encuentra /model y /config_provider (Hito 3.5)', () => {
    expect(filterCommands('/mod').map((c) => c.name)).toContain('/model');
    expect(filterCommands('/config').map((c) => c.name)).toContain('/config_provider');
    expect(filterCommands('/provider').map((c) => c.name)).toContain('/config_provider');
  });

  it('sin coincidencias devuelve lista vacía (el panel se oculta)', () => {
    expect(filterCommands('/xyzxyz')).toEqual([]);
  });

  it('no es sensible a mayúsculas', () => {
    expect(filterCommands('/MODEL').map((c) => c.name)).toContain('/model');
  });

  it('input que no empieza por / no abre el panel', () => {
    expect(filterCommands('hola /model')).toEqual([]);
  });
});
