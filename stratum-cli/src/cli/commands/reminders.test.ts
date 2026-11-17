import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../../ipc/codec.js';
import type { ProtocolReminder } from '../../protocol/index.js';
import { formatLocalTime } from './routines.js';
import { describeReminderError, formatRemindersTable } from './reminders.js';

const AT = new Date(2026, 10, 18, 9, 0).getTime();

function reminder(overrides: Partial<ProtocolReminder> = {}): ProtocolReminder {
  return {
    id: 'rem_abc',
    text: 'Llama al médico',
    dueAt: AT,
    createdAt: AT - 60_000,
    origin: 'agent',
    status: 'pending',
    ...overrides,
  };
}

describe('stratum reminders — formato', () => {
  it('sin recordatorios lo dice', () => {
    expect(formatRemindersTable([])).toBe('No reminders.\n');
  });

  it('una fila por recordatorio, con id, estado, hora local y texto en una línea', () => {
    const lines = formatRemindersTable([
      reminder(),
      reminder({
        id: 'rem_def',
        text: 'Riega\nlas plantas',
        status: 'delivered',
        endedAt: AT,
        late: true,
      }),
    ])
      .trimEnd()
      .split('\n');
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+DUE\s+TEXT$/);
    expect(lines[1]).toMatch(/^rem_abc\s+pending\s+2026-11-18 09:00\s+Llama al médico$/);
    expect(lines[2]).toContain('rem_def');
    expect(lines[2]).toContain(`delivered late ${formatLocalTime(AT)}`);
    expect(lines[2]).toContain('Riega las plantas');
    expect(lines[2]!.split('\n')).toHaveLength(1);
  });

  it('un terminado sin hora de fin no inventa una', () => {
    const [header, row] = formatRemindersTable([reminder({ status: 'cancelled' })]).split('\n');
    expect(header).toContain('STATUS');
    expect(row).toContain('cancelled');
  });
});

describe('stratum reminders — errores', () => {
  it('traduce los del protocolo, con sus issues', () => {
    expect(
      describeReminderError(
        new ProtocolError('INVALID_PARAMS', 'Invalid status: reminder "rem_abc" is not pending.', {
          issues: [{ path: 'status', message: 'not pending' }],
        }),
      ),
    ).toBe('status: not pending');
    expect(describeReminderError(new ProtocolError('NOT_FOUND', 'Reminder not found.'))).toBe(
      'Reminder not found.',
    );
  });

  it('un daemon sin planificador se explica en claro', () => {
    expect(
      describeReminderError(
        new ProtocolError('UNAVAILABLE', 'Reminders are disabled in this daemon.', {
          reason: 'reminders-disabled',
        }),
      ),
    ).toContain('Reminders are disabled');
  });
});
