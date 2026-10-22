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
          <p className="settings__lead">
            Stratum Desktop es un cliente de <code>stratumd</code>: los providers, modelos y permisos
            son los de tu Stratum. Se configuran con <code>stratum config</code> o editando el
            fichero de configuración.
          </p>
          <section className="settings-card" aria-labelledby="settings-config">
            <header className="settings-card__header">
              <h3 id="settings-config" className="settings-card__title">
                Configuración
              </h3>
              <button
                type="button"
                className="button button--primary"
                onClick={() => onOpenConfig().catch((err) => setNote(String(err)))}
              >
                Abrir la configuración
              </button>
            </header>
            {prefs && <p className="settings-card__path">{prefs.configPath}</p>}
            {prefs?.warnings.map((w) => (
              <p key={w} className="notice" data-tone="warning">
                {w}
              </p>
            ))}
          </section>
          {prefs && (
            <>
              <section className="settings-card" aria-labelledby="settings-window">
                <h3 id="settings-window" className="settings-card__title">
                  Ventana
                </h3>
                <dl className="settings-rows">
                  <dt>Atajo global</dt>
                  <dd>{prefs.globalHotkey ? <kbd>{prefs.globalHotkey}</kbd> : 'ninguno'}</dd>
                  <dt>Notificaciones</dt>
                  <dd>
                    {prefs.notifications.enabled
                      ? `sí, tras ${prefs.notifications.minSeconds} s`
                      : 'no'}
                  </dd>
                </dl>
                {prefs.hotkeyError && (
                  <p className="notice" data-tone="warning">
                    {prefs.hotkeyError}
                  </p>
                )}
              </section>
              <section className="settings-card" aria-labelledby="settings-conversations">
                <h3 id="settings-conversations" className="settings-card__title">
                  Conversaciones
                </h3>
                <dl className="settings-rows">
                  <dt>Carpeta</dt>
                  <dd className="settings-rows__path">{prefs.workspacesRoot}</dd>
                  <dt>Límites de ficheros</dt>
                  <dd>
                    {formatBytes(prefs.maxFileBytes)} por fichero ·{' '}
                    {formatBytes(prefs.maxWorkspaceBytes)} por conversación
                  </dd>
                </dl>
                {prefs.legacyConversations > 0 && (
                  <p className="notice" data-tone="info">
                    Hay {prefs.legacyConversations} conversación(es) de la versión anterior de Desktop
                    sin importar. Ejecuta <code>stratum desktop import</code> para convertirlas en
                    sesiones de Stratum (se hace una vez; lo antiguo no se borra).
                  </p>
                )}
              </section>
            </>
          )}
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
          <p className="settings__footnote">
            Los cambios en el fichero se aplican al volver a abrir Desktop (y, los de Stratum, en
            las sesiones nuevas).
          </p>
        </div>
      </section>
  );
}
