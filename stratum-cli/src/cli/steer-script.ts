/**
 * Guion de steering para `stratum run`: una lista de acciones («cuando ocurra
 * tal evento del turno, envía este mensaje» o «cancela») que se ejecutan solas
 * mientras el agente trabaja. `run` no tiene teclado con el que escribir a
 * mitad de turno, así que esta es la forma de reproducir, de manera
 * determinista, lo que un usuario hace en el chat: es lo que usan los
 * escenarios de `stratum eval` del grupo `steering`.
 *
 * Se activa con la variable de entorno `STRATUM_STEER_SCRIPT` (ruta a un JSON
 * con la lista). No es una opción de usuario: sin la variable, `run` no cambia.
 *
 * El disparo es síncrono con el evento: una acción sin `delayMs` sobre un
 * `tool_call_ready` llega **antes** de que esa llamada se despache; con
 * `delayMs`, mientras se ejecuta.
 */
import { readFileSync } from 'fs';
import { z } from 'zod';
import type { AgentEvent } from '../agent/types.js';

export const STEER_SCRIPT_ENV = 'STRATUM_STEER_SCRIPT';

export const STEER_EVENTS = [
  'tool_call_ready',
  'tool_result',
  'text_delta',
  'subagent_started',
  'job_started',
  'job_ended',
] as const;

export const SteerActionSchema = z
  .object({
    /** Evento que dispara la acción. `job_*` vienen del `JobManager`, no del turno. */
    on: z.enum(STEER_EVENTS),
    /** `tool_call_ready` / `tool_result`: solo los de esta tool. */
    tool: z.string().min(1).optional(),
    /** `subagent`: el evento es de un subagente (`subagent_event`), no del principal. */
    in: z.enum(['main', 'subagent']).default('main'),
    /** Cuál de las apariciones dispara (la primera por defecto). */
    nth: z.number().int().positive().default(1),
    /** Espera tras el evento: para caer en mitad de una tool lenta. */
    delayMs: z.number().int().nonnegative().max(60_000).default(0),
    /** Mensaje del usuario que se envía como steering. */
    text: z.string().min(1).optional(),
    /** Cancelación explícita (lo que hace Ctrl+C). */
    cancel: z.boolean().optional(),
  })
  .strict()
  .refine((a) => (a.text !== undefined) !== (a.cancel === true), {
    message: 'indica `text` o `cancel: true` (uno de los dos)',
  });
export type SteerAction = z.infer<typeof SteerActionSchema>;

export const SteerScriptSchema = z.array(SteerActionSchema);

/** El guion de `STRATUM_STEER_SCRIPT`, o `null` si no hay. Un guion ilegible lanza. */
export function loadSteerScript(env: NodeJS.ProcessEnv = process.env): SteerAction[] | null {
  const path = env[STEER_SCRIPT_ENV];
  if (!path) return null;
  return SteerScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface SteerHost {
  /** Envía el mensaje al turno en curso; `false` si no había turno que lo aceptase. */
  /** Estado de `StratumAgent.enqueueUserMessage`: solo `accepted` encola. */
  enqueue(text: string): string;
  cancel(): void;
  log?(line: string): void;
}

export type SteerSignal = AgentEvent | { type: 'job_started' } | { type: 'job_ended' };

export interface SteerDriver {
  observe(event: SteerSignal): void;
  dispose(): void;
}

function matches(action: SteerAction, event: SteerSignal): boolean {
  let ev: SteerSignal = event;
  if (action.in === 'subagent') {
    if (event.type !== 'subagent_event') return false;
    ev = event.event;
  }
  if (ev.type !== action.on) return false;
  if (action.tool === undefined) return true;
  return (ev.type === 'tool_call_ready' || ev.type === 'tool_result') && ev.name === action.tool;
}

export function createSteerDriver(actions: readonly SteerAction[], host: SteerHost): SteerDriver {
  const seen = actions.map(() => 0);
  const fired = actions.map(() => false);
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const fire = (action: SteerAction): void => {
    if (action.cancel) {
      host.log?.('[steer] cancel');
      host.cancel();
      return;
    }
    const status = host.enqueue(action.text!);
    host.log?.(
      `[steer] ${status === 'accepted' ? 'queued as steering' : `not queued (${status})`}`,
    );
  };

  return {
    observe(event) {
      actions.forEach((action, i) => {
        if (fired[i] || !matches(action, event)) return;
        if (++seen[i]! < action.nth) return;
        fired[i] = true;
        if (action.delayMs === 0) {
          fire(action);
          return;
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          fire(action);
        }, action.delayMs);
        timers.add(timer);
      });
    },
    dispose() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
