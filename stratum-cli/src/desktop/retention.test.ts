import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import * as tar from 'tar-stream';
import { ArchiveError, extractArchive, packDirectory, verifyArchive } from './archive.js';
import { WorkspaceJanitor, retentionAction } from './retention.js';
import { WorkspaceManager, WORKSPACE_META_FILE, resolveWorkspaceSettings } from './workspace.js';
import { ConversationHost } from './conversation-host.js';
import { DesktopSessionStore } from './session-store.js';
import { buildAssistantConfig } from './assistant-runtime.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { parseInboundFrame } from './codec.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { ConversationOutboundFrame, WorkspaceStatus } from './protocol.js';

const base = mkdtempSync(join(tmpdir(), 'stratum-desktop-ret-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const cid = () => `3e0f6a52-7d3b-4c1e-9a0b-${(++n).toString(16).padStart(12, '0')}`;

/** Reloj de test: se adelanta a mano. */
function clock(start = '2026-09-01T10:00:00Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function managerWith(c = clock(), days = { compress: 7, delete: 30 }) {
  const mgr = new WorkspaceManager(
    {
      root: join(base, `root${++n}`),
      maxFileBytes: 64 * 1024 * 1024,
      maxWorkspaceBytes: 256 * 1024 * 1024,
      compressAfterMs: days.compress * DAY,
      deleteAfterMs: days.delete * DAY,
    },
    c.now,
  );
  return { mgr, clock: c, janitor: new WorkspaceJanitor(mgr, { now: c.now }) };
}

/** sha256 de cada fichero bajo `dir`, sin los metadatos. */
function hashTree(dir: string, rel = '', out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const path = rel ? `${rel}/${name}` : name;
    if (path === WORKSPACE_META_FILE) continue;
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      out[`${path}/`] = 'dir';
      hashTree(abs, path, out);
    } else out[path] = createHash('sha256').update(readFileSync(abs)).digest('hex');
  }
  return out;
}

/** Un workspace con contenido variado: binario, texto, anidado, vacío, unicode, nombre largo. */
function populate(dir: string): void {
  writeFileSync(join(dir, 'inputs', 'ventas.csv'), 'mes,total\nenero,10\n');
  writeFileSync(join(dir, 'inputs', 'foto.bin'), randomBytes(300_000));
  writeFileSync(join(dir, 'inputs', 'año ñandú — informe.txt'), 'acentos ✓');
  mkdirSync(join(dir, 'outputs', 'sub', 'dir'), { recursive: true });
  writeFileSync(join(dir, 'outputs', 'sub', 'dir', 'resumen.md'), '# Resumen\n');
  writeFileSync(join(dir, 'outputs', `${'n'.repeat(140)}.txt`), 'nombre largo');
  writeFileSync(join(dir, 'outputs', 'vacío.txt'), '');
  mkdirSync(join(dir, 'scratch', 'carpeta-vacia'), { recursive: true });
}

describe('archive (tar.gz en JS puro)', () => {
  it('empaqueta, verifica y extrae byte a byte', async () => {
    const src = join(base, `src${++n}`);
    for (const d of ['inputs', 'outputs', 'scratch']) mkdirSync(join(src, d), { recursive: true });
    populate(src);
    const archive = join(base, `a${n}.tar.gz`);
    const manifest = await packDirectory(src, archive);
    await verifyArchive(archive, manifest);
    const dest = join(base, `dest${n}`);
    await extractArchive(archive, dest);
    expect(hashTree(dest)).toEqual(hashTree(src));
  });

  it('verifyArchive detecta un archivo que no coincide o está corrupto', async () => {
    const src = join(base, `src${++n}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'uno');
    const archive = join(base, `a${n}.tar.gz`);
    const manifest = await packDirectory(src, archive);
    await expect(
      verifyArchive(archive, [...manifest, { path: 'b.txt', type: 'file', size: 1, sha256: 'x' }]),
    ).rejects.toBeInstanceOf(ArchiveError);
    const bytes = readFileSync(archive);
    writeFileSync(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(verifyArchive(archive, manifest)).rejects.toBeInstanceOf(ArchiveError);
  });

  it.each([
    ['../fuera.txt', 'file'],
    ['/abs.txt', 'file'],
    ['a/../../x', 'file'],
    ['enlace', 'symlink'],
  ] as const)('la extracción rechaza %s (%s) y no deja nada', async (name, type) => {
    const archive = join(base, `evil${++n}.tar.gz`);
    const pack = tar.pack();
    if (type === 'symlink') pack.entry({ name, type: 'symlink', linkname: '/etc/passwd' });
    else pack.entry({ name }, 'malicioso');
    pack.finalize();
    await pipeline(
      pack as unknown as NodeJS.ReadableStream,
      createGzip(),
      createWriteStream(archive),
    );
    const dest = join(base, `evil-dest${n}`);
    await expect(extractArchive(archive, dest)).rejects.toBeInstanceOf(ArchiveError);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(resolve(base, 'fuera.txt'))).toBe(false);
  });
});

describe('retentionAction', () => {
  const s = { compressAfterMs: 7 * DAY, deleteAfterMs: 30 * DAY };
  const now = new Date('2026-10-01T00:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  it.each([
    ['active', 3, false, s, 'none'],
    ['active', 7, false, s, 'archive'],
    ['active', 31, false, s, 'purge'],
    ['archived', 10, false, s, 'none'],
    ['archived', 30, false, s, 'purge'],
    ['purged', 90, false, s, 'none'],
    ['active', 90, true, s, 'none'],
    ['active', 90, false, { compressAfterMs: 0, deleteAfterMs: 30 * DAY }, 'purge'],
    ['active', 90, false, { compressAfterMs: 7 * DAY, deleteAfterMs: 0 }, 'archive'],
    ['archived', 900, false, { compressAfterMs: 7 * DAY, deleteAfterMs: 0 }, 'none'],
  ] as const)('%s, %i días sin uso, fijada=%s → %s', (state, days, pinned, settings, want) => {
    expect(retentionAction(state, { lastUsedAt: ago(days), pinned }, now, settings)).toBe(want);
  });

  it('el schema valida deleteAfterDays > compressAfterDays y 0 desactiva', () => {
    const parse = (w: Record<string, unknown>) =>
      StratumConfigSchema.safeParse({ desktop: { workspaces: w } }).success;
    expect(parse({})).toBe(true);
    expect(parse({ compressAfterDays: 10, deleteAfterDays: 5 })).toBe(false);
    expect(parse({ compressAfterDays: 7, deleteAfterDays: 7 })).toBe(false);
    expect(parse({ compressAfterDays: 0, deleteAfterDays: 1 })).toBe(true);
    expect(parse({ compressAfterDays: 7, deleteAfterDays: 0 })).toBe(true);
    const { settings } = resolveWorkspaceSettings(
      StratumConfigSchema.parse({ desktop: { workspaces: { compressAfterDays: 0.5 } } }),
      join(base, 'data'),
      join(base, 'home'),
    );
    expect(settings.compressAfterMs).toBe(DAY / 2);
    expect(settings.deleteAfterMs).toBe(30 * DAY);
  });
});

describe('WorkspaceManager + janitor', () => {
  it('active → archived → purged, con el estado correcto en cada paso', async () => {
    const { mgr, clock: c, janitor } = managerWith();
    const id = cid();
    const ws = mgr.open(id);
    populate(ws.dir);
    ws.touch();
    const before = hashTree(ws.dir);

    c.advance(6 * DAY);
    expect((await janitor.runOnce()).archived).toEqual([]);

    c.advance(1 * DAY);
    expect((await janitor.runOnce()).archived).toEqual([id]);
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(mgr.archivePath(id))).toBe(true);
    expect(mgr.statusOf(id)).toMatchObject({
      state: 'archived',
      purgeAt: new Date(Date.parse(ws.getMeta().lastUsedAt) + 30 * DAY).toISOString(),
    });

    // Restaurar es byte a byte y no cuenta como uso.
    const { workspace, restored } = await mgr.acquire(id);
    expect(restored).toBe(true);
    expect(hashTree(workspace.dir)).toEqual(before);
    expect(workspace.getMeta().lastUsedAt).toBe(ws.getMeta().lastUsedAt);
    expect(existsSync(mgr.archivePath(id))).toBe(false);
    mgr.release(id);

    // Sigue sin usarse: se vuelve a comprimir y al día 30 se purga.
    expect((await janitor.runOnce()).archived).toEqual([id]);
    c.advance(23 * DAY);
    expect((await janitor.runOnce()).purged).toEqual([id]);
    expect(existsSync(mgr.archivePath(id))).toBe(false);
    expect(mgr.statusOf(id)).toMatchObject({ state: 'purged', purgeAt: null });
    expect(mgr.statusOf(id)?.filesExpiredAt).toBe(c.now().toISOString());
  });

  it('una conversación fijada nunca se comprime ni se purga', async () => {
    const { mgr, clock: c, janitor } = managerWith();
    const id = cid();
    const ws = mgr.open(id);
    ws.setPinned(true);
    c.advance(400 * DAY);
    const report = await janitor.runOnce();
    expect(report.archived).toEqual([]);
    expect(report.purged).toEqual([]);
    expect(existsSync(ws.dir)).toBe(true);
    expect(mgr.statusOf(id)).toMatchObject({ state: 'active', pinned: true, purgeAt: null });
  });

  it('una conversación abierta en el host (o con turno) nunca se comprime', async () => {
    const { mgr, clock: c, janitor } = managerWith();
    const id = cid();
    await mgr.acquire(id);
    c.advance(40 * DAY);
    const report = await janitor.runOnce();
    expect(report.inUse).toEqual([id]);
    expect(existsSync(join(mgr.root, id))).toBe(true);
    mgr.release(id);
    expect((await janitor.runOnce()).purged).toEqual([id]);
  });

  it('abrir espera a que termine una compresión en marcha y restaura', async () => {
    const { mgr, clock: c } = managerWith();
    const id = cid();
    const ws = mgr.open(id);
    populate(ws.dir);
    const before = hashTree(ws.dir);
    c.advance(8 * DAY);
    const compressing = mgr.withLock(id, () => mgr.archive(id));
    const opening = mgr.acquire(id);
    await compressing;
    const { workspace, restored } = await opening;
    expect(restored).toBe(true);
    expect(hashTree(workspace.dir)).toEqual(before);
  });

  it('el janitor no toca una carpeta sin metadatos válidos', async () => {
    const { mgr, clock: c, janitor } = managerWith();
    const id = cid();
    const ws = mgr.open(id);
    writeFileSync(join(ws.dir, WORKSPACE_META_FILE), '{roto');
    c.advance(100 * DAY);
    await janitor.runOnce();
    expect(existsSync(ws.dir)).toBe(true);
  });

  it('un fallo al retirar la carpeta deshace el archivo y conserva la carpeta', async () => {
    const { mgr, clock: c } = managerWith();
    const id = cid();
    const ws = mgr.open(id);
    populate(ws.dir);
    c.advance(8 * DAY);
    // El rename a la papelera falla si el destino ya existe y no está vacío
    // (en Windows pasaría también con un fichero abierto dentro).
    const spy = vi.spyOn(Date, 'now').mockReturnValue(12345);
    const trash = join(mgr.root, `.trash-${id}-12345`);
    mkdirSync(trash, { recursive: true });
    writeFileSync(join(trash, 'ocupado'), 'x');
    try {
      await expect(mgr.withLock(id, () => mgr.archive(id))).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(ws.dir)).toBe(true);
    expect(existsSync(mgr.archivePath(id))).toBe(false);
    expect(existsSync(mgr.recordPath(id))).toBe(false);
  });
});

describe('recuperación tras un apagado brusco', () => {
  async function archivedFixture() {
    const ctx = managerWith();
    const id = cid();
    const ws = ctx.mgr.open(id);
    populate(ws.dir);
    const hashes = hashTree(ws.dir);
    ctx.clock.advance(8 * DAY);
    return { ...ctx, id, ws, hashes };
  }

  it('temporal a medias + carpeta entera → se borra el temporal y queda active', async () => {
    const { mgr, id, ws, hashes } = await archivedFixture();
    writeFileSync(join(mgr.root, `.tmp-${id}.tar.gz`), randomBytes(1000));
    await mgr.recover();
    expect(readdirSync(mgr.root).some((e) => e.startsWith('.tmp-'))).toBe(false);
    expect(mgr.inspect(id).state).toBe('active');
    expect(hashTree(ws.dir)).toEqual(hashes);
  });

  it('archivo y registro publicados pero la carpeta sin retirar → gana la carpeta', async () => {
    const { mgr, id, ws, hashes } = await archivedFixture();
    await packDirectory(ws.dir, mgr.archivePath(id));
    writeFileSync(
      mgr.recordPath(id),
      JSON.stringify({
        conversationId: id,
        state: 'archived',
        lastUsedAt: new Date().toISOString(),
      }),
    );
    await mgr.recover();
    expect(mgr.inspect(id).state).toBe('active');
    expect(existsSync(mgr.archivePath(id))).toBe(false);
    expect(existsSync(mgr.recordPath(id))).toBe(false);
    expect(hashTree(ws.dir)).toEqual(hashes);
  });

  it('carpeta ya en la papelera y borrada a medias → queda archived y se restaura entera', async () => {
    const { mgr, id, ws, hashes } = await archivedFixture();
    await mgr.withLock(id, () => mgr.archive(id));
    // Simula el borrado interrumpido: una papelera con restos.
    const trash = join(mgr.root, `.trash-${id}-1`);
    mkdirSync(join(trash, 'inputs'), { recursive: true });
    writeFileSync(join(trash, 'inputs', 'resto.bin'), 'x');
    await mgr.recover();
    expect(existsSync(trash)).toBe(false);
    expect(mgr.inspect(id).state).toBe('archived');
    const { workspace } = await mgr.acquire(id);
    expect(workspace.dir).toBe(ws.dir);
    expect(hashTree(workspace.dir)).toEqual(hashes);
  });

  it('una carpeta sin metadatos junto al archivo no lo invalida: se aparta y se restaura', async () => {
    const { mgr, id, hashes } = await archivedFixture();
    await mgr.withLock(id, () => mgr.archive(id));
    // Lo que dejaría una copia a `inputs/` hecha sin abrir la conversación.
    mkdirSync(join(mgr.root, id, 'inputs'), { recursive: true });
    writeFileSync(join(mgr.root, id, 'inputs', 'suelto.txt'), 'x');
    await mgr.recover();
    expect(existsSync(mgr.archivePath(id))).toBe(true);
    expect(mgr.inspect(id).state).toBe('archived');
    const { workspace } = await mgr.acquire(id);
    expect(hashTree(workspace.dir)).toEqual(hashes);
    expect(readdirSync(mgr.root).some((e) => e.startsWith(`.orphan-${id}`))).toBe(true);
  });

  it('restauración interrumpida → se descarta y el archivo sigue válido', async () => {
    const { mgr, id, hashes } = await archivedFixture();
    await mgr.withLock(id, () => mgr.archive(id));
    const staging = join(mgr.root, `.restoring-${id}`);
    mkdirSync(join(staging, 'inputs'), { recursive: true });
    await mgr.recover();
    expect(existsSync(staging)).toBe(false);
    const { workspace } = await mgr.acquire(id);
    expect(hashTree(workspace.dir)).toEqual(hashes);
  });

  it('registro purged con el archivo aún en disco → purged y se borra el archivo', async () => {
    const { mgr, id } = await archivedFixture();
    await mgr.withLock(id, () => mgr.archive(id));
    const record = JSON.parse(readFileSync(mgr.recordPath(id), 'utf-8')) as Record<string, unknown>;
    writeFileSync(mgr.recordPath(id), JSON.stringify({ ...record, state: 'purged' }));
    await mgr.recover();
    expect(mgr.inspect(id).state).toBe('purged');
    expect(existsSync(mgr.archivePath(id))).toBe(false);
  });

  it(
    'matar el proceso a mitad de una compresión no pierde datos',
    { timeout: 60_000 },
    async () => {
      const { mgr, id, ws } = await archivedFixture();
      for (let i = 0; i < 12; i++)
        writeFileSync(join(ws.dir, 'inputs', `big${i}.bin`), randomBytes(4 * 1024 * 1024));
      const hashes = hashTree(ws.dir);
      const script = join(base, `child${n}.mts`);
      const wsModule = pathToFileURL(resolve('src/desktop/workspace.ts')).href;
      writeFileSync(
        script,
        [
          `import { WorkspaceManager } from ${JSON.stringify(wsModule)};`,
          `const mgr = new WorkspaceManager(${JSON.stringify(mgr.settings)});`,
          `process.stdout.write('ready\\n');`,
          `await mgr.withLock(${JSON.stringify(id)}, () => mgr.archive(${JSON.stringify(id)}));`,
          `process.stdout.write('done\\n');`,
        ].join('\n'),
      );
      const child = spawn(process.execPath, ['--import', 'tsx', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise((r) => child.once('exit', r));
      const tmp = join(mgr.root, `.tmp-${id}.tar.gz`);
      // Se mata en cuanto el temporal ya tiene datos: compresión en marcha.
      const sawTmp = await new Promise<boolean>((res) => {
        const deadline = Date.now() + 30_000;
        const tick = () => {
          try {
            if (lstatSync(tmp).size > 0) return res(true);
          } catch {
            /* aún no existe */
          }
          if (child.exitCode !== null || Date.now() > deadline) return res(false);
          setTimeout(tick, 2);
        };
        tick();
      });
      child.kill('SIGKILL');
      await exited;
      expect(sawTmp, `el hijo no llegó a comprimir: ${stderr}`).toBe(true);
      // Muerto a mitad: ni archivo publicado ni carpeta retirada.
      expect(existsSync(mgr.archivePath(id))).toBe(false);

      await mgr.recover();
      const state = mgr.inspect(id).state;
      expect(['active', 'archived']).toContain(state);
      const { workspace } = await mgr.acquire(id);
      expect(hashTree(workspace.dir)).toEqual(hashes);
      expect(readdirSync(mgr.root).filter((e) => e.startsWith('.'))).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Conversación de punta a punta con el host
// ---------------------------------------------------------------------------

class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push({ ...req, messages: [...req.messages] });
    return super.complete(req);
  }
}

/** Emite un trozo y espera a que lo aborten. */
class HangingProvider implements IProvider {
  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    yield {
      choices: [{ delta: { content: '…' }, finish_reason: null, index: 0 }],
    } as OpenAIStreamChunk;
    await new Promise<void>((r) => {
      req.signal?.addEventListener('abort', () => r(), { once: true });
      setTimeout(r, 10_000).unref();
    });
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function hostWith(provider: IProvider, mgr: WorkspaceManager) {
  const config = buildAssistantConfig(
    StratumConfigSchema.parse({
      provider: {
        default: 'test',
        providers: {
          test: {
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: '',
            model: 'test-model',
            contextWindow: 32768,
          },
        },
      },
      memory: { globalFile: join(base, 'none', 'STRATUM.md'), autoExtract: false },
    }),
    join(base, `data${++n}`),
  );
  const frames: ConversationOutboundFrame[] = [];
  const host = new ConversationHost({
    config,
    store: new DesktopSessionStore(join(base, `sessions${n}`)),
    makeRouter: () => {
      const router = new ProviderRouter(config);
      vi.spyOn(router, 'getActive').mockReturnValue(provider);
      return router;
    },
    workspaces: mgr,
  });
  host.attach(1, (f) => frames.push(f));
  const waitFor = async (pred: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(JSON.stringify(frames.map((f) => f.type)));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const opened = (id: string) =>
    frames.filter(
      (f): f is Extract<ConversationOutboundFrame, { type: 'conversation_opened' }> =>
        f.type === 'conversation_opened' && f.conversationId === id,
    );
  return { host, frames, waitFor, opened };
}

describe('conversación y retención', () => {
  it('la conversación se abre en cada estado y conserva el historial', async () => {
    const { mgr, clock: c, janitor } = managerWith();
    const provider = new RecordingProvider([
      makeTextRound('Hola'),
      makeTextRound('Sigo aquí'),
      makeTextRound('Y aquí'),
    ]);
    const { host, frames, waitFor, opened } = hostWith(provider, mgr);
    const id = cid();
    const turn = async (turnId: string) => {
      host.handle({ type: 'chat', conversationId: id, turnId, text: 'hola' }, 1);
      await waitFor(() => frames.some((f) => f.type === 'turn_ended' && f.turnId === turnId));
    };
    const reopen = async () => {
      host.handle({ type: 'new_conversation', conversationId: id, resume: true }, 1);
      await host.idle();
      return opened(id).at(-1)!;
    };
    const close = async () => {
      host.handle({ type: 'close_conversation', conversationId: id }, 1);
      await waitFor(() => frames.some((f) => f.type === 'conversation_closed'));
      await waitFor(() => !mgr.isInUse(id));
      frames.length = 0;
    };

    expect((await reopen()).workspace).toMatchObject({ state: 'active', pinned: false });
    writeFileSync(join(mgr.root, id, 'inputs', 'dato.txt'), 'DATO');
    await turn('t1');
    // Tras el turno se anuncia el estado con la fecha de purga.
    const status = frames.find((f) => f.type === 'workspace_status');
    expect(status).toMatchObject({ status: { state: 'active' } });
    await close();

    c.advance(8 * DAY);
    expect((await janitor.runOnce()).archived).toEqual([id]);
    const afterArchive = await reopen();
    expect(afterArchive).toMatchObject({ resumed: true, workspace: { state: 'active' } });
    // Antes del conversation_opened, el indicador de restauración.
    const restoring = frames.findIndex(
      (f) => f.type === 'workspace_status' && f.status.state === 'restoring',
    );
    expect(restoring).toBeGreaterThanOrEqual(0);
    expect(restoring).toBeLessThan(frames.indexOf(afterArchive));
    expect(readFileSync(join(mgr.root, id, 'inputs', 'dato.txt'), 'utf-8')).toBe('DATO');
    await turn('t2');
    await close();

    c.advance(31 * DAY);
    expect((await janitor.runOnce()).purged).toEqual([id]);
    const afterPurge = await reopen();
    expect(afterPurge.resumed).toBe(true);
    expect(afterPurge.messageCount).toBeGreaterThanOrEqual(4);
    const ws = afterPurge.workspace as WorkspaceStatus;
    expect(ws.state).toBe('active');
    expect(ws.filesExpiredAt).toBe(c.now().toISOString());
    expect(existsSync(join(mgr.root, id, 'inputs', 'dato.txt'))).toBe(false);
    await turn('t3');
    // El prompt avisa al agente de que los ficheros anteriores ya no existen.
    const system = provider.requests.at(-1)?.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('Files from earlier in this conversation were deleted');
    const firstSystem = provider.requests[0]?.messages.find((m) => m.role === 'system');
    expect(firstSystem?.content).not.toContain('were deleted');
  });

  it('una conversación con turno en curso nunca se comprime', async () => {
    const { mgr, clock: c, janitor } = managerWith();
    const { host, frames, waitFor } = hostWith(new HangingProvider(), mgr);
    const id = cid();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'hola' }, 1);
    await waitFor(() => frames.some((f) => f.type === 'agent_event'));
    c.advance(100 * DAY);
    const report = await janitor.runOnce();
    expect(report.inUse).toEqual([id]);
    expect(existsSync(join(mgr.root, id))).toBe(true);
    // Al cerrar (y terminar el turno) vuelve a estar a merced de la retención.
    host.handle({ type: 'close_conversation', conversationId: id }, 1);
    await waitFor(() => !mgr.isInUse(id));
    // El turno que termina también cuenta como uso: hace falta otro plazo entero.
    c.advance(31 * DAY);
    expect((await janitor.runOnce()).purged).toEqual([id]);
  });

  it('workspace_pin fija la conversación y anuncia el estado sin purgeAt', async () => {
    const { mgr, clock: c, janitor } = managerWith();
    const { host, frames, waitFor } = hostWith(new RecordingProvider([]), mgr);
    const id = cid();
    const frame = parseInboundFrame(
      JSON.stringify({ type: 'workspace_pin', conversationId: id, pinned: true }),
    );
    expect(frame).not.toBeNull();
    expect(
      parseInboundFrame(JSON.stringify({ type: 'workspace_pin', conversationId: id, pinned: 1 })),
    ).toBeNull();
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    host.handle(frame as never, 1);
    await waitFor(() => frames.some((f) => f.type === 'workspace_status'));
    expect(frames.find((f) => f.type === 'workspace_status')).toMatchObject({
      status: { pinned: true, purgeAt: null },
    });
    host.handle({ type: 'close_conversation', conversationId: id }, 1);
    await waitFor(() => !mgr.isInUse(id));
    c.advance(400 * DAY);
    const report = await janitor.runOnce();
    expect(report.archived).toEqual([]);
    expect(report.purged).toEqual([]);
  });

  it('un archivo corrupto no impide abrir la conversación (sin ficheros y con aviso)', async () => {
    const { mgr, clock: c, janitor } = managerWith();
    const id = cid();
    const ws = mgr.open(id);
    populate(ws.dir);
    c.advance(8 * DAY);
    await janitor.runOnce();
    writeFileSync(mgr.archivePath(id), 'no es un gzip');
    const { host, frames, opened } = hostWith(new RecordingProvider([]), mgr);
    host.handle({ type: 'new_conversation', conversationId: id }, 1);
    await host.idle();
    expect(frames.some((f) => f.type === 'conversation_error')).toBe(true);
    expect(opened(id)).toHaveLength(1);
    expect(opened(id)[0]!.workspace).toBeUndefined();
    // El archivo sigue ahí: no se pierde nada por un fallo de lectura.
    expect(existsSync(mgr.archivePath(id))).toBe(true);
    expect(mgr.isInUse(id)).toBe(false);
  });
});
