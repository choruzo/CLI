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
 *
 * **Desde cuándo obliga esa regla.** La v1 todavía **no está congelada**: ningún
 * paquete publicado la contiene (el último, `stratum-cli` 0.8.0, es anterior al
 * protocolo) y no hay clientes fuera de este repositorio. Mientras sea así, su
 * forma se puede corregir sin subir el número, y cada cambio se anota en
 * `docs/protocol.md` §17. La compatibilidad estricta empieza con **la primera
 * versión publicada de `stratum-cli` que incluya `stratumd`** (su tag `v*`): a
 * partir de ese tag, lo que aquí se llama v1 es lo que esa versión publicó.
 */
export const STRATUM_PROTOCOL_VERSION = 1;

/**
 * M23 — **revisión** del protocolo dentro de su versión: sube con cada cambio
 * aditivo (método, evento o campo nuevo). Cada app lleva su propia versión
 * (Dot 0.3, Desktop 0.11, la CLI 0.15), así que compararlas no dice nada; esto
 * sí: el servidor la anuncia en `core.hello` (`server.revision`) y el cliente la
 * compara con la suya para decir quién se quedó atrás (`compareRevision`).
 * Nunca decide si se conecta: eso es solo `STRATUM_PROTOCOL_VERSION`.
 *
 * Un servidor sin `revision` es anterior a que existiera (cuenta como 0).
 * `protocol/revision.test.ts` guarda la huella de métodos y eventos de cada
 * revisión: añadir uno sin subirla hace fallar el test.
 */
export const STRATUM_PROTOCOL_REVISION = 1;

export type RevisionSkew = 'same' | 'server-older' | 'server-newer';

/** Quién se quedó atrás. `server` ausente = un servidor de antes de la revisión. */
export function compareRevision(
  server: number | undefined,
  client: number = STRATUM_PROTOCOL_REVISION,
): RevisionSkew {
  const s = server ?? 0;
  if (s === client) return 'same';
  return s < client ? 'server-older' : 'server-newer';
}

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
  /** Imágenes adjuntas a un mensaje (`runs.start`/`runs.steer`), como rutas. */
  imagesPerMessage: 5,
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
