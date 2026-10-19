import { forwardRef, useEffect, useMemo, useState } from 'react';
import {
  describeSession,
  groupByDate,
  matchesSearch,
  relativeDate,
  type SessionItem,
} from '../../view/sessions';

function SessionRow({
  item,
  active,
  closing,
  now,
  onSelect,
  onClose,
}: {
  item: SessionItem;
  active: boolean;
  closing: boolean;
  now: Date;
  onSelect: () => void;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  if (confirm) {
    return (
      <li className="conv-item conv-item--confirm" data-active={active || undefined} role="group">
        <p className="conv-item__question">
          ¿Cerrar esta sesión? Deja de existir para todos los clientes (también guardada). Sus
          ficheros se conservan.
        </p>
        <span className="conv-item__confirm-actions">
          <button type="button" className="button" onClick={() => setConfirm(false)} autoFocus>
            Cancelar
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              setConfirm(false);
              onClose();
            }}
          >
            Cerrar sesión
          </button>
        </span>
      </li>
    );
  }
  const meta = [describeSession(item), relativeDate(item.updatedAt, now)].filter(Boolean).join(' · ');
  return (
    <li className="conv-item" data-active={active || undefined}>
      <button
        type="button"
        className="conv-item__main"
        aria-current={active ? 'page' : undefined}
        title={`${item.title}\n${item.cwd}`}
        onClick={onSelect}
      >
        <span className="conv-item__title">
          {item.waiting > 0 && (
            <span className="conv-item__badge" data-tone="warn" title="Espera a una persona">
              ●
            </span>
          )}
          {item.running && item.waiting === 0 && (
            <span
              className="conv-item__badge conv-item__badge--spin"
              title={item.state === 'paused' ? 'En pausa' : 'Trabajando'}
              aria-label={item.state === 'paused' ? 'En pausa' : 'Trabajando'}
            />
          )}
          {item.title}
        </span>
        <span className="conv-item__meta">{meta}</span>
      </button>
      {!item.peer && (
        <span className="conv-item__actions">
          <button
            type="button"
            className="icon-button"
            title="Cerrar la sesión"
            aria-label="Cerrar la sesión"
            disabled={closing || item.running}
            onClick={() => setConfirm(true)}
          >
            🗑
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * Sesiones del daemon (§7.1, M12): todas las que hay —de Desktop, de Dot, de
 * la terminal—, con su estado operativo, de la foto de conjunto (sin descargar
 * ninguna conversación). Abrir una es mirarla; lo que se pueda hacer con ella
 * lo dice el daemon.
 */
export const SessionsPanel = forwardRef<
  HTMLInputElement,
  {
    items: SessionItem[];
    /** El daemon ya dijo qué sesiones hay. */
    listed: boolean;
    selectedId: string | null;
    creating: boolean;
    closing: ReadonlySet<string>;
    onSelect: (id: string) => void;
    onNew: () => void;
    onClose: (id: string) => void;
  }
>(function SessionsPanel({ items, listed, selectedId, creating, closing, onSelect, onNew, onClose }, searchRef) {
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(
    () => (query.trim() ? items.filter((c) => matchesSearch(c.title, query)) : items),
    [items, query],
  );
  const groups = useMemo(() => groupByDate(filtered, now), [filtered, now]);

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Sesiones</h2>
        <button
          type="button"
          className="button"
          onClick={onNew}
          disabled={creating}
          title="Nueva conversación (Ctrl+N)"
        >
          {creating ? 'Abriendo…' : 'Nueva'}
        </button>
      </div>
      <input
        ref={searchRef}
        type="search"
        className="side-panel__search"
        placeholder="Buscar sesiones…"
        aria-label="Buscar sesiones"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.stopPropagation();
            setQuery('');
          }
        }}
      />
      <div className="side-panel__body">
        {!listed && <p className="side-panel__empty">Esperando a Stratum…</p>}
        {listed && items.length === 0 && !query && (
          <p className="side-panel__empty">
            No hay sesiones.
            <br />
            Empieza una conversación nueva.
          </p>
        )}
        {query && filtered.length === 0 && (
          <p className="side-panel__empty">No se encontraron sesiones para «{query.trim()}».</p>
        )}
        {groups.map((g) => (
          <section key={g.group} className="conv-group" aria-label={g.group}>
            <h3 className="conv-group__title">{g.group}</h3>
            <ul className="conv-list">
              {g.items.map((item) => (
                <SessionRow
                  key={item.id}
                  item={item}
                  active={item.id === selectedId}
                  closing={closing.has(item.id)}
                  now={now}
                  onSelect={() => onSelect(item.id)}
                  onClose={() => onClose(item.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
});
