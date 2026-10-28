import { describe, it, expect } from 'vitest';
import { formatJobEndText, jobOutcomeText, jobStatusLabel } from './job-text.js';

describe('textos de jobs en español', () => {
  it('estados', () => {
    expect(jobStatusLabel('running')).toBe('en curso');
    expect(jobStatusLabel('completed')).toBe('terminado');
    expect(jobStatusLabel('failed')).toBe('fallido');
    expect(jobStatusLabel('cancelled')).toBe('cancelado');
  });

  it('desenlace', () => {
    expect(jobOutcomeText({ status: 'running' })).toBe('');
    expect(jobOutcomeText({ status: 'failed', endReason: 'timeout' })).toBe('timeout');
    expect(jobOutcomeText({ status: 'failed', endReason: 'spawn-error' })).toBe('no arrancó');
    expect(jobOutcomeText({ status: 'cancelled', endReason: 'session-closed' })).toBe(
      'sesión cerrada',
    );
    expect(jobOutcomeText({ status: 'cancelled', endReason: 'cancelled' })).toBe('');
    expect(jobOutcomeText({ status: 'completed', exitCode: null })).toBe('exit desconocido');
    expect(jobOutcomeText({ status: 'completed', exitCode: 0 })).toBe('exit 0');
  });

  it('línea de fin', () => {
    expect(
      formatJobEndText({
        id: '3',
        status: 'completed',
        exitCode: 1,
        endReason: 'exit',
        durationMs: 38_200,
      }),
    ).toBe('[job #3 terminado · exit 1 · 38.2s]');
    expect(
      formatJobEndText({
        id: '4',
        status: 'cancelled',
        exitCode: null,
        endReason: 'cancelled',
        durationMs: 1600,
      }),
    ).toBe('[job #4 cancelado · 1.6s]');
  });
});
