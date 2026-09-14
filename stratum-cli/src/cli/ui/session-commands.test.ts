import { describe, it, expect } from 'vitest';
import { filterCommands, SESSION_COMMANDS } from './session-commands.js';

describe('filterCommands (panel §5.2)', () => {
  it('"/" solo muestra todos los comandos', () => {
    expect(filterCommands('/')).toEqual(SESSION_COMMANDS);
  });

  it('filtra por substring, no solo prefijo', () => {
    // "/mem" encuentra todos los comandos de memoria (Hito 5)
    const byPrefix = filterCommands('/mem').map((c) => c.name);
    expect(byPrefix).toEqual(
      expect.arrayContaining(['/memory show', '/memory list', '/memory search', '/memory forget']),
    );
    expect(byPrefix.every((n) => n.startsWith('/memory'))).toBe(true);

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

describe('cobertura de la tabla de §5.2 (Hito 10)', () => {
  const names = SESSION_COMMANDS.map((c) => c.name);

  it('registra los comandos de contexto y sesión', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        '/clear',
        '/compact',
        '/context',
        '/debug',
        '/mcp reload',
        '/sessions list',
        '/sessions resume',
        '/sessions delete',
        '/config get',
        '/config set',
      ]),
    );
  });

  it('marca hasArgs solo en los comandos que esperan argumentos', () => {
    const byName = new Map(SESSION_COMMANDS.map((c) => [c.name, c.hasArgs]));
    // Sin argumentos: se ejecutan directamente al pulsar Enter.
    for (const n of ['/clear', '/compact', '/context', '/debug', '/mcp reload', '/sessions list']) {
      expect(byName.get(n), n).toBe(false);
    }
    // Con argumentos: Enter solo completa el prefijo en el input.
    for (const n of ['/sessions resume', '/sessions delete', '/config get', '/config set']) {
      expect(byName.get(n), n).toBe(true);
    }
  });

  it('"/c" ofrece toda la familia de comandos que empiezan por c', () => {
    const found = filterCommands('/c').map((c) => c.name);
    expect(found).toEqual(
      expect.arrayContaining([
        '/clear',
        '/compact',
        '/context',
        '/config get',
        '/config set',
        '/config_provider',
      ]),
    );
  });

  it('"/sessions" ofrece los tres subcomandos', () => {
    expect(filterCommands('/sessions').map((c) => c.name)).toEqual([
      '/sessions list',
      '/sessions resume',
      '/sessions delete',
    ]);
  });

  it('no hay nombres duplicados en el registro', () => {
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('comandos de perfiles (Hito 15)', () => {
  it('/agents lista y /agent espera argumentos', () => {
    const agents = SESSION_COMMANDS.find((c) => c.name === '/agents');
    const agent = SESSION_COMMANDS.find((c) => c.name === '/agent');
    expect(agents?.hasArgs).toBe(false);
    expect(agent?.hasArgs).toBe(true);
    expect(filterCommands('/agen').map((c) => c.name)).toEqual(
      expect.arrayContaining(['/agents', '/agent']),
    );
  });
});
