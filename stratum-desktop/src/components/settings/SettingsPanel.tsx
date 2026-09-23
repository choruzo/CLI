import { useEffect, useMemo, useRef, useState } from 'react';
import type { Config } from '../../hooks/useConfig';
import {
  defaultProvider,
  editDraft,
  issuesFor,
  parseDraft,
  providersOf,
  removeProvider,
  upsertProvider,
  type Json,
  type ProviderEntry,
} from './config-draft';
import type { FieldContext } from './fields';
import { Issues } from './fields';
import { JsonEditor } from './JsonEditor';
import { ProviderWizard, type WizardResult } from './ProviderWizard';
import { MemorySection, ModelSection, ProvidersSection, WebSearchSection, WorkspacesSection } from './sections';

/**
 * Panel de Ajustes (D5, §7.4): overlay a pantalla completa con el
 * `.stratumrc.json` global en formularios y, en Avanzado, en crudo. Todo pasa
 * por el borrador de `useConfig`; guardar lo valida y escribe el sidecar.
 */

export type SettingsTab = 'providers' | 'model' | 'web' | 'memory' | 'workspaces' | 'advanced';

const TABS: Array<{ id: SettingsTab; label: string; paths: string[] }> = [
  { id: 'providers', label: 'Providers', paths: ['provider'] },
  { id: 'model', label: 'Modelo activo', paths: ['desktop.maxConcurrentTurns'] },
  { id: 'web', label: 'Búsqueda web', paths: ['tools.webSearch'] },
  { id: 'memory', label: 'Memoria', paths: ['memory'] },
  { id: 'workspaces', label: 'Espacios de trabajo', paths: ['desktop.workspaces'] },
  { id: 'advanced', label: 'Avanzado', paths: [] },
];

type WizardState = { mode: 'add' } | { mode: 'edit'; provider: ProviderEntry } | null;

export function SettingsPanel({
  config,
  connected,
  onClose,
  onOpenMemory,
}: {
  config: Config;
  connected: boolean;
  onClose: () => void;
  onOpenMemory: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>('providers');
  const [wizard, setWizard] = useState<WizardState>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  const parsed = useMemo(() => parseDraft(config.draft), [config.draft]);
  const value: Json = parsed.ok ? parsed.value : {};
  const readOnly = config.snapshot?.readOnly ?? null;
  const brokenFile = config.snapshot?.parseError ?? null;
  const formsDisabled = !parsed.ok || readOnly !== null || !connected;

  const ctx: FieldContext = {
    value,
    defaults: config.defaults,
    issues: config.issues,
    disabled: formsDisabled,
    update: (fn) => {
      const next = editDraft(config.draft, fn);
      if (next !== null) config.edit(next);
    },
  };

  const close = () => {
    if (config.dirty) setConfirmClose(true);
    else onClose();
  };

  const finishWizard = (result: WizardResult) => {
    setWizard(null);
    const next = editDraft(config.draft, (v) =>
      upsertProvider(v, result.name, result.entry, result.makeDefault),
    );
    // Como el wizard de la CLI: termina guardando.
    if (next !== null) config.save({ text: next });
  };

  const syntaxIssues = issuesFor(config.issues, '').filter((i) => i.path === '');
  const canSave =
    connected && config.dirty && !config.saving && readOnly === null && config.issues.length === 0 && !config.validating;

  const tabIssues = (t: (typeof TABS)[number]) =>
    t.id === 'advanced'
      ? config.issues.length
      : t.paths.reduce((n, p) => n + issuesFor(config.issues, p).length, 0);

  return (
    <div
      ref={panel}
      className="settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !wizard) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className="settings__header">
        <div>
          <h2 id="settings-title" className="settings__title">
            Ajustes
          </h2>
          {config.snapshot && (
            <p className="settings__path" title={config.snapshot.path}>
              {config.snapshot.path}
              {!config.snapshot.exists && ' (todavía no existe: se crea al guardar)'}
            </p>
          )}
        </div>
        <button type="button" className="icon-button" aria-label="Cerrar ajustes (Esc)" onClick={close}>
          ×
        </button>
      </header>

      <div className="settings__banners">
        {!connected && (
          <p className="notice" data-tone="warning" role="status">
            El agente no está conectado: los ajustes se podrán guardar cuando vuelva.
          </p>
        )}
        {readOnly && (
          <p className="notice" data-tone="error" role="alert">
            {readOnly}
          </p>
        )}
        {brokenFile && (
          <p className="notice" data-tone="error" role="alert">
            El fichero no es JSON válido ({brokenFile}). Arréglalo en Avanzado.
          </p>
        )}
        {config.snapshot && config.snapshot.overrides.length > 0 && (
          <p className="notice" data-tone="warning">
            También se aplica {config.snapshot.overrides.join(', ')}, que va por encima de esta
            config: lo que defina ahí gana.
          </p>
        )}
        {config.applied && !config.applied.ok && config.applied.error && (
          <p className="notice" data-tone="error" role="alert">
            La configuración en disco no se pudo aplicar y el agente sigue con la anterior:{' '}
            {config.applied.error}
          </p>
        )}
        {config.applied && config.applied.restartRequired.length > 0 && (
          <div className="notice settings__restart" data-tone="warning" role="status">
            Para aplicar {config.applied.restartRequired.join(', ').toLowerCase()} hay que reiniciar
            el agente (las conversaciones se guardan y se reabren; una respuesta en curso se corta).
            <button type="button" className="button" onClick={config.restartAgent}>
              Reiniciar el agente
            </button>
          </div>
        )}
        {config.external && (
          <div className="notice settings__conflict" data-tone="warning" role="alert">
            La configuración cambió fuera de la app (quizá desde la CLI) mientras la editabas.
            <span className="settings__conflict-actions">
              <button type="button" className="button" onClick={config.takeDisk}>
                Descartar mis cambios
              </button>
              <button type="button" className="button" onClick={config.keepMine}>
                Mantener mis cambios
              </button>
            </span>
          </div>
        )}
        {config.conflict && (
          <div className="notice settings__conflict" data-tone="warning" role="alert">
            No se ha guardado: el fichero cambió en disco desde que lo abriste (quizá desde la CLI).
            <span className="settings__conflict-actions">
              <button type="button" className="button" onClick={config.takeDisk}>
                Cargar la versión del disco
              </button>
              <button type="button" className="button" onClick={() => config.save({ force: true })}>
                Sobrescribir con la mía
              </button>
            </span>
          </div>
        )}
        {config.error && (
          <p className="notice" data-tone="error" role="alert">
            {config.error}
          </p>
        )}
        {config.notice && (
          <p className="notice notice--dismissable" data-tone="info" role="status">
            {config.notice}
            <button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={config.dismissNotice}>
              ×
            </button>
          </p>
        )}
      </div>

      <div className="settings__body">
        <nav className="settings__tabs" aria-label="Secciones de ajustes" role="tablist">
          {TABS.map((t) => {
            const n = tabIssues(t);
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="settings__tab"
                aria-selected={tab === t.id}
                data-active={tab === t.id || undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {n > 0 && (
                  <span className="settings__tab-issues" aria-label={`${n} problemas`}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="settings__content" role="tabpanel">
          {!config.loaded ? (
            <p className="notice">Cargando la configuración…</p>
          ) : tab === 'advanced' ? (
            <section className="settings-section" aria-labelledby="settings-advanced">
              <header className="settings-section__header">
                <h3 id="settings-advanced" className="settings-section__title">
                  Avanzado
                </h3>
              </header>
              <p className="settings-section__intro">
                El <code>.stratumrc.json</code> global tal cual, validado en vivo contra el schema.
                Los secretos guardados aparecen como <code>••••••••</code>: déjalos así para
                conservarlos.
              </p>
              <JsonEditor
                value={config.draft}
                onChange={config.edit}
                issues={config.issues}
                disabled={readOnly !== null}
              />
              {config.validating && config.dirty ? (
                <p className="settings-field__hint">Validando…</p>
              ) : config.issues.length === 0 ? (
                <p className="settings-field__hint">Sin problemas.</p>
              ) : null}
              <Issues
                issues={config.issues.map((i) =>
                  i.line !== undefined ? { ...i, message: `línea ${i.line}, columna ${i.column ?? 1}: ${i.message}` } : i,
                )}
              />
            </section>
          ) : !parsed.ok ? (
            <div className="notice" data-tone="error" role="alert">
              El borrador no es JSON válido, así que los formularios no pueden leerlo.{' '}
              <button type="button" className="link-button" onClick={() => setTab('advanced')}>
                Corrígelo en Avanzado
              </button>
              <Issues issues={syntaxIssues} />
            </div>
          ) : tab === 'providers' ? (
            <ProvidersSection
              ctx={ctx}
              onAdd={() => setWizard({ mode: 'add' })}
              onEdit={(provider) => setWizard({ mode: 'edit', provider })}
              onRemove={(name) => ctx.update((v) => removeProvider(v, name))}
            />
          ) : tab === 'model' ? (
            <ModelSection ctx={ctx} config={config} />
          ) : tab === 'web' ? (
            <WebSearchSection ctx={ctx} />
          ) : tab === 'memory' ? (
            <MemorySection
              ctx={ctx}
              onOpenMemory={config.dirty ? () => setConfirmClose(true) : onOpenMemory}
            />
          ) : (
            <WorkspacesSection ctx={ctx} config={config} />
          )}
        </div>
      </div>

      <footer className="settings__footer">
        {confirmClose ? (
          <span className="settings-confirm" role="alert">
            Tienes cambios sin guardar.
            <button type="button" className="button" onClick={() => setConfirmClose(false)}>
              Seguir editando
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                setConfirmClose(false);
                onClose();
              }}
            >
              Descartar y cerrar
            </button>
          </span>
        ) : (
          <span className="settings__status" role="status">
            {config.saving
              ? 'Guardando…'
              : config.issues.length > 0
                ? `${config.issues.length} ${config.issues.length === 1 ? 'problema' : 'problemas'}: corrígelos para guardar`
                : config.dirty
                  ? 'Cambios sin guardar'
                  : 'Sin cambios'}
          </span>
        )}
        <span className="settings__footer-actions">
          <button type="button" className="button" disabled={!config.dirty || config.saving} onClick={config.discard}>
            Descartar
          </button>
          <button type="button" className="button button--primary" disabled={!canSave} onClick={() => config.save()}>
            Guardar
          </button>
        </span>
      </footer>

      {wizard && (
        <ProviderWizard
          mode={wizard.mode}
          existing={providersOf(value).map((p) => p.name)}
          initial={wizard.mode === 'edit' ? wizard.provider : undefined}
          isDefault={wizard.mode === 'edit' ? defaultProvider(value) === wizard.provider.name : undefined}
          config={config}
          onComplete={finishWizard}
          onCancel={() => setWizard(null)}
        />
      )}
    </div>
  );
}
