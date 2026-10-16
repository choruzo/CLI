/**
 * Traspaso de una sesión viva de su anfitrión par al daemon (M10). Es un
 * **traspaso de propiedad**, no una sesión nueva: el `sessionId`, el `seq`, la
 * conversación y el contexto del agente siguen siendo los mismos, y en ningún
 * momento hay dos anfitriones.
 *
 *   par (dueño, época N) ── host.handoffBegin/Chunk/Commit ──▶ stratumd
 *                                                              │ monta SessionHost
 *                                                              │ con este contexto
 *   par: fuera (época N, rancia) ◀── commit ───────────────────┘ daemon (época N+1)
 *
 * Lo que viaja es `ProtocolHandoffContext`: un DTO **explícito y versionado**
 * con lo que el agente necesita para continuar —su historial y los ajustes de
 * la sesión— y nada más. No viajan ni el entorno del terminal, ni claves, ni la
 * config, ni la autoridad de aprobar, ni handles del sistema (procesos, sockets,
 * conexiones SSH): lo que es del proceso par no se teletransporta, y una sesión
 * que dependa de algo así en ese momento no es transferible.
 *
 * Que no viajen credenciales del runtime no significa que no viaje nada
 * sensible: el historial va completo y tal cual, así que lo que ya esté en el
 * contexto del modelo (un mensaje del usuario, una salida de tool que la
 * redacción no reconoció) llega al daemon con él. No se filtra: es el contexto.
 *
 * La foto de la sesión **no** viaja aquí: el daemon ya la tiene, al día, por lo
 * que el par publicó (`host.publish`); `seq` dice hasta dónde. Si no coincide,
 * el traspaso no se hace (`STALE_STATE`).
 */

/** Formato de `ProtocolHandoffContext`. Cambiarlo es subir este número. */
export const HANDOFF_FORMAT = 1;

/** Límites del traspaso. El contexto va troceado: un mensaje del protocolo no pasa de 1 MiB. */
export const HANDOFF_LIMITS = {
  /**
   * Caracteres de un trozo. Con el peor escape de JSON (`\u00XX`, 6 bytes por
   * carácter) un trozo sigue cabiendo en un mensaje.
   */
  chunkChars: 96 * 1024,
  /** Tamaño máximo del contexto serializado. */
  maxChars: 48 * 1024 * 1024,
  /** Trozos de un traspaso: `maxChars / chunkChars`. */
  maxChunks: 512,
  /** Mensajes del historial del agente. */
  maxMessages: 20_000,
} as const;

/** Una llamada a una tool dentro de un mensaje del asistente. */
export interface ProtocolAgentToolCall {
  id: string;
  name: string;
  /** Argumentos tal como los generó el modelo (JSON en texto). */
  arguments: string;
}

/**
 * Un mensaje del **historial del agente**: lo que el modelo tiene de contexto,
 * system prompt incluido. No es `ProtocolChatMessage` (la vista para personas):
 * lleva resultados de tools y lo que la compresión dejó. Viaja tal cual porque
 * es el contexto que el modelo ya tiene; nunca se publica ni se registra.
 */
export interface ProtocolAgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ProtocolAgentToolCall[];
  toolCallId?: string;
  name?: string;
}

/** Lo que el agente necesita para continuar en otro anfitrión. */
export interface ProtocolHandoffContext {
  format: typeof HANDOFF_FORMAT;
  sessionId: string;
  /** Directorio de la sesión. El daemon lo valida como el de `sessions.open`. */
  cwd: string;
  /** Alias del provider y modelo en uso. Sin `baseUrl` ni claves: el daemon los resuelve. */
  provider: string;
  model: string;
  /** Perfil principal activo, o `null` (`general`). */
  agent: string | null;
  readOnly: boolean;
  /** Perfil de sesión pedido (`auto`, `code`…). */
  sessionProfile: string;
  /** Plan asociado a la sesión (`.stratum/plans/` del proyecto), si lo hay. */
  planRef: string | null;
  /** Contadores de la sesión. Los tokens, solo si el backend los reportó: nunca se estiman. */
  usage: {
    toolCalls: number;
    tokens: number | null;
    tokenStatus: 'reported' | 'unavailable' | 'unsupported';
  };
  messages: ProtocolAgentMessage[];
}

/**
 * Por qué una sesión no se puede traspasar ahora. Viaja en `data.reason` del
 * error (`BUSY` o `NOT_TRANSFERABLE`).
 *
 *  - `run-active`: hay un turno en curso, también en pausa o esperando una
 *    aprobación (lo pendiente es una promesa del proceso par). → `BUSY`.
 *  - `handoff-in-progress`: ya se está traspasando. → `BUSY`.
 *  - `jobs-running`: un job en segundo plano es un proceso del par. → `NOT_TRANSFERABLE`.
 *  - `inbox-pending`: hay avisos o mensajes que el agente aún no ha visto.
 *  - `background-work`: trabajo auxiliar en vuelo (extracción de memoria).
 *  - `unsupported-host`: ese anfitrión no sabe traspasar (`stratum run`).
 *  - `startup`: el daemon no puede montar la sesión en ese directorio (config,
 *    provider, modelo o perfil que no resuelve con su entorno).
 *  - `cwd`: el daemon no puede usar el directorio.
 *  - `context`: el contexto no es válido o no cabe.
 */
export type HandoffBlocker =
  | 'run-active'
  | 'handoff-in-progress'
  | 'jobs-running'
  | 'inbox-pending'
  | 'background-work'
  | 'unsupported-host'
  | 'startup'
  | 'cwd'
  | 'context';

/**
 * Trocea el contexto serializado para `host.handoffChunk`, **sin partir un par
 * de surrogates** (medio carácter es un texto mal formado que un cliente
 * estricto rechazaría). Unir los trozos devuelve el texto exacto.
 */
export function splitHandoff(text: string, size: number = HANDOFF_LIMITS.chunkChars): string[] {
  if (size < 2) throw new RangeError('chunk size too small');
  const out: string[] = [];
  let from = 0;
  while (from < text.length) {
    let end = Math.min(text.length, from + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(text.slice(from, end));
    from = end;
  }
  return out;
}
