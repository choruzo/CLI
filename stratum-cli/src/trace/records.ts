/**
 * Formato de la traza de una sesión (`~/.stratum/traces/<sessionId>.jsonl`): un
 * registro JSON por línea, solo se añade. Sin imports a propósito, como
 * `agent/events.ts`: el visor web y el webview de Stratum Desktop leen estos
 * mismos tipos y no pueden arrastrar nada de Node.
 *
 * La traza la escribe el runtime (loop, provider, dispatcher) a partir de lo
 * que ocurre; el modelo ni la ve ni puede tocarla. Los turnos y los pasos se
 * numeran al leer, por orden de aparición: reanudar una sesión añade al mismo
 * fichero sin tener que releerlo.
 */

export const TRACE_FORMAT_VERSION = 1;

/**
 * Carril del timeline al que pertenece un paso:
 *  - `system` / `user` / `context` — lo que entra al modelo (prompt del sistema,
 *    mensaje del usuario, mensajes inyectados por el runtime)
 *  - `model` — una llamada al LLM
 *  - `tool` / `subagent` — lo que el agente ejecuta
 *  - `notice` — avisos y errores del runtime
 */
export type TraceKind = 'system' | 'user' | 'context' | 'model' | 'tool' | 'subagent' | 'notice';

export type TraceStatus = 'ok' | 'error' | 'cancelled';

/** Datos libres del paso. Las cadenas llegan redactadas y recortadas. */
export type TraceData = Record<string, unknown>;

/** `meta.caps`: la traza registra las decisiones del runtime (`TraceRuntimeEvent`). */
export const TRACE_CAP_RUNTIME = 'runtime';

/**
 * Decisiones del runtime que no son un `AgentEvent`: se guardan como un `point`
 * de tipo `notice` con estos campos en `data` (el visor las pinta como un aviso
 * más; `stratum eval` y `stratum stats` las cuentan por `data.event`).
 *  - `confirmation` — una confirmación destructiva o de entorno: `approved` /
 *    `allow-all` / `denied` las contesta el usuario; `blocked` es que nadie
 *    podía contestar (sin TTY, `--deny-destructive`)
 *  - `veto` — la llamada se rechazó sin preguntar: `preflight` de la tool, modo
 *    read-only, política de entorno que no se pudo evaluar, tool fuera del
 *    toolset de la sesión (`toolset`) o cambio fuera de un plan aprobado (`plan`)
 *  - `retry` — reintento de una llamada al modelo antes del primer chunk
 */
export type TraceRuntimeEvent =
  | {
      event: 'confirmation';
      decision: 'approved' | 'allow-all' | 'denied' | 'blocked';
      tool: string;
      callId: string;
      description: string;
      /** Entorno cuya política forzó la pregunta. */
      environment?: string;
      forced?: boolean;
    }
  | {
      event: 'veto';
      source: 'preflight' | 'read-only' | 'environment' | 'toolset' | 'plan';
      tool: string;
      callId: string;
      reason: string;
    }
  | { event: 'retry'; attempt: number; error: string };

export type TraceRecord =
  /** Cabecera: una por proceso que escribe en el fichero (arranque o reanudación). */
  | {
      t: 'meta';
      v: number;
      at: number;
      sessionId: string;
      cwd?: string;
      version?: string;
      /**
       * Lo que este escritor sabe registrar además del formato base. Ausente en
       * las trazas anteriores: quien calcula métricas distingue así «no hubo
       * ninguna confirmación» de «esta traza no las registraba».
       */
      caps?: string[];
    }
  /** Empieza un turno del usuario. */
  | { t: 'turn'; at: number; input: string }
  | { t: 'turn_end'; at: number; stopReason: string | null }
  /** Paso con duración: se abre aquí y lo cierra el `end` del mismo `id`. */
  | {
      t: 'begin';
      at: number;
      id: string;
      kind: TraceKind;
      name: string;
      /** Paso que lo contiene (el subagente al que pertenece). */
      parent?: string;
      data?: TraceData;
    }
  | { t: 'end'; at: number; id: string; status: TraceStatus; data?: TraceData }
  /** Marca dentro de un paso abierto (primer token de una llamada al modelo). */
  | { t: 'mark'; at: number; id: string; name: string }
  /** Paso instantáneo. */
  | {
      t: 'point';
      at: number;
      id: string;
      kind: TraceKind;
      name: string;
      parent?: string;
      status?: TraceStatus;
      data?: TraceData;
    };
