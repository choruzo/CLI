import { useEffect, useState, type ReactNode } from 'react';
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from '../../ipc/window';
import { AppLogo } from '../onboarding/AppLogo';

/** Alto de la barra: el mismo en CSS (`--titlebar-height`). */
export const TITLEBAR_HEIGHT = 32;

const GLYPH = {
  minimize: 'M4 8.5h8',
  maximize: 'M4.5 4.5h7v7h-7z',
  restore: 'M6.5 4.5h5v5M4.5 6.5h5v5h-5z',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
} as const;

const Glyph = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

/**
 * Barra de título propia de la ventana frameless (D7, 15.14): 32 px con el
 * logo, el título de la conversación y los controles ─ □ ×. Todo lo que no es
 * un control arrastra la ventana; el doble clic maximiza. Los controles son
 * botones de verdad (Tab, Enter, nombre accesible), no zonas pintadas.
 *
 * `modes` es el hueco del conmutador Chat | Code de D8.
 */
export function TitleBar({ title, modes }: { title?: string | null; modes?: ReactNode }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    const refresh = () =>
      isWindowMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => undefined);
    refresh();
    onWindowResized(refresh)
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const run = (action: () => Promise<void>) => () => {
    action().catch((err) => console.warn('[stratum] control de ventana', err));
  };

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar__brand" data-tauri-drag-region>
        <AppLogo className="titlebar__logo" />
        <span className="titlebar__name" data-tauri-drag-region>
          Stratum
        </span>
      </div>
      <div className="titlebar__modes">{modes}</div>
      <div className="titlebar__title" data-tauri-drag-region title={title ?? undefined}>
        {title}
      </div>
      <div className="titlebar__controls" role="group" aria-label="Ventana">
        <button
          type="button"
          className="titlebar__control"
          aria-label="Minimizar"
          title="Minimizar"
          onClick={run(minimizeWindow)}
        >
          <Glyph d={GLYPH.minimize} />
        </button>
        <button
          type="button"
          className="titlebar__control"
          aria-label={maximized ? 'Restaurar' : 'Maximizar'}
          title={maximized ? 'Restaurar' : 'Maximizar'}
          onClick={run(toggleMaximizeWindow)}
        >
          <Glyph d={maximized ? GLYPH.restore : GLYPH.maximize} />
        </button>
        <button
          type="button"
          className="titlebar__control titlebar__control--close"
          aria-label="Cerrar"
          title="Cerrar"
          onClick={run(closeWindow)}
        >
          <Glyph d={GLYPH.close} />
        </button>
      </div>
    </header>
  );
}
