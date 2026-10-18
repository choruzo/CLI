import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resumeDecision, whoHostsSession } from './resume-guard.js';

const ID = 'sess_20261018_abcdef';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('chat --resume (M11): nunca un segundo anfitrión de la misma sesión', () => {
  it('una sesión del daemon (viva o guardada) se continúa con attach, no se reanuda', () => {
    for (const archived of [true, false]) {
      const d = resumeDecision(ID, { kind: 'daemon', archived }, false);
      expect(d.action).toBe('refuse');
      expect((d as { message: string }).message).toContain(`stratum attach ${ID}`);
      expect((d as { message: string }).message).toContain('--fork');
    }
  });

  it('una sesión abierta en otra terminal tampoco', () => {
    expect(resumeDecision(ID, { kind: 'peer' }, false).action).toBe('refuse');
  });

  it('sin anfitrión se reanuda; con --fork siempre es una copia con otro id', () => {
    expect(resumeDecision(ID, null, false)).toEqual({ action: 'resume' });
    expect(resumeDecision(ID, { kind: 'daemon', archived: true }, true)).toEqual({
      action: 'fork',
    });
  });

  it('una sesión guardada por el daemon se reconoce sin daemon vivo', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'stratum-guard-'));
    dirs.push(sessionsDir);
    expect(await whoHostsSession(ID, { sessionsDir })).toBeNull();
    mkdirSync(join(sessionsDir, ID));
    expect(await whoHostsSession(ID, { sessionsDir })).toEqual({ kind: 'daemon', archived: true });
  });
});
