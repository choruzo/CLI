import { useEffect, useMemo, useState } from 'react';
import type { Memory } from '../../hooks/useMemory';
import { matchesSearch } from '../../hooks/conversations-store';
import { MarkdownRenderer } from '../chat/markdown/MarkdownRenderer';

/**
 * Memoria global del asistente (§7.3, modo Chat): el `STRATUM.md` global
 * —compartido con la CLI, editable aquí— y las decisiones que el asistente
 * guardó, con búsqueda y borrado. La pestaña de proyecto llega con el modo Code.
 */
export function MemoryPanel({ memory }: { memory: Memory }) {
  const { global, decisions, conflict, error, saving, savedAt } = memory;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  /** Versión sobre la que se edita: la que se manda en `memory_save`. */
  const [base, setBase] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  // Guardado confirmado: se cierra el editor.
  useEffect(() => {
    if (savedAt !== null) setEditing(false);
  }, [savedAt]);

  const startEdit = () => {
    setDraft(global?.content ?? '');
    setBase(global?.mtimeMs ?? null);
    setEditing(true);
    memory.dismissConflict();
  };

  const filtered = useMemo(
    () =>
      query.trim()
        ? decisions.filter((d) => matchesSearch(`${d.title} ${d.content} ${d.tags.join(' ')}`, query))
        : decisions,
    [decisions, query],
  );

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Memoria</h2>
        <button type="button" className="button" onClick={memory.refresh} title="Volver a leer del disco">
          Recargar
        </button>
      </div>
      <div className="side-panel__body">
        {error && (
          <p className="notice" data-tone="error" role="alert">
            {error}
          </p>
        )}
        <section className="memory-section" aria-label="STRATUM.md global">
          <div className="memory-section__header">
            <h3 className="conv-group__title">STRATUM.md global</h3>
            {!editing && global && (
              <button type="button" className="button" onClick={startEdit}>
                {global.exists ? 'Editar' : 'Crear'}
              </button>
            )}
          </div>
          {global && (
            <p className="memory-section__path" title={global.path}>
              {global.path}
            </p>
          )}
          {editing ? (
            <form
              className="memory-editor"
              onSubmit={(e) => {
                e.preventDefault();
                memory.save(draft, base);
              }}
            >
              <textarea
                className="memory-editor__text"
                aria-label="Contenido de STRATUM.md"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={14}
                spellCheck={false}
              />
              {conflict && (
                <div className="notice" data-tone="warning" role="alert">
                  El fichero cambió en disco mientras lo editabas (quizá desde la CLI). No se ha
                  guardado.
                  <span className="memory-editor__conflict">
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setDraft(conflict.content);
                        setBase(conflict.mtimeMs);
                        memory.dismissConflict();
                      }}
                    >
                      Cargar la versión del disco
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setBase(conflict.mtimeMs);
                        memory.dismissConflict();
                        memory.save(draft, conflict.mtimeMs);
                      }}
                    >
                      Sobrescribir con la mía
                    </button>
                  </span>
                </div>
              )}
              <span className="memory-editor__actions">
                <button type="button" className="button" onClick={() => setEditing(false)}>
                  Cancelar
                </button>
                <button type="submit" className="button button--primary" disabled={saving}>
                  {saving ? 'Guardando…' : 'Guardar'}
                </button>
              </span>
            </form>
          ) : global?.exists && global.content.trim() ? (
            <div className="memory-section__content">
              <MarkdownRenderer text={global.content} />
            </div>
          ) : (
            global && (
              <p className="side-panel__empty">
                No hay STRATUM.md global. Lo que escribas aquí lo leen el asistente y la CLI al
                empezar cada conversación.
              </p>
            )
          )}
        </section>

        <section className="memory-section" aria-label="Decisiones del asistente">
          <h3 className="conv-group__title">Decisiones del asistente</h3>
          {decisions.length > 0 && (
            <input
              type="search"
              className="side-panel__search"
              placeholder="Buscar en la memoria…"
              aria-label="Buscar decisiones"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {decisions.length === 0 && (
            <p className="side-panel__empty">El asistente todavía no ha guardado nada.</p>
          )}
          {query && filtered.length === 0 && decisions.length > 0 && (
            <p className="side-panel__empty">Nada coincide con «{query.trim()}».</p>
          )}
          <ul className="decision-list">
            {filtered.map((d) => (
              <li key={d.id} className="decision">
                <div className="decision__header">
                  <strong className="decision__title">{d.title}</strong>
                  {confirming === d.id ? (
                    <span className="decision__confirm">
                      <button type="button" className="button" onClick={() => setConfirming(null)}>
                        No
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => {
                          setConfirming(null);
                          memory.forget(d.id);
                        }}
                      >
                        Olvidar
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Olvidar «${d.title}»`}
                      title="Olvidar"
                      onClick={() => setConfirming(d.id)}
                    >
                      🗑
                    </button>
                  )}
                </div>
                <p className="decision__content">{d.content}</p>
                <p className="decision__meta">
                  {d.type} · {d.importance}
                  {d.tags.length > 0 && ` · ${d.tags.join(', ')}`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
