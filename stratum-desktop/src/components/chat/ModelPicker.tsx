import { useState } from 'react';
import type { ProtocolModel } from '../../protocol';

/** Un provider (alias de la config) y un modelo suyo. */
export interface ModelChoice {
  provider: string;
  model: string;
}

/** Lo que se ofrece al elegir modelo: lo que lista `models.list` y lo actual. */
export interface ModelsOffer {
  /** `null` mientras el daemon aún no ha contestado. */
  models: ProtocolModel[] | null;
  /** Lo de la sesión, o lo elegido para la conversación nueva; `null` si no se sabe. */
  current: ModelChoice | null;
  /** El daemon no pudo listarlos (o la lista está incompleta). */
  error?: string;
}

/** Los providers en el orden en que los lista el daemon, con el actual aunque no liste nada. */
export function providersOf(offer: ModelsOffer): string[] {
  const names = [...new Set((offer.models ?? []).map((m) => m.provider))];
  if (offer.current && !names.includes(offer.current.provider)) names.unshift(offer.current.provider);
  return names;
}

/**
 * Elegir provider y modelo (botón del composer o `/model` sin argumento). Con
 * varios providers, primero se elige el provider y después uno de sus modelos;
 * con uno solo, se va directo a sus modelos. Si el backend no lista modelos
 * (llama.cpp sin `/models`), se escribe a mano. En una sesión, solo cambia el
 * de esa sesión (`sessions.setModel`); en una conversación nueva, el de la
 * sesión que se abrirá.
 */
export function ModelPicker({
  offer,
  onPick,
  onClose,
}: {
  offer: ModelsOffer;
  onPick: (choice: ModelChoice) => void;
  onClose: () => void;
}) {
  const providers = providersOf(offer);
  const single = providers.length === 1 ? providers[0]! : null;
  const [chosen, setChosen] = useState<string | null>(null);
  const provider = chosen ?? single;
  const [manual, setManual] = useState('');

  const models = provider ? (offer.models ?? []).filter((m) => m.provider === provider) : [];
  const isCurrent = (p: string, m?: string) =>
    offer.current?.provider === p && (m === undefined || offer.current.model === m);

  return (
    <section
      className="model-picker"
      aria-label="Modelo de esta conversación"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (chosen && !single) setChosen(null);
          else onClose();
        }
      }}
    >
      <header className="model-picker__header">
        {provider && !single ? (
          <button
            type="button"
            className="model-picker__back"
            aria-label="Volver a los providers"
            onClick={() => {
              setChosen(null);
              setManual('');
            }}
          >
            ‹ <strong>{provider}</strong>
          </button>
        ) : (
          <strong>{provider ? `Modelos de ${provider}` : 'Elige un provider'}</strong>
        )}
        <button type="button" className="icon-button" aria-label="Cerrar" onClick={onClose}>
          ×
        </button>
      </header>
      {offer.error && (
        <p className="notice" data-tone="warning">
          {offer.error}
        </p>
      )}
      {offer.models === null && providers.length === 0 && (
        <p className="model-picker__loading" role="status">
          Pidiendo los modelos…
        </p>
      )}
      {!provider && providers.length > 0 && (
        <ul className="model-picker__list" role="listbox" aria-label="Providers">
          {providers.map((p, i) => {
            const count = (offer.models ?? []).filter((m) => m.provider === p).length;
            return (
              <li key={p} role="option" aria-selected={isCurrent(p)}>
                <button
                  type="button"
                  className="model-picker__item"
                  data-current={isCurrent(p) || undefined}
                  autoFocus={i === 0}
                  onClick={() => setChosen(p)}
                >
                  {p}
                  <span className="model-picker__current">
                    {' '}
                    · {count === 1 ? '1 modelo' : `${count} modelos`}
                    {isCurrent(p) && ' · actual'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {provider && models.length > 0 && (
        <ul className="model-picker__list" role="listbox" aria-label="Modelos disponibles">
          {models.map((m, i) => (
            <li key={m.id} role="option" aria-selected={isCurrent(provider, m.id)}>
              <button
                type="button"
                className="model-picker__item"
                data-current={isCurrent(provider, m.id) || undefined}
                autoFocus={i === 0}
                onClick={() => onPick({ provider, model: m.id })}
              >
                {m.id}
                {isCurrent(provider, m.id) && <span className="model-picker__current"> · actual</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {provider && (
        <form
          className="model-picker__manual"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) onPick({ provider, model: manual.trim() });
          }}
        >
          <input
            className="side-panel__search"
            aria-label="Nombre del modelo"
            placeholder={models.length > 0 ? 'Otro modelo' : `Modelo de ${provider} (no lista los suyos)`}
            value={manual}
            autoFocus={models.length === 0}
            onChange={(e) => setManual(e.target.value)}
          />
          <button type="submit" className="button" disabled={!manual.trim()}>
            Usar
          </button>
        </form>
      )}
    </section>
  );
}
