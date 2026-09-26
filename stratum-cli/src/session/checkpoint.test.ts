import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from './store.js';
import { SessionCheckpointer, checkpointMessages } from './checkpoint.js';
import type { Message } from '../agent/types.js';

let dir: string;
let store: SessionStore;
let messages: Message[];

function checkpointer(id: string, expectedUpdatedAt?: string): SessionCheckpointer {
  return new SessionCheckpointer(store, {
    id,
    expectedUpdatedAt,
    snapshot: () => ({
      provider: 'p',
      model: 'm',
      project: dir,
      messages,
      toolCallCount: 0,
    }),
  });
}

function onDisk(id: string): { messages: Message[]; forkedFrom?: string } {
  return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf-8'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-ckpt-'));
  store = new SessionStore(dir);
  messages = [{ role: 'system', content: 'sys' }];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionCheckpointer', () => {
  it('no escribe nada mientras no hay ningún mensaje del usuario', async () => {
    const cp = checkpointer('sess_20260927_120000_abc');
    await cp.checkpoint();
    expect(existsSync(join(dir, 'sess_20260927_120000_abc.json'))).toBe(false);
  });

  it('guarda a mitad de sesión y los checkpoints siguientes no se ven como conflicto', async () => {
    const cp = checkpointer('sess_20260927_120000_abc');
    messages.push({ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hey' });
    await cp.checkpoint();
    expect(onDisk('sess_20260927_120000_abc').messages).toHaveLength(3);

    messages.push({ role: 'user', content: 'otra' }, { role: 'assistant', content: 'vale' });
    await cp.checkpoint();
    const final = await cp.saveFinal();
    // Sin bifurcar: cada guardado parte del updatedAt que escribió el anterior.
    expect(final.id).toBe('sess_20260927_120000_abc');
    expect(final.forkedFrom).toBeUndefined();
    expect(onDisk('sess_20260927_120000_abc').messages).toHaveLength(5);
  });

  it('no guarda un turno a medias: quita tool_calls sin respuesta y el user final', async () => {
    const cp = checkpointer('sess_20260927_120000_abc');
    messages.push(
      { role: 'user', content: 'uno' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'dos' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
    );
    await cp.checkpoint();
    expect(onDisk('sess_20260927_120000_abc').messages).toEqual(messages.slice(0, 3));
  });

  it('si otra terminal guardó la sesión, bifurca una vez y sigue en el fork', async () => {
    messages.push({ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hey' });
    const cp = checkpointer('sess_20260927_120000_abc');
    await cp.checkpoint();

    // Otra terminal reescribe la sesión.
    const other = onDisk('sess_20260927_120000_abc') as Record<string, unknown>;
    writeFileSync(
      join(dir, 'sess_20260927_120000_abc.json'),
      JSON.stringify({ ...other, updatedAt: '2099-01-01T00:00:00.000Z' }),
    );

    messages.push({ role: 'user', content: 'más' }, { role: 'assistant', content: 'sí' });
    await cp.checkpoint();
    const forkId = cp.sessionId;
    expect(forkId).not.toBe('sess_20260927_120000_abc');
    expect(cp.forkedFrom).toBe('sess_20260927_120000_abc');

    messages.push({ role: 'user', content: 'fin' }, { role: 'assistant', content: 'adiós' });
    const final = await cp.saveFinal();
    expect(final.id).toBe(forkId);
    expect(final.forkedFrom).toBe('sess_20260927_120000_abc');
    // La versión de la otra terminal queda intacta.
    expect(onDisk('sess_20260927_120000_abc').messages).toHaveLength(3);
  });

  it('un checkpoint que falla no lanza y el siguiente lo reintenta', async () => {
    messages.push({ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hey' });
    const cp = checkpointer('sess_20260927_120000_abc');
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'no soy un directorio');
    await expect(cp.checkpoint()).resolves.toBeUndefined();
    rmSync(dir, { force: true });
    await cp.checkpoint();
    expect(onDisk('sess_20260927_120000_abc').messages).toHaveLength(3);
  });
});

describe('checkpointMessages', () => {
  it('conserva un historial cerrado', () => {
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ];
    expect(checkpointMessages(msgs)).toEqual(msgs);
  });
});
