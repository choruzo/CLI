/**
 * Quién se conecta y qué puede hacer. La autorización es **por capacidad**: cada
 * método exige una (`METHODS` en `methods.ts`), y el servidor comprueba esa
 * capacidad, nunca «es operator». Poder cancelar un run no implica poder
 * aprobar una acción destructiva: son capacidades distintas.
 */

export const CLIENT_KINDS = ['cli', 'dot', 'desktop', 'daemon', 'other'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const CAPABILITIES = [
  /** Leer: listados, estado, eventos, trazas. Ningún método con efecto. */
  'observe',
  /** Conducir runs y sesiones: abrir, cerrar, iniciar, cancelar, pausar, reanudar, steering. */
  'control',
  /** Resolver aprobaciones, preguntas y planes. */
  'approve',
  /** Publicar y gobernar las sesiones que aloja esa conexión, y solo esas. */
  'host',
  /** Ofrecer capacidades nativas del escritorio (reservado). */
  'broker',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = ['observer', 'operator', 'approver', 'host', 'broker'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Un rol es un conjunto con nombre de capacidades. Un cliente puede pedir
 * varios en `core.hello` (`operator` + `approver`); el servidor contesta con las
 * capacidades que **concede**, que pueden ser menos de las pedidas.
 */
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  observer: ['observe'],
  operator: ['observe', 'control'],
  approver: ['observe', 'approve'],
  host: ['observe', 'host'],
  broker: ['broker'],
};

/** Capacidades que suman unos roles, sin repetir y en el orden de `CAPABILITIES`. */
export function capabilitiesOf(roles: readonly Role[]): Capability[] {
  const wanted = new Set<Capability>();
  for (const role of roles) for (const cap of ROLE_CAPABILITIES[role]) wanted.add(cap);
  return CAPABILITIES.filter((cap) => wanted.has(cap));
}
