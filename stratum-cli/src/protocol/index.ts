/**
 * Stratum Protocol v1 — superficie pública **pura**: tipos, constantes y
 * funciones sin dependencias. La validación (Zod) vive aparte, en
 * `protocol/schemas.ts`, para que quien solo necesita los tipos no la arrastre.
 *
 * Referencia: `docs/protocol.md`.
 */
export * from './version.js';
export * from './errors.js';
export * from './messages.js';
export * from './roles.js';
export * from './model.js';
export * from './events.js';
export * from './methods.js';
export * from './transcript.js';
export * from './reduce.js';
export * from './resolve.js';
