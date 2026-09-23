import { useEffect, useId, useState, type ReactNode } from 'react';
import { SECRET_PLACEHOLDER, type ConfigIssue } from '../../ipc/types';
import { getIn, issuesFor, numberField, setIn, type Json } from './config-draft';

/**
 * Campos de los formularios de Ajustes (D5). Cada uno lee y escribe una ruta
 * del borrador; vaciarlo borra la clave, y entonces rige el valor por defecto,
 * que se muestra como placeholder.
 */

export interface FieldContext {
  value: Json;
  defaults: Json;
  issues: readonly ConfigIssue[];
  update: (fn: (value: Json) => Json) => void;
  disabled?: boolean;
}

export function Issues({ issues }: { issues: readonly ConfigIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="settings-issues" role="alert">
      {issues.map((i, n) => (
        <li key={`${i.path}:${n}`}>
          {i.path && <code>{i.path}</code>} {i.message}
        </li>
      ))}
    </ul>
  );
}

function Row({
  id,
  label,
  hint,
  issues,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  issues: readonly ConfigIssue[];
  children: ReactNode;
}) {
  return (
    <div className="settings-field" data-invalid={issues.length > 0 || undefined}>
      <label className="settings-field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && <p className="settings-field__hint">{hint}</p>}
      <Issues issues={issues} />
    </div>
  );
}

const fmt = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);

export function TextSetting({
  ctx,
  path,
  label,
  hint,
  placeholder,
}: {
  ctx: FieldContext;
  path: string[];
  label: string;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const id = useId();
  const current = getIn(ctx.value, path);
  return (
    <Row id={id} label={label} hint={hint} issues={issuesFor(ctx.issues, path.join('.'))}>
      <input
        id={id}
        className="settings-input"
        type="text"
        spellCheck={false}
        disabled={ctx.disabled}
        value={typeof current === 'string' ? current : fmt(current)}
        placeholder={placeholder ?? fmt(getIn(ctx.defaults, path))}
        onChange={(e) => {
          const v = e.target.value;
          ctx.update((draft) => setIn(draft, path, v === '' ? undefined : v));
        }}
      />
    </Row>
  );
}

/**
 * Número con el texto tal cual se escribe: un «1.» a medio teclear no se
 * convierte ni se pierde; solo un valor completo llega al borrador.
 */
export function NumberSetting({
  ctx,
  path,
  label,
  hint,
  unit,
}: {
  ctx: FieldContext;
  path: string[];
  label: string;
  hint?: ReactNode;
  unit?: string;
}) {
  const id = useId();
  const current = getIn(ctx.value, path);
  const [text, setText] = useState(fmt(current));
  useEffect(() => {
    // Cambió desde fuera (Avanzado, recarga): se sincroniza si no coincide con
    // lo tecleado. `text` no es dependencia a propósito: teclear no resincroniza.
    setText((t) => (numberField(t) === (typeof current === 'number' ? current : undefined) ? t : fmt(current)));
  }, [current]);
  const local = numberField(text) === null ? [{ path: path.join('.'), message: 'Tiene que ser un número.' }] : [];
  return (
    <Row id={id} label={label} hint={hint} issues={[...local, ...issuesFor(ctx.issues, path.join('.'))]}>
      <span className="settings-number">
        <input
          id={id}
          className="settings-input settings-input--number"
          type="text"
          inputMode="decimal"
          disabled={ctx.disabled}
          value={text}
          placeholder={fmt(getIn(ctx.defaults, path))}
          aria-describedby={unit ? `${id}-unit` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            const n = numberField(e.target.value);
            if (n !== null) ctx.update((draft) => setIn(draft, path, n));
          }}
        />
        {unit && (
          <span id={`${id}-unit`} className="settings-number__unit">
            {unit}
          </span>
        )}
      </span>
    </Row>
  );
}

export function CheckboxSetting({
  ctx,
  path,
  label,
  hint,
}: {
  ctx: FieldContext;
  path: string[];
  label: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const current = getIn(ctx.value, path);
  const effective = typeof current === 'boolean' ? current : getIn(ctx.defaults, path) === true;
  return (
    <div className="settings-field settings-field--check">
      <label className="settings-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          disabled={ctx.disabled}
          checked={effective}
          onChange={(e) => {
            const v = e.target.checked;
            ctx.update((draft) => setIn(draft, path, v));
          }}
        />
        {label}
      </label>
      {hint && <p className="settings-field__hint">{hint}</p>}
      <Issues issues={issuesFor(ctx.issues, path.join('.'))} />
    </div>
  );
}

export function SelectSetting({
  ctx,
  path,
  label,
  hint,
  options,
}: {
  ctx: FieldContext;
  path: string[];
  label: string;
  hint?: ReactNode;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}) {
  const id = useId();
  const current = getIn(ctx.value, path);
  const effective = typeof current === 'string' ? current : fmt(getIn(ctx.defaults, path));
  return (
    <Row id={id} label={label} hint={hint} issues={issuesFor(ctx.issues, path.join('.'))}>
      <select
        id={id}
        className="settings-input"
        disabled={ctx.disabled}
        value={effective}
        onChange={(e) => {
          const v = e.target.value;
          ctx.update((draft) => setIn(draft, path, v));
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/**
 * Secreto (API key). Uno guardado llega como `SECRET_PLACEHOLDER` y no se
 * muestra: «Cambiar» lo sustituye y «Quitar» lo deja vacío. Se admite
 * también una referencia `${VAR}`, que es lo recomendable.
 */
export function SecretInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  if (value === SECRET_PLACEHOLDER) {
    return (
      <span className="settings-secret">
        <span id={id} className="settings-secret__stored">
          Guardada ({SECRET_PLACEHOLDER})
        </span>
        <button type="button" className="button" disabled={disabled} onClick={() => onChange('')}>
          Cambiar
        </button>
      </span>
    );
  }
  return (
    <input
      id={id}
      className="settings-input"
      type={value.includes('${') ? 'text' : 'password'}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      value={value}
      placeholder={placeholder ?? 'sk-… o ${VARIABLE}'}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function SecretSetting({
  ctx,
  path,
  label,
  hint,
}: {
  ctx: FieldContext;
  path: string[];
  label: string;
  hint?: ReactNode;
}) {
  const id = useId();
  const current = getIn(ctx.value, path);
  return (
    <Row id={id} label={label} hint={hint} issues={issuesFor(ctx.issues, path.join('.'))}>
      <SecretInput
        id={id}
        disabled={ctx.disabled}
        value={typeof current === 'string' ? current : ''}
        onChange={(v) => ctx.update((draft) => setIn(draft, path, v === '' ? undefined : v))}
      />
    </Row>
  );
}
