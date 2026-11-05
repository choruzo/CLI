/**
 * M18 — los canales externos dentro del daemon (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Como el `RoutineScheduler`, no importa `daemon.ts`: lo que necesita del
 * daemon entra por el constructor. Es dueño del canal de Telegram en marcha,
 * del emparejamiento en curso (en memoria) y de las escrituras de
 * `telegram.json` que hace el daemon (emparejar y desemparejar); el token solo
 * lo escribe `stratum channels telegram setup`.
 *
 * Falla cerrado: un `telegram.json` que no valida, uno de un Stratum más nuevo
 * o una config que no se puede leer dejan el canal **apagado**.
 */
import { ProtocolError } from '../ipc/codec.js';
import { getLogger } from '../logging/index.js';
import type {
  ProtocolChannelsStatus,
  ProtocolEvent,
  ProtocolTelegramPaired,
  ProtocolTelegramStatus,
} from '../protocol/index.js';
import { HttpTelegramApi, type TelegramApi } from '../channels/telegram/api.js';
import { TelegramChannel } from '../channels/telegram/channel.js';
import { TelegramPairing, type PairingCandidate } from '../channels/telegram/pairing.js';
import { TEXT, pairingLink } from '../channels/telegram/render.js';
import {
  readTelegramFile,
  writeTelegramFile,
  type TelegramFile,
  type TelegramFileState,
  type TelegramPaired,
} from '../channels/telegram/store.js';
import { CompanionLink, type CompanionPort } from './channel-companion.js';
import { ChannelApprovals, type PendingSource } from './channel-approvals.js';
import type { SessionLabel } from '../channels/telegram/render.js';

const log = getLogger('channels');

/** Los que caben en `telegram.json`. */
const MAX_PAIRED = 16;

export interface ChannelHostOptions {
  /** Carpeta privada del daemon, donde vive `telegram.json`. */
  dir: string;
  /** `channels.telegram.enabled`, leído de la config global en cada `reload`. */
  enabled: () => boolean;
  /** El cliente de la API para un token. Por defecto, el de HTTP. Tests: uno falso. */
  api?: (token: string) => TelegramApi;
  now: () => number;
  /**
   * La conversación del `companion` (parte 3): adónde va lo que se escribe en el
   * chat y de dónde sale el espejo. Sin ella, el canal solo empareja.
   */
  companion?: CompanionPort;
  /**
   * Lo pendiente de todas las sesiones (parte 4): el `ApprovalCenter`. Sin él,
   * el canal no enseña ni resuelve aprobaciones.
   */
  approvals?: PendingSource;
  /** Lo que se enseña de una sesión en una tarjeta. */
  sessionLabel?: (sessionId: string) => SessionLabel | null;
  /** Redacción de lo que sale al chat. Por defecto, ninguna (tests). */
  redact?: (text: string) => string;
  /** Ajustes del sondeo y de la salida (tests). */
  pollTimeoutSec?: number;
  retry?: { initialMs: number; maxMs: number };
  sendIntervalMs?: number;
  typingIntervalMs?: number;
}

function channelOff(message: string): ProtocolError {
  return new ProtocolError('UNAVAILABLE', message, { reason: 'channel-off' });
}

function toProtocolPaired(p: TelegramPaired): ProtocolTelegramPaired {
  const at = Date.parse(p.pairedAt);
  return {
    userId: p.userId,
    name: p.name,
    ...(p.username ? { username: p.username } : {}),
    pairedAt: Number.isFinite(at) ? at : 0,
  };
}

export class ChannelHost {
  private file: TelegramFileState = { state: 'absent' };
  private enabled = false;
  private channel: TelegramChannel | null = null;
  private readonly pairing: TelegramPairing;
  private readonly link: CompanionLink | null;
  private readonly cards: ChannelApprovals | null;

  constructor(private readonly opts: ChannelHostOptions) {
    this.pairing = new TelegramPairing(opts.now);
    this.link = opts.companion
      ? new CompanionLink({
          companion: opts.companion,
          target: () => (this.channel?.state === 'running' ? this.channel : null),
          chats: () => this.paired().map((p) => p.chatId),
          redact: opts.redact ?? ((text) => text),
          ...(opts.typingIntervalMs !== undefined
            ? { typingIntervalMs: opts.typingIntervalMs }
            : {}),
        })
      : null;
    this.cards = opts.approvals
      ? new ChannelApprovals({
          approvals: opts.approvals,
          target: () => (this.channel?.state === 'running' ? this.channel : null),
          chats: () => this.paired().map((p) => p.chatId),
          redact: opts.redact ?? ((text) => text),
          sessionLabel: opts.sessionLabel ?? (() => null),
        })
      : null;
    this.cards?.start();
  }

  /** Un evento de una sesión del daemon: el espejo de la conversación del `companion`. */
  observe(event: ProtocolEvent): void {
    this.link?.observe(event);
  }

  /** M16 — aviso de rutina terminada a los chats emparejados. */
  routineFinished(name: string, status: string, summary: string | null): void {
    this.link?.routineFinished(name, status, summary);
  }

  /** Lee el fichero y la config y, si toca, empieza a escuchar. */
  start(): void {
    this.load();
  }

  /** Vuelve a leerlo todo (tras `setup` o `disable`). Anula el emparejamiento en curso. */
  async reload(): Promise<ProtocolChannelsStatus> {
    await this.stopChannel();
    this.pairing.cancel();
    // Los botones ya enviados dejan de resolver nada.
    this.cards?.reset();
    this.load();
    return this.status();
  }

  async stop(): Promise<void> {
    this.link?.stop();
    this.cards?.stop();
    this.pairing.cancel();
    await this.stopChannel();
  }

  /**
   * Con un canal escuchando y alguien emparejado (o emparejándose), el daemon no
   * se apaga por inactividad: un mensaje del chat tiene que poder llegar.
   */
  get keepsAlive(): boolean {
    if (this.channel?.state !== 'running') return false;
    return this.paired().length > 0 || this.pairing.pending;
  }

  status(): ProtocolChannelsStatus {
    return { telegram: this.telegramStatus() };
  }

  /** Un código de un solo uso y el enlace que lo manda al bot. */
  pairBegin(): { code: string; link: string; expiresAt: number } {
    const file = this.runningFile();
    const { code, expiresAt } = this.pairing.begin();
    log.info('telegram pairing started');
    return { code, link: pairingLink(file.bot.username, code), expiresAt };
  }

  /**
   * Empareja al candidato, si es `userId`. Lo llama `channels.pairConfirm`, que
   * ya exige `approve`: aquí solo se comprueba que haya ese candidato.
   */
  pairConfirm(userId: number): ProtocolTelegramPaired {
    this.runningFile();
    const status = this.pairing.status();
    if (!status?.candidate || status.candidate.userId !== userId) {
      throw new ProtocolError('NOT_FOUND', 'No pairing candidate with that id.', {
        reason: 'no-candidate',
      });
    }
    const others = this.paired().filter((p) => p.userId !== userId);
    if (others.length >= MAX_PAIRED) {
      throw new ProtocolError('UNAVAILABLE', `At most ${MAX_PAIRED} chats can be paired.`, {
        reason: 'paired-limit',
      });
    }
    const candidate = status.candidate;
    const paired: TelegramPaired = {
      userId: candidate.userId,
      chatId: candidate.chatId,
      name: candidate.name,
      ...(candidate.username ? { username: candidate.username } : {}),
      pairedAt: new Date(this.opts.now()).toISOString(),
    };
    this.persist([...others, paired]);
    // Solo ya escrito se gasta el candidato: si escribir falla, se puede reintentar.
    this.pairing.confirm(userId);
    log.info('telegram chat paired', { paired: others.length + 1 });
    void this.channel?.send(paired.chatId, TEXT.paired);
    return toProtocolPaired(paired);
  }

  /** Desemparejar solo resta. `false` si no estaba. */
  unpair(userId: number): boolean {
    if (this.file.state !== 'ok') throw channelOff('The Telegram channel is not set up.');
    const current = this.paired();
    const rest = current.filter((p) => p.userId !== userId);
    if (rest.length === current.length) return false;
    this.persist(rest);
    log.info('telegram chat unpaired', { paired: rest.length });
    return true;
  }

  // -------------------------------------------------------------------------

  private load(): void {
    try {
      this.enabled = this.opts.enabled();
    } catch (err) {
      // Una config rota no enciende nada.
      log.warn('cannot read channels.telegram.enabled; the channel stays off', { err });
      this.enabled = false;
    }
    this.file = readTelegramFile(this.opts.dir);
    if (this.file.state === 'invalid') log.warn('telegram.json is not valid; the channel is off');
    if (this.file.state === 'newer') log.warn('telegram.json is from a newer Stratum; not read');
    if (this.file.state !== 'ok' || !this.enabled) return;
    let api: TelegramApi;
    try {
      const token = this.file.file.token;
      api = this.opts.api ? this.opts.api(token) : new HttpTelegramApi({ token });
    } catch {
      this.file = { state: 'invalid' };
      return;
    }
    this.channel = new TelegramChannel({
      api,
      now: this.opts.now,
      pairedUser: (userId) => this.paired().find((p) => p.userId === userId) ?? null,
      offerCode: (code, who: PairingCandidate) => this.pairing.offer(code, who),
      unpair: async (userId) => this.unpair(userId),
      onText: async (from, message) => {
        // Con una tanda de preguntas abierta en ese chat, el texto es su respuesta.
        if (message.text !== undefined && (await this.cards?.takeText(from.chatId, message.text)))
          return;
        return this.link?.input(from.chatId, message);
      },
      onCallback: (_from, query) => this.cards?.onCallback(query),
      ...(this.opts.pollTimeoutSec !== undefined
        ? { pollTimeoutSec: this.opts.pollTimeoutSec }
        : {}),
      ...(this.opts.retry ? { retry: this.opts.retry } : {}),
      ...(this.opts.sendIntervalMs !== undefined
        ? { sendIntervalMs: this.opts.sendIntervalMs }
        : {}),
    });
    this.channel.start();
    log.info('telegram channel started', { bot: this.file.file.bot.username });
  }

  private async stopChannel(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    await channel?.stop();
  }

  private paired(): readonly TelegramPaired[] {
    return this.file.state === 'ok' ? this.file.file.paired : [];
  }

  /** El fichero del canal que está escuchando, o `UNAVAILABLE`. */
  private runningFile(): TelegramFile {
    if (this.file.state !== 'ok' || this.channel?.state !== 'running') {
      throw channelOff('The Telegram channel is not running.');
    }
    return this.file.file;
  }

  /**
   * Escribe la lista de emparejados sobre el fichero **de disco**, que se relee:
   * si `setup` lo cambió por otro bot (o ya no vale), no se escribe nada.
   */
  private persist(paired: TelegramPaired[]): void {
    if (this.file.state !== 'ok') throw channelOff('The Telegram channel is not set up.');
    const disk = readTelegramFile(this.opts.dir);
    if (disk.state !== 'ok' || disk.file.bot.id !== this.file.file.bot.id) {
      throw new ProtocolError(
        'UNAVAILABLE',
        'telegram.json changed on disk; reload the channel first.',
        { reason: 'channel-changed' },
      );
    }
    const next: TelegramFile = {
      ...disk.file,
      paired,
      updatedAt: new Date(this.opts.now()).toISOString(),
    };
    writeTelegramFile(this.opts.dir, next);
    this.file = { state: 'ok', file: next };
  }

  private telegramStatus(): ProtocolTelegramStatus {
    const file = this.file;
    const base = {
      bot: file.state === 'ok' ? { ...file.file.bot } : null,
      paired: this.paired().map(toProtocolPaired),
      pairing: null,
      lastError: null,
      lastPollAt: null,
    };
    if (file.state === 'absent') return { ...base, state: 'not-configured' };
    if (file.state === 'invalid') return { ...base, state: 'invalid' };
    if (file.state === 'newer') return { ...base, state: 'newer' };
    const channel = this.channel;
    if (!this.enabled || !channel) return { ...base, state: 'disabled' };
    const pairing = this.pairing.status();
    return {
      ...base,
      state: channel.state === 'unauthorized' ? 'unauthorized' : 'running',
      pairing: pairing
        ? {
            expiresAt: pairing.expiresAt,
            candidate: pairing.candidate
              ? {
                  userId: pairing.candidate.userId,
                  name: pairing.candidate.name,
                  ...(pairing.candidate.username ? { username: pairing.candidate.username } : {}),
                }
              : null,
          }
        : null,
      lastError: channel.lastError
        ? { ...channel.lastError, message: channel.lastError.message.slice(0, 500) }
        : null,
      lastPollAt: channel.lastPollAt,
    };
  }
}
