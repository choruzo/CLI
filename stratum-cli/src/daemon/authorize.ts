/**
 * Autorización del daemon. **Único** punto que decide si una conexión puede
 * llamar a un método: los handlers no vuelven a preguntarlo, y ninguno mira el
 * rol. La regla sale de la tabla del protocolo (`METHODS[method].capability`),
 * así que un método nuevo queda protegido por la capacidad que declare allí.
 */
import {
  METHODS,
  capabilitiesOf,
  type Capability,
  type MethodName,
  type ProtocolErrorPayload,
  type Role,
} from '../protocol/index.js';

/** Lo que la autorización necesita saber de una conexión. */
export interface Principal {
  authenticated: boolean;
  capabilities: readonly Capability[];
}

/**
 * Capacidades que este servidor concede. `broker` (reservada) todavía no: quien
 * la pida recibe el resto de lo que sumen sus roles.
 *
 * `host` da acceso a `host.register` / `host.publish` / `host.unregister`, y
 * nada más: no incluye `control` ni `approve`. Sobre **qué** sesiones puede
 * publicar una conexión decide el registro de sesiones pares (las que ella
 * misma registró), no esta tabla.
 */
export const GRANTABLE: readonly Capability[] = ['observe', 'control', 'approve', 'host'];

/** Lo concedido a unos roles: lo que suman, menos lo que el servidor no ofrece. */
export function grantCapabilities(roles: readonly Role[]): Capability[] {
  return capabilitiesOf(roles).filter((cap) => GRANTABLE.includes(cap));
}

/** `null` = puede. Si no, el error con el que se contesta. */
export function authorize(principal: Principal, method: MethodName): ProtocolErrorPayload | null {
  if (method === 'core.hello') {
    return principal.authenticated
      ? { code: 'INVALID_REQUEST', message: 'Handshake already completed.' }
      : null;
  }
  // Antes del handshake no se atiende nada, sea lo que sea.
  if (!principal.authenticated) return { code: 'UNAUTHORIZED', message: 'Handshake required.' };
  const info = METHODS[method];
  // Lo que el servidor envía a un anfitrión no es algo que un cliente pueda pedir.
  if (info.direction !== 'client-to-server') {
    return { code: 'METHOD_NOT_FOUND', message: 'Method not available here.' };
  }
  if (info.capability && !principal.capabilities.includes(info.capability)) {
    return {
      code: 'FORBIDDEN',
      message: `Missing capability: ${info.capability}.`,
      data: { capability: info.capability },
    };
  }
  return null;
}
