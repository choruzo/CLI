/**
 * La pregunta lateral (`/btw`) y su respuesta. No es parte de la conversación:
 * no entra en el historial ni en el contexto del agente, y por eso se pinta
 * aparte, encima del campo, y se cierra a mano. Solo vive en la interfaz: al
 * cambiar de sesión o cerrar Desktop se pierde, como en la terminal.
 */
export type SideQuestion =
  | { sessionId: string; question: string; status: 'pending' }
  | { sessionId: string; question: string; status: 'done'; answer: string; truncated: boolean }
  | { sessionId: string; question: string; status: 'failed'; message: string };

export function SideAnswer({ side, onClose }: { side: SideQuestion; onClose: () => void }) {
  return (
    <section className="side-answer" aria-label="Pregunta lateral" data-status={side.status}>
      <header className="side-answer__head">
        <span className="side-answer__label">Pregunta lateral · no entra en la conversación</span>
        <button type="button" className="icon-button" aria-label="Cerrar la pregunta lateral" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="side-answer__question">{side.question}</p>
      {side.status === 'pending' && (
        <p className="side-answer__body" role="status">
          Pensando…
        </p>
      )}
      {side.status === 'done' && (
        <>
          <p className="side-answer__body">{side.answer || '(sin respuesta)'}</p>
          {side.truncated && <p className="side-answer__note">La respuesta era más larga: se enseña el principio.</p>}
        </>
      )}
      {side.status === 'failed' && (
        <p className="notice" data-tone="warning" role="alert">
          {side.message}
        </p>
      )}
    </section>
  );
}
