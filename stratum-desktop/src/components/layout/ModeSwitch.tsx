import type { KeyboardEvent } from 'react';
import { APP_MODES, MODE_LABEL, type AppMode } from '../../view/mode';

const HINT: Record<AppMode, string> = {
  chat: 'Chat: conversar con el asistente (Ctrl+1)',
  code: 'Código: el agente de código en la carpeta de un proyecto (Ctrl+2)',
};

/**
 * Conmutador Chat | Código, centrado en la barra de título. Es un grupo de
 * radio (una opción siempre elegida): ← → cambian de modo y solo la opción
 * activa entra en el orden de tabulación.
 */
export function ModeSwitch({
  mode,
  onChange,
  badges,
}: {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  /** El otro modo tiene una sesión esperando a una persona. */
  badges?: Partial<Record<AppMode, boolean>>;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = APP_MODES.indexOf(mode);
    const next = APP_MODES[(at + (e.key === 'ArrowRight' ? 1 : -1) + APP_MODES.length) % APP_MODES.length]!;
    onChange(next);
    const group = e.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Modo" data-mode={mode} onKeyDown={onKeyDown}>
      <span className="mode-switch__thumb" aria-hidden="true" />
      {APP_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          className="mode-switch__option"
          aria-checked={m === mode}
          tabIndex={m === mode ? 0 : -1}
          title={HINT[m]}
          onClick={() => m !== mode && onChange(m)}
        >
          {MODE_LABEL[m]}
          {badges?.[m] && m !== mode && (
            <span className="mode-switch__badge" role="img" aria-label="hay una sesión esperando respuesta" />
          )}
        </button>
      ))}
    </div>
  );
}
