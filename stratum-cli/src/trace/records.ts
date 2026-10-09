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
 *  - `model` — una llamada al LLM; `data.origin` dice quién la hizo (`LlmCallOrigin`)
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
 * `meta.caps`: el escritor registra **todas** las llamadas al LLM, también las
 * auxiliares, y cada paso `model` lleva su origen en `data.origin`. Sin este
 * cap, que no haya llamadas auxiliares en la traza no significa que no las
 * hubiera: quien calcula métricas las da por desconocidas (`null`), nunca por 0.
 */
export const TRACE_CAP_LLM_ORIGIN = 'llm-origin';

/**
 * `meta.caps`: el escritor registra el ciclo de vida de los jobs en segundo
 * plano (`TraceJobEvent`). Sin él, las métricas de jobs son desconocidas.
 */
export const TRACE_CAP_JOBS = 'jobs';

/**
 * Quién hizo una llamada al LLM (`data.origin` de un paso `model`):
 *  - `agent` — el loop del agente principal;
 *  - `subagent` — el loop de un subagente (su paso lleva además `parent`);
 *  - `memory-extraction` — la extracción automática de decisiones tras un turno;
 *  - `context-compression` — el resumen del historial (umbral o `/compact`);
 *  - `session-summary` — el resumen de una línea al guardar la sesión.
 *
 * Las tres últimas son **auxiliares**: no las pide el modelo ni forman parte del
 * turno, pero ocupan el backend y su caché igual que las demás.
 */
export const LLM_CALL_ORIGINS = [
  'agent',
  'subagent',
  'memory-extraction',
  'context-compression',
  'session-summary',
] as const;
export type LlmCallOrigin = (typeof LLM_CALL_ORIGINS)[number];

export const AUXILIARY_LLM_ORIGINS = [
  'memory-extraction',
  'context-compression',
  'session-summary',
] as const satisfies readonly LlmCallOrigin[];
export type AuxiliaryLlmOrigin = (typeof AUXILIARY_LLM_ORIGINS)[number];

export function isAuxiliaryOrigin(origin: LlmCallOrigin): origin is AuxiliaryLlmOrigin {
  return (AUXILIARY_LLM_ORIGINS as readonly string[]).includes(origin);
}

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
 *  - `job` — ciclo de vida de un job en segundo plano (`exec` con `background:
 *    true`, `jobs/manager.ts`): `created` → `started` (con `pid`) → `ended`
 *    (estado, exit code, duración, bytes de cada stream y si su salida se
 *    leyó); `read` cada vez que un agente lee su salida, `cancel` cuando se
 *    pide cancelarlo y `notified` cuando el aviso de fin entra en el contexto
 *    del agente. Nunca llevan la salida del job, solo recuentos.
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
  | { event: 'retry'; attempt: number; error: string }
  | TraceJobEvent;

export type TraceJobEvent =
  | { event: 'job'; phase: 'created'; jobId: string; command: string; cwd: string; scope: string }
  | { event: 'job'; phase: 'started'; jobId: string; pid: number | null }
  | {
      event: 'job';
      phase: 'ended';
      jobId: string;
      status: 'completed' | 'failed' | 'cancelled';
      exitCode: number | null;
      reason: string;
      durationMs: number;
      stdoutBytes: number;
      stderrBytes: number;
      /** Caracteres que el límite de buffer descartó antes de que nadie los leyera. */
      droppedChars: number;
      /** Si algún agente había leído su salida al terminar (ver también `read`). */
      outputRead: boolean;
    }
  | {
      event: 'job';
      phase: 'read';
      jobId: string;
      scope: string;
      offset: number;
      chars: number;
      finished: boolean;
    }
  | { event: 'job'; phase: 'cancel'; jobId: string; scope: string; reason: string }
  | { event: 'job'; phase: 'notified'; jobId: string; status: string; scope: string };

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
