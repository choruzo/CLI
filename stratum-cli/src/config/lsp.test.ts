import { describe, it, expect } from 'vitest';
import { StratumConfigSchema, LspConfigSchema } from './schema.js';
import { LSP_PRESETS, resolveLspServers } from '../lsp/presets.js';

/** Parsea la sección `lsp` colgada de la config completa. */
const parse = (lsp: unknown) => StratumConfigSchema.parse({ lsp }).lsp;

describe('config: sección lsp', () => {
  it('sin sección, los defaults dejan el LSP apagado', () => {
    const config = StratumConfigSchema.parse({});
    expect(config.lsp).toEqual({
      enabled: false,
      timeoutMs: 3000,
      startupTimeoutMs: 15000,
      maxDiagnostics: 20,
      severity: 'error',
      servers: {},
    });
  });

  it('`lsp: {}` es equivalente a no ponerla', () => {
    expect(parse({})).toEqual(StratumConfigSchema.parse({}).lsp);
  });

  it('acepta un preset por nombre, sin repetir comando ni extensiones', () => {
    const lsp = parse({ enabled: true, servers: { typescript: {} } });
    expect(lsp.enabled).toBe(true);
    expect(lsp.servers.typescript).toEqual({ env: {} });

    const [server] = resolveLspServers(lsp.servers);
    expect(server).toMatchObject({
      name: 'typescript',
      command: 'typescript-language-server',
      args: ['--stdio'],
      env: {},
    });
    expect(server!.extensions).toContain('.ts');
    expect(server!.extensions).toContain('.tsx');
  });

  it('un servidor completo sobreescribe el preset campo a campo', () => {
    const lsp = parse({
      servers: {
        typescript: { args: ['--stdio', '--log-level', '4'] },
      },
    });
    const [server] = resolveLspServers(lsp.servers);
    // `args` viene del usuario; comando y extensiones, del preset.
    expect(server).toMatchObject({
      command: 'typescript-language-server',
      args: ['--stdio', '--log-level', '4'],
    });
    expect(server!.extensions).toEqual(LSP_PRESETS.typescript!.extensions);

    const [onlyExt] = resolveLspServers(
      parse({ servers: { typescript: { extensions: ['.vue'] } } }).servers,
    );
    expect(onlyExt).toMatchObject({
      command: 'typescript-language-server',
      args: ['--stdio'],
      extensions: ['.vue'],
    });
  });

  it('admite un servidor propio completo', () => {
    const lsp = parse({
      servers: {
        mio: {
          command: 'foo-ls',
          args: ['--stdio'],
          extensions: ['.foo'],
          env: { FOO_LOG: 'debug' },
          initializationOptions: { strict: true },
        },
      },
    });
    expect(resolveLspServers(lsp.servers)).toEqual([
      {
        name: 'mio',
        command: 'foo-ls',
        args: ['--stdio'],
        extensions: ['.foo'],
        env: { FOO_LOG: 'debug' },
        initializationOptions: { strict: true },
      },
    ]);
  });

  it('un nombre que no es preset exige command', () => {
    expect(() => parse({ servers: { raro: {} } })).toThrow(/no es un preset conocido/);
  });

  it('un servidor propio sin extensiones no sirve para nada y se rechaza', () => {
    expect(() => parse({ servers: { raro: { command: 'foo-ls' } } })).toThrow(
      /al menos una extensión/,
    );
  });

  it('las extensiones tienen que empezar por punto', () => {
    expect(() => parse({ servers: { mio: { command: 'x', extensions: ['foo'] } } })).toThrow(
      /debe empezar por punto/,
    );
  });

  it('valida umbrales numéricos', () => {
    expect(() => parse({ timeoutMs: 0 })).toThrow();
    expect(() => parse({ startupTimeoutMs: -1 })).toThrow();
    expect(() => parse({ maxDiagnostics: 1.5 })).toThrow();
    expect(parse({ timeoutMs: 500 }).timeoutMs).toBe(500);
    expect(parse({ maxDiagnostics: 5 }).maxDiagnostics).toBe(5);
  });

  it('severity solo admite error o warning', () => {
    expect(() => parse({ severity: 'info' })).toThrow();
    expect(parse({ severity: 'warning' }).severity).toBe('warning');
  });

  it('rechaza campos desconocidos en un servidor', () => {
    expect(() => parse({ servers: { typescript: { comand: 'x' } } })).toThrow();
  });

  it('el schema suelto también vale por sí mismo', () => {
    expect(LspConfigSchema.parse({})).toMatchObject({ enabled: false, servers: {} });
  });
});

describe('resolveLspServers', () => {
  it('normaliza las extensiones a minúsculas y con punto', () => {
    const [server] = resolveLspServers({
      mio: { command: 'foo-ls', extensions: ['ts', '.TSX', ' .Foo '] },
    });
    expect(server!.extensions).toEqual(['.ts', '.tsx', '.foo']);
  });

  it('descarta en silencio un servidor sin comando (la config ya lo impide)', () => {
    expect(resolveLspServers({ raro: {} })).toEqual([]);
  });

  it('los presets conocidos son los tres del encargo', () => {
    expect(Object.keys(LSP_PRESETS).sort()).toEqual(['pyright', 'rust-analyzer', 'typescript']);
    expect(LSP_PRESETS.pyright).toMatchObject({
      command: 'pyright-langserver',
      args: ['--stdio'],
      extensions: ['.py'],
    });
    expect(LSP_PRESETS['rust-analyzer']).toMatchObject({
      command: 'rust-analyzer',
      extensions: ['.rs'],
    });
  });
});
