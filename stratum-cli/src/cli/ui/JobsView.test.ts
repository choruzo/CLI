import { describe, it, expect } from 'vitest';
import { JOB_LINGER_MS, formatJobRows, jobStatusDetail, visibleJobs } from './JobsView.js';
import {
  formatJobDuration,
  formatJobEndLine,
  shortJobCommand,
  type BackgroundJob,
} from '../../jobs/types.js';

const NOW = 1_000_000;

function job(over: Partial<BackgroundJob>): BackgroundJob {
  return {
    id: '1',
    command: 'npm test',
    cwd: '/repo',
    status: 'running',
    startedAt: NOW - 18_000,
    owner: { scope: 'main' },
    stdoutBytes: 0,
    stderrBytes: 0,
    outputChars: 0,
    droppedChars: 0,
    outputRead: false,
    ...over,
  };
}

describe('panel de jobs', () => {
  it('una fila por job: id, comando, estado y tiempo o desenlace', () => {
    const rows = formatJobRows(
      [
        job({ id: '3' }),
        job({
          id: '4',
          command: 'cargo build',
          status: 'failed',
          exitCode: 101,
          endReason: 'exit',
          endedAt: NOW - 1000,
        }),
      ],
      NOW,
      14,
    );
    expect(rows[0]).toMatch(/^#3\s+npm test\s+running\s+18\.0s$/);
    expect(rows[1]).toMatch(/^#4\s+cargo build\s+failed\s+exit 101$/);
    // Columnas alineadas.
    expect(rows[0]!.indexOf('running')).toBe(rows[1]!.indexOf('failed'));
  });

  it('el detalle de un job terminado es su desenlace', () => {
    const done = { endedAt: NOW - 500 };
    expect(
      jobStatusDetail(job({ status: 'completed', exitCode: 0, endReason: 'exit', ...done }), NOW),
    ).toBe('exit 0');
    expect(
      jobStatusDetail(
        job({ status: 'failed', exitCode: null, endReason: 'timeout', ...done }),
        NOW,
      ),
    ).toBe('timeout');
    expect(
      jobStatusDetail(
        job({ status: 'cancelled', exitCode: null, endReason: 'session-closed', ...done }),
        NOW,
      ),
    ).toBe('session closed');
    // Cancelado a mano: no hay desenlace que contar, se enseña lo que duró.
    expect(
      jobStatusDetail(
        job({ status: 'cancelled', exitCode: null, endReason: 'cancelled', ...done }),
        NOW,
      ),
    ).toBe('17.5s');
  });

  it('solo se pintan los vivos y los recién terminados', () => {
    const jobs = [
      job({ id: '1' }),
      job({ id: '2', status: 'completed', endedAt: NOW - 5000 }),
      job({ id: '3', status: 'completed', endedAt: NOW - JOB_LINGER_MS - 1 }),
    ];
    expect(visibleJobs(jobs, NOW).map((j) => j.id)).toEqual(['1', '2']);
  });
});

describe('formato de jobs', () => {
  it('duraciones legibles', () => {
    expect(formatJobDuration(850)).toBe('850ms');
    expect(formatJobDuration(38_200)).toBe('38.2s');
    expect(formatJobDuration(252_000)).toBe('4m12s');
    expect(formatJobDuration(3_780_000)).toBe('1h03m');
  });

  it('línea de fin', () => {
    expect(
      formatJobEndLine({
        id: '3',
        status: 'completed',
        exitCode: 1,
        endReason: 'exit',
        durationMs: 38_200,
      }),
    ).toBe('[background job #3 completed · exit 1 · 38.2s]');
    expect(
      formatJobEndLine({
        id: '4',
        status: 'cancelled',
        exitCode: null,
        endReason: 'cancelled',
        durationMs: 1600,
      }),
    ).toBe('[background job #4 cancelled · 1.6s]');
  });

  it('el comando se aplana y se recorta', () => {
    expect(shortJobCommand('npm   run\n  test', 60)).toBe('npm run test');
    expect(shortJobCommand('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
