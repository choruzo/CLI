import { compareRevision } from './index';

/** Un desfase entre la revisión del protocolo de Dot y la del daemon. */
export interface RevisionSkewNotice {
  kind: 'server-older' | 'server-newer';
  title: string;
  body: string;
}

/**
 * M23 — el aviso de desfase Dot ↔ daemon, o `null` si no lo hay. Puro: solo
 * compara la revisión que anunció el daemon en `core.hello` con la de este
 * Dot (`compareRevision`, del contrato). **Solo informa**: nunca decide si se
 * conecta ni reinicia nada. `serverRevision` nulo es un daemon anterior a que
 * la anunciara, y cuenta como más viejo.
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
      title: 'The Stratum daemon is older than this Dot',
      body:
        `It runs Stratum ${serverVersion}, so some features may not work. If you already updated the CLI, ` +
        'restart the daemon: stratum daemon stop, then stratum daemon start. If not, update the CLI first.',
    };
  }
  return {
    kind: 'server-newer',
    title: 'This Dot is older than the Stratum daemon',
    body: `The daemon runs Stratum ${serverVersion}. Dot keeps working, but what is new will not show until you update Dot.`,
  };
}
