import { describe, expect, it } from 'vitest';
import { sampleReminder } from '../testing/fixtures';
import { REMINDER_NOTICE_TITLE, buildReminderNotice, reminderDueEvents } from './reminder-notices';

/** M21 — qué avisar al sistema cuando vence un recordatorio (lógica pura). */

const due = (reminder: unknown) => ({ type: 'reminder.due', sessionId: 'ses_companion', seq: 9, data: { reminder } });

describe('reminderDueEvents', () => {
  it('saca los `reminder.due` que validan e ignora lo demás', () => {
    const events = reminderDueEvents([
      due(sampleReminder()),
      due(sampleReminder({ id: 'rem_2' })),
      { type: 'reminder.due', data: {} },
      due({ id: 'rem_3' }),
      due(sampleReminder({ text: '' })),
      { type: 'run.started', data: {} },
      { type: 'reminder.created', data: { reminder: sampleReminder() } },
      null,
      'texto',
    ]);
    expect(events.map((r) => r.id)).toEqual(['rem_abc1234567', 'rem_2']);
  });
});

describe('buildReminderNotice', () => {
  it('título «Reminder» y el texto en el cuerpo', () => {
    const notice = buildReminderNotice(sampleReminder({ text: 'Sacar la ropa' }));
    expect(notice.title).toBe(REMINDER_NOTICE_TITLE);
    expect(notice.body).toBe('Sacar la ropa');
    expect(notice.reminderId).toBe('rem_abc1234567');
  });

  it('si se entregó tarde, dice a qué hora tocaba', () => {
    const at = new Date(2026, 10, 17, 21, 30, 0).getTime();
    const notice = buildReminderNotice(sampleReminder({ text: 'Sacar la ropa', dueAt: at, late: true }));
    expect(notice.body).toBe('Sacar la ropa (late: was due 21:30)');
    // Sin `late`, ni con `late: false`, no se dice nada.
    expect(buildReminderNotice(sampleReminder({ text: 'x' })).body).toBe('x');
    expect(buildReminderNotice(sampleReminder({ text: 'x', late: false })).body).toBe('x');
  });
});
