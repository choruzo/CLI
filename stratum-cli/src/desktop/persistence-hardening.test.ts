import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConversationHost } from './conversation-host.js';
import { DesktopConversationStore } from './conversation-store.js';
import { DesktopSessionStore } from './session-store.js';
import { WorkspaceManager, WORKSPACE_META_FILE } from './workspace.js';
import { buildAssistantConfig } from './assistant-runtime.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { SessionCorruptError } from '../session/store.js';
import { SchemaVersionError } from '../config/schema-version.js';
import type { ConversationOutboundFrame } from './protocol.js';

/**
 * Lo que el sidecar no puede leer nunca se abre encima: una sesión o un
 * registro dañados se apartan a `.corrupt-<fecha>`, y uno de un Stratum más
 * nuevo ni se abre ni se toca.
 */

const root = mkdtempSync(join(tmpdir(), 'stratum-desktop-persist-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
    memory: { globalFile: join(root, 'none', 'STRATUM.md'), autoExtract: false },
  }),
  join(root, 'data'),
);

let seq = 0;
function setup(opts: { workspaces?: WorkspaceManager } = {}) {
  const dir = join(root, `case-${++seq}`);
  const sessionsDir = join(dir, 'sessions');
  const recordsDir = join(dir, 'conversations');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(recordsDir, { recursive: true });
  const store = new DesktopSessionStore(sessionsDir);
  const records = new DesktopConversationStore(recordsDir, store);
  const frames: ConversationOutboundFrame[] = [];
  const host = new ConversationHost({
    config,
    store,
    records,
    workspaces: opts.workspaces,
    makeRouter: () => {
      const router = new ProviderRouter(config);
      vi.spyOn(router, 'getActive').mockReturnValue(new MockProvider([]));
      return router;
    },
  });
  host.attach(1, (f) => frames.push(f));
  const id = `6f1c1c0e-3d2a-4b8e-9c1d-${seq.toString(16).padStart(12, '0')}`;
  return {
    host,
    frames,
    store,
    records,
    id,
    sessionPath: join(sessionsDir, `${id}.json`),
    recordPath: join(recordsDir, `${id}.json`),
    asideIn: (d: 'sessions' | 'conversations') =>
      readdirSync(join(dir, d)).filter((f) => f.startsWith(`${id}.json.corrupt-`)),
    dirOf: (d: 'sessions' | 'conversations') => join(dir, d),
  };
}

function sessionJson(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    provider: 'test',
    model: 'test-model',
    project: '',
    messages: [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: '¡Hola!' },
    ],
    toolCallCount: 0,
    summary: '',
    ...extra,
  });
}

function recordJson(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    conversationId: id,
    title: 'Mi título editado',
    titleEdited: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    provider: 'test',
    model: 'test-model',
    transcript: [
      {
        turnId: 't1',
        user: { text: 'hola' },
        parts: [{ kind: 'text', text: '¡Hola!' }],
        toolCalls: {},
        status: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...extra,
  });
}

async function openAndClose(h: ReturnType<typeof setup>): Promise<void> {
  h.host.handle({ type: 'new_conversation', conversationId: h.id, resume: true }, 1);
  await h.host.idle();
  await h.host.closeAll();
}

describe('DesktopSessionStore.load valida como la CLI', () => {
  it('JSON roto → SessionCorruptError', () => {
    const h = setup();
    writeFileSync(h.sessionPath, '{"id":');
    expect(() => h.store.load(h.id)).toThrow(SessionCorruptError);
  });

  it('forma inválida (rol desconocido) → SessionCorruptError', () => {
    const h = setup();
    writeFileSync(
      h.sessionPath,
      sessionJson(h.id, { messages: [{ role: 'robot', content: 'x' }] }),
    );
    expect(() => h.store.load(h.id)).toThrow(SessionCorruptError);
  });

  it('el fichero es de otra conversación → SessionCorruptError', () => {
    const h = setup();
    writeFileSync(h.sessionPath, sessionJson('6f1c1c0e-3d2a-4b8e-9c1d-ffffffffffff'));
    expect(() => h.store.load(h.id)).toThrow(SessionCorruptError);
  });

  it('schemaVersion mayor → SchemaVersionError', () => {
    const h = setup();
    writeFileSync(h.sessionPath, sessionJson(h.id, { schemaVersion: 99 }));
    expect(() => h.store.load(h.id)).toThrow(SchemaVersionError);
  });
});

describe('abrir una conversación ilegible no la pisa', () => {
  it('sesión dañada: se aparta intacta, el registro visible se conserva y se avisa', async () => {
    const h = setup();
    const broken =
      '{"schemaVersion":1,"id":"' + h.id + '","messages":[{"role":"user","content":"ho';
    writeFileSync(h.sessionPath, broken);
    writeFileSync(h.recordPath, recordJson(h.id));

    await openAndClose(h);

    const aside = h.asideIn('sessions');
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(h.dirOf('sessions'), aside[0]), 'utf-8')).toBe(broken);
    const opened = h.frames.find((f) => f.type === 'conversation_opened');
    expect(opened).toMatchObject({ title: 'Mi título editado' });
    expect(opened && 'transcript' in opened ? opened.transcript : []).toHaveLength(1);
    expect(h.frames).toContainEqual(
      expect.objectContaining({ type: 'conversation_notice', tone: 'warning' }),
    );
    // El registro sigue con su título y su turno tras el cierre.
    const record = JSON.parse(readFileSync(h.recordPath, 'utf-8'));
    expect(record.title).toBe('Mi título editado');
    expect(record.transcript).toHaveLength(1);
  });

  it('sesión de un Stratum más nuevo: no se abre y los ficheros no cambian', async () => {
    const h = setup();
    const newer = sessionJson(h.id, { schemaVersion: 99 });
    const record = recordJson(h.id);
    writeFileSync(h.sessionPath, newer);
    writeFileSync(h.recordPath, record);

    await openAndClose(h);

    expect(h.frames.some((f) => f.type === 'conversation_opened')).toBe(false);
    expect(h.frames).toContainEqual(
      expect.objectContaining({ type: 'conversation_error', conversationId: h.id }),
    );
    expect(h.host.size).toBe(0);
    expect(readFileSync(h.sessionPath, 'utf-8')).toBe(newer);
    expect(readFileSync(h.recordPath, 'utf-8')).toBe(record);
  });

  it('registro de un Stratum más nuevo: no se abre y no se toca', async () => {
    const h = setup();
    const session = sessionJson(h.id);
    const record = recordJson(h.id, { version: 99 });
    writeFileSync(h.sessionPath, session);
    writeFileSync(h.recordPath, record);

    await openAndClose(h);

    expect(h.frames.some((f) => f.type === 'conversation_opened')).toBe(false);
    expect(readFileSync(h.sessionPath, 'utf-8')).toBe(session);
    expect(readFileSync(h.recordPath, 'utf-8')).toBe(record);
  });

  it('registro dañado con sesión sana: se aparta y se deriva de la sesión', async () => {
    const h = setup();
    writeFileSync(h.sessionPath, sessionJson(h.id));
    writeFileSync(h.recordPath, 'no es json');

    await openAndClose(h);

    expect(h.asideIn('conversations')).toHaveLength(1);
    const opened = h.frames.find((f) => f.type === 'conversation_opened');
    expect(opened).toMatchObject({ resumed: true, messageCount: 2 });
    expect(h.frames).toContainEqual(
      expect.objectContaining({ type: 'conversation_notice', tone: 'warning' }),
    );
  });

  it('un turno guardado con forma inválida cuenta como registro dañado', async () => {
    const h = setup();
    writeFileSync(h.sessionPath, sessionJson(h.id));
    writeFileSync(h.recordPath, recordJson(h.id, { transcript: [42] }));

    await openAndClose(h);

    expect(h.asideIn('conversations')).toHaveLength(1);
  });
});

describe('el listado avisa de lo que no puede leer', () => {
  it('las ilegibles salen en `unreadable` y listar no mueve ni reescribe nada', () => {
    const corrupt = setup();
    writeFileSync(corrupt.sessionPath, '{roto');
    const newer = setup();
    writeFileSync(newer.sessionPath, sessionJson(newer.id, { schemaVersion: 99 }));

    for (const h of [corrupt, newer]) {
      h.host.handle({ type: 'list_conversations' }, 1);
    }
    return Promise.all([corrupt.host.idle(), newer.host.idle()]).then(() => {
      const listOf = (h: ReturnType<typeof setup>) =>
        h.frames.find((f) => f.type === 'conversations');
      expect(listOf(corrupt)).toEqual({
        type: 'conversations',
        items: [],
        unreadable: [{ conversationId: corrupt.id, reason: 'corrupt' }],
      });
      expect(listOf(newer)).toEqual({
        type: 'conversations',
        items: [],
        unreadable: [{ conversationId: newer.id, reason: 'newer' }],
      });
      expect(readFileSync(corrupt.sessionPath, 'utf-8')).toBe('{roto');
      expect(corrupt.asideIn('sessions')).toHaveLength(0);
    });
  });

  it('sin ilegibles no manda el campo', async () => {
    const h = setup();
    writeFileSync(h.sessionPath, sessionJson(h.id));
    h.host.handle({ type: 'list_conversations' }, 1);
    await h.host.idle();
    const list = h.frames.find((f) => f.type === 'conversations');
    expect(list).not.toHaveProperty('unreadable');
    expect(list && 'items' in list ? list.items : []).toHaveLength(1);
  });

  it('renombrar una cerrada con registro dañado lo aparta antes de escribir', async () => {
    const h = setup();
    writeFileSync(h.sessionPath, sessionJson(h.id));
    writeFileSync(h.recordPath, '{roto');
    h.host.handle({ type: 'rename_conversation', conversationId: h.id, title: 'Nuevo' }, 1);
    await h.host.idle();
    const aside = h.asideIn('conversations');
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(h.dirOf('conversations'), aside[0]), 'utf-8')).toBe('{roto');
    expect(JSON.parse(readFileSync(h.recordPath, 'utf-8')).title).toBe('Nuevo');
  });
});

describe('metadatos de workspace ilegibles', () => {
  it('se regeneran fijados: la retención no puede borrar lo que quizá estaba fijado', async () => {
    const wsRoot = join(root, `ws-${++seq}`);
    const manager = new WorkspaceManager({
      root: wsRoot,
      maxFileBytes: 1024 * 1024,
      maxWorkspaceBytes: 10 * 1024 * 1024,
      compressAfterMs: 1,
      deleteAfterMs: 2,
    });
    const id = `6f1c1c0e-3d2a-4b8e-9c1d-${seq.toString(16).padStart(12, '0')}`;
    mkdirSync(join(wsRoot, id), { recursive: true });
    writeFileSync(join(wsRoot, id, WORKSPACE_META_FILE), '{roto');

    const { workspace } = await manager.acquire(id);
    expect(workspace.getMeta().pinned).toBe(true);
    manager.release(id);
    expect(existsSync(join(wsRoot, id))).toBe(true);
    expect(manager.statusOf(id)).toMatchObject({ pinned: true, purgeAt: null });
  });

  it('al abrirla, el listado recibe el estado nuevo (visto en la ventana: seguía sin fijar)', async () => {
    const wsRoot = join(root, `ws-${++seq}`);
    const manager = new WorkspaceManager({
      root: wsRoot,
      maxFileBytes: 1024 * 1024,
      maxWorkspaceBytes: 10 * 1024 * 1024,
    });
    const h = setup({ workspaces: manager });
    writeFileSync(h.sessionPath, sessionJson(h.id));
    writeFileSync(h.recordPath, recordJson(h.id));
    mkdirSync(join(wsRoot, h.id), { recursive: true });
    writeFileSync(join(wsRoot, h.id, WORKSPACE_META_FILE), '{roto');

    h.host.handle({ type: 'new_conversation', conversationId: h.id, resume: true }, 1);
    await h.host.idle();

    const updated = h.frames.find((f) => f.type === 'conversation_updated');
    expect(updated).toMatchObject({
      summary: { conversationId: h.id, workspace: { pinned: true } },
    });
    await h.host.closeAll();
  });

  it('una conversación nueva no se anuncia al abrirla', async () => {
    const h = setup();
    h.host.handle({ type: 'new_conversation', conversationId: h.id, resume: true }, 1);
    await h.host.idle();
    expect(h.frames.map((f) => f.type)).toEqual(['conversation_opened']);
    await h.host.closeAll();
  });
});
