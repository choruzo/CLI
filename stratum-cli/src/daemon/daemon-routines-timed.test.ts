/**
 * M16 — criterio de aceptación (PRD de Stratum Dot §23.11): «una rutina corre
 * a su hora con nadie mirando, lo que pide aprobación caduca a `deny` sin
 * bloquear el daemon, y su resultado está disponible».
 *
 * Daemon real con timers reales, sin `runNow` y sin ningún cliente conectado
 * mientras vence: el horario es `1m` con el anchor (`createdAt`) puesto 59 s
 * atrás, así que vence en ~1 s. Con aprobadores acreditados pero nadie que
 * conteste, la confirmación caduca y el run sigue hasta el final.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { RoutineStore } from '../routines/store.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

let t: TestDaemon | null = null;
let base: string | null = null;
afterEach(async () => {
  await t?.stop().catch(() => undefined);
  if (base) rmSync(base, { recursive: true, force: true });
  t = null;
  base = null;
});

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('M16 — aceptación', () => {
  it('vence a su hora sin nadie mirando; la aprobación caduca a deny y el daemon sigue atendiendo', async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m16t-')));
    // Lo que se cree aquí queda con `createdAt` 59 s atrás: un `1m` vence en ~1 s.
    const store = new RoutineStore(join(base, 'routines.json'), {
      now: () => new Date(Date.now() - 59_000),
    });
    t = await startTestDaemon({ base, routines: store, approvalTimeoutMs: 800 });
    const cwd = t.project(join('companion', 'workspace'), [
      // `propose_routine` pide confirmación forzada; en la sesión de una rutina
      // no existe, así que se usa la tool `question`, que caduca igual.
      makeToolCallRound('q1', 'question', { questions: [{ question: '¿Lo envío?' }] }),
      makeTextRound('Nadie contestó: no envío nada. Resumen hecho.'),
    ]);
    // El aprobador existe (hay a quién preguntar), pero no contesta y se va.
    const approver = await t.connect(['approver'], 'appr');
    approver.close();

    const routine = t.daemon.routines!.add({
      name: 'Matinal',
      schedule: '1m',
      prompt: 'Resume las novedades.',
    }).routine;
    const status = () => t!.daemon.routines!.list().find((s) => s.routine.id === routine.id)!;
    expect(status().nextFireAt! - Date.now()).toBeLessThan(5_000);

    // Nadie conectado mientras vence y corre.
    await until(() => status().lastFire !== null, 10_000);
    expect(status().lastFire).toMatchObject({ outcome: 'started', manual: false });

    // Mientras la pregunta espera, el daemon atiende a un cliente nuevo.
    const observer = await t.connect(['observer'], 'obs');
    expect((await observer.request('core.status', {})).liveSessions).toBeGreaterThanOrEqual(1);

    await until(() => status().lastResult !== null, 20_000);
    expect(status().lastResult).toMatchObject({ status: 'completed' });
    expect(status().lastResult!.summary).toContain('Resumen hecho');
    // El resultado está disponible para Dot por el protocolo.
    const listed = await observer.request('routines.list', {});
    expect(listed.routines[0]).toMatchObject({
      id: routine.id,
      lastResult: { status: 'completed' },
    });
    // Siguiente vencimiento armado, alineado al anchor.
    expect(status().nextFireAt).toBeGreaterThan(Date.now());
    expect(t.provider(cwd).calls).toBeGreaterThanOrEqual(2);
  }, 40_000);
});
