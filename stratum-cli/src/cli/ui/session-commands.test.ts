import { describe, it, expect } from 'vitest';
import {
  BUSY_COMMANDS,
  COMMAND_GROUPS,
  helpText,
  filterCommands,
  isBusyCommand,
  matchCommand,
  SESSION_COMMANDS,
  slashCommandName,
} from './session-commands.js';

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

describe('slashCommandName', () => {
  it('reconoce un /comando solo o con argumentos', () => {
    expect(slashCommandName('/noexiste')).toBe('/noexiste');
    expect(slashCommandName('  /memory search algo')).toBe('/memory');
    expect(slashCommandName('/config_provider')).toBe('/config_provider');
  });

  it('una ruta o un texto normal no son un comando', () => {
    expect(slashCommandName('/etc/hosts qué contiene')).toBeNull();
    expect(slashCommandName('/tmp/a.log')).toBeNull();
    expect(slashCommandName('/')).toBeNull();
    expect(slashCommandName('mira /help')).toBeNull();
    expect(slashCommandName('hola')).toBeNull();
  });
});

describe('comandos con el agente trabajando', () => {
  it('los de consulta están disponibles, también con argumentos', () => {
    for (const line of ['/jobs', '/jobs cancel 3', '/context', '/memory search spark', '/help']) {
      expect(isBusyCommand(line), line).toBe(true);
    }
  });

  it('los que tocan el historial, el modelo o el toolset no', () => {
    for (const line of [
      '/clear',
      '/compact',
      '/model',
      '/agent tdd',
      '/memory forget dec_1',
      '/plan x',
      '/config set a b',
      '/quit',
    ]) {
      expect(isBusyCommand(line), line).toBe(false);
    }
  });

  it('gana el nombre más largo y un prefijo parecido no cuenta', () => {
    expect(matchCommand('/jobs cancel 3')?.name).toBe('/jobs cancel');
    expect(matchCommand('/agents')?.name).toBe('/agents');
    expect(matchCommand('/agent tdd')?.name).toBe('/agent');
    expect(matchCommand('/config_provider')?.name).toBe('/config_provider');
    expect(matchCommand('/etc/hosts')).toBeNull();
  });

  it('la paleta reducida solo ofrece comandos que existen', () => {
    expect(BUSY_COMMANDS.length).toBeGreaterThan(10);
    expect(filterCommands('/cl', BUSY_COMMANDS)).toEqual([]);
    expect(filterCommands('/jo', BUSY_COMMANDS).map((c) => c.name)).toEqual([
      '/jobs',
      '/jobs cancel',
    ]);
  });
});

describe('/help agrupado (helpText)', () => {
  it('todo comando pertenece a un grupo, y solo a uno', () => {
    const grouped = COMMAND_GROUPS.flatMap((g) => g.commands);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(SESSION_COMMANDS.map((c) => c.name).sort());
  });

  it('pinta un bloque por grupo, con su título y sus comandos', () => {
    const text = helpText(100);
    const blocks = text.split('\n\n');
    expect(blocks).toHaveLength(COMMAND_GROUPS.length);
    expect(blocks[0]?.split('\n')[0]).toBe('**Conversación**');
    expect(text).not.toContain('**Otros**');
    for (const c of SESSION_COMMANDS) {
      expect(text, c.name).toMatch(new RegExp(`^  ${c.name.replace('/', '\\/')} {2,}\\S`, 'm'));
    }
  });

  it('ninguna línea pasa del ancho y lo que no cabe sigue bajo la descripción', () => {
    const text = helpText(60);
    const lines = text.split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(60);
    const column = lines.find((l) => l.startsWith('  /help'))!.indexOf('Lista');
    const continuations = lines.filter((l) => l.startsWith('   '));
    expect(continuations.length).toBeGreaterThan(0);
    for (const l of continuations) expect(l.search(/\S/), l).toBe(column);
  });

  it('un comando sin grupo no se pierde: sale en «Otros»', () => {
    const extra = { name: '/nuevo', description: 'Algo nuevo', hasArgs: false };
    const text = helpText(100, [...SESSION_COMMANDS, extra]);
    expect(text).toMatch(/\*\*Otros\*\*\n {2}\/nuevo +Algo nuevo$/);
  });
});
