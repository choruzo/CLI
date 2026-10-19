/**
 * M12 — traspasa **una** conversación de Stratum Desktop D1–D7 a `stratumd`
 * (ver `desktop-legacy.ts`). Es el camino de `/detach` (M10), sin terminal:
 *
 *   SessionHost (agente `assistant`, en su carpeta, con su historial)
 *   → PeerHostBridge (se publica con su conversación visible y origen Desktop)
 *   → detach() → el daemon la adopta (mismo contexto) y la guarda (M11)
 *
 * Nada de la sesión se ejecuta aquí: no se lanza ningún turno, solo se monta
 * para entregarla. Un resultado desconocido no se repite.
 */
import type { ProviderRouter } from '../providers/router.js';
import type { StratumConfig } from '../config/schema.js';
import type { Discovery } from '../client/discovery.js';
import { createSessionEnv } from '../runtime/session-env.js';
import { SessionHost } from '../host/session-host.js';
import type { AssistantData } from '../host/assistant.js';
import { PeerHostBridge } from '../host/peer-host-bridge.js';
import { SessionOwnership, prepareHandoff } from '../host/handoff.js';
import { ensureFolder, legacyTranscriptToChat, type LegacyConversation } from './desktop-legacy.js';

export type ImportOutcome =
  | { status: 'imported'; sessionId: string }
  /** No se traspasó: no cambió nada en el daemon. Se puede volver a intentar. */
  | { status: 'failed'; reason: string }
  /** No se sabe si se traspasó: **no** se reintenta solo. */
  | { status: 'unknown'; sessionId: string };

export interface ImportDeps {
  /** Config y router de la sesión en ese directorio (`resolveSessionStartup` en la CLI). */
  startup: (
    cwd: string,
  ) => Promise<
    { ok: true; config: StratumConfig; router: ProviderRouter } | { ok: false; error: string }
  >;
  version: string;
  /** Sin él, el descubrimiento oficial (`~/.stratum/daemon/endpoint.json`). */
  discovery?: Discovery;
  env?: NodeJS.ProcessEnv;
  assistantData?: AssistantData;
}

export async function importConversation(
  conv: LegacyConversation,
  deps: ImportDeps,
): Promise<ImportOutcome> {
  ensureFolder(conv.folder);
  const startup = await deps.startup(conv.folder);
  if (!startup.ok) return { status: 'failed', reason: startup.error };
  const host = await SessionHost.create({
    env: createSessionEnv({ cwd: conv.folder, env: deps.env ?? process.env }),
    config: startup.config,
    router: startup.router,
    mcp: 'none',
    preset: 'assistant',
    destructivePolicy: 'deny',
    ...(deps.assistantData ? { assistantData: deps.assistantData } : {}),
    agent: { initialMessages: conv.messages },
  });
  const ownership = new SessionOwnership();
  const bridge = new PeerHostBridge({
    session: host,
    control: {
      cancel: () => host.cancel(),
      steer: (text) => host.steer(text),
      pause: () => host.pause(),
      resume: () => host.resume(),
      prepareHandoff: () =>
        prepareHandoff(host, ownership, async () => {
          await host.trace?.flush();
        }),
    },
    name: 'stratum-desktop-import',
    version: deps.version,
    origin: 'desktop',
    transcript: legacyTranscriptToChat(conv.turns),
    title: conv.title,
    ...(deps.discovery ? { discovery: deps.discovery } : {}),
    onHandedOff: () => ownership.completeHandoff(),
  });
  try {
    await bridge.start();
    const outcome = await bridge.detach();
    switch (outcome.status) {
      case 'detached':
        return { status: 'imported', sessionId: host.sessionId };
      case 'kept':
        return { status: 'failed', reason: outcome.message };
      default:
        return { status: 'unknown', sessionId: host.sessionId };
    }
  } finally {
    await host.dispose({ cancelBackground: true });
    await bridge.close();
  }
}
