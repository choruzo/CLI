import { useRef, useState } from 'react';
import type { Updates } from '../../hooks/useUpdates';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { DesktopPrefs } from '../../ipc/native';
import { formatBytes } from '../../ipc/files';
import { openLogsDir } from '../../ipc/os';

/**
 * Ajustes de Desktop (M12): **de solo lectura**. Las preferencias de la app
 * (`desktop.*`) viven en el `.stratumrc.json` global, que se edita con
 * `stratum config` o a mano; los providers y modelos son de Stratum, no de
 * Desktop. Antes de M12 los editaba el sidecar; ahora no hay sidecar, y el
 * daemon no expone la configuración (lleva credenciales).
 */
export function SettingsPanel({
  prefs,
  updates,
  onOpenConfig,
  onClose,
}: {
  prefs: DesktopPrefs | null;
  updates: Updates;
  onOpenConfig: () => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref);
  const [note, setNote] = useState<string | null>(null);
  const phase = updates.phase;
  return (
      <section
        ref={ref}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Ajustes"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="settings__header">
          <h2 className="settings__title">Ajustes</h2>
          <button type="button" className="icon-button" aria-label="Cerrar" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="settings__content">
          <p>
            Stratum Desktop es un cliente de <code>stratumd</code>: los providers, modelos y permisos
            son los de tu Stratum. Se configuran con <code>stratum config</code> o editando el
            fichero de configuración.
          </p>
          {prefs && (
            <>
              <dl className="context-grid">
                <dt>Configuración</dt>
                <dd>{prefs.configPath}</dd>
                <dt>Atajo global</dt>
                <dd>{prefs.globalHotkey || 'ninguno'}</dd>
                <dt>Notificaciones</dt>
                <dd>
                  {prefs.notifications.enabled
                    ? `sí, tras ${prefs.notifications.minSeconds} s`
                    : 'no'}
                </dd>
                <dt>Buscar actualizaciones</dt>
                <dd>{prefs.updatesAutoCheck ? 'al abrir' : 'solo a mano'}</dd>
                <dt>Carpeta de conversaciones</dt>
                <dd>{prefs.workspacesRoot}</dd>
                <dt>Límites de ficheros</dt>
                <dd>
                  {formatBytes(prefs.maxFileBytes)} por fichero ·{' '}
                  {formatBytes(prefs.maxWorkspaceBytes)} por conversación
                </dd>
              </dl>
              {prefs.legacyConversations > 0 && (
                <p className="notice" data-tone="info">
                  Hay {prefs.legacyConversations} conversación(es) de la versión anterior de Desktop sin
                  importar. Ejecuta <code>stratum desktop import</code> para convertirlas en sesiones de
                  Stratum (se hace una vez; lo antiguo no se borra).
                </p>
              )}
              {prefs.hotkeyError && (
                <p className="notice" data-tone="warning">
                  {prefs.hotkeyError}
                </p>
              )}
              {prefs.warnings.map((w) => (
                <p key={w} className="notice" data-tone="warning">
                  {w}
                </p>
              ))}
            </>
          )}
          <div className="alert__actions">
            <button
              type="button"
              className="button"
              onClick={() => onOpenConfig().catch((err) => setNote(String(err)))}
            >
              Abrir la configuración
            </button>
            <button
              type="button"
              className="button"
              onClick={() => openLogsDir().catch((err) => setNote(String(err)))}
            >
              Ver logs
            </button>
            <button
              type="button"
              className="button"
              disabled={phase.kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'installing'}
              onClick={updates.check}
            >
              Buscar actualizaciones
            </button>
          </div>
          {phase.kind === 'none' && <p className="notice">Tienes la última versión.</p>}
          {phase.kind === 'error' && phase.manual && (
            <p className="notice" data-tone="warning">
              {phase.message}
            </p>
          )}
          {note && (
            <p className="notice" data-tone="warning">
              {note}
            </p>
          )}
          <p className="side-panel__empty">
            Los cambios en el fichero se aplican al volver a abrir Desktop (y, los de Stratum, en
            las sesiones nuevas).
          </p>
        </div>
      </section>
  );
}
