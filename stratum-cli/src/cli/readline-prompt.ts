import type { Interface } from 'readline';

/**
 * `rl.question` que no se queda colgado (§12.12). Con la API de callback, un
 * Ctrl+C mientras se espera la respuesta **cierra** el readline sin llamar
 * nunca al callback, y no llega al proceso como `SIGINT` porque la terminal
 * está en modo raw: la confirmación destructiva de `stratum run` se quedaba
 * esperando para siempre y hacían falta tres Ctrl+C para salir.
 *
 * Aquí un Ctrl+C resuelve `null` (el llamador lo trata como «no») y se reenvía
 * al proceso como `SIGINT`, para que el comando cancele el turno como con
 * cualquier otro Ctrl+C. Un cierre del readline por otra vía (EOF en stdin)
 * también resuelve `null`.
 */
export function askLine(rl: Interface, prompt: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      rl.off('close', onClose);
      rl.off('SIGINT', onSigint);
      resolve(value);
    };
    const onClose = (): void => finish(null);
    const onSigint = (): void => {
      finish(null);
      rl.close();
      process.emit('SIGINT');
    };
    rl.once('close', onClose);
    rl.once('SIGINT', onSigint);
    rl.question(prompt, (answer) => finish(answer));
  });
}

/**
 * Retira un prompt de readline cuando su solicitud deja de estar pendiente por
 * otra vía: la resolvió otro cliente a través de `stratumd`, caducó o se
 * canceló el turno. Cerrar el readline hace que `askLine` resuelva `null`; lo
 * que devuelva el prompt después ya no cuenta para nadie.
 *
 * `onDismiss` se llama solo si fue la señal la que lo cerró. Devuelve la
 * función que suelta el enganche (para el `finally` del prompt).
 */
export function dismissOn(
  rl: Interface,
  signal: AbortSignal | undefined,
  onDismiss?: () => void,
): () => void {
  if (!signal) return () => undefined;
  const dismiss = (): void => {
    try {
      onDismiss?.();
    } finally {
      rl.close();
    }
  };
  if (signal.aborted) {
    dismiss();
    return () => undefined;
  }
  signal.addEventListener('abort', dismiss, { once: true });
  return () => signal.removeEventListener('abort', dismiss);
}
