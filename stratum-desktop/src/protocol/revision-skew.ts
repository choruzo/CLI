import { compareRevision } from './index';

/** Un desfase entre la revisión del protocolo de Desktop y la del daemon. */
export interface RevisionSkewNotice {
  kind: 'server-older' | 'server-newer';
  title: string;
  body: string;
}

/**
 * M23 — el aviso de desfase Desktop ↔ daemon, o `null` si no lo hay (texto en
 * español, como el resto de Desktop). Puro: compara la revisión que anunció el
 * daemon en `core.hello` con la de este Desktop. **Solo informa**: nunca decide
 * si se conecta ni reinicia nada. `serverRevision` nulo es un daemon anterior a
 * que la anunciara, y cuenta como más viejo.
 */
export function revisionSkewNotice(
  serverRevision: number | null | undefined,
  serverVersion: string,
): RevisionSkewNotice | null {
  const skew = compareRevision(serverRevision ?? undefined);
  if (skew === 'same') return null;
  if (skew === 'server-older') {
    return {
      kind: 'server-older',
      title: 'El daemon de Stratum es más antiguo que este Desktop',
      body:
        `Corre Stratum ${serverVersion}, así que algunas funciones pueden no ir. Si ya actualizaste la CLI, ` +
        'reinicia el daemon: stratum daemon stop y luego stratum daemon start. Si no, actualiza antes la CLI.',
    };
  }
  return {
    kind: 'server-newer',
    title: 'Este Desktop es más antiguo que el daemon de Stratum',
    body: `El daemon corre Stratum ${serverVersion}. Desktop sigue funcionando, pero lo nuevo no se verá hasta que lo actualices.`,
  };
}
