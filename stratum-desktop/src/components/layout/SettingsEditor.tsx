import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toCommandError, type NativeBridge } from '../../ipc/native';
import {
  RESTART_NOTES,
  type ProviderFieldMeta,
  type SecretView,
  type SettingsChange,
  type SettingsField,
  type SettingsLevel,
  type SettingsProvider,
  type SettingsRestart,
  type SettingsValue,
  type SettingsView,
} from '../../ipc/settings';

/**
 * Editor de la configuración **global** de Stratum (`~/.stratum/.stratumrc.json`),
 * equivalente a `stratum config`. Aquí solo se pinta y se pide: el lado nativo
 * (`src-tauri/src/settings.rs`) lee el fichero, decide el nivel de cada clave y
 * lo escribe llamando a la CLI instalada.
 *
 *  - **Nivel A**: se guarda al momento.
 *  - **Nivel B** (candado): el lado nativo abre una ventana aparte para confirmar.
 *    Si se cierra o caduca, no se escribe nada.
 *  - **Solo CLI**: lo que ejecuta código o abre acceso se enseña aparte, sin editar.
 *
 * El webview no recibe nunca una clave de API guardada: llega como «hay una» o
 * como el nombre de su variable de entorno. Tampoco **hay estado optimista**: tras
 * cada guardado se enseña lo que el lado nativo ha vuelto a leer.
 */

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'confirming' }
  | { kind: 'saved'; changed: boolean }
  | { kind: 'error'; message: string };

const IDLE: Status = { kind: 'idle' };

/** Un error de la petición, tal cual lo cuenta el lado nativo (ya en español). */
function failureText(err: unknown): string {
  const e = toCommandError(err);
  if (e.kind === 'unknown') return `${e.message} No se repite sola.`;
  return e.message;
}

function Lock() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2M3.5 7h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LevelBadge({ level }: { level: SettingsLevel }) {
  if (level !== 'B') return null;
  return (
    <span className="settings-level" title="Cambiarlo pide confirmar en una ventana aparte, fuera de esta">
      <Lock />
      Pide confirmar
    </span>
  );
}

function StatusLine({ status }: { status: Status }) {
  let text: string | null = null;
  let tone = '';
  if (status.kind === 'saving') text = 'Guardando…';
  if (status.kind === 'confirming') text = 'Confirma el cambio en la ventana que se ha abierto…';
  if (status.kind === 'saved') text = status.changed ? 'Guardado' : 'Sin cambios';
  if (status.kind === 'error') {
    text = status.message;
    tone = 'bad';
  }
  return (
    <p className="settings-status" data-tone={tone || undefined} role="status" aria-live="polite">
      {text}
    </p>
  );
}

/** Cómo se enseña un valor por defecto. */
function show(value: SettingsValue): string {
  if (value === null || value === undefined) return 'sin definir';
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  if (value === '') return 'vacío';
  return String(value);
}

/** Un guardado con su estado propio: «guardando / confirmando / guardado / error». */
function useSave(level: SettingsLevel, save: () => Promise<SettingsChange | void>) {
  const [status, setStatus] = useState<Status>(IDLE);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (): Promise<boolean> => {
    setStatus(level === 'B' ? { kind: 'confirming' } : { kind: 'saving' });
    try {
      const result = await save();
      if (alive.current) setStatus({ kind: 'saved', changed: result ? result.changed : true });
      return true;
    } catch (err) {
      if (alive.current) setStatus({ kind: 'error', message: failureText(err) });
      return false;
    }
  }, [level, save]);
  return { status, run, reset: () => setStatus(IDLE) };
}

/** Texto que parece una clave: se pinta con puntos, sin ser un campo de contraseña. */
const SECRET_INPUT_PROPS = {
  type: 'text',
  className: 'settings-input settings-input--secret',
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
} as const;

function SecretControl({
  label,
  secret,
  level,
  disabled,
  onSave,
}: {
  label: string;
  secret: SecretView;
  level: SettingsLevel;
  disabled: boolean;
  onSave: (value: string) => Promise<SettingsChange | void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const { status, run, reset } = useSave(level, () => onSave(draft));
  const stored = secret.envVar
    ? `Se lee de la variable de entorno ${secret.envVar}`
    : secret.set
      ? 'Guardada (no se muestra)'
      : 'Sin clave';
  const close = () => {
    setDraft('');
    setEditing(false);
  };
  return (
    <div className="settings-secret-block">
      {!editing ? (
        <div className="settings-secret">
          <span className="settings-secret__stored">{stored}</span>
          <button
            type="button"
            className="button button--small"
            disabled={disabled}
            onClick={() => {
              reset();
              setEditing(true);
            }}
          >
            Cambiar
          </button>
        </div>
      ) : (
        <form
          className="settings-secret"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run().then((ok) => ok && close());
          }}
        >
          <input
            {...SECRET_INPUT_PROPS}
            aria-label={`${label}: clave nueva`}
            placeholder="Clave nueva o ${NOMBRE_VARIABLE}"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={status.kind === 'saving' || status.kind === 'confirming'}
          />
          <button
            type="submit"
            className="button button--small button--primary"
            disabled={status.kind === 'saving' || status.kind === 'confirming'}
          >
            Guardar
          </button>
          <button type="button" className="button button--small" onClick={close}>
            Cancelar
          </button>
        </form>
      )}
      <StatusLine status={status} />
    </div>
  );
}

/** Parsea lo escrito en un campo numérico o de «auto o número». */
function parseDraft(field: SettingsField, draft: string): SettingsValue | { error: string } {
  const text = draft.trim();
  if (field.kind === 'autoInt' && text === 'auto') return 'auto';
  if (field.kind === 'int' || field.kind === 'number' || field.kind === 'autoInt') {
    const n = Number(text);
    if (text === '' || !Number.isFinite(n)) {
      return { error: field.kind === 'autoInt' ? 'Escribe «auto» o un número.' : 'Escribe un número.' };
    }
    if (field.kind !== 'number' && !Number.isInteger(n)) return { error: 'Tiene que ser un número entero.' };
    if (field.min !== null && n < field.min) return { error: `Mínimo ${field.min}.` };
    if (field.max !== null && n > field.max) return { error: `Máximo ${field.max}.` };
    return n;
  }
  return draft;
}

const draftOf = (value: SettingsValue): string => (value === null || value === undefined ? '' : String(value));

/** Una dirección con credenciales o parámetros llega tapada: no se edita a ciegas. */
const MASKED = '••••';

function FieldRow({
  field,
  readOnly,
  aliases,
  onSave,
}: {
  field: SettingsField;
  readOnly: boolean;
  aliases: string[];
  onSave: (path: string, value: SettingsValue) => Promise<SettingsChange>;
}) {
  const masked = typeof field.value === 'string' && field.value.includes(MASKED);
  const lockedReason =
    field.locked ??
    (masked ? 'Tiene credenciales o parámetros en la dirección: edítala con `stratum config`.' : null);
  const disabled = readOnly || lockedReason !== null;
  const [draft, setDraft] = useState(draftOf(field.value));
  const [problem, setProblem] = useState<string | null>(null);
  // El valor que enseña el lado nativo manda: lo que se escribe sin guardar se pierde al releer.
  useEffect(() => setDraft(draftOf(field.value)), [field.value]);
  const parsedRef = useRef<SettingsValue>(null);
  const save = useCallback(() => onSave(field.path, parsedRef.current), [onSave, field.path]);
  const { status, run } = useSave(field.level, save);

  const commit = (value: SettingsValue) => {
    parsedRef.current = value;
    setProblem(null);
    void run();
  };
  const submitText = (e?: FormEvent) => {
    e?.preventDefault();
    const parsed = parseDraft(field, draft);
    if (typeof parsed === 'object' && parsed !== null) {
      setProblem(parsed.error);
      return;
    }
    commit(parsed);
  };
  const dirty = draft !== draftOf(field.value);
  const busy = status.kind === 'saving' || status.kind === 'confirming';
  const id = `setting-${field.path}`;

  let control: ReactNode;
  if (field.kind === 'secret' && field.secret) {
    control = (
      <SecretControl
        label={field.label}
        secret={field.secret}
        level={field.level}
        disabled={disabled}
        onSave={(value) => onSave(field.path, value)}
      />
    );
  } else if (field.kind === 'bool') {
    control = (
      <label className="settings-check">
        <input
          id={id}
          type="checkbox"
          checked={field.value === true}
          disabled={disabled || busy}
          onChange={(e) => commit(e.target.checked)}
        />
        {field.value === true ? 'Sí' : 'No'}
      </label>
    );
  } else if (field.kind === 'enum' || field.kind === 'alias') {
    const options = field.kind === 'alias' ? aliases : field.options;
    control = (
      <select
        id={id}
        className="settings-input"
        value={typeof field.value === 'string' ? field.value : ''}
        disabled={disabled || busy || options.length === 0}
        onChange={(e) => commit(e.target.value)}
      >
        {typeof field.value !== 'string' && <option value="">(sin definir)</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else {
    const numeric = field.kind === 'int' || field.kind === 'number';
    control = (
      <form className="settings-number" onSubmit={submitText}>
        <input
          id={id}
          className={numeric ? 'settings-input settings-input--number' : 'settings-input'}
          type="text"
          inputMode={numeric ? 'decimal' : undefined}
          autoComplete="off"
          spellCheck={false}
          value={draft}
          disabled={disabled || busy}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="button button--small"
          disabled={disabled || busy || !dirty}
          aria-label={`Guardar ${field.label}`}
        >
          Guardar
        </button>
      </form>
    );
  }

  return (
    <div className="settings-field" data-invalid={problem ? '' : undefined} data-path={field.path}>
      <div className="settings-field__head">
        <label className="settings-field__label" htmlFor={id}>
          {field.label}
        </label>
        <LevelBadge level={field.level} />
        {field.isDefault && field.kind !== 'secret' && <span className="settings-tag">por defecto</span>}
      </div>
      {control}
      {field.hint && <p className="settings-field__hint">{field.hint}</p>}
      {!field.isDefault && field.kind !== 'secret' && field.default !== null && (
        <p className="settings-field__hint">Por defecto: {show(field.default)}</p>
      )}
      {lockedReason && <p className="settings-field__hint">{lockedReason}</p>}
      {problem && <p className="settings-status" data-tone="bad">{problem}</p>}
      {field.kind !== 'secret' && <StatusLine status={status} />}
    </div>
  );
}

function ProviderCard({
  provider,
  fields,
  readOnly,
  aliases,
  onSave,
}: {
  provider: SettingsProvider;
  fields: ProviderFieldMeta[];
  readOnly: boolean;
  aliases: string[];
  onSave: (path: string, value: SettingsValue) => Promise<SettingsChange>;
}) {
  const asField = (meta: ProviderFieldMeta): SettingsField => {
    const base = {
      path: `provider.providers.${provider.alias}.${meta.name}`,
      label: meta.label,
      hint: meta.hint,
      kind: meta.kind,
      options: [],
      min: meta.min,
      max: meta.max,
      level: meta.level,
      default: null,
      isDefault: false,
      restart: 'session' as const,
      locked: null,
    };
    if (meta.name === 'apiKey') return { ...base, value: null, secret: provider.apiKey };
    const value =
      meta.name === 'baseUrl'
        ? provider.baseUrl
        : meta.name === 'model'
          ? provider.model
          : provider.contextWindow;
    return { ...base, value, secret: null };
  };
  const make = useSave('A', () => onSave('provider.default', provider.alias));
  return (
    <section className="settings-card" aria-label={`Provider ${provider.alias}`}>
      <header className="settings-card__header">
        <h4 className="settings-card__title">
          {provider.alias}
          {provider.isDefault && <span className="settings-tag">por defecto</span>}
        </h4>
        {!provider.isDefault && (
          <button
            type="button"
            className="button button--small"
            disabled={readOnly || make.status.kind === 'saving'}
            onClick={() => void make.run()}
          >
            Usar por defecto
          </button>
        )}
      </header>
      {make.status.kind === 'error' && <StatusLine status={make.status} />}
      {fields.map((meta) => (
        <FieldRow key={meta.name} field={asField(meta)} readOnly={readOnly} aliases={aliases} onSave={onSave} />
      ))}
    </section>
  );
}

function AddProvider({
  native,
  readOnly,
  first,
  onChanged,
}: {
  native: NativeBridge;
  readOnly: boolean;
  first: boolean;
  onChanged: (change: SettingsChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const { status, run, reset } = useSave('B', async () => {
    const change = await native.settingsAddProvider({ alias: alias.trim(), baseUrl: baseUrl.trim(), apiKey, model: model.trim(), makeDefault });
    onChanged(change);
    return change;
  });
  const close = () => {
    setApiKey('');
    setOpen(false);
  };
  if (!open) {
    return (
      <button
        type="button"
        className="button"
        disabled={readOnly}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Añadir un provider
      </button>
    );
  }
  const busy = status.kind === 'saving' || status.kind === 'confirming';
  return (
    <form
      className="settings-card settings-add"
      aria-label="Añadir un provider"
      onSubmit={(e) => {
        e.preventDefault();
        void run().then((ok) => {
          if (ok) {
            setAlias('');
            setBaseUrl('');
            setModel('');
            close();
          }
        });
      }}
    >
      <header className="settings-card__header">
        <h4 className="settings-card__title">Añadir un provider</h4>
        <LevelBadge level="B" />
      </header>
      <p className="settings-card__hint">
        Cualquier servidor compatible con la API de OpenAI (Ollama, llama.cpp, vLLM, LiteLLM…).
        Para la clave puedes escribir <code>{'${NOMBRE_VARIABLE}'}</code> y se leerá de esa variable de entorno.
      </p>
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="new-provider-alias">Alias</label>
        <input id="new-provider-alias" className="settings-input" value={alias} onChange={(e) => setAlias(e.target.value)} autoComplete="off" spellCheck={false} placeholder="mi-ollama" disabled={busy} />
      </div>
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="new-provider-url">Dirección (baseUrl)</label>
        <input id="new-provider-url" className="settings-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://localhost:11434/v1" disabled={busy} />
      </div>
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="new-provider-key">Clave de API</label>
        <input id="new-provider-key" {...SECRET_INPUT_PROPS} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Opcional" disabled={busy} />
      </div>
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="new-provider-model">Modelo por defecto</label>
        <input id="new-provider-model" className="settings-input" value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Opcional" disabled={busy} />
      </div>
      {!first && (
        <label className="settings-check">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} disabled={busy} />
          Usarlo por defecto
        </label>
      )}
      <StatusLine status={status} />
      <div className="settings-add__actions">
        <button type="button" className="button" onClick={close} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="button button--primary" disabled={busy || alias.trim() === '' || baseUrl.trim() === ''}>
          Añadir
        </button>
      </div>
    </form>
  );
}

/** Una sección del editor, para el índice de Ajustes: el `id` es el de su título. */
export interface SettingsSectionLink {
  id: string;
  title: string;
}

export function SettingsEditor({
  native,
  onSections,
}: {
  native: NativeBridge;
  /** Qué secciones pinta el editor, en orden: se avisa cuando llega o cambia la vista. */
  onSections?: (sections: SettingsSectionLink[]) => void;
}) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restarts, setRestarts] = useState<SettingsRestart[]>([]);
  const alive = useRef(true);

  const load = useCallback(() => {
    native
      .settingsGet()
      .then((v) => {
        if (!alive.current) return;
        setView(v);
        setLoadError(null);
      })
      .catch((err) => {
        if (alive.current) setLoadError(failureText(err));
      });
  }, [native]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const apply = useCallback((change: SettingsChange) => {
    setView(change.view);
    const restart = change.restart;
    if (change.changed && restart) setRestarts((prev) => (prev.includes(restart) ? prev : [...prev, restart]));
  }, []);

  const save = useCallback(
    async (path: string, value: SettingsValue): Promise<SettingsChange> => {
      const change = await native.settingsSet(path, value);
      apply(change);
      return change;
    },
    [native, apply],
  );

  // El índice solo depende de qué secciones hay, no de sus valores.
  const sectionKey = view ? JSON.stringify(view.sections.map((s) => [s.id, s.title])) : null;
  useEffect(() => {
    if (!onSections) return;
    if (sectionKey === null) {
      onSections([{ id: 'settings-editor', title: 'Configuración de Stratum' }]);
      return;
    }
    const sections = JSON.parse(sectionKey) as Array<[string, string]>;
    onSections([
      { id: 'settings-providers', title: 'Providers' },
      ...sections.map(([id, title]) => ({ id: `settings-s-${id}`, title })),
      { id: 'settings-cli-only', title: 'Solo desde la CLI' },
    ]);
  }, [onSections, sectionKey]);

  if (!view) {
    return (
      <section className="settings-card" aria-labelledby="settings-editor">
        <h3 id="settings-editor" className="settings-card__title">
          Configuración de Stratum
        </h3>
        {loadError ? (
          <p className="notice" data-tone="warning">
            {loadError}
          </p>
        ) : (
          <p className="settings-card__hint">Leyendo la configuración…</p>
        )}
      </section>
    );
  }

  const readOnly = view.state === 'readOnly';
  const aliases = view.providers.map((p) => p.alias);
  return (
    <div className="settings-editor">
      {readOnly && (
        <p className="notice" data-tone="warning" role="alert">
          {view.reason ?? 'El editor está en solo lectura.'} Se enseñan los valores, pero no se pueden cambiar desde aquí.
        </p>
      )}
      {restarts.length > 0 && (
        <p className="notice" data-tone="info" role="status">
          {restarts.map((r) => RESTART_NOTES[r]).join(' ')}
        </p>
      )}
      <section className="settings-card" aria-labelledby="settings-providers">
        <header className="settings-card__header">
          <h3 id="settings-providers" className="settings-card__title">
            Providers
          </h3>
        </header>
        <p className="settings-card__hint">
          Los servidores de modelos que usa Stratum. Las claves no se muestran: solo si hay una guardada.
        </p>
        {view.providers.length === 0 && <p className="settings-card__hint">Todavía no hay ninguno.</p>}
        {view.providers.map((p) => (
          <ProviderCard
            key={p.alias}
            provider={p}
            fields={view.providerFields}
            readOnly={readOnly}
            aliases={aliases}
            onSave={save}
          />
        ))}
        <AddProvider native={native} readOnly={readOnly} first={view.providers.length === 0} onChanged={apply} />
      </section>
      {view.sections.map((section) => (
        <section key={section.id} className="settings-card" aria-labelledby={`settings-s-${section.id}`}>
          <h3 id={`settings-s-${section.id}`} className="settings-card__title">
            {section.title}
          </h3>
          {section.intro && <p className="settings-card__hint">{section.intro}</p>}
          {section.fields.length === 0 && <p className="settings-card__hint">No hay nada definido todavía.</p>}
          {section.fields.map((field) => (
            <FieldRow key={field.path} field={field} readOnly={readOnly} aliases={aliases} onSave={save} />
          ))}
        </section>
      ))}
      <section className="settings-card" aria-labelledby="settings-cli-only">
        <h3 id="settings-cli-only" className="settings-card__title">
          Solo desde la CLI
        </h3>
        <p className="settings-card__hint">
          Lo que ejecuta código o abre acceso (plugins, servidores MCP, SSH, la caja, canales…) y las listas de reglas
          no se editan desde Desktop: edítalo con <code>stratum config</code>. Aquí solo se dice si hay algo definido.
        </p>
        <ul className="settings-cli-only">
          {view.cliOnly.map((item) => (
            <li key={item.title}>
              <span>{item.title}</span>
              <span className="settings-tag" data-present={item.present ? '' : undefined}>
                {item.present ? 'definido' : 'sin definir'}
              </span>
              <span className="settings-level">Solo CLI</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
