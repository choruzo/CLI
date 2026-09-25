import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { Config } from '../../hooks/useConfig';
import { editDraft, parseDraft, providersOf, upsertProvider } from '../settings/config-draft';
import { ProviderWizard, type WizardResult } from '../settings/ProviderWizard';
import { AppLogo } from './AppLogo';

/**
 * Onboarding del primer arranque (D6): bienvenida → ProviderWizard → primera
 * conversación. Aparece mientras la config en uso no tiene un provider por
 * defecto utilizable (`applied.providerReady`), sea porque no existe
 * `.stratumrc.json` o porque no tiene ninguno. Guardar pasa por el mismo
 * borrador y la misma escritura que Ajustes (D5): el sidecar valida, escribe de
 * forma atómica y aplica la config; en cuanto llega con provider, termina.
 */

type Step = 'welcome' | 'wizard' | 'saving';

export function Onboarding({
  config,
  providerReady,
  configExists,
  onDone,
  onSkip,
}: {
  config: Config;
  providerReady: boolean;
  configExists: boolean;
  /** Provider listo: a la primera conversación. */
  onDone: () => void;
  /** «Ahora no»: la app sigue sin modelo (se puede configurar en Ajustes). */
  onSkip: () => void;
}) {
  const [step, setStep] = useState<Step>('welcome');
  const start = useRef<HTMLButtonElement>(null);
  const parsed = useMemo(() => parseDraft(config.draft), [config.draft]);
  const existing = parsed.ok ? providersOf(parsed.value).map((p) => p.name) : [];

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step === 'welcome') start.current?.focus();
  }, [step]);
  useFocusTrap(root, step !== 'wizard');

  // Guardado y aplicado por el sidecar: listo.
  useEffect(() => {
    if (step === 'saving' && providerReady) onDone();
  }, [step, providerReady, onDone]);

  // Rechazado (conflicto, inválido, error de escritura): de vuelta al wizard.
  const failed = step === 'saving' && !config.saving && (config.error || config.issues.length > 0 || config.conflict);
  useEffect(() => {
    if (failed) setStep('wizard');
  }, [failed]);

  const finish = (result: WizardResult) => {
    const next = editDraft(config.draft, (v) =>
      upsertProvider(v, result.name, result.entry, result.makeDefault),
    );
    if (next === null) {
      // El fichero en disco no es JSON: se arregla en Ajustes → Avanzado.
      setStep('welcome');
      return;
    }
    setStep('saving');
    // Si el fichero cambió mientras tanto (la CLI), se guarda igual: el wizard
    // solo añade su provider sobre lo que había.
    config.save({ text: next, force: config.conflict !== null });
  };

  const brokenFile = config.snapshot?.parseError ?? null;
  const readOnly = config.snapshot?.readOnly ?? null;

  if (step === 'wizard') {
    return (
      <ProviderWizard
        mode="add"
        existing={existing}
        config={config}
        onComplete={finish}
        onCancel={() => setStep('welcome')}
      />
    );
  }

  return (
    <div
      ref={root}
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="onboarding__card">
        <AppLogo className="onboarding__logo" />
        <h1 id="onboarding-title" className="onboarding__title">
          Te damos la bienvenida a Stratum
        </h1>
        <p className="onboarding__lead">
          Stratum es un asistente que trabaja con el modelo que tú elijas: un servidor local (Ollama,
          llama.cpp, LM Studio, vLLM…) o cualquier servicio compatible con la API de OpenAI.
        </p>
        <p className="onboarding__lead">
          {configExists
            ? 'Tu configuración todavía no tiene un modelo por defecto. Vamos a conectar uno.'
            : 'Para empezar, conecta un modelo. Se guardará en ~/.stratum/.stratumrc.json, el mismo fichero que usa la CLI.'}
        </p>
        {(brokenFile || readOnly) && (
          <p className="notice" data-tone="error" role="alert">
            {readOnly ?? `El fichero de configuración no es JSON válido: ${brokenFile}. Corrígelo en Ajustes → Avanzado.`}
          </p>
        )}
        {config.error && (
          <p className="notice" data-tone="error" role="alert">
            {config.error}
          </p>
        )}
        <div className="onboarding__actions">
          {step === 'saving' ? (
            <p className="onboarding__status" role="status">
              Guardando y conectando…
            </p>
          ) : (
            <>
              <button type="button" className="button" onClick={onSkip}>
                Ahora no
              </button>
              <button
                ref={start}
                type="button"
                className="button button--primary"
                disabled={!config.loaded || brokenFile !== null || readOnly !== null}
                onClick={() => setStep('wizard')}
              >
                Conectar un modelo
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
