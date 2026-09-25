import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { inertProps } from '../chat/Collapse';

export type SidebarPanel = 'conversations' | 'outline' | 'memory' | 'files';

export interface SidebarState {
  open: boolean;
  panel: SidebarPanel;
}

const STORAGE_KEY = 'stratum.sidebar';
const PANELS: SidebarPanel[] = ['conversations', 'outline', 'memory', 'files'];

/** Estado del sidebar recordado por usuario (comodidad: sin él, abierto en Conversaciones). */
export function loadSidebarState(): SidebarState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<SidebarState> | null;
    if (raw && typeof raw.open === 'boolean' && PANELS.includes(raw.panel as SidebarPanel)) {
      return { open: raw.open, panel: raw.panel as SidebarPanel };
    }
  } catch {
    /* sin almacenamiento o valor corrupto */
  }
  return { open: true, panel: 'conversations' };
}

export function saveSidebarState(state: SidebarState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* no crítico */
  }
}

/** Click en un icono: el activo con el panel abierto lo cierra; cualquier otro lo abre (§7.5). */
export function togglePanel(state: SidebarState, panel: SidebarPanel): SidebarState {
  if (state.open && state.panel === panel) return { ...state, open: false };
  return { open: true, panel };
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ICONS: Record<SidebarPanel | 'settings', string> = {
  conversations: 'M4 5h16v10H8l-4 4z',
  outline: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  memory: 'M12 4a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5 3 3 0 0 0 3 4h6a3 3 0 0 0 3-4 3 3 0 0 0-2-5V8a4 4 0 0 0-4-4zM12 4v14',
  files: 'M6 3h8l4 4v14H6zM14 3v4h4',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
};

const LABELS: Record<SidebarPanel, string> = {
  conversations: 'Conversaciones (Ctrl+K para buscar)',
  outline: 'Índice de la conversación',
  memory: 'Memoria global',
  files: 'Ficheros de la conversación',
};

/**
 * Sidebar (§6, §7): raíl de iconos siempre visible y un panel de 280 px.
 * `Ctrl+B` lo pliega; el estado se recuerda en `localStorage`.
 */
export function Sidebar({
  state,
  onToggle,
  onSettings,
  badges,
  children,
}: {
  state: SidebarState;
  onToggle: (panel: SidebarPanel) => void;
  onSettings: () => void;
  /** Marca en el icono de Conversaciones (alguna de fondo espera respuesta). */
  badges?: Partial<Record<SidebarPanel, boolean>>;
  children: ReactNode;
}) {
  const present = usePresence(state.open, PANEL_TRANSITION_MS);
  const railRef = useRef<HTMLElement>(null);

  // Raíl con flechas (patrón toolbar): ↑↓ recorren los iconos, Inicio/Fin saltan.
  const onRailKey = (e: KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const buttons = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <aside className="sidebar" data-open={state.open || undefined} aria-label="Barra lateral">
      <nav
        ref={railRef}
        className="sidebar__rail"
        aria-label="Paneles"
        aria-orientation="vertical"
        onKeyDown={onRailKey}
      >
        {PANELS.map((p) => (
          <button
            key={p}
            type="button"
            className="rail-button"
            data-active={(state.open && state.panel === p) || undefined}
            aria-pressed={state.open && state.panel === p}
            aria-label={LABELS[p] + (badges?.[p] ? ' — hay una respuesta esperando' : '')}
            title={LABELS[p]}
            onClick={() => onToggle(p)}
          >
            <Icon d={ICONS[p]} />
            {badges?.[p] && <span className="rail-button__badge" aria-hidden="true" />}
          </button>
        ))}
        <span className="sidebar__spacer" />
        <button
          type="button"
          className="rail-button"
          aria-label="Ajustes (Ctrl+,)"
          title="Ajustes (Ctrl+,)"
          onClick={onSettings}
        >
          <Icon d={ICONS.settings} />
        </button>
      </nav>
      {(state.open || present) && (
        <div
          className="sidebar__panel"
          data-state={state.open && present ? 'open' : 'closed'}
          {...inertProps(!state.open)}
        >
          <div className="sidebar__panel-inner">{children}</div>
        </div>
      )}
    </aside>
  );
}

/** Lo que dura la transición de anchura del panel (`--dur-med`). */
export const PANEL_TRANSITION_MS = 220;

/**
 * Montado con retraso en las dos direcciones: al abrir se monta cerrado y pasa
 * a abierto en el siguiente frame (para que la anchura transicione); al cerrar
 * se desmonta cuando la transición ha terminado.
 */
function usePresence(open: boolean, exitMs: number): boolean {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => setPresent(true));
      return () => cancelAnimationFrame(raf);
    }
    const t = window.setTimeout(() => setPresent(false), exitMs);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);
  return present;
}
