import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PlanStore, generatePlanId, normalizePlanRef, parsePlanFile } from './plan-store.js';
import { SessionStore } from './store.js';
import { SubagentStore } from './subagent-store.js';
import { prepareSessionResume, loadResumablePlan, sessionProjectRoot } from './resume.js';
import {
  deleteSessionWithArtifacts,
  pruneOldPlans,
  pruneSessionsWithArtifacts,
} from './cleanup.js';
import { buildInterruptedSubagentsPreamble } from '../agent/subagent.js';
import type { Plan } from '../agent/types.js';

const DAY = 24 * 60 * 60 * 1000;

const plan = (statuses: Array<Plan['steps'][number]['status']>): Plan => ({
  summary: 'Refactor',
  steps: statuses.map((status, i) => ({ id: `s${i + 1}`, title: `Paso ${i + 1}`, status })),
});

describe('normalizePlanRef / parsePlanFile', () => {
  it('acepta las refs que genera generatePlanId, con o sin .json', () => {
    const ref = generatePlanId();
    expect(normalizePlanRef(ref)).toBe(ref);
    expect(normalizePlanRef(`${ref}.json`)).toBe(ref);
  });
  it('rechaza refs que saldrían de .stratum/plans/', () => {
    for (const bad of ['../plan_x', 'plan_x/../../y', '..\\plan_x', 'C:\\plan_x', 'otra', '']) {
      expect(normalizePlanRef(bad)).toBeNull();
    }
  });

  const base = {
    task: 't',
    status: 'in_progress',
    plan: plan(['done', 'pending']),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  it('un plan anterior al campo schemaVersion es la versión 1', () => {
    const r = parsePlanFile(base);
    expect(r.kind === 'ok' && r.file.schemaVersion).toBe(1);
  });
  it('schemaVersion mayor → newer; forma rota → corrupt', () => {
    expect(parsePlanFile({ ...base, schemaVersion: 7 }).kind).toBe('newer');
    expect(parsePlanFile({ ...base, plan: { summary: 'x' } }).kind).toBe('corrupt');
    expect(parsePlanFile({ ...base, plan: { summary: 'x', steps: [] } }).kind).toBe('corrupt');
    expect(
      parsePlanFile({
        ...base,
        plan: { summary: 'x', steps: [{ id: 's1', title: 't', status: 'x' }] },
      }).kind,
    ).toBe('corrupt');
    expect(parsePlanFile({ ...base, status: 'otro' }).kind).toBe('corrupt');
    expect(parsePlanFile(null).kind).toBe('corrupt');
  });
});

describe('PlanStore', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratum-plans-'));
    dir = join(root, '.stratum', 'plans');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeRaw(name: string, body: unknown): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  }

  it('save/read con schemaVersion y estado derivado del plan', () => {
    const store = new PlanStore(root);
    store.save('plan_a', 'tarea', plan(['done', 'pending']), '2026-01-01T00:00:00Z');
    expect(store.read('plan_a')).toMatchObject({ schemaVersion: 1, status: 'in_progress' });
    store.save('plan_a', 'tarea', plan(['done', 'skipped']), '2026-01-01T00:00:00Z');
    expect(store.read('plan_a.json')?.status).toBe('done');
  });

  it('una ref maliciosa ni lee ni escribe fuera de la carpeta', () => {
    writeFileSync(join(root, 'plan_fuera.json'), JSON.stringify({ secreto: 1 }));
    const store = new PlanStore(root);
    expect(store.read('../../plan_fuera')).toBeNull();
    store.save('../../plan_escape', 't', plan(['pending']), 'x');
    expect(existsSync(join(root, 'plan_escape.json'))).toBe(false);
    expect(existsSync(join(root, '.stratum', 'plan_escape.json'))).toBe(false);
  });

  it('nunca reescribe ni borra un plan de un Stratum más nuevo', () => {
    const body = JSON.stringify({ schemaVersion: 9, futuro: true });
    const p = writeRaw('plan_new.json', body);
    utimesSync(p, new Date(0), new Date(0));
    const store = new PlanStore(root);
    store.save('plan_new', 't', plan(['pending']), 'x');
    expect(store.delete('plan_new')).toBe(false);
    expect(store.prune(DAY)).toBe(0);
    expect(readFileSync(p, 'utf-8')).toBe(body);
  });

  it('prune: viejos, corruptos y temporales fuera; recientes y referenciados dentro', () => {
    const store = new PlanStore(root);
    store.save('plan_recent', 't', plan(['pending']), 'x');
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const oldFile = {
      schemaVersion: 1,
      task: 't',
      status: 'done',
      plan: plan(['done']),
      createdAt: old,
      updatedAt: old,
    };
    writeRaw('plan_old.json', oldFile);
    writeRaw('plan_kept.json', { ...oldFile, status: 'in_progress', plan: plan(['pending']) });
    const past = new Date(Date.now() - 40 * DAY);
    utimesSync(writeRaw('plan_broken.json', '{'), past, past);
    utimesSync(writeRaw('plan_x.json.tmp', '{'), past, past);
    expect(store.prune(30 * DAY, new Set(['plan_kept']))).toBe(3);
    expect(existsSync(join(dir, 'plan_recent.json'))).toBe(true);
    expect(existsSync(join(dir, 'plan_kept.json'))).toBe(true);
    expect(existsSync(join(dir, 'plan_old.json'))).toBe(false);
  });
});

describe('reanudación de sesión (prepareSessionResume)', () => {
  let root: string;
  let project: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratum-resume-'));
    project = join(root, 'proj');
    mkdirSync(project);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const messages = [{ role: 'user' as const, content: 'hola' }];

  it('busca en el proyecto de la sesión, no en el cwd', () => {
    new PlanStore(project).save('plan_p', 'tarea', plan(['done', 'in_progress']), 'c');
    const ctx = prepareSessionResume(
      { id: 'sess_1', project, planRef: 'plan_p', messages },
      join(root, 'otro-cwd'),
    );
    expect(ctx.projectRoot).toBe(project);
    expect(ctx.plan).toMatchObject({ ref: 'plan_p', task: 'tarea', root: project });
    expect(ctx.preamble).toContain('resuming an interrupted plan');
  });

  it('sin proyecto existente cae al cwd', () => {
    expect(sessionProjectRoot({ project: join(root, 'no-existe') }, root)).toBe(root);
    expect(sessionProjectRoot({}, root)).toBe(root);
  });

  it('un plan dañado no impide reanudar: aviso y sin plan', () => {
    mkdirSync(join(project, '.stratum', 'plans'), { recursive: true });
    writeFileSync(join(project, '.stratum', 'plans', 'plan_bad.json'), '{"task":"t"}');
    const ctx = prepareSessionResume({ id: 's', project, planRef: 'plan_bad', messages }, root);
    expect(ctx.plan).toBeNull();
    expect(ctx.preamble).toBeNull();
    expect(ctx.warnings[0]).toContain('plan_bad');
  });

  it('una ref de plan maliciosa en la sesión se trata como dañada', () => {
    const r = loadResumablePlan(project, '../../etc/passwd');
    expect(r.plan).toBeNull();
    expect(r.warning).toBeDefined();
  });

  it('plan terminado → nada que reanudar ni avisar', () => {
    new PlanStore(project).save('plan_d', 't', plan(['done']), 'c');
    expect(loadResumablePlan(project, 'plan_d')).toEqual({ plan: null });
  });

  it('plan y subagentes: los dos preámbulos, el del plan primero', () => {
    new PlanStore(project).save('plan_p', 't', plan(['in_progress']), 'c');
    const writer = new SubagentStore(project, {
      probe: () => ({
        pid: 1,
        host: 'otro-host',
        now: Date.now() - 10 * 60_000,
        pidAlive: () => true,
      }),
    });
    writer.saveRunning('sub_1', 'code', 'tarea', { sessionId: 's' });
    writer.dispose();
    const ctx = prepareSessionResume({ id: 's', project, planRef: 'plan_p', messages }, root);
    expect(ctx.orphans.map((o) => o.id)).toEqual(['sub_1']);
    const planAt = ctx.preamble!.indexOf('resuming an interrupted plan');
    const subAt = ctx.preamble!.indexOf('sub_1');
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(subAt).toBeGreaterThan(planAt);
    // Un huérfano ya avisado en el historial se marca y no se repite.
    const again = prepareSessionResume(
      {
        id: 's',
        project,
        messages: [{ role: 'user', content: buildInterruptedSubagentsPreamble(ctx.orphans)! }],
      },
      root,
    );
    expect(again.orphans).toEqual([]);
    expect(new SubagentStore(project).read('sub_1')?.status).toBe('interrupted');
  });
});

describe('limpieza de planes con las sesiones', () => {
  let root: string;
  let project: string;
  let sessions: SessionStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratum-plan-cleanup-'));
    project = join(root, 'proj');
    mkdirSync(project);
    sessions = new SessionStore(join(root, 'sessions'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Con `usedAt`, la sesión queda sin usar desde esa fecha (prune mira `updatedAt`). */
  const save = async (planRef: string, usedAt?: string) => {
    const s = await sessions.save({
      provider: 'p',
      model: 'm',
      project,
      messages: [{ role: 'user', content: 'hola' }],
      toolCallCount: 0,
      planRef,
    });
    if (usedAt) {
      const file = join(root, 'sessions', `${s.id}.json`);
      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      writeFileSync(file, JSON.stringify({ ...raw, createdAt: usedAt, updatedAt: usedAt }));
    }
    return s;
  };

  it('sessions delete borra su plan salvo que otra sesión lo use', async () => {
    const plans = new PlanStore(project);
    plans.save('plan_a', 't', plan(['pending']), 'c');
    plans.save('plan_b', 't', plan(['pending']), 'c');
    const a = await save('plan_a');
    const b1 = await save('plan_b');
    await save('plan_b'); // adoptado por otra sesión
    expect(deleteSessionWithArtifacts(sessions, a.id)).toEqual({ subagents: 0, plans: 1 });
    expect(deleteSessionWithArtifacts(sessions, b1.id)).toEqual({ subagents: 0, plans: 0 });
    expect(plans.read('plan_a')).toBeNull();
    expect(plans.read('plan_b')).not.toBeNull();
  });

  it('sessions prune arrastra el plan de las sesiones podadas', async () => {
    const plans = new PlanStore(project);
    plans.save('plan_old', 't', plan(['pending']), 'c');
    plans.save('plan_new', 't', plan(['pending']), 'c');
    await save('plan_old', new Date(Date.now() - 40 * DAY).toISOString());
    await save('plan_new');
    const out = pruneSessionsWithArtifacts(sessions, 30 * DAY, project);
    expect(out).toEqual({ sessions: 1, subagents: 0, plans: 1 });
    expect(plans.read('plan_old')).toBeNull();
    expect(plans.read('plan_new')).not.toBeNull();
  });

  it('la retención automática respeta los planes que una sesión puede reanudar', async () => {
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    mkdirSync(join(project, '.stratum', 'plans'), { recursive: true });
    for (const ref of ['plan_used', 'plan_stale']) {
      writeFileSync(
        join(project, '.stratum', 'plans', `${ref}.json`),
        JSON.stringify({
          task: 't',
          status: 'in_progress',
          plan: plan(['pending']),
          createdAt: old,
          updatedAt: old,
        }),
      );
    }
    await save('plan_used');
    expect(pruneOldPlans(sessions, project, 30)).toBe(1);
    expect(new PlanStore(project).read('plan_used')).not.toBeNull();
    expect(pruneOldPlans(sessions, project, 0)).toBe(0);
  });

  it('con una sesión ilegible no se borra ningún plan', async () => {
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    mkdirSync(join(project, '.stratum', 'plans'), { recursive: true });
    writeFileSync(
      join(project, '.stratum', 'plans', 'plan_x.json'),
      JSON.stringify({
        task: 't',
        status: 'done',
        plan: plan(['done']),
        createdAt: old,
        updatedAt: old,
      }),
    );
    await save('plan_x');
    writeFileSync(join(root, 'sessions', 'sess_20260101_000000_bad.json'), '{ roto');
    expect(pruneOldPlans(sessions, project, 30)).toBe(0);
  });
});
