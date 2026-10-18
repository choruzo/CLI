/**
 * M11 — `chat --resume <id>` no abre otro anfitrión de una sesión que ya
 * tiene uno. Antes de M11, reanudar en la terminal una sesión que alojaba el
 * daemon creaba en silencio un segundo runtime con el mismo id (dos copias de
 * la conversación, una de ellas vallada). Ahora:
 *
 *  - la aloja `stratumd` (viva o guardada para recuperarla) → no se reanuda:
 *    se continúa con `stratum attach <id>`;
 *  - la aloja viva otra terminal (anfitrión par conectado) → tampoco;
 *  - con `--fork`, la copia local se reanuda como **sesión nueva** (otro id):
 *    una bifurcación explícita, nunca la misma sesión.
 *
 * Un anfitrión par desconectado (la terminal murió) no bloquea: es el camino
 * de recuperación de siempre, y el daemon no dejaría registrarse a dos.
 */
import { StratumClient } from '../client/client.js';
import { fileDiscovery } from '../client/discovery.js';
import { SessionArchive, defaultSessionsDir } from '../daemon/session-archive.js';
import { locateLiveDaemon } from './daemon-link.js';
import { cliVersion } from './version.js';

export type ResumeOwner = { kind: 'daemon'; archived: boolean } | { kind: 'peer' } | null;

export type ResumeDecision =
  | { action: 'resume' }
  | { action: 'fork' }
  | { action: 'refuse'; message: string };

/** Qué hacer con `chat --resume <id>` según quién la aloja. Pura. */
export function resumeDecision(
  sessionId: string,
  owner: ResumeOwner,
  fork: boolean,
): ResumeDecision {
  if (fork) return { action: 'fork' };
  if (owner?.kind === 'daemon') {
    return {
      action: 'refuse',
      message:
        `La sesión ${sessionId} la aloja stratumd${owner.archived ? ' (guardada; se recupera al usarla)' : ''}. ` +
        `Continúa con: stratum attach ${sessionId}\n` +
        'chat --resume no abre un segundo anfitrión de la misma sesión. Para seguir en esta ' +
        'terminal con una copia independiente (otro id), usa --fork.',
    };
  }
  if (owner?.kind === 'peer') {
    return {
      action: 'refuse',
      message:
        `La sesión ${sessionId} está abierta ahora en otra terminal. ` +
        `Síguela desde aquí con: stratum attach ${sessionId}, o usa --fork para una copia independiente.`,
    };
  }
  return { action: 'resume' };
}

/**
 * ¿Quién aloja ahora esa sesión? Mira las guardadas del daemon (disco) y, si
 * hay un daemon vivo, le pregunta. Cualquier fallo es «nadie»: la CLI no
 * depende del daemon para trabajar.
 */
export async function whoHostsSession(
  sessionId: string,
  opts: { sessionsDir?: string; timeoutMs?: number } = {},
): Promise<ResumeOwner> {
  if (new SessionArchive(opts.sessionsDir ?? defaultSessionsDir()).has(sessionId)) {
    return { kind: 'daemon', archived: true };
  }
  if (process.env.STRATUM_NO_DAEMON === '1') return null;
  let client: StratumClient | null = null;
  try {
    const found = await locateLiveDaemon();
    if (found.status !== 'found') return null;
    client = new StratumClient({
      discovery: fileDiscovery(),
      identity: {
        kind: 'cli',
        name: 'stratum chat --resume',
        version: cliVersion(),
        roles: ['observer'],
      },
      reconnect: false,
      requestTimeoutMs: opts.timeoutMs ?? 3_000,
    });
    await client.connect();
    const { snapshot } = await client.request('sessions.get', { sessionId });
    const host = snapshot.session.host;
    if (host.kind === 'daemon') return { kind: 'daemon', archived: false };
    return host.connected ? { kind: 'peer' } : null;
  } catch {
    // `NOT_FOUND`: el daemon no la conoce. Cualquier otro fallo: no se sabe, y no se bloquea.
    return null;
  } finally {
    client?.close();
  }
}
