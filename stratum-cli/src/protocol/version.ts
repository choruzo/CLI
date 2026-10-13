/**
 * Stratum Protocol — versión y límites del canal.
 *
 * Todo `src/protocol/` es **puro**: sin Node, sin sistema de ficheros, sin
 * sockets, sin `process` y sin nada del runtime (`SessionHost`, `StratumAgent`,
 * la config). Lo importan clientes que no son Node (un webview), así que solo
 * puede importar de sí mismo. `protocol/purity.test.ts` lo comprueba.
 */

/**
 * Versión del protocolo. No hay compatibilidad implícita: cliente y servidor la
 * intercambian en `core.hello` y, si no coinciden, la conexión termina con
 * `PROTOCOL_MISMATCH` antes de aceptar ningún otro método.
 *
 * Dentro de una versión solo se añade: campos opcionales, métodos y eventos
 * nuevos (anunciados en `features`). Quitar o cambiar el significado de algo
 * exige subir este número.
 */
export const STRATUM_PROTOCOL_VERSION = 1;

/** Tiempo máximo para recibir `core.hello` tras aceptar una conexión. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Tope de un mensaje antes de autenticar: un `core.hello` cabe de sobra. */
export const MAX_UNAUTHENTICATED_MESSAGE_BYTES = 4 * 1024;

/** Tope de un mensaje autenticado, en bytes de su línea NDJSON. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Límites de los campos de entrada. Los aplican los schemas (`schemas.ts`). */
export const LIMITS = {
  /** Identificadores opacos: sesión, run, aprobación, suscripción… */
  idChars: 128,
  /** Nombre de método. */
  methodChars: 64,
  /** Entrada de un turno o mensaje de steering. */
  inputChars: 200_000,
  /** Ruta absoluta (`cwd`). */
  pathChars: 4_096,
  /** Nombre de perfil, modelo, provider, cliente. */
  nameChars: 256,
  /** Token del handshake. */
  tokenChars: 1_024,
  /** Clave de aprobador del handshake (`core.hello.approverKey`). */
  approverKeyChars: 1_024,
  /** Frase tecleada de una confirmación con nombre. */
  phraseChars: 256,
  /** Tanda de respuestas de `question`. */
  answers: 8,
  answerChars: 4_000,
  /** Pasos de un plan editado al aprobarlo. */
  planSteps: 100,
  planStepChars: 2_000,
  /** Variables de `sessions.open.env` (reservado) y tamaño de cada valor. */
  envVars: 512,
  envValueChars: 32_768,
  /** Eventos de un lote `host.publish`. */
  publishBatch: 256,
  /** Elementos de un listado. */
  listLimit: 500,
  /** Texto de una consulta de memoria. */
  queryChars: 2_000,
} as const;
