/**
 * Textos en español del traspaso de una sesión al daemon (M10) que solo pinta
 * la TUI de `stratum chat`. `../handoff-text.ts` sigue en inglés porque también
 * lo usan `stratum detach` y `stratum attach`.
 */

/** Por qué no se traspasó, para una persona. */
export function describeDetachRefusalEs(code: string, reason?: string): string {
  switch (reason) {
    case 'run-active':
      return 'el agente está trabajando (o esperando una aprobación); inténtalo cuando acabe el turno';
    case 'handoff-in-progress':
      return 'ya hay un traspaso en curso';
    case 'jobs-running':
      return 'hay un job en segundo plano en esta terminal; espera a que acabe o cancélalo (/jobs)';
    case 'inbox-pending':
      return 'el agente tiene mensajes que aún no ha visto; envía un turno antes';
    case 'background-work':
      return 'sigue en marcha trabajo en segundo plano (extracción de memoria); inténtalo en un momento';
    case 'unsupported-host':
      return 'este tipo de sesión no se puede traspasar (solo las de `stratum chat`)';
    case 'startup':
      return (
        'stratumd no puede arrancar esta sesión con su propio entorno ' +
        '(configuración, provider, modelo o perfil de agente)'
      );
    case 'cwd':
      return 'stratumd no puede usar el directorio de la sesión';
    case 'context':
      return 'no se pudo transferir el contexto de la sesión';
    case 'changed':
      return 'la sesión cambió durante el traspaso; inténtalo de nuevo';
    case 'host-unavailable':
      return 'el proceso que aloja la sesión no respondió';
    default:
      break;
  }
  switch (code) {
    case 'NOT_FOUND':
      return 'no hay ninguna sesión viva con ese id';
    case 'FORBIDDEN':
      return 'no permitido';
    case 'UNAVAILABLE':
      return 'stratumd no está disponible';
    default:
      return code.toLowerCase().replace(/_/g, ' ');
  }
}

/** Lo que se dice cuando la sesión ya es del daemon. */
export function handedOffNoticeEs(sessionId: string): string {
  return (
    `La sesión ${sessionId} ya la aloja stratumd: esta terminal deja de ejecutarla. ` +
    `Continúa con: stratum attach ${sessionId}`
  );
}
