import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Updates } from '../../hooks/useUpdates';
import { useAppVersion } from '../../hooks/useAppVersion';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { DesktopPrefs, NativeBridge } from '../../ipc/native';
import { openLogsDir } from '../../ipc/os';
import { SettingsEditor, type SettingsSectionLink } from './SettingsEditor';

/** A qué altura del área de scroll (fracción) una sección pasa a ser «la que se lee». */
const SPY_LINE = 0.3;

/**
 * Ajustes de Desktop. Las preferencias de la app (`desktop.*`) y la
 * configuración de Stratum viven en el `.stratumrc.json` **global**, que aquí se
 * edita igual que con `stratum config` (`SettingsEditor`): el lado nativo lo lee
 * y lo escribe llamando a la CLI instalada, el webview solo ve valores con los
 * secretos enmascarados y lo que cambia la superficie de riesgo pide confirmar
 * en una ventana nativa. Por el protocolo no pasa nada de esto: el daemon no
 * expone la configuración (lleva credenciales).
 *
 * Es una ventana flotante de cristal sobre el chat (que sigue viéndose detrás,
 * atenuado): a la izquierda el índice de secciones, que sigue al scroll, y a la
 * derecha todas las secciones en una sola columna. Se cierra con Esc, con la × o
 * pulsando fuera.
 */
export function SettingsPanel({
  native,
  prefs,
  updates,
  onOpenConfig,
  onClose,
}: {
  native: NativeBridge;
  prefs: DesktopPrefs | null;
  updates: Updates;
  onOpenConfig: () => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  // El foco entra en el diálogo al abrirse: Esc lo cierra sin tener que pulsar dentro.
  useEffect(() => ref.current?.focus(), []);
  const version = useAppVersion();
  const [note, setNote] = useState<string | null>(null);
  const [editorSections, setEditorSections] = useState<SettingsSectionLink[]>([]);
  const sections = useMemo<SettingsSectionLink[]>(
    () => [
      { id: 'settings-config', title: 'General' },
      ...editorSections,
      { id: 'settings-updates', title: 'Actualizaciones' },
      { id: 'settings-diagnostics', title: 'Diagnóstico' },
    ],
    [editorSections],
  );
  const [active, setActive] = useState('settings-config');

  /** La sección (el bloque entero) a la que pertenece un título del índice. */
  const sectionOf = (id: string): HTMLElement | null =>
    document.getElementById(id)?.closest<HTMLElement>('section') ?? null;

  const spy = useCallback(() => {
    const box = contentRef.current;
    if (!box) return;
    // Al fondo del todo manda la última: una sección corta nunca llegaría arriba.
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2 && box.scrollTop > 0) {
      setActive(sections[sections.length - 1]?.id ?? 'settings-config');
      return;
    }
    const line = box.getBoundingClientRect().top + box.clientHeight * SPY_LINE;
    let current = sections[0]?.id ?? 'settings-config';
    for (const s of sections) {
      const el = sectionOf(s.id);
      if (el && el.getBoundingClientRect().top <= line) current = s.id;
    }
    setActive(current);
  }, [sections]);
  useEffect(spy, [spy]);

  const jump = (id: string) => {
    const box = contentRef.current;
    const el = sectionOf(id);
    if (!box || !el) return;
    setActive(id);
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    // De golpe: con scroll suave, saltar de punta a punta tarda y el índice va barriendo.
    box.scrollTop = Math.max(0, top - 12);
  };

  const phase = updates.phase;
  return (
    <div className="settings-layer">
      <div className="settings-layer__scrim" aria-hidden="true" onMouseDown={onClose} />
      <section
        ref={ref}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Ajustes"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="settings__header">
          <div className="settings__heading">
            <h2 className="settings__title">Ajustes</h2>
            {prefs && <p className="settings__path">{prefs.configPath}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="Cerrar" title="Cerrar (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="settings__body">
          <nav className="settings__nav" aria-label="Secciones de Ajustes">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className="settings__nav-item"
                aria-current={active === s.id ? 'true' : undefined}
                onClick={() => jump(s.id)}
              >
                {s.title}
              </button>
            ))}
          </nav>
          <div ref={contentRef} className="settings__content" onScroll={spy}>
            <section className="settings-card" aria-labelledby="settings-config">
              <header className="settings-card__header">
                <h3 id="settings-config" className="settings-card__title">
                  General
                </h3>
                <button
                  type="button"
                  className="button"
                  onClick={() => onOpenConfig().catch((err) => setNote(String(err)))}
                >
                  Abrir la configuración
                </button>
              </header>
              <p className="settings__lead">
                Stratum Desktop es un cliente de <code>stratumd</code>: los providers, modelos y permisos
                son los de tu Stratum, los mismos que edita <code>stratum config</code>. Lo que cambia
                lo que el agente puede hacer te pide confirmarlo en una ventana aparte.
              </p>
              {prefs?.warnings.map((w) => (
                <p key={w} className="notice" data-tone="warning">
                  {w}
                </p>
              ))}
              {prefs?.hotkeyError && (
                <p className="notice" data-tone="warning">
                  {prefs.hotkeyError}
                </p>
              )}
              {prefs && prefs.legacyConversations > 0 && (
                <p className="notice" data-tone="info">
                  Hay {prefs.legacyConversations} conversación(es) de la versión anterior de Desktop sin
                  importar. Ejecuta <code>stratum desktop import</code> para convertirlas en sesiones de
                  Stratum (se hace una vez; lo antiguo no se borra).
                </p>
              )}
            </section>
            <SettingsEditor native={native} onSections={setEditorSections} />
            <section className="settings-card" aria-labelledby="settings-updates">
              <header className="settings-card__header">
                <h3 id="settings-updates" className="settings-card__title">
                  Actualizaciones
                </h3>
                <button
                  type="button"
                  className="button"
                  disabled={phase.kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'installing'}
                  onClick={updates.check}
                >
                  Buscar actualizaciones
                </button>
              </header>
              {prefs && (
                <p className="settings-card__hint">
                  Se buscan {prefs.updatesAutoCheck ? 'al abrir Desktop' : 'solo a mano'}.
                </p>
              )}
              {phase.kind === 'none' && <p className="notice">Tienes la última versión.</p>}
              {phase.kind === 'error' && phase.manual && (
                <p className="notice" data-tone="warning">
                  {phase.message}
                </p>
              )}
            </section>
            <section className="settings-card" aria-labelledby="settings-diagnostics">
              <header className="settings-card__header">
                <h3 id="settings-diagnostics" className="settings-card__title">
                  Diagnóstico
                </h3>
                <button
                  type="button"
                  className="button"
                  onClick={() => openLogsDir().catch((err) => setNote(String(err)))}
                >
                  Ver logs
                </button>
              </header>
              <p className="settings-card__hint">Los logs de Desktop y del enlace con Stratum.</p>
            </section>
            {note && (
              <p className="notice" data-tone="warning">
                {note}
              </p>
            )}
          </div>
        </div>
        <footer className="settings__footer">
          <p className="settings__footnote">
            Cada cambio dice si necesita una sesión nueva, reiniciar el daemon o volver a abrir Desktop.
          </p>
          {version && <span className="settings__version">v{version}</span>}
        </footer>
      </section>
    </div>
  );
}
