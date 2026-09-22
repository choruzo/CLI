import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, parse } from 'path';
import {
  WORKSPACE_META_FILE,
  WorkspaceManager,
  resolveWorkspaceSettings,
  type WorkspaceMeta,
} from './workspace.js';
import { ConversationHost } from './conversation-host.js';
import { composeUserMessage } from './conversation.js';
import { DesktopSessionStore } from './session-store.js';
import { buildAssistantConfig } from './assistant-runtime.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { parseInboundFrame } from './codec.js';
import type { CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import type { ConversationOutboundFrame } from './protocol.js';

const base = mkdtempSync(join(tmpdir(), 'stratum-desktop-ws-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const IDS = [
  '0b5b2c7e-5c1a-4f7e-8d3a-000000000001',
  '0b5b2c7e-5c1a-4f7e-8d3a-000000000002',
  '0b5b2c7e-5c1a-4f7e-8d3a-000000000003',
  '0b5b2c7e-5c1a-4f7e-8d3a-000000000004',
];

let n = 0;
function manager(): WorkspaceManager {
  return new WorkspaceManager({
    root: join(base, `root${++n}`),
    maxFileBytes: 1024,
    maxWorkspaceBytes: 4096,
  });
}

describe('resolveWorkspaceSettings', () => {
  const home = join(base, 'home');
  const dataDir = join(home, '.stratum', 'desktop');
  const cfg = (workspaces: Record<string, unknown>) =>
    StratumConfigSchema.parse({ desktop: { workspaces } });

  it('por defecto: <datos>/workspaces con 25 MB / 250 MB', () => {
    const { settings, warning } = resolveWorkspaceSettings(cfg({}), dataDir, home);
    expect(settings.root).toBe(join(dataDir, 'workspaces'));
    expect(settings.maxFileBytes).toBe(25 * 1024 * 1024);
    expect(settings.maxWorkspaceBytes).toBe(250 * 1024 * 1024);
    expect(warning).toBeNull();
  });

  it('admite cualquier ruta absoluta y expande ~/', () => {
    const other = join(base, 'otro-disco', 'ws');
    expect(resolveWorkspaceSettings(cfg({ root: other }), dataDir, home).settings.root).toBe(other);
    expect(
      resolveWorkspaceSettings(cfg({ root: '~/Stratum/ws' }), dataDir, home).settings.root,
    ).toBe(join(home, 'Stratum', 'ws'));
  });

  it.each([
    ['relativa', 'workspaces'],
    ['la raíz de una unidad', parse(base).root],
    ['el propio home', '~'],
  ])('rechaza %s y usa el default con aviso', (_label, root) => {
    const { settings, warning } = resolveWorkspaceSettings(cfg({ root }), dataDir, home);
    expect(settings.root).toBe(join(dataDir, 'workspaces'));
    expect(warning).toContain('no es válida');
  });

  it('rechaza un ancestro del home', () => {
    const { warning } = resolveWorkspaceSettings(cfg({ root: base }), dataDir, home);
    expect(warning).toContain('home');
  });

  it('el schema exige maxWorkspaceMB >= maxFileMB', () => {
    expect(() => cfg({ maxFileMB: 100, maxWorkspaceMB: 10 })).toThrow();
  });
});

describe('WorkspaceManager', () => {
  it('crea inputs/, outputs/, scratch/ y .workspace.json', () => {
    const ws = manager().open(IDS[0]!);
    for (const d of ['inputs', 'outputs', 'scratch'])
      expect(existsSync(join(ws.dir, d))).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(ws.dir, WORKSPACE_META_FILE), 'utf-8'),
    ) as WorkspaceMeta;
    expect(meta).toMatchObject({
      conversationId: IDS[0],
      state: 'active',
      pinned: false,
      version: 1,
    });
  });

  it('rechaza un id que no es UUID (viene del webview)', () => {
    expect(() => manager().open('../../etc')).toThrow(/inválido/);
  });

  it('reabrir conserva createdAt y fijado, y touch actualiza último uso y tamaño', () => {
    let now = new Date('2026-09-01T10:00:00Z');
    const mgr = new WorkspaceManager(
      { root: join(base, `root${++n}`), maxFileBytes: 1, maxWorkspaceBytes: 1 },
      () => now,
    );
    const first = mgr.open(IDS[1]!);
    const metaPath = join(first.dir, WORKSPACE_META_FILE);
    const saved = JSON.parse(readFileSync(metaPath, 'utf-8')) as WorkspaceMeta;
    writeFileSync(metaPath, JSON.stringify({ ...saved, pinned: true }));
    writeFileSync(join(first.dir, 'inputs', 'a.txt'), 'x'.repeat(100));
    now = new Date('2026-09-05T10:00:00Z');
    const again = mgr.open(IDS[1]!);
    expect(again.getMeta()).toMatchObject({
      createdAt: '2026-09-01T10:00:00.000Z',
      lastUsedAt: '2026-09-05T10:00:00.000Z',
      pinned: true,
      sizeBytes: 100,
    });
  });

  it('el tamaño no sigue enlaces que salen del workspace', () => {
    const ws = manager().open(IDS[2]!);
    const outside = join(base, 'fuera-grande');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'big.bin'), Buffer.alloc(50_000));
    symlinkSync(
      outside,
      join(ws.dir, 'scratch', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(ws.sizeBytes()).toBe(0);
  });

  it('changedOutputs devuelve los ficheros nuevos o modificados de outputs/', () => {
    const ws = manager().open(IDS[3]!);
    writeFileSync(join(ws.dir, 'outputs', 'viejo.md'), 'v1');
    const before = ws.snapshotOutputs();
    writeFileSync(join(ws.dir, 'outputs', 'nuevo.csv'), 'a,b');
    mkdirSync(join(ws.dir, 'outputs', 'sub'));
    writeFileSync(join(ws.dir, 'outputs', 'sub', 'hondo.txt'), 'x');
    writeFileSync(join(ws.dir, 'scratch', 'nota.txt'), 'no se anuncia');
    const changed = ws
      .changedOutputs(before)
      .map((f) => f.path)
      .sort();
    expect(changed).toEqual(['outputs/nuevo.csv', 'outputs/sub/hondo.txt']);
    // Modificar uno existente también cuenta.
    const t = new Date(Date.now() + 5_000);
    writeFileSync(join(ws.dir, 'outputs', 'viejo.md'), 'v2 más largo');
    utimesSync(join(ws.dir, 'outputs', 'viejo.md'), t, t);
    const csv = ws.changedOutputs(before).find((f) => f.name === 'nuevo.csv');
    expect(csv).toMatchObject({ mime: 'text/csv', size: 3 });
    expect(ws.changedOutputs(before).map((f) => f.path)).toContain('outputs/viejo.md');
  });

  it('checkAttachment solo acepta ficheros de inputs/ dentro del workspace', () => {
    const ws = manager().open(IDS[0]!);
    writeFileSync(join(ws.dir, 'inputs', 'datos.csv'), 'a,b');
    writeFileSync(join(ws.dir, 'outputs', 'o.txt'), 'x');
    expect(ws.checkAttachment('inputs/datos.csv')).toMatchObject({ ok: true, size: 3 });
    expect(ws.checkAttachment('inputs/no-existe.csv').ok).toBe(false);
    expect(ws.checkAttachment('outputs/o.txt').ok).toBe(false);
    expect(ws.checkAttachment('inputs/../outputs/o.txt').ok).toBe(false);
    expect(ws.checkAttachment('inputs/../../../x').ok).toBe(false);
    expect(ws.checkAttachment('inputs').ok).toBe(false);
  });

});

describe('composeUserMessage', () => {
  it('antepone el bloque de adjuntos con rutas del workspace, nunca rutas del disco', () => {
    const msg = composeUserMessage('Resúmelo', [
      { path: 'inputs/ventas.csv', size: 2048, mime: 'text/csv' },
    ]);
    expect(msg).toContain('<attachments>');
    expect(msg).toContain('- inputs/ventas.csv (text/csv, 2.0 KB)');
    expect(msg.endsWith('Resúmelo')).toBe(true);
    expect(composeUserMessage('hola', [])).toBe('hola');
  });
});

describe('codec — chat con adjuntos', () => {
  const conversationId = IDS[0]!;
  it('admite adjuntos y un texto vacío solo si hay adjuntos', () => {
    expect(
      parseInboundFrame(
        JSON.stringify({
          type: 'chat',
          conversationId,
          turnId: 't',
          text: '',
          attachments: ['inputs/a'],
        }),
      ),
    ).not.toBeNull();
    expect(
      parseInboundFrame(JSON.stringify({ type: 'chat', conversationId, turnId: 't', text: '  ' })),
    ).toBeNull();
    expect(
      parseInboundFrame(
        JSON.stringify({
          type: 'chat',
          conversationId,
          turnId: 't',
          text: 'x',
          attachments: Array.from({ length: 21 }, (_, i) => `inputs/${i}`),
        }),
      ),
    ).toBeNull();
  });

  it('workspace_touch es una trama válida para el sidecar', () => {
    expect(parseInboundFrame(JSON.stringify({ type: 'workspace_touch', conversationId }))).toEqual({
      type: 'workspace_touch',
      conversationId,
    });
  });
});

// ---------------------------------------------------------------------------
// Flujo completo por el host
// ---------------------------------------------------------------------------

class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push({ ...req, messages: [...req.messages] });
    return super.complete(req);
  }
}

function hostWith(provider: MockProvider, workspaces: WorkspaceManager) {
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
    workspaces,
  });
  host.attach(1, (f) => frames.push(f));
  const waitFor = async (pred: () => boolean) => {
    const deadline = Date.now() + 3_000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(JSON.stringify(frames.map((f) => f.type)));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { host, frames, waitFor };
}

describe('conversación con workspace', () => {
  it('sube un csv, el agente lo lee, deja un derivado en outputs/ y se anuncia', async () => {
    const workspaces = manager();
    const conversationId = IDS[0]!;
    const provider = new RecordingProvider([
      makeToolCallRound('r1', 'read_file', { path: 'inputs/ventas.csv' }),
      makeToolCallRound('w1', 'write_file', {
        path: 'outputs/resumen.csv',
        content: 'mes,total\nenero,30\n',
      }),
      makeTextRound('Listo: outputs/resumen.csv'),
    ]);
    const { host, frames, waitFor } = hostWith(provider, workspaces);
    host.handle({ type: 'new_conversation', conversationId }, 1);
    await host.idle();
    // Lo que haría Rust: copiar la subida en inputs/ y avisar.
    const dir = join(workspaces.root, conversationId);
    const original = 'mes,total\nenero,10\nenero,20\n';
    writeFileSync(join(dir, 'inputs', 'ventas.csv'), original);
    host.handle({ type: 'workspace_touch', conversationId }, 1);
    host.handle(
      {
        type: 'chat',
        conversationId,
        turnId: 't1',
        text: 'Resume por mes',
        attachments: ['inputs/ventas.csv'],
      },
      1,
    );
    await waitFor(() => frames.some((f) => f.type === 'turn_ended'));

    const userMsg = provider.requests[0]?.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('inputs/ventas.csv');
    expect(userMsg?.content).not.toContain(base);
    const offered = (provider.requests[0]?.tools ?? []).map((t) => t.function.name);
    expect(offered).toContain('read_file');
    expect(offered).not.toContain('exec');

    const files = frames.find((f) => f.type === 'workspace_files');
    expect(files).toMatchObject({
      turnId: 't1',
      files: [{ path: 'outputs/resumen.csv', name: 'resumen.csv', mime: 'text/csv' }],
    });
    // Llega antes que el `turn_ended`.
    expect(frames.findIndex((f) => f.type === 'workspace_files')).toBeLessThan(
      frames.findIndex((f) => f.type === 'turn_ended'),
    );
    expect(readFileSync(join(dir, 'inputs', 'ventas.csv'), 'utf-8')).toBe(original);
  });

  it('un adjunto fuera de inputs/ o inexistente rechaza el chat sin llamar al modelo', async () => {
    const provider = new RecordingProvider([makeTextRound('no debería')]);
    const { host, frames } = hostWith(provider, manager());
    const conversationId = IDS[1]!;
    host.handle({ type: 'new_conversation', conversationId }, 1);
    for (const path of ['inputs/fantasma.pdf', '../../secreto', 'outputs/x']) {
      host.handle(
        { type: 'chat', conversationId, turnId: path, text: 'mira', attachments: [path] },
        1,
      );
    }
    await host.idle();
    const rejected = frames.filter((f) => f.type === 'chat_rejected');
    expect(rejected).toHaveLength(3);
    expect(rejected.every((f) => f.type === 'chat_rejected' && f.reason === 'bad_attachment')).toBe(
      true,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it('dos conversaciones no ven los ficheros de la otra', async () => {
    const workspaces = manager();
    const [a, b] = [IDS[2]!, IDS[3]!];
    const provider = new RecordingProvider([
      makeToolCallRound('r1', 'read_file', { path: `../${a}/inputs/privado.txt` }),
      makeToolCallRound('r2', 'list_directory', { path: `../${a}` }),
      makeTextRound('no puedo'),
    ]);
    const { host, frames, waitFor } = hostWith(provider, workspaces);
    host.handle({ type: 'new_conversation', conversationId: a }, 1);
    host.handle({ type: 'new_conversation', conversationId: b }, 1);
    await host.idle();
    writeFileSync(join(workspaces.root, a, 'inputs', 'privado.txt'), 'SOLO-DE-A');
    // B tampoco puede adjuntar un fichero de A.
    host.handle(
      {
        type: 'chat',
        conversationId: b,
        turnId: 'robo',
        text: 'x',
        attachments: [`inputs/../../${a}/inputs/privado.txt`],
      },
      1,
    );
    host.handle({ type: 'chat', conversationId: b, turnId: 't', text: 'lee lo de A' }, 1);
    await waitFor(() => frames.some((f) => f.type === 'turn_ended'));
    expect(frames.find((f) => f.type === 'chat_rejected')).toMatchObject({ turnId: 'robo' });
    const errors = frames.filter((f) => f.type === 'agent_event' && f.event.type === 'tool_error');
    expect(errors).toHaveLength(2);
    expect(JSON.stringify(frames)).not.toContain('SOLO-DE-A');
  });
});
