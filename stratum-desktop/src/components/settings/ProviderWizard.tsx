import { useEffect, useId, useRef, useState } from 'react';
import {
  PROVIDER_TYPE_PRESETS,
  buildProviderEntry,
  validateAlias,
  validateBaseUrl,
  type ProviderTypePreset,
} from '../../../../stratum-cli/src/cli/ui/wizard-logic';
import { SECRET_PLACEHOLDER } from '../../ipc/types';
import type { Config } from '../../hooks/useConfig';
import { SecretInput } from './fields';
import type { ProviderEntry } from './config-draft';

/**
 * ProviderWizard de la CLI (Hito 3.5) portado a modal (D5). Mismo flujo y la
 * misma lógica (`wizard-logic.ts`, importada, no copiada): tipo → URL y API
 * key → nombre → modelo (`/models`, o a mano si el endpoint no lista) →
 * activar. El sondeo lo hace el sidecar: el webview no sale a la red, y una key
 * guardada no pasa por aquí.
 */

type Step = 'type' | 'connection' | 'name' | 'model' | 'finish';

export interface WizardResult {
  name: string;
  entry: Record<string, unknown>;
  makeDefault: boolean;
}

function originOf(url: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return url.trim();
  }
}

export function ProviderWizard({
  mode,
  existing,
  initial,
  isDefault,
  config,
  onComplete,
  onCancel,
}: {
  mode: 'add' | 'edit';
  /** Nombres ya usados (colisiones al añadir). */
  existing: string[];
  initial?: ProviderEntry;
  isDefault?: boolean;
  config: Pick<Config, 'probe' | 'probeResult'>;
  onComplete: (result: WizardResult) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const urlId = useId();
  const keyId = useId();
  const nameId = useId();
  const modelId = useId();
  const ctxId = useId();
  const [step, setStep] = useState<Step>(mode === 'edit' ? 'connection' : 'type');
  const [preset, setPreset] = useState<ProviderTypePreset | null>(null);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [contextWindow, setContextWindow] = useState(String(initial?.contextWindow ?? 32768));
  const [makeDefault, setMakeDefault] = useState(isDefault ?? existing.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [probeId, setProbeId] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, [step]);

  // La key guardada solo vale para su servidor (el sidecar tampoco la usaría).
  const keyForOtherServer =
    mode === 'edit' &&
    apiKey === SECRET_PLACEHOLDER &&
    initial !== undefined &&
    originOf(baseUrl) !== originOf(initial.baseUrl);

  const probe = probeId ? config.probeResult(probeId) : null;
  const probing = probeId !== null && probe === null;

  const startProbe = () => {
    setProbeId(
      config.probe({
        baseUrl: baseUrl.trim(),
        ...(apiKey !== SECRET_PLACEHOLDER ? { apiKey } : {}),
        ...(mode === 'edit' && initial ? { provider: initial.name } : {}),
      }),
    );
  };

  const next = () => {
    setError(null);
    switch (step) {
      case 'connection': {
        const e = validateBaseUrl(baseUrl);
        if (e) return setError(e);
        if (keyForOtherServer) {
          return setError('La URL es de otro servidor: escribe la API key para esta URL.');
        }
        if (mode === 'edit') {
          setStep('model');
          startProbe();
        } else setStep('name');
        return;
      }
      case 'name': {
        const e = validateAlias(name, existing);
        if (e) return setError(e);
        setStep('model');
        startProbe();
        return;
      }
      case 'model': {
        if (!model.trim()) return setError('Elige o escribe un modelo.');
        const cw = Number(contextWindow);
        if (!Number.isInteger(cw) || cw <= 0) {
          return setError('La ventana de contexto tiene que ser un entero positivo.');
        }
        setStep('finish');
        return;
      }
      case 'finish':
        onComplete({
          name: name.trim(),
          entry: buildProviderEntry({
            baseUrl,
            apiKey,
            model,
            contextWindow: Number(contextWindow),
          }),
          makeDefault,
        });
        return;
    }
  };

  const titles: Record<Step, string> = {
    type: 'Tipo de provider',
    connection: 'Conexión',
    name: 'Nombre del provider',
    model: 'Modelo por defecto',
    finish: mode === 'add' ? '¿Activar ahora?' : 'Guardar cambios',
  };

  const body = () => {
    switch (step) {
      case 'type':
        return (
          <ul className="wizard__choices">
            {PROVIDER_TYPE_PRESETS.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="wizard__choice"
                  onClick={() => {
                    setPreset(p);
                    setBaseUrl(p.defaultBaseUrl);
                    setApiKey(p.requiresApiKey ? '' : p.defaultApiKey);
                    setStep('connection');
                  }}
                >
                  <strong>{p.label}</strong>
                  {p.defaultBaseUrl && <span>{p.defaultBaseUrl}</span>}
                </button>
              </li>
            ))}
          </ul>
        );
      case 'connection':
        return (
          <>
            <label className="settings-field__label" htmlFor={urlId}>
              Base URL
            </label>
            <input
              id={urlId}
              className="settings-input"
              type="text"
              spellCheck={false}
              value={baseUrl}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <label className="settings-field__label" htmlFor={keyId}>
              API key {preset && !preset.requiresApiKey && '(opcional)'}
            </label>
            <SecretInput id={keyId} value={apiKey} onChange={setApiKey} />
            <p className="settings-field__hint">
              Mejor como referencia <code>{'${VARIABLE}'}</code>: la config guarda el nombre y la
              key se lee del entorno al arrancar.
            </p>
          </>
        );
      case 'name':
        return (
          <>
            <label className="settings-field__label" htmlFor={nameId}>
              Nombre (alias)
            </label>
            <input
              id={nameId}
              className="settings-input"
              type="text"
              spellCheck={false}
              value={name}
              placeholder={preset?.id ?? 'mi-provider'}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="settings-field__hint">Letras, números, guiones y guiones bajos.</p>
          </>
        );
      case 'model':
        return (
          <>
            {probing && <p className="notice">Detectando modelos en {baseUrl.trim()}…</p>}
            {probe && probe.models.length > 0 && (
              <ul className="wizard__models" role="listbox" aria-label="Modelos disponibles">
                {probe.models.map((m) => (
                  <li key={m}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={m === model}
                      className="wizard__model"
                      onClick={() => setModel(m)}
                    >
                      {m}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {probe?.error && (
              <p className="notice" data-tone="warning">
                No se pudieron listar los modelos ({probe.error}). Escribe el nombre a mano.
              </p>
            )}
            <label className="settings-field__label" htmlFor={modelId}>
              Modelo
            </label>
            <input
              id={modelId}
              className="settings-input"
              type="text"
              spellCheck={false}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <label className="settings-field__label" htmlFor={ctxId}>
              Ventana de contexto (tokens)
            </label>
            <input
              id={ctxId}
              className="settings-input settings-input--number"
              type="text"
              inputMode="numeric"
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
            />
            {!probing && (
              <button type="button" className="link-button" onClick={startProbe}>
                Volver a detectar
              </button>
            )}
          </>
        );
      case 'finish':
        return (
          <>
            <dl className="facts">
              <dt>Nombre</dt>
              <dd>{name.trim()}</dd>
              <dt>URL</dt>
              <dd>{baseUrl.trim()}</dd>
              <dt>Modelo</dt>
              <dd>{model.trim()}</dd>
            </dl>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(e) => setMakeDefault(e.target.checked)}
              />
              Usarlo por defecto en las conversaciones nuevas
            </label>
          </>
        );
    }
  };

  return (
    <div className="wizard-backdrop" role="presentation">
      <div
        ref={dialog}
        className="wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <header className="wizard__header">
          <h2 id={titleId} className="wizard__title">
            {mode === 'add' ? 'Añadir provider' : `Editar «${initial?.name ?? ''}»`} · {titles[step]}
          </h2>
          <button type="button" className="icon-button" aria-label="Cancelar" onClick={onCancel}>
            ×
          </button>
        </header>
        <form
          className="wizard__body"
          onSubmit={(e) => {
            e.preventDefault();
            next();
          }}
        >
          {body()}
          {error && (
            <p className="notice" data-tone="error" role="alert">
              {error}
            </p>
          )}
          {step !== 'type' && (
            <footer className="wizard__actions">
              <button type="button" className="button" onClick={onCancel}>
                Cancelar
              </button>
              <button type="submit" className="button button--primary" disabled={probing}>
                {step === 'finish' ? 'Guardar' : 'Siguiente'}
              </button>
            </footer>
          )}
        </form>
      </div>
    </div>
  );
}
