import { useState } from 'react';
import type { Config } from '../../hooks/useConfig';
import { SECRET_PLACEHOLDER } from '../../ipc/types';
import {
  defaultProvider,
  getIn,
  issuesFor,
  providersOf,
  setIn,
  type ProviderEntry,
} from './config-draft';
import {
  CheckboxSetting,
  Issues,
  NumberSetting,
  SecretSetting,
  SelectSetting,
  TextSetting,
  type FieldContext,
} from './fields';

/** Secciones del panel de Ajustes (D5). Cada una edita su parte del borrador. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function ProvidersSection({
  ctx,
  onAdd,
  onEdit,
  onRemove,
}: {
  ctx: FieldContext;
  onAdd: () => void;
  onEdit: (p: ProviderEntry) => void;
  onRemove: (name: string) => void;
}) {
  const providers = providersOf(ctx.value);
  const def = defaultProvider(ctx.value);
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <section className="settings-section" aria-labelledby="settings-providers">
      <header className="settings-section__header">
        <h3 id="settings-providers" className="settings-section__title">
          Providers
        </h3>
        <button type="button" className="button button--primary" disabled={ctx.disabled} onClick={onAdd}>
          Añadir provider
        </button>
      </header>
      <p className="settings-section__intro">
        Cualquier API compatible con OpenAI: Ollama, llama.cpp, vLLM, LiteLLM u OpenAI. Los mismos
        que ve <code>stratum</code> en la terminal.
      </p>
      <Issues issues={issuesFor(ctx.issues, 'provider')} />
      {providers.length === 0 ? (
        <p className="side-panel__empty">
          No hay ningún provider: sin uno, el asistente no puede responder.
        </p>
      ) : (
        <ul className="provider-list">
          {providers.map((p) => (
            <li key={p.name} className="provider-row" data-default={p.name === def || undefined}>
              <div className="provider-row__main">
                <strong className="provider-row__name">
                  {p.name}
                  {p.name === def && <span className="provider-row__badge">por defecto</span>}
                </strong>
                <span className="provider-row__meta">
                  {p.baseUrl} · {p.model || 'sin modelo'}
                  {p.apiKey === SECRET_PLACEHOLDER && ' · key guardada'}
                  {p.apiKey.includes('${') && ` · key ${p.apiKey}`}
                </span>
              </div>
              {confirming === p.name ? (
                <span className="provider-row__actions">
                  <button type="button" className="button" onClick={() => setConfirming(null)}>
                    No
                  </button>
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => {
                      setConfirming(null);
                      onRemove(p.name);
                    }}
                  >
                    Quitar
                  </button>
                </span>
              ) : (
                <span className="provider-row__actions">
                  {p.name !== def && (
                    <button
                      type="button"
                      className="button"
                      disabled={ctx.disabled}
                      onClick={() => ctx.update((v) => setIn(v, ['provider', 'default'], p.name))}
                    >
                      Usar por defecto
                    </button>
                  )}
                  <button type="button" className="button" disabled={ctx.disabled} onClick={() => onEdit(p)}>
                    Editar
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={ctx.disabled}
                    aria-label={`Quitar ${p.name}`}
                    title="Quitar"
                    onClick={() => setConfirming(p.name)}
                  >
                    🗑
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Modelo activo
// ---------------------------------------------------------------------------

export function ModelSection({ ctx, config }: { ctx: FieldContext; config: Config }) {
  const providers = providersOf(ctx.value);
  const def = defaultProvider(ctx.value);
  const active = providers.find((p) => p.name === def) ?? null;
  const [probeId, setProbeId] = useState<string | null>(null);
  const probe = probeId ? config.probeResult(probeId) : null;
  const setModel = (m: string) =>
    active && ctx.update((v) => setIn(v, ['provider', 'providers', active.name, 'model'], m));

  return (
    <section className="settings-section" aria-labelledby="settings-model">
      <header className="settings-section__header">
        <h3 id="settings-model" className="settings-section__title">
          Modelo activo
        </h3>
      </header>
      <p className="settings-section__intro">
        El provider y el modelo de las conversaciones nuevas, y de las abiertas que no eligieron
        otro con <code>/model</code>.
      </p>
      {providers.length === 0 ? (
        <p className="side-panel__empty">Añade antes un provider.</p>
      ) : (
        <>
          <SelectSetting
            ctx={ctx}
            path={['provider', 'default']}
            label="Provider"
            options={providers.map((p) => ({ value: p.name, label: p.name }))}
          />
          {active && (
            <>
              <TextSetting
                ctx={ctx}
                path={['provider', 'providers', active.name, 'model']}
                label="Modelo"
              />
              <div className="settings-field">
                <button
                  type="button"
                  className="button"
                  disabled={ctx.disabled || (probeId !== null && probe === null)}
                  onClick={() =>
                    setProbeId(
                      config.probe({
                        baseUrl: active.baseUrl,
                        provider: active.name,
                        ...(active.apiKey !== SECRET_PLACEHOLDER ? { apiKey: active.apiKey } : {}),
                      }),
                    )
                  }
                >
                  {probeId !== null && probe === null ? 'Buscando modelos…' : 'Ver modelos disponibles'}
                </button>
                {probe?.error && (
                  <p className="notice" data-tone="warning">
                    {probe.error}
                  </p>
                )}
                {probe && probe.models.length > 0 && (
                  <ul className="wizard__models" role="listbox" aria-label="Modelos del provider">
                    {probe.models.map((m) => (
                      <li key={m}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={m === active.model}
                          className="wizard__model"
                          onClick={() => setModel(m)}
                        >
                          {m}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </>
      )}
      <NumberSetting
        ctx={ctx}
        path={['desktop', 'maxConcurrentTurns']}
        label="Generaciones simultáneas"
        hint="Entre todas las conversaciones (1–8). Con un servidor local de un solo slot, 1 evita que dos respuestas vayan a la mitad de velocidad."
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Búsqueda web
// ---------------------------------------------------------------------------

export function WebSearchSection({ ctx }: { ctx: FieldContext }) {
  const backend = getIn(ctx.value, ['tools', 'webSearch', 'backend']);
  return (
    <section className="settings-section" aria-labelledby="settings-web">
      <header className="settings-section__header">
        <h3 id="settings-web" className="settings-section__title">
          Búsqueda web
        </h3>
      </header>
      <SelectSetting
        ctx={ctx}
        path={['tools', 'webSearch', 'backend']}
        label="Motor"
        options={[
          { value: 'meta', label: 'Meta: DuckDuckGo + Tavily (si hay key)' },
          { value: 'duckduckgo', label: 'Solo DuckDuckGo (sin key)' },
          { value: 'tavily', label: 'Solo Tavily' },
          { value: 'brave', label: 'Brave (no implementado)', disabled: backend !== 'brave' },
          { value: 'serpapi', label: 'SerpAPI (no implementado)', disabled: backend !== 'serpapi' },
        ]}
      />
      <SecretSetting
        ctx={ctx}
        path={['tools', 'webSearch', 'tavilyApiKey']}
        label="API key de Tavily"
        hint={
          <>
            Si se deja vacía se usa <code>TAVILY_API_KEY</code> del entorno, si existe.
          </>
        }
      />
      <NumberSetting
        ctx={ctx}
        path={['tools', 'webSearch', 'maxResults']}
        label="Resultados por búsqueda"
        hint="Entre 1 y 20."
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Memoria
// ---------------------------------------------------------------------------

export function MemorySection({ ctx, onOpenMemory }: { ctx: FieldContext; onOpenMemory: () => void }) {
  const endpoint = getIn(ctx.value, ['memory', 'embeddingEndpoint']);
  return (
    <section className="settings-section" aria-labelledby="settings-memory">
      <header className="settings-section__header">
        <h3 id="settings-memory" className="settings-section__title">
          Memoria
        </h3>
        <button type="button" className="button" onClick={onOpenMemory}>
          Editar STRATUM.md
        </button>
      </header>
      <p className="settings-section__intro">
        Las decisiones del asistente se guardan aparte de las de cualquier proyecto, en{' '}
        <code>~/.stratum/desktop/memory/</code>.
      </p>
      <TextSetting
        ctx={ctx}
        path={['memory', 'globalFile']}
        label="STRATUM.md global"
        hint="Lo leen el asistente y la CLI al empezar cada conversación."
      />
      <CheckboxSetting
        ctx={ctx}
        path={['memory', 'autoExtract']}
        label="Extraer decisiones automáticamente tras cada respuesta"
      />
      <NumberSetting ctx={ctx} path={['memory', 'retrievalTopK']} label="Decisiones recuperadas por consulta" />
      <NumberSetting
        ctx={ctx}
        path={['memory', 'similarityThreshold']}
        label="Umbral de similitud"
        hint="De 0 a 1: por encima, dos decisiones se consideran la misma."
      />
      <div className="settings-field settings-field--check">
        <label className="settings-check">
          <input
            type="checkbox"
            disabled={ctx.disabled}
            checked={endpoint !== undefined}
            onChange={(e) => {
              const on = e.target.checked;
              ctx.update((v) =>
                setIn(v, ['memory', 'embeddingEndpoint'], on ? { url: 'http://localhost:11434/v1' } : undefined),
              );
            }}
          />
          Embeddings por HTTP (<code>/v1/embeddings</code>) en vez del modelo ONNX local
        </label>
      </div>
      {endpoint !== undefined && (
        <div className="settings-group">
          <TextSetting ctx={ctx} path={['memory', 'embeddingEndpoint', 'url']} label="URL" />
          <TextSetting ctx={ctx} path={['memory', 'embeddingEndpoint', 'model']} label="Modelo" />
          <SecretSetting ctx={ctx} path={['memory', 'embeddingEndpoint', 'apiKey']} label="API key" />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Espacios de trabajo
// ---------------------------------------------------------------------------

export function WorkspacesSection({ ctx, config }: { ctx: FieldContext; config: Config }) {
  const { usage, retention } = config;
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="settings-section" aria-labelledby="settings-workspaces">
      <header className="settings-section__header">
        <h3 id="settings-workspaces" className="settings-section__title">
          Espacios de trabajo
        </h3>
        <button type="button" className="button" onClick={config.refreshUsage}>
          Actualizar uso
        </button>
      </header>
      <p className="settings-section__intro">
        Cada conversación tiene su carpeta con los ficheros subidos y los generados. Sin uso, se
        comprime y más tarde se borra; el texto de la conversación se conserva siempre.
      </p>
      {usage && (
        <dl className="facts settings-usage">
          <dt>Uso total</dt>
          <dd>{formatBytes(usage.totalBytes)}</dd>
          <dt>Activos</dt>
          <dd>
            {usage.active.count} · {formatBytes(usage.active.bytes)}
          </dd>
          <dt>Comprimidos</dt>
          <dd>
            {usage.archived.count} · {formatBytes(usage.archived.bytes)}
          </dd>
          <dt>Purgados</dt>
          <dd>{usage.purged.count}</dd>
        </dl>
      )}
      <TextSetting
        ctx={ctx}
        path={['desktop', 'workspaces', 'root']}
        label="Carpeta"
        placeholder={usage?.root ?? '~/.stratum/desktop/workspaces'}
        hint="Ruta absoluta (p. ej. en otro disco). Se aplica al reiniciar el agente; las conversaciones existentes siguen en la carpeta anterior."
      />
      <NumberSetting ctx={ctx} path={['desktop', 'workspaces', 'maxFileMB']} label="Tamaño máximo por fichero" unit="MB" />
      <NumberSetting
        ctx={ctx}
        path={['desktop', 'workspaces', 'maxWorkspaceMB']}
        label="Tamaño máximo por conversación"
        unit="MB"
      />
      <NumberSetting
        ctx={ctx}
        path={['desktop', 'workspaces', 'compressAfterDays']}
        label="Comprimir tras"
        unit="días sin uso"
        hint="0 = nunca."
      />
      <NumberSetting
        ctx={ctx}
        path={['desktop', 'workspaces', 'deleteAfterDays']}
        label="Borrar los ficheros tras"
        unit="días sin uso"
        hint="0 = nunca. Las conversaciones fijadas no se tocan."
      />
      <div className="settings-field">
        {confirming ? (
          <span className="settings-confirm">
            ¿Aplicar ya la retención? Se comprimen o borran los ficheros que hayan superado los plazos
            guardados.
            <button type="button" className="button" onClick={() => setConfirming(false)}>
              No
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                setConfirming(false);
                config.runRetention();
              }}
            >
              Purgar ahora
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="button"
            disabled={retention.running}
            onClick={() => setConfirming(true)}
          >
            {retention.running ? 'Aplicando la retención…' : 'Purgar ahora'}
          </button>
        )}
        <p className="settings-field__hint">
          Usa los plazos guardados, no los que estén sin guardar. Nunca toca una conversación abierta.
        </p>
        {retention.report && (
          <p className="notice" data-tone="info" role="status">
            {retention.report.disabled
              ? 'La retención está desactivada (los dos plazos a 0).'
              : `Comprimidas: ${retention.report.archived} · purgadas: ${retention.report.purged}` +
                (retention.report.inUse ? ` · abiertas, sin tocar: ${retention.report.inUse}` : '') +
                (retention.report.failed ? ` · con error: ${retention.report.failed}` : '')}
          </p>
        )}
      </div>
    </section>
  );
}
