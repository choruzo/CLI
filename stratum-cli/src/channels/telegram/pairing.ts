/**
 * M18 — el emparejamiento de un chat de Telegram (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Emparejar da autoridad (hablar con el asistente y aprobar desde el chat), así
 * que va en dos pasos y ninguno basta solo:
 *
 *  1. `begin` crea un código de un solo uso (10 caracteres sin ambigüedades,
 *     10 minutos) que enseña Dot. Quien lo manda al bot por `/start <código>`
 *     queda como **candidato**, sin emparejar.
 *  2. `confirm` lo acepta, y solo lo llama `channels.pairConfirm`, que exige
 *     `approve` (en Dot, tras la confirmación nativa).
 *
 * Un código falso no da pistas a quien lo manda, y cinco fallos lo anulan. Todo
 * en memoria: un reinicio del daemon anula el código y el candidato.
 */
import { randomInt, timingSafeEqual } from 'crypto';

/** Sin `0/O`, `1/I/L`: se puede leer en voz alta o teclear. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_FAILURES = 5;

/** Quién mandó el código, tal como lo dice Telegram. */
export interface PairingCandidate {
  userId: number;
  chatId: number;
  name: string;
  username?: string;
}

export type OfferResult =
  /** Código bueno: queda como candidato (y el código ya no vale). */
  | 'candidate'
  /** No hay código vivo, o no es ese. A quien lo manda no se le dice cuál. */
  | 'rejected';

export interface PairingStatus {
  expiresAt: number;
  candidate: PairingCandidate | null;
}

export function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class TelegramPairing {
  private code: string | null = null;
  private expiresAt = 0;
  private failures = 0;
  private candidate: PairingCandidate | null = null;

  constructor(
    private readonly now: () => number,
    private readonly makeCode: () => string = newPairingCode,
  ) {}

  /** Un código nuevo. Anula el anterior y su candidato. */
  begin(): { code: string; expiresAt: number } {
    this.code = this.makeCode();
    this.expiresAt = this.now() + PAIRING_TTL_MS;
    this.failures = 0;
    this.candidate = null;
    return { code: this.code, expiresAt: this.expiresAt };
  }

  /** Un `/start <código>` de un chat privado. */
  offer(code: string, who: PairingCandidate): OfferResult {
    this.expire();
    if (this.code === null) return 'rejected';
    if (!sameCode(code.trim().toUpperCase(), this.code)) {
      if (++this.failures >= PAIRING_MAX_FAILURES) this.cancel();
      return 'rejected';
    }
    // De un solo uso: el candidato es quien lo mandó primero.
    this.code = null;
    this.candidate = { ...who };
    return 'candidate';
  }

  /**
   * Acepta al candidato si es `userId` (el que enseñó Dot al pedir la
   * confirmación). Lo quita: un emparejamiento no se confirma dos veces.
   */
  confirm(userId: number): PairingCandidate | null {
    this.expire();
    const candidate = this.candidate;
    if (!candidate || candidate.userId !== userId) return null;
    this.cancel();
    return candidate;
  }

  cancel(): void {
    this.code = null;
    this.candidate = null;
    this.failures = 0;
    this.expiresAt = 0;
  }

  /** `null` sin emparejamiento en curso. Nunca lleva el código. */
  status(): PairingStatus | null {
    this.expire();
    if (this.code === null && this.candidate === null) return null;
    return { expiresAt: this.expiresAt, candidate: this.candidate ? { ...this.candidate } : null };
  }

  get pending(): boolean {
    return this.status() !== null;
  }

  private expire(): void {
    if (this.expiresAt !== 0 && this.now() >= this.expiresAt) this.cancel();
  }
}
