import {
  SHOW_ELAPSED_AFTER_MS,
  formatElapsed,
  thinkingPhrase,
  type ThinkingPhase,
} from './thinking-phrases';

/**
 * Indicador de que el agente sigue trabajando (D7): tres capas que se
 * depositan una tras otra y una frase que rota. La frase no es una región
 * viva: un lector de pantalla oiría una cada cuatro segundos. El anuncio lo
 * hace `ConversationView` una vez por turno.
 */
export function ThinkingIndicator({
  seed,
  phase,
  elapsedMs,
}: {
  /** Id del turno: cada turno empieza por una frase distinta. */
  seed: string;
  phase: ThinkingPhase;
  elapsedMs: number;
}) {
  const phrase = thinkingPhrase(seed, phase, elapsedMs);
  return (
    <div className="thinking" data-phase={phase}>
      <span className="strata-loader" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {/* `key`: al cambiar la frase, entra con su animación. */}
      <span key={phrase} className="thinking__phrase">
        {phrase}
      </span>
      {elapsedMs >= SHOW_ELAPSED_AFTER_MS && (
        <span className="thinking__meta">
          {formatElapsed(elapsedMs)} · <kbd>Esc</kbd> para detener
        </span>
      )}
    </div>
  );
}
