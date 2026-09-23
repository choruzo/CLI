import { useState } from 'react';
import type { ModelsOffer } from '../../hooks/useConversations';

/**
 * `/model` sin argumento (D4): los modelos que lista el provider, o entrada
 * manual si no los lista (llama.cpp sin `/models`). Solo cambia el modelo de
 * esta conversación.
 */
export function ModelPicker({
  offer,
  onPick,
  onClose,
}: {
  offer: ModelsOffer;
  onPick: (model: string) => void;
  onClose: () => void;
}) {
  const [manual, setManual] = useState('');
  return (
    <section
      className="model-picker"
      aria-label="Modelo de esta conversación"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="model-picker__header">
        <strong>Modelo de esta conversación</strong>
        <button type="button" className="icon-button" aria-label="Cerrar" onClick={onClose}>
          ×
        </button>
      </header>
      {offer.error && (
        <p className="notice" data-tone="warning">
          El provider no lista sus modelos ({offer.error}). Escribe el nombre a mano.
        </p>
      )}
      {offer.models.length > 0 && (
        <ul className="model-picker__list" role="listbox" aria-label="Modelos disponibles">
          {offer.models.map((m, i) => (
            <li key={m} role="option" aria-selected={m === offer.current}>
              <button
                type="button"
                className="model-picker__item"
                data-current={m === offer.current || undefined}
                autoFocus={i === 0}
                onClick={() => onPick(m)}
              >
                {m}
                {m === offer.current && <span className="model-picker__current"> · actual</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="model-picker__manual"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) onPick(manual);
        }}
      >
        <input
          className="side-panel__search"
          aria-label="Nombre del modelo"
          placeholder={`Otro modelo (actual: ${offer.current})`}
          value={manual}
          autoFocus={offer.models.length === 0}
          onChange={(e) => setManual(e.target.value)}
        />
        <button type="submit" className="button" disabled={!manual.trim()}>
          Usar
        </button>
      </form>
    </section>
  );
}
