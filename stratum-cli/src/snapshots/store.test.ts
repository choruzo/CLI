/**
 * Tests del almacén de snapshots (UX-1) contra **git real** en directorios
 * temporales, con el home inyectado: nunca se escribe en el `~` del usuario ni
 * se toca el `.git` del proyecto, que es justo lo que aquí se verifica.
 *
 * Cubre los puntos 1–4, 6 y 8 del brief a nivel de módulo (`SnapshotStore`): el
 * ciclo por turno, el límite de tamaño (`skipped`), las exclusiones duras
 * (`.stratum/`, `.git/`, `.gitignore`), el aislamiento del entorno de git, los
 * conflictos contra T1, el `.git` del usuario intacto y el registro versionado.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SnapshotsConfig } from '../config/schema.js';
import { SnapshotStore } from './store.js';
import { snapshotGitEnv } from './env.js';
import { normalizeRootForId, snapshotDirForRoot, snapshotRootId } from './paths.js';

interface GitOut {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** git real contra el repo de apoyo (el del usuario), sin lanzar por exit != 0. */
async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitOut> {
  const result = await execa('git', args, {
    cwd,
    reject: false,
    ...(env ? { env } : {}),
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const CONFIG: SnapshotsConfig = {
  enabled: true,
  maxFileBytes: 64 * 1024,
  retentionDays: 7,
  timeoutMs: 20_000,
  maxFiles: 20_000,
};

let repo: string;
let home: string;

/** Repo del usuario con identidad configurada (sin commits: no hacen falta). */
async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
}

async function open(overrides: Partial<SnapshotsConfig> = {}, cwd = repo): Promise<SnapshotStore> {
  return SnapshotStore.open({
    cwd,
    sessionId: 'ses_test',
    config: { ...CONFIG, ...overrides },
    home,
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'stratum-snap-repo-'));
  home = await mkdtemp(join(tmpdir(), 'stratum-snap-home-'));
  await initRepo(repo);
});

afterEach(async () => {
  for (const dir of [repo, home]) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Un lock de Windows sobre .git/objects no invalida el test.
    }
  }
});

describe('SnapshotStore: ciclo por turno', () => {
  it(
    'registra added/modified/deleted y revertTurns(1) deja el árbol como estaba (CRLF y BOM byte a byte)',
    { timeout: 60_000 },
    async () => {
      const crlf = Buffer.from('uno\r\ndos\r\n', 'utf-8');
      const bom = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('con bom\r\n', 'utf-8')]);
      await writeFile(join(repo, 'keep.txt'), 'base\n');
      await writeFile(join(repo, 'crlf.txt'), crlf);
      await writeFile(join(repo, 'bom.txt'), bom);
      await writeFile(join(repo, 'gone.txt'), 'se borra\n');

      const store = await open();
      expect(store.isActive()).toBe(true);
      // El seed: el primer snapshot incluye lo que ya existía en el work-tree.
      await store.track();

      const turn = await store.beginTurn();
      expect(turn).not.toBeNull();
      await writeFile(join(repo, 'nuevo.txt'), 'a\nb\n');
      await writeFile(join(repo, 'keep.txt'), 'base\nagente\n');
      await rm(join(repo, 'gone.txt'));
      await writeFile(join(repo, 'crlf.txt'), Buffer.from('uno\r\ntres\r\n', 'utf-8'));
      const record = await store.finishTurn(turn);

      expect(record).not.toBeNull();
      const byPath = Object.fromEntries(record!.files.map((f) => [f.path, f.status]));
      expect(byPath['nuevo.txt']).toBe('added');
      expect(byPath['keep.txt']).toBe('modified');
      expect(byPath['gone.txt']).toBe('deleted');
      expect(byPath['crlf.txt']).toBe('modified');
      // El estado de las líneas sale de `--numstat`; un binario no es 0.
      const added = record!.files.find((f) => f.path === 'nuevo.txt')!;
      expect(added.additions).toBe(2);
      expect(added.deletions).toBe(0);

      const undoable = store.getUndoableTurns();
      expect(undoable.map((t) => t.turn)).toEqual([1]);

      const plan = await store.planRevert(1);
      expect(plan.turns).toEqual([1]);
      expect(plan.restore.sort()).toEqual(['crlf.txt', 'gone.txt', 'keep.txt']);
      expect(plan.remove).toEqual(['nuevo.txt']);
      expect(plan.conflicts).toEqual([]);

      const result = await store.revertTurns(1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // El árbol vuelve al T0 del turno, byte a byte.
      expect(existsSync(join(repo, 'nuevo.txt'))).toBe(false);
      expect(await readFile(join(repo, 'keep.txt'), 'utf-8')).toBe('base\n');
      expect(await readFile(join(repo, 'gone.txt'), 'utf-8')).toBe('se borra\n');
      expect((await readFile(join(repo, 'crlf.txt'))).equals(crlf)).toBe(true);
      expect((await readFile(join(repo, 'bom.txt'))).equals(bom)).toBe(true);
      expect(store.getUndoableTurns()).toEqual([]);
    },
  );

  it('no registra un turno sin cambios', { timeout: 60_000 }, async () => {
    await writeFile(join(repo, 'a.txt'), 'a\n');
    const store = await open();
    await store.track();
    const turn = await store.beginTurn();
    const record = await store.finishTurn(turn);
    expect(record).toBeNull();
    expect(store.getUndoableTurns()).toEqual([]);
  });

  it('revierte 2 turnos a la vez al estado del más antiguo', { timeout: 60_000 }, async () => {
    await writeFile(join(repo, 'base.txt'), 'base\n');
    const store = await open();
    await store.track();

    const t1 = await store.beginTurn();
    await writeFile(join(repo, 'a.txt'), '1\n');
    await writeFile(join(repo, 'b.txt'), '1\n');
    expect(await store.finishTurn(t1)).not.toBeNull();

    const t2 = await store.beginTurn();
    await writeFile(join(repo, 'a.txt'), '2\n');
    await rm(join(repo, 'b.txt'));
    expect(await store.finishTurn(t2)).not.toBeNull();

    expect(store.getUndoableTurns().map((t) => t.turn)).toEqual([2, 1]);

    const plan = await store.planRevert(2);
    expect(plan.turns).toEqual([1, 2]);
    expect(plan.remove.sort()).toEqual(['a.txt', 'b.txt']);
    expect(plan.restore).toEqual([]);
    expect(plan.conflicts).toEqual([]);

    const result = await store.revertTurns(2);
    expect(result.ok).toBe(true);
    expect(existsSync(join(repo, 'a.txt'))).toBe(false);
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);
    // Lo que existía antes del turno 1 no se toca.
    expect(await readFile(join(repo, 'base.txt'), 'utf-8')).toBe('base\n');
    expect(store.getUndoableTurns()).toEqual([]);
  });

  it('rechaza revertir mientras un turno está en curso', { timeout: 60_000 }, async () => {
    await writeFile(join(repo, 'a.txt'), 'a\n');
    const store = await open();
    await store.track();
    const turn = await store.beginTurn();
    await writeFile(join(repo, 'a.txt'), 'agente\n');
    const busy = await store.revertTurns(1, { force: true });
    expect(busy).toEqual({ ok: false, reason: 'turn-in-progress' });
    await store.finishTurn(turn);
  });
});

describe('SnapshotStore: conflictos contra T1', () => {
  it(
    'una edición posterior del usuario bloquea el revert salvo con force',
    { timeout: 60_000 },
    async () => {
      await writeFile(join(repo, 'base.txt'), 'base\n');
      const store = await open();
      await store.track();

      const t1 = await store.beginTurn();
      await writeFile(join(repo, 'a.txt'), 'agente\n');
      await writeFile(join(repo, 'base.txt'), 'base+agente\n');
      expect(await store.finishTurn(t1)).not.toBeNull();

      // El usuario toca a posteriori uno de los ficheros del turno.
      await writeFile(join(repo, 'a.txt'), 'usuario\n');

      const plan = await store.planRevert(1);
      expect(plan.conflicts).toEqual(['a.txt']);

      const blocked = await store.revertTurns(1);
      expect(blocked).toMatchObject({ ok: false, reason: 'conflicts', conflicts: ['a.txt'] });
      // Nada se tocó: ni el fichero en conflicto ni el resto del turno.
      expect(await readFile(join(repo, 'a.txt'), 'utf-8')).toBe('usuario\n');
      expect(await readFile(join(repo, 'base.txt'), 'utf-8')).toBe('base+agente\n');
      expect(store.getUndoableTurns().map((t) => t.turn)).toEqual([1]);

      const forced = await store.revertTurns(1, { force: true });
      expect(forced.ok).toBe(true);
      expect(existsSync(join(repo, 'a.txt'))).toBe(false);
      expect(await readFile(join(repo, 'base.txt'), 'utf-8')).toBe('base\n');
    },
  );
});

describe('SnapshotStore: límites y exclusiones', () => {
  it(
    'un fichero > maxFileBytes no entra y se reporta como skipped',
    { timeout: 60_000 },
    async () => {
      await writeFile(join(repo, 'base.txt'), 'base\n');
      const store = await open({ maxFileBytes: 32 });
      await store.track();

      const turn = await store.beginTurn();
      await writeFile(join(repo, 'pequeno.txt'), 'x\n');
      await writeFile(join(repo, 'grande.bin'), Buffer.alloc(256, 7));
      const record = await store.finishTurn(turn);

      expect(record).not.toBeNull();
      expect(record!.files.map((f) => f.path)).toEqual(['pequeno.txt']);
      expect(record!.skipped).toEqual(['grande.bin']);

      const plan = await store.planRevert(1);
      expect(plan.skipped).toEqual(['grande.bin']);
      expect(plan.remove).toEqual(['pequeno.txt']);

      const result = await store.revertTurns(1);
      expect(result.ok).toBe(true);
      // Lo que no tiene snapshot no se puede deshacer: queda en disco.
      expect(existsSync(join(repo, 'grande.bin'))).toBe(true);
      expect(existsSync(join(repo, 'pequeno.txt'))).toBe(false);
    },
  );

  it(
    '.stratum/ y lo ignorado por .gitignore nunca entran en el snapshot',
    { timeout: 60_000 },
    async () => {
      await writeFile(join(repo, '.gitignore'), 'ignorado/\n');
      await mkdir(join(repo, '.stratum', 'plans'), { recursive: true });
      await writeFile(join(repo, '.stratum', 'plans', 'p.json'), '{}');
      await mkdir(join(repo, 'ignorado'), { recursive: true });
      await writeFile(join(repo, 'ignorado', 'x.txt'), 'no\n');
      await writeFile(join(repo, 'base.txt'), 'base\n');

      const store = await open();
      await store.track();

      const turn = await store.beginTurn();
      await writeFile(join(repo, 'visibles.txt'), 'si\n');
      await writeFile(join(repo, '.stratum', 'plans', 'p.json'), '{"otra":"cosa"}');
      await writeFile(join(repo, 'ignorado', 'x.txt'), 'sigue sin entrar\n');
      const record = await store.finishTurn(turn);

      expect(record).not.toBeNull();
      expect(record!.files.map((f) => f.path)).toEqual(['visibles.txt']);

      const result = await store.revertTurns(1);
      expect(result.ok).toBe(true);
      // Ni se revierten ni se borran: nunca fueron parte del snapshot.
      expect(existsSync(join(repo, 'ignorado', 'x.txt'))).toBe(true);
      expect(readFileSync(join(repo, '.stratum', 'plans', 'p.json'), 'utf-8')).toBe(
        '{"otra":"cosa"}',
      );
    },
  );
});

describe('SnapshotStore: pathspecs literales', () => {
  it(
    'un fichero con metacaracteres de pathspec se snapshotea y se revierte',
    { timeout: 60_000 },
    async () => {
      // `[1]` es una clase de caracteres de pathspec: sin GIT_LITERAL_PATHSPECS
      // el `git add` fallaría («did not match any files»). En Windows `*` no es
      // un nombre válido, así que solo se añade fuera de él.
      const raro = process.platform === 'win32' ? 'a[1].txt' : 'a[1]*.txt';
      await writeFile(join(repo, raro), 'base\n');

      const store = await open();
      await store.track();

      const turn = await store.beginTurn();
      await writeFile(join(repo, raro), 'agente\n');
      const record = await store.finishTurn(turn);
      expect(record).not.toBeNull();
      expect(record!.files.map((f) => f.path)).toEqual([raro]);

      const result = await store.revertTurns(1);
      expect(result.ok).toBe(true);
      expect(await readFile(join(repo, raro), 'utf-8')).toBe('base\n');
    },
  );
});

describe('SnapshotStore: el .git del usuario no cambia', () => {
  it(
    'snapshotear un work-tree sucio no toca índice, HEAD ni status del usuario',
    { timeout: 60_000 },
    async () => {
      await writeFile(join(repo, 'tracked.txt'), 'base\n');
      await writeFile(join(repo, 'otro.txt'), 'base\n');
      await git(repo, ['add', '-A']);
      await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);

      // El agente ya ensució el árbol ANTES de abrir el almacén.
      await writeFile(join(repo, 'tracked.txt'), 'sucio\n');
      await writeFile(join(repo, 'untracked.txt'), 'nuevo\n');

      const statusBefore = (await git(repo, ['status', '--porcelain'])).stdout;
      const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
      const indexBefore = (await git(repo, ['ls-files', '-s'])).stdout;

      const store = await open();
      await store.track();
      const turn = await store.beginTurn();
      await writeFile(join(repo, 'agente.txt'), 'a\n');
      expect(await store.finishTurn(turn)).not.toBeNull();
      await store.planRevert(1);
      await store.revertTurns(1);

      expect((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
      // El índice del usuario es el mismo: el `git add` fue al índice de la sombra.
      expect((await git(repo, ['ls-files', '-s'])).stdout).toBe(indexBefore);
      // Tras deshacer, el work-tree (y por tanto el status) vuelve al de antes.
      expect((await git(repo, ['status', '--porcelain'])).stdout).toBe(statusBefore);
      // Y no se creó nada dentro del proyecto.
      expect(existsSync(join(repo, '.git', 'stratum'))).toBe(false);
    },
  );
});

describe('entorno de git aislado (punto 2)', () => {
  it('fija GIT_CONFIG_GLOBAL/NOSYSTEM y no hereda el enrutado del proceso', () => {
    const env = snapshotGitEnv({
      gitDir: '/shadow/git',
      workTree: '/proyecto',
      indexFile: '/shadow/index-ses',
      globalConfig: '/shadow/empty.gitconfig',
      base: {
        PATH: 'x',
        GIT_DIR: '/otro/repo/.git',
        GIT_WORK_TREE: '/otro/repo',
        GIT_INDEX_FILE: '/otro/index',
        GIT_CONFIG_GLOBAL: '/home/user/.gitconfig',
        GIT_COMMON_DIR: '/otro/common',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/tmp/hooks',
      },
    });

    expect(env.GIT_DIR).toBe('/shadow/git');
    expect(env.GIT_WORK_TREE).toBe('/proyecto');
    expect(env.GIT_INDEX_FILE).toBe('/shadow/index-ses');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/shadow/empty.gitconfig');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.PATH).toBe('x');
  });

  it(
    'un GIT_DIR exportado en el proceso no desvía los snapshots',
    { timeout: 60_000 },
    async () => {
      await writeFile(join(repo, 'base.txt'), 'base\n');
      const otros = await mkdtemp(join(tmpdir(), 'stratum-snap-ajeno-'));
      await initRepo(otros);
      const savedDir = process.env.GIT_DIR;
      const savedWorkTree = process.env.GIT_WORK_TREE;
      process.env.GIT_DIR = join(otros, '.git');
      process.env.GIT_WORK_TREE = otros;
      try {
        const store = await open();
        await store.track();
        const turn = await store.beginTurn();
        await writeFile(join(repo, 'nuevo.txt'), 'a\n');
        const record = await store.finishTurn(turn);
        expect(record?.files.map((f) => f.path)).toEqual(['nuevo.txt']);
        // El repo ajeno no se ha tocado.
        expect((await git(otros, ['status', '--porcelain'])).stdout.trim()).toBe('');
      } finally {
        if (savedDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = savedDir;
        if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = savedWorkTree;
        await rm(otros, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
          () => undefined,
        );
      }
    },
  );
});

describe('SnapshotStore: activación, ubicación y registro versionado', () => {
  it('fuera de un repo git queda desactivado sin lanzar', { timeout: 60_000 }, async () => {
    const plano = await mkdtemp(join(tmpdir(), 'stratum-snap-plano-'));
    try {
      const store = await SnapshotStore.open({
        cwd: plano,
        sessionId: 'ses_test',
        config: CONFIG,
        home,
      });
      expect(store.isActive()).toBe(false);
      expect(store.disabledReason).toContain('not inside a git repository');
      expect(await store.track()).toBeNull();
      expect(await store.beginTurn()).toBeNull();
      expect((await store.planRevert(1)).turns).toEqual([]);
      expect(await store.revertTurns(1)).toMatchObject({ ok: false, reason: 'disabled' });
    } finally {
      await rm(plano, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
        () => undefined,
      );
    }
  });

  it('enabled:false desactiva sin crear nada', { timeout: 60_000 }, async () => {
    const store = await open({ enabled: false });
    expect(store.isActive()).toBe(false);
    expect(store.disabledReason).toContain('enabled');
    expect(existsSync(store.dir)).toBe(false);
  });

  it('la raíz es el worktree (no el cwd) y el id sale de ella', { timeout: 60_000 }, async () => {
    const sub = join(repo, 'paquete');
    await mkdir(sub);
    const store = await open({}, sub);
    expect(store.root).toBe(repo);
    // El id se hashea de la raíz del worktree, no del cwd: abrir desde
    // `paquete/` y desde la raíz comparten almacén e índice por sesión.
    expect(store.dir).toBe(snapshotDirForRoot(repo, home));
    expect(store.gitDir).toBe(join(store.dir, 'git'));
    expect(store.globalConfig).toBe(join(store.dir, 'empty.gitconfig'));
    expect(store.indexFile).toBe(join(store.dir, 'index-ses_test'));
    expect(store.turnsFile).toBe(join(store.dir, 'turns-ses_test.json'));
    expect(existsSync(join(store.dir, 'empty.gitconfig'))).toBe(true);
    // Config dura del repo de la sombra.
    const config = await git(
      join(repo, 'paquete'),
      ['config', '--list'],
      snapshotGitEnv({
        gitDir: store.gitDir,
        workTree: store.root,
        indexFile: store.indexFile,
        globalConfig: store.globalConfig,
      }),
    );
    for (const line of [
      'core.autocrlf=false',
      'core.safecrlf=false',
      'core.longpaths=true',
      'core.quotepath=false',
      'gc.auto=0',
    ]) {
      expect(config.stdout).toContain(line);
    }
  });

  it('normaliza la raíz antes de hashear (mismo id con otro separador)', () => {
    const a = snapshotRootId('D:\\Repo\\Sub');
    const b = snapshotRootId('D:/Repo/Sub');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    if (process.platform === 'win32') {
      expect(normalizeRootForId('D:\\Repo')).toBe('d:/repo');
    }
  });

  it(
    'un registro con schemaVersion mayor no se toca y desactiva la sesión',
    { timeout: 60_000 },
    async () => {
      const dir = snapshotDirForRoot(repo, home);
      await mkdir(dir, { recursive: true });
      const turnsFile = join(dir, 'turns-ses_test.json');
      const raw = JSON.stringify({ schemaVersion: 99, turns: [] });
      await writeFile(turnsFile, raw);

      const store = await open();
      expect(store.isActive()).toBe(false);
      expect(store.disabledReason).toContain('incompatible');
      expect(readFileSync(turnsFile, 'utf-8')).toBe(raw);
    },
  );

  it(
    'purga los turnos más viejos que retentionDays y el turno vivo sigue siendo revertible tras el gc',
    { timeout: 90_000 },
    async () => {
      await writeFile(join(repo, 'base.txt'), 'base\n');
      const store = await open({ retentionDays: 7 });
      await store.track();

      const t1 = await store.beginTurn();
      await writeFile(join(repo, 'viejo.txt'), '1\n');
      const viejo = await store.finishTurn(t1);
      const t2 = await store.beginTurn();
      await writeFile(join(repo, 'base.txt'), 'agente\n');
      const vivo = await store.finishTurn(t2);
      expect(viejo).not.toBeNull();
      expect(vivo).not.toBeNull();

      // Envejece el primer turno por fuera: el registro se reescribe al abrir.
      const turnsFile = join(store.dir, 'turns-ses_test.json');
      const file = JSON.parse(readFileSync(turnsFile, 'utf-8')) as {
        turns: Array<{ turn: number; endedAt: string }>;
      };
      file.turns[0]!.endedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
      await writeFile(turnsFile, JSON.stringify(file));

      const reopened = await open({ retentionDays: 7 });
      expect(reopened.isActive()).toBe(true);
      expect(reopened.getUndoableTurns().map((t) => t.turn)).toEqual([vivo!.turn]);
      const persisted = JSON.parse(readFileSync(turnsFile, 'utf-8')) as { turns: unknown[] };
      expect(persisted.turns).toHaveLength(1);

      // El gc va en segundo plano; se le da margen antes de comprobar que el
      // turno vivo (protegido por su ref) sigue deshacible.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await reopened.revertTurns(1, { force: true });
      expect(result.ok).toBe(true);
      expect(await readFile(join(repo, 'base.txt'), 'utf-8')).toBe('base\n');
    },
  );
});

describe('SnapshotStore: atributos del proyecto no normalizan los bytes', () => {
  it(
    'con `.gitattributes` (text eol=lf, working-tree-encoding) un .sh con CRLF se revierte byte a byte',
    { timeout: 60_000 },
    async () => {
      // Si el repo de la sombra respetara esto, `git add` guardaría LF y el
      // revert devolvería un fichero distinto al que el usuario tenía.
      await writeFile(
        join(repo, '.gitattributes'),
        '*.sh text eol=lf\n*.txt working-tree-encoding=UTF-16\n',
      );
      const original = Buffer.from('#!/bin/sh\r\necho hola\r\n', 'utf-8');
      await writeFile(join(repo, 'deploy.sh'), original);

      const store = await open();
      await store.track();

      const turn = await store.beginTurn();
      await writeFile(join(repo, 'deploy.sh'), Buffer.from('#!/bin/sh\r\necho adios\r\n', 'utf-8'));
      expect(await store.finishTurn(turn)).not.toBeNull();

      const result = await store.revertTurns(1);
      expect(result.ok).toBe(true);
      expect((await readFile(join(repo, 'deploy.sh'))).equals(original)).toBe(true);
    },
  );
});

describe('SnapshotStore: gc entre sesiones del mismo proyecto', () => {
  it(
    'la sesión A purga y lanza gc sin podar los árboles que la sesión B necesita',
    { timeout: 120_000 },
    async () => {
      await writeFile(join(repo, 'base.txt'), 'base\n');

      const storeA = await SnapshotStore.open({
        cwd: repo,
        sessionId: 'ses_a',
        config: CONFIG,
        home,
      });
      const storeB = await SnapshotStore.open({
        cwd: repo,
        sessionId: 'ses_b',
        config: CONFIG,
        home,
      });
      expect(storeA.isActive()).toBe(true);
      expect(storeB.isActive()).toBe(true);
      await storeA.track();
      await storeB.track();

      // A: un turno que quedará viejo.
      const turnA = await storeA.beginTurn();
      await writeFile(join(repo, 'a.txt'), 'de A\n');
      expect(await storeA.finishTurn(turnA)).not.toBeNull();

      // B: un turno vivo, que debe seguir siendo deshacible.
      const turnB = await storeB.beginTurn();
      await writeFile(join(repo, 'b.txt'), 'de B\n');
      const recordB = await storeB.finishTurn(turnB);
      expect(recordB).not.toBeNull();

      // Envejecer el turno de A por fuera (el registro se reescribe al abrir).
      const turnsA = join(storeA.dir, 'turns-ses_a.json');
      const parsed = JSON.parse(readFileSync(turnsA, 'utf-8')) as {
        turns: Array<{ endedAt: string }>;
      };
      parsed.turns[0]!.endedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
      await writeFile(turnsA, JSON.stringify(parsed));

      // Reabrir A dispara la purga y el `git gc` en segundo plano.
      const reopenedA = await SnapshotStore.open({
        cwd: repo,
        sessionId: 'ses_a',
        config: CONFIG,
        home,
      });
      expect(reopenedA.isActive()).toBe(true);
      expect(reopenedA.getUndoableTurns()).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // B conserva su turno y puede revertirlo: sus árboles no se podaron.
      expect(storeB.getUndoableTurns().map((t) => t.turn)).toEqual([recordB!.turn]);
      const reverted = await storeB.revertTurns(1, { force: true });
      expect(reverted.ok).toBe(true);
      expect(existsSync(join(repo, 'b.txt'))).toBe(false);
    },
  );
});

describe('SnapshotStore: límites de seguridad', () => {
  it(
    'más candidatos que maxFiles desactiva la sesión en vez de recorrer el proyecto',
    { timeout: 60_000 },
    async () => {
      for (let i = 0; i < 6; i++) await writeFile(join(repo, `f${i}.txt`), `${i}\n`);

      const store = await open({ maxFiles: 2 });
      expect(store.isActive()).toBe(true);
      expect(await store.beginTurn()).toBeNull();
      expect(store.isActive()).toBe(false);
      expect(store.disabledReason).toContain('maxFiles');
    },
  );

  it('un git que se pasa de timeout desactiva la sesión', { timeout: 60_000 }, async () => {
    await writeFile(join(repo, 'a.txt'), 'a\n');
    const store = await open({ timeoutMs: 1 });
    expect(store.isActive()).toBe(false);
    expect(store.disabledReason).toMatch(/timeout/i);
    expect(await store.track()).toBeNull();
  });
});

describe('SnapshotStore: confinamiento y secretos', () => {
  it(
    'rechaza el revert entero si el registro trae una ruta fuera del work-tree',
    { timeout: 60_000 },
    async () => {
      await writeFile(join(repo, 'base.txt'), 'base\n');
      const outside = join(home, 'fuera.txt');
      await writeFile(outside, 'no tocar\n');

      const store = await open();
      await store.track();
      const turn = await store.beginTurn();
      await writeFile(join(repo, 'dentro.txt'), 'x\n');
      const record = await store.finishTurn(turn);
      expect(record).not.toBeNull();

      // Registro manipulado a mano: una ruta que sale del work-tree.
      const turnsFile = join(store.dir, 'turns-ses_test.json');
      const file = JSON.parse(readFileSync(turnsFile, 'utf-8')) as {
        turns: Array<{ files: Array<{ path: string; status: string }> }>;
      };
      file.turns[0]!.files.push({ path: '../fuera.txt', status: 'deleted' });
      await writeFile(turnsFile, JSON.stringify(file));

      const reopened = await open();
      const result = await reopened.revertTurns(1, { force: true });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('error');
      expect(result.error).toContain('../fuera.txt');
      // Ni se tocó el fichero de fuera ni se aplicó nada del turno.
      expect(await readFile(outside, 'utf-8')).toBe('no tocar\n');
      expect(existsSync(join(repo, 'dentro.txt'))).toBe(true);
      expect(reopened.getUndoableTurns()).toHaveLength(1);
    },
  );

  it(
    '.stratumrc.json y cualquier .stratumrc.* nunca entran en el snapshot',
    { timeout: 60_000 },
    async () => {
      await writeFile(join(repo, '.stratumrc.json'), '{"provider":{"apiKey":"sk-secreto"}}\n');
      await writeFile(join(repo, '.stratumrc.local.json'), '{"x":1}\n');
      const store = await open();
      await store.track();

      const turn = await store.beginTurn();
      await writeFile(join(repo, '.stratumrc.json'), '{"provider":{"apiKey":"sk-otro"}}\n');
      await writeFile(join(repo, 'visible.txt'), 'si\n');
      const record = await store.finishTurn(turn);

      expect(record).not.toBeNull();
      expect(record!.files.map((f) => f.path)).toEqual(['visible.txt']);
    },
  );

  it(
    'roba un lock huérfano del registro en vez de quedarse esperando',
    { timeout: 60_000 },
    async () => {
      await writeFile(join(repo, 'base.txt'), 'base\n');
      const store = await open();
      await store.track();

      const turn = await store.beginTurn();
      await writeFile(join(repo, 'lock.txt'), 'x\n');
      // Lock de un pid muerto y viejo, como el de una CLI que se colgó.
      await writeFile(
        store.lockFile,
        JSON.stringify({ pid: 999_999, host: 'otro-host', at: Date.now() - 5 * 60_000 }),
      );

      const record = await store.finishTurn(turn);
      expect(record).not.toBeNull();
      expect(existsSync(store.lockFile)).toBe(false);
    },
  );
});
