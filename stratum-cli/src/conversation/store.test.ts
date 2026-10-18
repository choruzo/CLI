import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProtocolChatMessage } from '../protocol/index.js';
import {
  ConversationFormatError,
  ConversationLockedError,
  FileConversationStore,
  MemoryConversationStore,
  type ConversationStore,
} from './store.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-conv-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SID = 'sess_20261018_abcdef';

function chat(seq: number, text = `mensaje ${seq}`): ProtocolChatMessage {
  return { kind: 'user', id: `m${seq}`, runId: 'run_1', at: seq, text };
}

function exercise(make: () => ConversationStore): void {
  it('añade, lee y cuenta el historial del agente con ids estables', () => {
    const store = make();
    const a = store.appendAgent({ role: 'user', content: 'hola' });
    const b = store.appendAgent({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
    });
    expect([a, b]).toEqual(['e1', 'e2']);
    expect(store.agentCount()).toBe(2);
    expect(store.getAgent('e2')?.message.toolCalls?.[0]?.name).toBe('read_file');
    expect(store.orderOf('e2')).toBe(1);
    expect(store.orderOf('e9')).toBe(-1);
    store.amendAgent('e1', 'hola\n\n<aviso>');
    expect(store.getAgent('e1')?.message.content).toBe('hola\n\n<aviso>');
    store.close();
  });

  it('pagina la conversación hacia atrás, en orden cronológico', () => {
    const store = make();
    for (let i = 1; i <= 25; i++) store.putChat(chat(i));
    expect(store.chatCount()).toBe(25);
    const last = store.listChatBefore(null, 10);
    expect(last.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, k) => `m${16 + k}`),
    );
    expect(last.hasMore).toBe(true);
    const prev = store.listChatBefore('m16', 10);
    expect(prev.messages[0]?.id).toBe('m6');
    const first = store.listChatBefore('m6', 10);
    expect(first.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(first.hasMore).toBe(false);
    expect(store.maxChatSeq()).toBe(25);
    store.close();
  });

  it('una actualización del mismo mensaje no lo duplica (una tool que termina)', () => {
    const store = make();
    const tool = (state: 'running' | 'completed'): ProtocolChatMessage => ({
      kind: 'tool',
      id: 'm3',
      runId: 'r',
      at: 3,
      callId: 'c1',
      name: 'exec',
      description: 'ls',
      state,
    });
    store.putChat(tool('running'));
    store.putChat(tool('completed'));
    expect(store.chatCount()).toBe(1);
    expect(store.getChat('m3')).toMatchObject({ state: 'completed' });
    store.close();
  });
}

describe('MemoryConversationStore', () => {
  exercise(() => new MemoryConversationStore(SID));
});

describe('FileConversationStore', () => {
  exercise(() => FileConversationStore.open(join(tmp(), 'conversation.jsonl'), SID));

  it('sobrevive a cerrar y abrir: mismo contenido, mismos ids, sigue numerando', () => {
    const path = join(tmp(), 'conversation.jsonl');
    const a = FileConversationStore.open(path, SID);
    for (let i = 0; i < 50; i++) a.appendAgent({ role: 'user', content: `turno ${i}` });
    for (let i = 1; i <= 50; i++) a.putChat(chat(i));
    a.amendAgent('e3', 'cambiado');
    a.close();

    const b = FileConversationStore.open(path, SID);
    expect(b.agentCount()).toBe(50);
    expect(b.chatCount()).toBe(50);
    expect(b.getAgent('e3')?.message.content).toBe('cambiado');
    expect(b.getAgent('e50')?.message.content).toBe('turno 49');
    expect(b.appendAgent({ role: 'user', content: 'otro' })).toBe('e51');
    expect(b.skipped).toBe(0);
    b.close();
  });

  it('una última línea a medias (el proceso murió escribiendo) se descarta al abrir', () => {
    const path = join(tmp(), 'conversation.jsonl');
    const a = FileConversationStore.open(path, SID);
    a.appendAgent({ role: 'user', content: 'entera' });
    a.close();
    appendFileSync(path, '{"t":"agent","id":"e2","at":1,"msg":{"role":"user","cont');

    const b = FileConversationStore.open(path, SID);
    expect(b.agentCount()).toBe(1);
    // Lo siguiente se escribe donde acababa lo bueno: el fichero vuelve a ser válido.
    b.appendAgent({ role: 'assistant', content: 'después' });
    b.close();
    const c = FileConversationStore.open(path, SID);
    expect(c.agentIds()).toEqual(['e1', 'e2']);
    expect(c.getAgent('e2')?.message.content).toBe('después');
    expect(c.skipped).toBe(0);
    c.close();
  });

  it('una línea intermedia que no valida se salta y se cuenta, sin reescribir nada', () => {
    const path = join(tmp(), 'conversation.jsonl');
    const a = FileConversationStore.open(path, SID);
    a.appendAgent({ role: 'user', content: 'uno' });
    a.close();
    appendFileSync(path, 'esto no es json\n');
    const before = readFileSync(path, 'utf8');
    const b = FileConversationStore.open(path, SID);
    expect(b.skipped).toBe(1);
    expect(b.agentCount()).toBe(1);
    b.close();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('un fichero de un formato más nuevo no se toca', () => {
    const path = join(tmp(), 'conversation.jsonl');
    const content = `${JSON.stringify({ t: 'header', format: 99, sessionId: SID, createdAt: 1 })}\n`;
    writeFileSync(path, content);
    expect(() => FileConversationStore.open(path, SID)).toThrow(ConversationFormatError);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('un solo escritor: otro proceso vivo con el cerrojo impide abrir; uno muerto no', () => {
    const path = join(tmp(), 'conversation.jsonl');
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 999_999, at: 1 }));
    expect(() => FileConversationStore.open(path, SID, { isAlive: () => true })).toThrow(
      ConversationLockedError,
    );
    const store = FileConversationStore.open(path, SID, { isAlive: () => false });
    store.appendAgent({ role: 'user', content: 'ok' });
    store.close();
  });

  it('abrir en solo lectura no escribe ni toma el cerrojo', () => {
    const path = join(tmp(), 'conversation.jsonl');
    const writer = FileConversationStore.open(path, SID);
    writer.putChat(chat(1));
    writer.flush();
    const reader = FileConversationStore.open(path, SID, { readOnly: true });
    expect(reader.chatCount()).toBe(1);
    expect(() => reader.appendAgent({ role: 'user', content: 'x' })).toThrow();
    reader.close();
    writer.putChat(chat(2));
    writer.close();
  });

  it('no carga los mensajes al abrir: miles de entradas se indexan y se leen bajo demanda', () => {
    const path = join(tmp(), 'conversation.jsonl');
    const a = FileConversationStore.open(path, SID);
    const big = 'x'.repeat(2_000);
    for (let i = 0; i < 3_000; i++)
      a.appendAgent({ role: 'tool', content: big, toolCallId: `c${i}` });
    a.close();
    const b = FileConversationStore.open(path, SID);
    expect(b.agentCount()).toBe(3_000);
    expect(b.getAgent('e1500')?.message.toolCallId).toBe('c1499');
    b.close();
  });
});
