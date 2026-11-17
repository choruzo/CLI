/**
 * M21 — `reminders.*`: los errores del almacén traducidos al protocolo
 * (`docs/protocol.md` §30). No hay más DTO: un recordatorio ya es lo que va por
 * el protocolo, sin campos derivados.
 *
 * Nada aquí loguea: el texto del aviso lo escribió la persona y nunca va a los
 * logs.
 */
import { ProtocolError } from '../ipc/codec.js';
import { ReminderStoreError } from '../reminders/store.js';

/** Ejecuta una operación del planificador con los errores del almacén como errores del protocolo. */
export async function reminderOperation<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ReminderStoreError)) throw err;
    switch (err.code) {
      case 'not-found':
        throw new ProtocolError('NOT_FOUND', 'Reminder not found.');
      case 'read-only':
        throw new ProtocolError('UNAVAILABLE', err.message, { reason: 'read-only' });
      case 'invalid': {
        // El almacén dice «Invalid <campo>: …»; sin campo, el recordatorio entero.
        const path = /^Invalid ([A-Za-z.]+):/.exec(err.message)?.[1] ?? 'reminder';
        throw new ProtocolError('INVALID_PARAMS', err.message, {
          issues: [{ path, message: err.message }],
        });
      }
    }
  }
}
