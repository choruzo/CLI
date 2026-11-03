import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolApprovalGrant } from '../../protocol/index.js';
import { approvalsCommand, formatGrantTable, parseGrantMinutes } from './approvals.js';

const grant = (over: Partial<ProtocolApprovalGrant> = {}): ProtocolApprovalGrant => ({
  id: 'grt_aaaa',
  sessionId: 'ses_1',
  tool: 'exec',
  target: 'ssh:stg-1',
  minutes: 30,
  grantedAt: 0,
  expiresAt: 0,
  grantedBy: { kind: 'remote', client: 'cli', at: 0 },
  ...over,
});

describe('stratum approvals — concesiones (M17)', () => {
  it('--for solo acepta 10, 30 o 60 como entero', () => {
    expect(parseGrantMinutes('10')).toBe(10);
    expect(parseGrantMinutes('30')).toBe(30);
    expect(parseGrantMinutes(' 60 ')).toBe(60);
    for (const bad of ['15', '0', '', '10m', '1e1', '-10', '10.0', '030x', 'abc']) {
      expect(parseGrantMinutes(bad), bad).toBeNull();
    }
  });

  it('la tabla enseña sesión, tool, target, minutos que quedan (hacia arriba) e id', () => {
    const now = 1_000_000;
    const table = formatGrantTable(
      [
        grant({ expiresAt: now + 29 * 60_000 + 1 }),
        grant({
          id: 'grt_bbbb',
          sessionId: 'ses_22',
          tool: 'write_file',
          target: undefined,
          expiresAt: now + 1_000,
        }),
        grant({ id: 'grt_cccc', expiresAt: now - 5_000 }),
      ],
      now,
    );
    const lines = table.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^SESSION\s+TOOL\s+TARGET\s+LEFT\s+ID$/);
    expect(lines[1]).toMatch(/^ses_1\s+exec\s+ssh:stg-1\s+30m\s+grt_aaaa$/);
    // Sin target se enseña un guion; menos de un minuto cuenta como uno.
    expect(lines[2]).toMatch(/^ses_22\s+write_file\s+-\s+1m\s+grt_bbbb$/);
    // Una vencida no baja de cero.
    expect(lines[3]).toMatch(/^ses_1\s+exec\s+ssh:stg-1\s+0m\s+grt_cccc$/);
    expect(table.endsWith('\n')).toBe(true);
  });

  it('sin concesiones lo dice', () => {
    expect(formatGrantTable([])).toBe('No active grants.\n');
  });

  it('los subcomandos están registrados', () => {
    const names = approvalsCommand.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['grants', 'revoke']));
    const approve = approvalsCommand.commands.find((c) => c.name() === 'approve')!;
    expect(approve.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--all', '--for']));
  });

  describe('approve --for: se rechaza antes de pedir la clave o enviar nada', () => {
    afterEach(() => {
      process.exitCode = undefined;
      vi.restoreAllMocks();
    });

    async function run(...args: string[]): Promise<string> {
      let err = '';
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err += String(chunk);
        return true;
      });
      await approvalsCommand.parseAsync(['approve', 'apr_1', ...args], { from: 'user' });
      return err;
    }

    it('minutos que no son 10, 30 o 60', async () => {
      expect(await run('--for', '15')).toContain('--for takes 10, 30, 60');
      expect(process.exitCode).toBe(1);
    });

    it('incompatible con --all', async () => {
      expect(await run('--for', '10', '--all')).toContain('cannot be combined');
      expect(process.exitCode).toBe(1);
    });
  });
});
