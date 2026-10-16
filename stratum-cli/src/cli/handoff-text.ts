/**
 * Textos del traspaso de una sesión al daemon (M10), comunes a `/detach` en
 * `stratum chat` y a `stratum detach`. Puros: solo leen códigos y motivos del
 * contrato (`HandoffBlocker`), nunca un mensaje de otro proceso.
 */

/** Por qué no se traspasó, para una persona. */
export function describeDetachRefusal(code: string, reason?: string): string {
  switch (reason) {
    case 'run-active':
      return 'the agent is working (or waiting for an approval); try again when the turn ends';
    case 'handoff-in-progress':
      return 'a handoff is already in progress';
    case 'jobs-running':
      return 'a background job is running in this terminal; wait for it or cancel it (/jobs)';
    case 'inbox-pending':
      return 'the agent has updates it has not seen yet; send a turn first';
    case 'background-work':
      return 'background work (memory extraction) is still running; try again in a moment';
    case 'unsupported-host':
      return 'this kind of session cannot be handed off (only `stratum chat` sessions can)';
    case 'startup':
      return (
        'stratumd cannot start this session with its own environment ' +
        '(configuration, provider, model or agent profile)'
      );
    case 'cwd':
      return 'stratumd cannot use the session directory';
    case 'context':
      return 'the session context could not be transferred';
    case 'changed':
      return 'the session changed during the handoff; try again';
    case 'host-unavailable':
      return 'the process hosting the session did not answer';
    default:
      break;
  }
  switch (code) {
    case 'NOT_FOUND':
      return 'no live session with that id';
    case 'FORBIDDEN':
      return 'not allowed';
    case 'UNAVAILABLE':
      return 'stratumd is not available';
    default:
      return code.toLowerCase().replace(/_/g, ' ');
  }
}

/** Lo que se dice cuando la sesión ya es del daemon. */
export function handedOffNotice(sessionId: string): string {
  return (
    `Session ${sessionId} is now hosted by stratumd: this terminal no longer runs it. ` +
    `Continue with: stratum attach ${sessionId}`
  );
}
