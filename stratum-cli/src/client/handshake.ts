/**
 * Handshake: la primera petición de toda conexión. Hasta que no termina bien,
 * el cliente no envía nada más.
 */
import {
  STRATUM_PROTOCOL_VERSION,
  type ClientKind,
  type HelloResult,
  type Role,
} from '../protocol/index.js';
import { ProtocolError } from '../ipc/codec.js';
import type { RpcPeer } from '../ipc/peer.js';

/** Quién es este cliente y qué pide. */
export interface ClientIdentity {
  kind: ClientKind;
  name: string;
  version: string;
  roles: Role[];
  features?: string[];
}

/**
 * Cliente y servidor hablan versiones distintas del protocolo. No hay
 * compatibilidad implícita: la conexión se abandona sin enviar ningún método.
 */
export class ProtocolMismatchError extends Error {
  override readonly name = 'ProtocolMismatchError';

  constructor(
    readonly clientProtocol: number,
    /** `null` si el servidor no dijo cuál habla. */
    readonly serverProtocol: number | null,
    readonly serverVersion?: string,
  ) {
    super(
      `Stratum protocol mismatch: this client speaks v${clientProtocol}, the server ` +
        `${serverProtocol === null ? 'a different version' : `v${serverProtocol}`}` +
        `${serverVersion ? ` (Stratum ${serverVersion})` : ''}. Update the older side.`,
    );
  }
}

export async function performHandshake(
  peer: RpcPeer,
  token: string,
  identity: ClientIdentity,
  timeoutMs: number,
): Promise<HelloResult> {
  let result: HelloResult;
  try {
    result = await peer.request(
      'core.hello',
      {
        protocol: STRATUM_PROTOCOL_VERSION,
        token,
        client: { kind: identity.kind, name: identity.name, version: identity.version },
        roles: identity.roles,
        ...(identity.features ? { features: identity.features } : {}),
      },
      { timeoutMs },
    );
  } catch (err) {
    if (err instanceof ProtocolError && err.code === 'PROTOCOL_MISMATCH') {
      throw new ProtocolMismatchError(STRATUM_PROTOCOL_VERSION, err.data?.protocol ?? null);
    }
    throw err;
  }
  // El servidor aceptó, pero dice hablar otra versión: tampoco vale.
  if (result.protocol !== STRATUM_PROTOCOL_VERSION) {
    throw new ProtocolMismatchError(
      STRATUM_PROTOCOL_VERSION,
      result.protocol,
      result.server.version,
    );
  }
  return result;
}
