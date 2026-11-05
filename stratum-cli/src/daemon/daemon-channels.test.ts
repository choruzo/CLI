/**
 * M18 — el canal de Telegram en el daemon y `channels.*` por el protocolo
 * (`docs/protocol.md` §24): estado sin token, emparejar en dos pasos (código →
 * candidato → `pairConfirm` con `approve`), desemparejar, recargar, y que un
 * canal con alguien emparejado no deja que el daemon se apague solo.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEXT } from '../channels/telegram/render.js';
import {
  TELEGRAM_SCHEMA_VERSION,
  readTelegramFile,
  writeTelegramFile,
  type TelegramPaired,
} from '../channels/telegram/store.js';
import { FakeTelegramApi } from '../channels/telegram/api.fixtures.js';
import type { StratumdOptions } from './daemon.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { startTestDaemon, textRound, type TestDaemon } from './daemon.fixtures.js';
import { fromDot } from '../channels/telegram/render.js';

const TOKEN = `123456789:${'A'.repeat(35)}`;

let running: TestDaemon | null = null;
let base: string | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  if (base) rmSync(base, { recursive: true, force: true });
  base = null;
});

async function start(
  opts: {
    paired?: TelegramPaired[];
    enabled?: { value: boolean };
    file?: boolean;
  } & Partial<StratumdOptions> = {},
): Promise<{ t: TestDaemon; api: FakeTelegramApi; dir: string }> {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-channels-')));
  const dir = join(base, 'daemon');
  if (opts.file !== false) {
    writeTelegramFile(dir, {
      schemaVersion: TELEGRAM_SCHEMA_VERSION,
      token: TOKEN,
      bot: { id: 777, username: 'test_bot' },
      paired: opts.paired ?? [],
      updatedAt: new Date().toISOString(),
    });
  }
  const api = new FakeTelegramApi();
  const enabled = opts.enabled ?? { value: true };
  const { paired: _p, enabled: _e, file: _f, ...rest } = opts;
  running = await startTestDaemon({
    base,
    dir,
    channels: {
      enabled: () => enabled.value,
      api: () => api,
      retry: { initialMs: 5, maxMs: 20 },
      sendIntervalMs: 0,
    },
    ...rest,
  });
  return { t: running, api, dir };
}

describe('channels.* (M18)', () => {
  it('channels.status: el bot y su estado, nunca el token', async () => {
    const { t } = await start();
    const observer = await t.connect(['observer']);
    const status = await observer.request('channels.status', {});
    expect(status.telegram).toMatchObject({
      state: 'running',
      bot: { id: 777, username: 'test_bot' },
      paired: [],
      pairing: null,
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN.split(':')[1]);
  });

  it('emparejar: código → candidato → pairConfirm, que exige approve', async () => {
    const { t, api, dir } = await start();
    const operator = await t.connect(['operator']);
    const begin = await operator.request('channels.pairBegin', {});
    expect(begin.link).toBe(`https://t.me/test_bot?start=${begin.code}`);
    // El código no sale por `status`.
    expect(JSON.stringify(await operator.request('channels.status', {}))).not.toContain(begin.code);

    api.push(api.text({ id: 9, firstName: 'Bea', username: 'bea' }, `/start ${begin.code}`));
    await api.waitSent(1);
    expect(api.sent[0]).toMatchObject({ chatId: 9, text: TEXT.candidate });
    const { telegram } = await operator.request('channels.status', {});
    expect(telegram.pairing?.candidate).toEqual({ userId: 9, name: 'Bea', username: 'bea' });
    // Aún no habla con nadie.
    expect(telegram.paired).toEqual([]);

    // Con `control` no se empareja: da autoridad.
    await expect(operator.request('channels.pairConfirm', { userId: 9 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const approver = await t.connect(['approver']);
    await expect(approver.request('channels.pairConfirm', { userId: 8 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const { paired } = await approver.request('channels.pairConfirm', { userId: 9 });
    expect(paired).toMatchObject({ userId: 9, name: 'Bea', username: 'bea' });
    await api.waitSent(2);
    expect(api.sent[1]).toMatchObject({ chatId: 9, text: TEXT.paired });

    // En disco, y el candidato gastado.
    const file = readTelegramFile(dir);
    expect(file.state === 'ok' && file.file.paired.map((p) => p.userId)).toEqual([9]);
    expect(file.state === 'ok' && file.file.token).toBe(TOKEN);
    await expect(approver.request('channels.pairConfirm', { userId: 9 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await operator.request('channels.status', {})).telegram.pairing).toBeNull();
  });

  it('un emparejado habla; /unpair desde el chat y channels.unpair lo quitan', async () => {
    const bea: TelegramPaired = {
      userId: 9,
      chatId: 9,
      name: 'Bea',
      pairedAt: new Date().toISOString(),
    };
    const ana: TelegramPaired = {
      userId: 42,
      chatId: 42,
      name: 'Ana',
      pairedAt: new Date().toISOString(),
    };
    const { t, api, dir } = await start({ paired: [bea, ana] });
    const operator = await t.connect(['operator']);
    expect((await operator.request('channels.unpair', { userId: 9 })).removed).toBe(true);
    expect((await operator.request('channels.unpair', { userId: 9 })).removed).toBe(false);

    api.push(api.text({ id: 42 }, '/unpair'));
    await api.waitSent(1);
    expect(api.sent[0]).toMatchObject({ chatId: 42, text: TEXT.unpaired });
    const file = readTelegramFile(dir);
    expect(file.state === 'ok' && file.file.paired).toEqual([]);
    expect((await operator.request('channels.status', {})).telegram.paired).toEqual([]);
  });

  it('apagado en la config: disabled, sin emparejar; reload lo enciende', async () => {
    const enabled = { value: false };
    const { t } = await start({ enabled });
    const operator = await t.connect(['operator']);
    expect((await operator.request('channels.status', {})).telegram.state).toBe('disabled');
    await expect(operator.request('channels.pairBegin', {})).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      data: { reason: 'channel-off' },
    });
    enabled.value = true;
    expect((await operator.request('channels.reload', {})).telegram.state).toBe('running');
  });

  it('sin telegram.json: not-configured; uno que no valida: invalid (apagado)', async () => {
    const { t, dir } = await start({ file: false });
    const operator = await t.connect(['operator']);
    expect((await operator.request('channels.status', {})).telegram.state).toBe('not-configured');
    const { writeFileSync } = await import('fs');
    writeFileSync(join(dir, 'telegram.json'), '{"schemaVersion":1,"token":"nope"}');
    expect((await operator.request('channels.reload', {})).telegram).toMatchObject({
      state: 'invalid',
      bot: null,
    });
  });

  it('el daemon sin canales: UNAVAILABLE channels-disabled', async () => {
    const { t } = await start({ channels: null });
    const observer = await t.connect(['observer']);
    await expect(observer.request('channels.status', {})).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      data: { reason: 'channels-disabled' },
    });
  });

  it('con alguien emparejado el daemon no se apaga por inactividad; sin nadie, sí', async () => {
    const ana: TelegramPaired = {
      userId: 42,
      chatId: 42,
      name: 'Ana',
      pairedAt: new Date().toISOString(),
    };
    const kept = await start({ paired: [ana], idleExitMs: 200 });
    let closed = false;
    void kept.t.daemon.closed.then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 700));
    expect(closed).toBe(false);
    await running!.stop();
    running = null;
    rmSync(base!, { recursive: true, force: true });
    base = null;

    const idle = await start({ idleExitMs: 200 });
    await vi.waitFor(() => expect(idle.t.daemon.closed).resolves.toBe('idle'), { timeout: 3_000 });
  });

  it('un texto del chat abre un turno del companion (via telegram); la respuesta y lo de Dot vuelven al chat', async () => {
    const ana: TelegramPaired = {
      userId: 42,
      chatId: 42,
      name: 'Ana',
      pairedAt: new Date().toISOString(),
    };
    const { t, api } = await start({ paired: [ana] });
    t.project(join('companion', 'workspace'), [
      textRound(['Hola, Ana.']),
      textRound(['Respuesta a Dot.']),
    ]);

    api.push(api.text({ id: 42 }, 'hola desde el móvil'));
    await vi.waitFor(() => expect(api.sent.map((m) => m.text)).toContain('Hola, Ana.'), {
      timeout: 10_000,
    });
    // Lo que vino de Telegram no se le devuelve.
    expect(api.sent.map((m) => m.text)).not.toContain(fromDot('hola desde el móvil'));

    // Dot ve la misma conversación, con la marca.
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const { snapshot } = await dot.request('sessions.get', { sessionId: session.id });
    const user = snapshot.messages.find((m) => m.kind === 'user');
    expect(user).toMatchObject({ text: 'hola desde el móvil', via: 'telegram' });

    // Y lo que se escribe en Dot llega al chat, con la respuesta.
    await vi.waitFor(async () => {
      const s = (await dot.request('sessions.get', { sessionId: session.id })).snapshot;
      expect(s.session.state).toBe('idle');
    });
    await dot.request('runs.start', { sessionId: session.id, input: 'desde Dot' });
    await vi.waitFor(() => expect(api.sent.map((m) => m.text)).toContain('Respuesta a Dot.'), {
      timeout: 10_000,
    });
    expect(api.sent.map((m) => m.text)).toContain(fromDot('desde Dot'));
    const after = (await dot.request('sessions.get', { sessionId: session.id })).snapshot;
    const users = after.messages.filter((m) => m.kind === 'user');
    expect(users.map((m) => (m.kind === 'user' ? (m.via ?? null) : null))).toEqual([
      'telegram',
      null,
    ]);
  });

  it('6E: una foto del chat entra en la conversación del companion; sin visión, el aviso llega al chat', async () => {
    const ana: TelegramPaired = {
      userId: 42,
      chatId: 42,
      name: 'Ana',
      pairedAt: new Date().toISOString(),
    };
    const { t, api } = await start({ paired: [ana] });
    t.project(join('companion', 'workspace'), [textRound(['Veo una foto.'])]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    api.push(api.photo({ id: 42 }, png, 'mira esto'));
    await vi.waitFor(() => expect(api.sent.map((m) => m.text)).toContain('Veo una foto.'), {
      timeout: 10_000,
    });
    expect(api.sent.map((m) => m.text).join('\n')).toContain(
      'Warning: The active model has no declared vision',
    );
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const { snapshot } = await dot.request('sessions.get', { sessionId: session.id });
    expect(snapshot.messages.find((m) => m.kind === 'user')).toMatchObject({
      text: 'mira esto',
      via: 'telegram',
    });
  });

  describe('aprobaciones desde el chat (parte 4)', () => {
    const ana: TelegramPaired = {
      userId: 42,
      chatId: 42,
      name: 'Ana',
      pairedAt: new Date().toISOString(),
    };

    /** Una sesión de código del daemon que pide borrar un fichero. */
    async function pending(t: TestDaemon, api: FakeTelegramApi) {
      const cwd = t.project('proyecto', [
        makeToolCallRound('c1', 'exec', { command: 'rm victim.txt' }),
        makeTextRound('hecho'),
      ]);
      const file = join(cwd, 'victim.txt');
      writeFileSync(file, 'no me borres\n');
      const operator = await t.connect(['operator'], 'op');
      const { session } = await operator.request('sessions.open', { cwd });
      await operator.request('runs.start', { sessionId: session.id, input: 'limpia' });
      await vi.waitFor(() => expect(api.sent.some((m) => m.keyboard)).toBe(true), {
        timeout: 10_000,
      });
      const card = api.sent.find((m) => m.keyboard)!;
      return { operator, session, file, card };
    }

    it('aprobar una vez desde Telegram ejecuta y edita la tarjeta', async () => {
      const { t, api } = await start({ paired: [ana] });
      const { operator, session, file, card } = await pending(t, api);
      expect(card.text).toContain('Approval needed');
      expect(card.text).toContain('exec');
      const [approve, deny] = card.keyboard![0]!;
      expect(approve!.text).toBe('Approve once');
      expect(deny!.text).toBe('Deny');

      api.push(api.press(42, card.messageId, approve!.callbackData));
      await vi.waitFor(() => expect(existsSync(file)).toBe(false), { timeout: 10_000 });
      await vi.waitFor(() =>
        expect(api.edits.map((e) => e.text).join('\n')).toContain('Approved from Telegram'),
      );
      expect(api.callbackAnswers.at(-1)?.text).toBe('Approved.');
      const { snapshot } = await operator.request('sessions.get', { sessionId: session.id });
      expect(snapshot.approvals).toEqual([]);
    });

    it('resuelta en otro cliente: la tarjeta lo dice y su botón ya no vale', async () => {
      const { t, api } = await start({ paired: [ana] });
      const { file, card } = await pending(t, api);
      const approver = await t.connect(['approver'], 'dot', { kind: 'dot' });
      const { approvals } = await approver.request('approvals.list', {});
      await approver.request('approvals.resolve', {
        approvalId: approvals[0]!.id,
        decision: 'deny',
      });
      await vi.waitFor(() =>
        expect(api.edits.map((e) => e.text).join('\n')).toContain('Denied in Dot'),
      );
      api.push(api.press(42, card.messageId, card.keyboard![0]![0]!.callbackData));
      await vi.waitFor(() => expect(api.callbackAnswers.at(-1)?.text).toContain('no longer valid'));
      expect(existsSync(file)).toBe(true);
    });

    it('6C: una pregunta de texto libre se contesta escribiendo en el chat, y ese texto no va al asistente', async () => {
      const { t, api } = await start({ paired: [ana] });
      t.project(join('companion', 'workspace'), []);
      const cwd = t.project('proyecto', [
        makeToolCallRound('q1', 'question', { questions: [{ question: '¿Qué nombre le pongo?' }] }),
        makeTextRound('anotado'),
      ]);
      const operator = await t.connect(['operator'], 'op');
      const { session } = await operator.request('sessions.open', { cwd });
      await operator.request('runs.start', { sessionId: session.id, input: 'pregunta' });
      await vi.waitFor(
        () => expect(api.sent.some((m) => m.text.includes('¿Qué nombre le pongo?'))).toBe(true),
        { timeout: 10_000 },
      );
      api.push(api.text({ id: 42 }, 'informe-final'));
      await vi.waitFor(
        async () => {
          const { snapshot } = await operator.request('sessions.get', { sessionId: session.id });
          expect(snapshot.questions).toEqual([]);
          expect(snapshot.session.state).toBe('idle');
        },
        { timeout: 10_000 },
      );
      expect(api.sent.map((m) => m.text)).toContain('Answers sent.');
      await vi.waitFor(() =>
        expect(api.edits.map((e) => e.text).join('\n')).toContain('Answered from Telegram'),
      );
      // El companion no recibió nada: su sesión no tiene ningún mensaje del usuario.
      const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
      const { session: companion } = await dot.request('sessions.open', { agent: 'companion' });
      const { snapshot } = await dot.request('sessions.get', { sessionId: companion.id });
      expect(snapshot.messages.filter((m) => m.kind === 'user')).toEqual([]);
    });

    it('un botón inventado o de un chat no emparejado no resuelve nada', async () => {
      const { t, api } = await start({ paired: [ana] });
      const { file, card } = await pending(t, api);
      api.push(api.press(42, card.messageId, 'b:inventado'));
      api.push(api.press(7, card.messageId, card.keyboard![0]![0]!.callbackData));
      await api.drained();
      await vi.waitFor(() => expect(api.callbackAnswers.length).toBe(1));
      expect(api.callbackAnswers[0]!.text).toContain('no longer valid');
      expect(existsSync(file)).toBe(true);
      const observer = await t.connect(['observer']);
      expect((await observer.request('approvals.list', {})).approvals).toHaveLength(1);
    });
  });
});
