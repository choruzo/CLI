import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BROWSER_POLL_MS,
  describeUnavailable,
  moveBrowser,
  normalizeAddress,
  readBrowser,
  type BrowserAction,
  type BrowserScreen,
  type BrowserStatus,
} from '../../client/browser';
import { openExternal } from '../../ipc/external';
import type { NativeBridge } from '../../ipc/native';
import { ICON, StrokeIcon } from '../chat/icons';

const STORAGE_KEY = 'stratum.rightPanel';

export type RightPanel = 'trajectory' | 'browser';

/** Qué panel de la derecha estaba abierto (comodidad de la interfaz). Solo uno a la vez. */
export function loadRightPanel(): RightPanel | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'trajectory' || raw === 'browser') return raw;
    // Antes de que hubiera navegador solo se recordaba la trayectoria.
    if (raw === null && localStorage.getItem('stratum.trajectory') === '1') return 'trajectory';
  } catch {
    /* sin almacenamiento */
  }
  return null;
}

export function saveRightPanel(panel: RightPanel | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, panel ?? 'none');
  } catch {
    /* no crítico */
  }
}

const NAV = {
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
} as const;

/**
 * El navegador de la sesión que se mira: lo que el agente está viendo cuando
 * comprueba su trabajo. Vive en el daemon; aquí se enseña su captura, de solo
 * lectura y pedida cada poco mientras el panel está abierto. Con la sesión en
 * reposo la persona puede ir a una dirección local, recargar y moverse por el
 * historial; con un turno en marcha el navegador es del agente.
 */
export function BrowserPanel({
  native,
  sessionId,
  connected,
  running,
  width,
  onClose,
}: {
  native: NativeBridge;
  /** La sesión que se mira, si el daemon la conoce. */
  sessionId: string | null;
  connected: boolean;
  /** Hay un turno en marcha: el agente puede estar usándolo. */
  running: boolean;
  width?: number | null;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [screen, setScreen] = useState<BrowserScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const round = useRef(0);

  const read = useCallback(async () => {
    if (!sessionId || !connected) return;
    const mine = ++round.current;
    const result = await readBrowser(native, sessionId);
    if (mine !== round.current) return;
    if (result.ok) {
      setStatus(result.view.browser);
      // Sin captura nueva se conserva la última solo si el navegador sigue abierto.
      setScreen((prev) => result.view.screen ?? (result.view.browser.state === 'open' ? prev : null));
      setError(null);
    } else setError(result.message);
  }, [native, sessionId, connected]);

  // Otra sesión: lo que se veía no es suyo.
  useEffect(() => {
    setStatus(null);
    setScreen(null);
    setError(null);
    setNotice(null);
    setEditing(false);
    return () => {
      round.current++;
    };
  }, [sessionId]);

  // Sondeo mientras el panel está abierto; más espaciado en reposo y con la ventana oculta.
  const unavailable = status?.state === 'unavailable';
  useEffect(() => {
    if (!sessionId || !connected || unavailable) return;
    let timer: number | undefined;
    let stopped = false;
    const tick = async () => {
      await read();
      if (stopped) return;
      const wait = document.hidden ? BROWSER_POLL_MS.hidden : running ? BROWSER_POLL_MS.inUse : BROWSER_POLL_MS.idle;
      timer = window.setTimeout(() => void tick(), wait);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [read, sessionId, connected, running, unavailable]);

  // La barra sigue a la página salvo mientras se escribe en ella.
  const url = status?.state === 'open' ? (status.url ?? '') : '';
  useEffect(() => {
    if (!editing) setAddress(url);
  }, [url, editing]);

  const move = async (action: BrowserAction, target?: string) => {
    if (!sessionId || moving) return;
    setMoving(true);
    setNotice(null);
    const result = await moveBrowser(native, sessionId, action, target);
    setMoving(false);
    if (!result.ok) setNotice(result.message);
    else setEditing(false);
    await read();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const target = normalizeAddress(address);
    if (!target) {
      setNotice('Escribe una dirección http(s), por ejemplo localhost:3000.');
      return;
    }
    void move('goto', target);
  };

  const open = status?.state === 'open';
  const canMove = connected && sessionId !== null && !running && !moving && !unavailable;
  const busyHint = running ? 'El agente está trabajando: el navegador es suyo hasta que acabe el turno' : undefined;

  const body = () => {
    if (!sessionId) return <p className="browser__empty">Abre una sesión para ver su navegador.</p>;
    if (!connected) return <p className="browser__empty">Sin conexión con Stratum.</p>;
    if (error && !status) {
      return (
        <p className="notice" data-tone="warning" role="alert">
          {error}
        </p>
      );
    }
    if (!status) return <p className="browser__empty">Preguntando por el navegador…</p>;
    if (status.state === 'unavailable') return <p className="browser__empty">{describeUnavailable(status.reason)}</p>;
    if (status.state === 'closed' || !screen) {
      return (
        <p className="browser__empty">
          {status.state === 'closed' ? (
            <>
              El navegador de esta sesión aún no se ha abierto.
              <br />
              El agente lo abre cuando necesita comprobar algo; también puedes escribir arriba una dirección local
              (por ejemplo <code>localhost:3000</code>).
            </>
          ) : (
            'Cargando la página…'
          )}
        </p>
      );
    }
    return (
      <figure className="browser__viewport" data-loading={status.loading || undefined}>
        <img
          src={`data:${screen.mime};base64,${screen.data}`}
          width={screen.width}
          height={screen.height}
          alt={`Captura de ${status.title || status.url || 'la página'} (solo lectura)`}
          draggable={false}
        />
      </figure>
    );
  };

  return (
    <aside className="browser" aria-label="Navegador de la sesión" style={width != null ? { width } : undefined} data-sized={width != null || undefined}>
      <header className="browser__head">
        <button
          type="button"
          className="icon-button"
          aria-label="Atrás"
          title={busyHint ?? 'Atrás'}
          disabled={!canMove || !open || !status?.canGoBack}
          onClick={() => void move('back')}
        >
          <StrokeIcon d={NAV.back} size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Adelante"
          title={busyHint ?? 'Adelante'}
          disabled={!canMove || !open || !status?.canGoForward}
          onClick={() => void move('forward')}
        >
          <StrokeIcon d={NAV.forward} size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Recargar"
          title={busyHint ?? 'Recargar'}
          disabled={!canMove || !open}
          onClick={() => void move('reload')}
        >
          <StrokeIcon d={ICON.refresh} size={16} />
        </button>
        <form className="browser__address" onSubmit={submit}>
          <input
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            aria-label="Dirección"
            placeholder="localhost:3000"
            title={busyHint}
            value={address}
            disabled={!connected || !sessionId || unavailable}
            readOnly={running || moving}
            onFocus={() => setEditing(true)}
            onBlur={() => address === url && setEditing(false)}
            onChange={(e) => {
              setEditing(true);
              setAddress(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(false);
                setAddress(url);
              }
            }}
          />
        </form>
        <button
          type="button"
          className="icon-button"
          aria-label="Abrir en mi navegador"
          title="Abrir esta página en tu navegador"
          disabled={!open || !/^https?:/i.test(url)}
          onClick={() => void openExternal(url)}
        >
          <StrokeIcon d={ICON.external} size={16} />
        </button>
        <button type="button" className="icon-button" aria-label="Cerrar el navegador" title="Cerrar el panel" onClick={onClose}>
          ×
        </button>
      </header>
      {open && (
        <p className="browser__status" role="status">
          <span className="browser__title">{status.title || 'Sin título'}</span>
          <span>{running ? 'lo usa el agente · solo lectura' : status.loading ? 'cargando…' : 'solo lectura'}</span>
        </p>
      )}
      {notice && (
        <p className="notice notice--dismissable browser__notice" data-tone="warning" role="alert">
          {notice}
          <button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={() => setNotice(null)}>
            ×
          </button>
        </p>
      )}
      <div className="browser__body">{body()}</div>
    </aside>
  );
}
