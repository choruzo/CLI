import { describe, it, expect } from 'vitest';
import { sampleRun, sampleSession } from '../../protocol/protocol.fixtures.js';
import { formatSessionsTable, hostLabel, runLabel } from './ps.js';

const NOW = 1_760_000_100_000;

describe('stratum ps — tabla', () => {
  it('sin sesiones lo dice', () => {
    expect(formatSessionsTable([], [])).toBe('No live sessions.\n');
  });

  it('una fila por sesión, distinguiendo quién la aloja', () => {
    const local = sampleSession({
      id: 'sess_a',
      host: { kind: 'daemon', client: 'daemon', connected: true },
      state: 'idle',
      currentRunId: null,
    });
    const cli = sampleSession({ id: 'sess_b', cwd: '/work/web' });
    const gone = sampleSession({
      id: 'sess_c',
      state: 'detached',
      host: { kind: 'peer', client: 'cli', connected: false },
    });
    const table = formatSessionsTable(
      [local, cli, gone],
      [
        sampleRun({ id: 'r1', sessionId: 'sess_b', startedAt: NOW - 75_000 }),
        sampleRun({ id: 'r0', sessionId: 'sess_b', startedAt: NOW - 900_000, status: 'completed' }),
        sampleRun({ id: 'r2', sessionId: 'sess_c', startedAt: NOW - 5_000 }),
      ],
      NOW,
    );
    const lines = table.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^SESSION\s+HOST\s+STATE\s+AGENT\s+MODEL\s+CWD\s+RUN$/);
    expect(lines[1]).toMatch(/^sess_a\s+daemon\s+idle\s+general\s+test-model\s+\/work\/api\s+-$/);
    // El run que cuenta es el más reciente de la sesión.
    expect(lines[2]).toMatch(
      /^sess_b\s+cli\s+running\s+.*running 1m15s · Implement authentication$/,
    );
    // Sin anfitrión: el estado lo dice, y el run es el último conocido.
    expect(lines[3]).toMatch(/^sess_c\s+cli\s+detached\s+.*running 5s · /);
    // Columnas alineadas: HOST empieza en la misma columna en todas las filas.
    expect(new Set(lines.map((l) => l.search(/\s{2}\S/))).size).toBe(1);
  });

  it('etiquetas', () => {
    expect(hostLabel(sampleSession())).toBe('cli');
    expect(runLabel(undefined, NOW)).toBe('-');
    expect(runLabel(sampleRun({ status: 'failed', input: 'a\n  b' }), NOW)).toBe('failed · a b');
  });
});
