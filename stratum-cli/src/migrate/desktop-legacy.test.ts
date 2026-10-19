/**
 * M12 — migración única de las conversaciones de Stratum Desktop D1–D7 a
 * sesiones normales de `stratumd`, por el camino oficial del traspaso (M10).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTextRound } from '../providers/mock.js';
import { ProviderRouter } from '../providers/router.js';
import { fileDiscovery } from '../client/discovery.js';
import {
  ScriptedProvider,
  idleAgain,
  startTestDaemon,
  testConfig,
  watch,
  type TestDaemon,
} from '../daemon/daemon.fixtures.js';
import {
  LEGACY_IMPORT_VERSION,
  discoverLegacyConversations,
  legacyTranscriptToChat,
  readImportState,
  writeImportState,
  type LegacyTurn,
} from './desktop-legacy.js';
import { importConversation } from './desktop-import.js';

const CID = '98694c97-e7cb-4af7-ac03-178d665bf810';
const OTHER = '0b5b2c7e-5c1a-4f7e-8d3a-000000000001';

const turns: LegacyTurn[] = [
  {
    turnId: 't1',
    user: {
      text: 'Mi fruta es kiwi',
      attachments: [{ path: 'inputs/lista.txt', name: 'lista.txt' }],
    },
    parts: [
      { kind: 'reasoning', text: 'pienso' },
      { kind: 'tool', id: 'c1' },
      { kind: 'text', text: 'Anotado: kiwi.' },
    ],
    toolCalls: {
      c1: { id: 'c1', name: 'read_file', state: 'completed', input: 'inputs/lista.txt' },
    },
    status: 'done',
    startedAt: '2026-09-22T10:00:00.000Z',
  },
  {
    turnId: 't2',
    user: { text: 'otra cosa con sk-proj-AbCdEf0123456789XyZ_abc' },
    parts: [{ kind: 'notice', tone: 'error', text: 'sin modelo' }],
    toolCalls: {},
    status: 'error',
    startedAt: '2026-09-22T10:01:00.000Z',
  },
];

function legacySession(id: string, messages: Array<{ role: string; content: string }>) {
  return {
    schemaVersion: 1,
    id,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:02:00.000Z',
    provider: 'local',
    model: 'gemma',
    project: '',
    messages,
    toolCallCount: 1,
    summary: '',
  };
}

function seedDesktop(
  desktopDir: string,
  id: string,
  opts: { record?: boolean; session?: unknown } = {},
) {
  mkdirSync(join(desktopDir, 'sessions'), { recursive: true });
  mkdirSync(join(desktopDir, 'conversations'), { recursive: true });
  writeFileSync(
    join(desktopDir, 'sessions', `${id}.json`),
    JSON.stringify(
      opts.session ??
        legacySession(id, [
          { role: 'system', content: 'prompt de código antiguo' },
          { role: 'user', content: 'Mi fruta es kiwi' },
          { role: 'assistant', content: 'Anotado: kiwi.' },
        ]),
    ),
  );
  if (opts.record !== false) {
    writeFileSync(
      join(desktopDir, 'conversations', `${id}.json`),
      JSON.stringify({
        version: 1,
        conversationId: id,
        title: 'La fruta',
        titleEdited: true,
        createdAt: '2026-09-22T10:00:00.000Z',
        updatedAt: '2026-09-22T10:02:00.000Z',
        provider: 'local',
        model: 'gemma',
        transcript: turns,
      }),
    );
  }
}

describe('legacyTranscriptToChat: lo que pintaba Desktop, como la conversación del protocolo', () => {
  it('usuario (con sus adjuntos), tools, texto y cómo acabó; sin el razonamiento', () => {
    const chat = legacyTranscriptToChat(turns);
    expect(chat.map((m) => `${m.id}:${m.kind}`)).toEqual([
      'm1:user',
      'm2:tool',
      'm3:assistant',
      'm4:user',
      'm5:outcome',
    ]);
    expect(chat[0]).toMatchObject({
      text: 'Mi fruta es kiwi\n\n- inputs/lista.txt',
      runId: 'imported-t1',
    });
    expect(chat[1]).toMatchObject({ callId: 'c1', name: 'read_file', state: 'completed' });
    expect(chat[4]).toMatchObject({ status: 'failed', text: 'sin modelo' });
    expect(JSON.stringify(chat)).not.toContain('pienso');
  });
});

describe('discoverLegacyConversations', () => {
  let t: TestDaemon | null = null;
  afterEach(async () => {
    await t?.stop();
    t = null;
  });

  it('encuentra lo pendiente, salta lo dañado y lo ya migrado, y no toca nada', async () => {
    t = await startTestDaemon();
    const desktopDir = join(t.base, 'desktop');
    const root = join(desktopDir, 'workspaces');
    seedDesktop(desktopDir, CID);
    seedDesktop(desktopDir, OTHER, { session: { roto: true } });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${CID}.tar.gz`), 'x');
    const before = readFileSync(join(desktopDir, 'sessions', `${CID}.json`), 'utf-8');

    const state = readImportState(desktopDir);
    expect(state).toEqual({ version: LEGACY_IMPORT_VERSION, conversations: {} });
    const found = discoverLegacyConversations({ desktopDir, workspacesRoot: root, state });
    expect(found.conversations.map((c) => c.conversationId)).toEqual([CID]);
    expect(found.conversations[0]).toMatchObject({
      title: 'La fruta',
      archived: true,
      folderExists: false,
    });
    expect(found.skipped.map((s) => s.conversationId)).toEqual([OTHER]);
    expect(readFileSync(join(desktopDir, 'sessions', `${CID}.json`), 'utf-8')).toBe(before);

    // Lo anotado no se vuelve a ofrecer; una versión más nueva del registro no se toca.
    writeImportState(desktopDir, {
      version: 1,
      conversations: { [CID]: { status: 'imported', sessionId: 's', at: 'x' } },
    });
    expect(
      discoverLegacyConversations({
        desktopDir,
        workspacesRoot: root,
        state: readImportState(desktopDir),
      }).conversations,
    ).toEqual([]);
    writeFileSync(
      join(desktopDir, 'imported.json'),
      JSON.stringify({ version: 99, conversations: {} }),
    );
    expect(() => readImportState(desktopDir)).toThrow(/más nuevo/);
  });
});

describe('importConversation: el traspaso de M10, sin terminal', () => {
  let t: TestDaemon | null = null;
  afterEach(async () => {
    await t?.stop();
    t = null;
  });

  it('la conversación pasa a ser una sesión del daemon: asistente, origen Desktop, su conversación y su contexto', async () => {
    t = await startTestDaemon({ sessionsDir: null });
    const desktopDir = join(t.base, 'desktop');
    seedDesktop(desktopDir, CID);
    // Su carpeta de siempre es el directorio de la sesión (aquí, un proyecto del daemon de pruebas).
    const folder = t.project(CID, [makeTextRound('Me dijiste: kiwi.')]);
    const [conv] = discoverLegacyConversations({
      desktopDir,
      workspacesRoot: join(folder, '..'),
      state: readImportState(desktopDir),
    }).conversations;
    expect(conv?.folder).toBe(folder);

    const local = new ScriptedProvider([]);
    const outcome = await importConversation(conv!, {
      version: '0.0.0-test',
      discovery: fileDiscovery({ dir: t.dir }),
      assistantData: { dir: join(t.base, 'assistant'), legacyMemoryDir: null },
      startup: async () => {
        const config = testConfig(t!.base);
        const router = new ProviderRouter(config);
        router.getActive = () => local;
        return { ok: true, config, router };
      },
    });
    expect(outcome.status).toBe('imported');
    if (outcome.status !== 'imported') return;
    // Nada se ejecutó en la importación: solo se montó para entregarla.
    expect(local.calls).toBe(0);
    for (const sub of ['inputs', 'outputs', 'scratch'])
      expect(existsSync(join(folder, sub))).toBe(true);

    const desktop = await t.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    const { snapshot } = await desktop.request('sessions.get', { sessionId: outcome.sessionId });
    expect(snapshot.session).toMatchObject({
      origin: 'desktop',
      agent: 'assistant',
      title: 'La fruta',
      cwd: folder,
      host: { kind: 'daemon' },
    });
    expect(snapshot.messages.map((m) => m.kind)).toEqual([
      'user',
      'tool',
      'assistant',
      'user',
      'outcome',
    ]);
    // Lo importado se redacta como todo lo que se publica: el secreto no llega a nadie.
    expect(JSON.stringify(snapshot)).not.toContain('sk-proj-AbCdEf0123456789XyZ_abc');

    // Se continúa con el contexto que tenía el agente en Desktop.
    const live = watch(desktop, outcome.sessionId);
    await live.untilSnapshot();
    await desktop.request('runs.start', { sessionId: outcome.sessionId, input: '¿Qué fruta?' });
    await live.until(idleAgain);
    expect(t.provider(folder).userInputs.at(-1)).toEqual(
      expect.arrayContaining(['Mi fruta es kiwi', '¿Qué fruta?']),
    );
    // El system prompt es el del asistente, no el de código que traía guardado.
    expect(t.provider(folder).systemPrompts.at(-1)).not.toContain('prompt de código antiguo');
    // Lo nuevo no pisa los ids de lo importado.
    const after = (await desktop.request('sessions.get', { sessionId: outcome.sessionId }))
      .snapshot;
    const ids = after.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
