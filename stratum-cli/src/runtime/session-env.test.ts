import { describe, it, expect } from 'vitest';
import { inspect } from 'util';
import { createSessionEnv, processSessionEnv } from './session-env.js';

describe('SessionEnv', () => {
  const secret = 'sk-test-0123456789abcdef';
  const env = createSessionEnv({ cwd: '/work/a', env: { TOKEN: secret, PATH: '/bin' } });

  it('expone cwd y env a quien los pide', () => {
    expect(env.cwd).toBe('/work/a');
    expect(env.env.TOKEN).toBe(secret);
  });

  it('no deja salir las variables al serializar, copiar o inspeccionar', () => {
    expect(JSON.stringify(env)).toBe('{"cwd":"/work/a"}');
    expect(JSON.stringify({ session: env })).not.toContain(secret);
    expect({ ...env }).toEqual({ cwd: '/work/a' });
    expect(Object.keys(env)).toEqual(['cwd']);
    expect(inspect(env)).not.toContain(secret);
  });

  it('es inmutable', () => {
    expect(() => {
      (env as { cwd: string }).cwd = '/otro';
    }).toThrow();
    expect(env.cwd).toBe('/work/a');
  });

  it('processSessionEnv refleja el proceso en el momento de la llamada', () => {
    const current = processSessionEnv();
    expect(current.cwd).toBe(process.cwd());
    expect(current.env).toBe(process.env);
  });
});
