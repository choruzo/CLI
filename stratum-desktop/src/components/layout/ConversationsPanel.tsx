import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationSummary } from '../../ipc/types';
import type { ConversationState } from '../../hooks/conversation-reducer';
import {
  groupByDate,
  isBusy,
  matchesSearch,
  needsAttention,
  relativeDate,
} from '../../hooks/conversations-store';

type ItemMode = 'view' | 'rename' | 'confirm-delete';

function ConversationItem({
  item,
  active,
  saved,
  conv,
  now,
  onSelect,
  onRename,
  onDelete,
  onPin,
}: {
  item: ConversationSummary;
  active: boolean;
  /** Guardada en el sidecar (no es el borrador de una conversación nueva). */
  saved: boolean;
  conv: ConversationState | undefined;
  now: Date;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onPin: (pinned: boolean) => void;
}) {
  const [mode, setMode] = useState<ItemMode>('view');
  const [draft, setDraft] = useState(item.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === 'rename') inputRef.current?.select();
  }, [mode]);

  const generating = conv?.activeTurnId != null;
  const queued = conv?.messages.some((m) => m.role === 'agent' && m.status === 'queued');
  const attention = needsAttention(conv);
  const ws = item.workspace;

  if (mode === 'rename') {
    const commit = () => {
      const t = draft.trim();
      if (t && t !== item.title) onRename(t);
      setMode('view');
    };
    return (
      <li className="conv-item" data-active={active || undefined}>
        <input
          ref={inputRef}
          className="conv-item__rename"
          aria-label="Nuevo título"
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(item.title);
              setMode('view');
            }
          }}
        />
      </li>
    );
  }

  if (mode === 'confirm-delete') {
    return (
      <li className="conv-item conv-item--confirm" data-active={active || undefined} role="group">
        <p className="conv-item__question">¿Eliminar esta conversación y sus ficheros?</p>
        <span className="conv-item__confirm-actions">
          <button type="button" className="button" onClick={() => setMode('view')} autoFocus>
            Cancelar
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              setMode('view');
              onDelete();
            }}
          >
            Eliminar
          </button>
        </span>
      </li>
    );
  }

  const meta = [item.model, item.turnCount > 0 ? relativeDate(item.updatedAt, now) : 'sin mensajes']
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="conv-item" data-active={active || undefined}>
      <button
        type="button"
        className="conv-item__main"
        aria-current={active ? 'page' : undefined}
        title={item.title}
        onClick={onSelect}
      >
        <span className="conv-item__title">
          {attention && (
            <span className="conv-item__badge" data-tone="warn" title="Espera tu respuesta">
              ●
            </span>
          )}
          {generating && !attention && (
            <span
              className="conv-item__badge conv-item__badge--spin"
              title={queued ? 'En cola' : 'Generando'}
              aria-label={queued ? 'En cola' : 'Generando'}
            />
          )}
          {item.title}
        </span>
        <span className="conv-item__meta">
          {meta}
          {ws?.pinned && ' · fijada'}
          {ws?.state === 'archived' && ' · ficheros comprimidos'}
          {ws?.state === 'purged' && ' · ficheros caducados'}
        </span>
      </button>
      {saved && (
        <span className="conv-item__actions">
          {ws && ws.state !== 'purged' && (
            <button
              type="button"
              className="icon-button"
              title={
                ws.pinned ? 'Desfijar (vuelve a la retención)' : 'Fijar (sus ficheros no caducan)'
              }
              aria-label={ws.pinned ? 'Desfijar' : 'Fijar'}
              aria-pressed={ws.pinned}
              onClick={() => onPin(!ws.pinned)}
            >
              {ws.pinned ? '★' : '☆'}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            title="Renombrar"
            aria-label="Renombrar"
            onClick={() => {
              setDraft(item.title);
              setMode('rename');
            }}
          >
            ✎
          </button>
          <button
            type="button"
            className="icon-button"
            title="Eliminar"
            aria-label="Eliminar"
            disabled={isBusy(conv)}
            onClick={() => setMode('confirm-delete')}
          >
            🗑
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * Conversaciones (§7.1): búsqueda, agrupación por fecha, renombrar, eliminar
 * (con su workspace), fijar y el estado de sus ficheros.
 */
export const ConversationsPanel = forwardRef<
  HTMLInputElement,
  {
    list: ConversationSummary[];
    loaded: boolean;
    activeId: string;
    /** Conversación nueva aún sin guardar (sin acciones). */
    draftId?: string | null;
    byId: Record<string, ConversationState>;
    onSelect: (id: string) => void;
    onNew: () => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onPin: (id: string, pinned: boolean) => void;
  }
>(function ConversationsPanel(
  { list, loaded, activeId, draftId = null, byId, onSelect, onNew, onRename, onDelete, onPin },
  searchRef,
) {
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(
    () => (query.trim() ? list.filter((c) => matchesSearch(c.title, query)) : list),
    [list, query],
  );
  const groups = useMemo(() => groupByDate(filtered, now), [filtered, now]);
  const saved = list.filter((c) => c.conversationId !== draftId);

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Conversaciones</h2>
        <button
          type="button"
          className="button"
          onClick={onNew}
          title="Nueva conversación (Ctrl+N)"
        >
          Nueva
        </button>
      </div>
      <input
        ref={searchRef}
        type="search"
        className="side-panel__search"
        placeholder="Buscar conversaciones…"
        aria-label="Buscar conversaciones"
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
        {loaded && saved.length === 0 && !query && (
          <p className="side-panel__empty">
            Sin conversaciones guardadas.
            <br />
            Escribe un mensaje para empezar una.
          </p>
        )}
        {query && filtered.length === 0 && (
          <p className="side-panel__empty">
            No se encontraron conversaciones para «{query.trim()}».
          </p>
        )}
        {groups.map((g) => (
          <section key={g.group} className="conv-group" aria-label={g.group}>
            <h3 className="conv-group__title">{g.group}</h3>
            <ul className="conv-list">
              {g.items.map((item) => (
                <ConversationItem
                  key={item.conversationId}
                  item={item}
                  active={item.conversationId === activeId}
                  saved={item.conversationId !== draftId}
                  conv={byId[item.conversationId]}
                  now={now}
                  onSelect={() => onSelect(item.conversationId)}
                  onRename={(t) => onRename(item.conversationId, t)}
                  onDelete={() => onDelete(item.conversationId)}
                  onPin={(p) => onPin(item.conversationId, p)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
});
