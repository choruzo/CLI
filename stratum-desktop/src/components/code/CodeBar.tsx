import type { AgentProfile, Changes } from '../../client/code-actions';
import { projectName } from '../../view/mode';
import { ICON, StrokeIcon } from '../chat/icons';

/** El perfil «sin perfil»: el agente de código tal cual. */
export const GENERAL_AGENT = 'general';

/**
 * Selector de perfil de agente. El actual siempre aparece, aunque la lista no
 * haya llegado o ya no lo traiga: lo que manda es lo que dice la sesión.
 */
export function ProfileSelect({
  value,
  profiles,
  disabled,
  title,
  onChange,
}: {
  value: string;
  profiles: AgentProfile[] | null;
  disabled?: boolean;
  title?: string;
  onChange: (agent: string | null) => void;
}) {
  const names = new Set<string>([GENERAL_AGENT, value, ...(profiles ?? []).map((p) => p.name)]);
  const described = new Map((profiles ?? []).map((p) => [p.name, p.description]));
  return (
    <label className="code-bar__field" title={title ?? described.get(value) ?? 'Perfil de agente de la sesión'}>
      <span className="code-bar__label">Perfil</span>
      <select
        className="code-bar__select"
        aria-label="Perfil de agente"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === GENERAL_AGENT ? null : e.target.value)}
      >
        {[...names].map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** `+12 −3 · 4 ficheros`, o lo que haya que decir si no hay nada que contar. */
export function changesLabel(changes: Changes | null): string {
  if (!changes) return 'Cambios';
  if (!changes.isRepo) return 'Sin repositorio git';
  if (changes.files === 0) return 'Sin cambios';
  return `${changes.files} ${changes.files === 1 ? 'fichero' : 'ficheros'}`;
}

/**
 * Barra de una sesión de código: en qué carpeta trabaja, con qué perfil, si
 * está en solo lectura y cuánto ha cambiado el árbol de trabajo. Todo sale de
 * la foto de la sesión; cambiar algo es una petición al daemon y se ve cuando
 * él lo publica (mientras, los controles quedan deshabilitados).
 */
export function CodeBar({
  cwd,
  agent,
  readOnly,
  profiles,
  changes,
  runningJobs,
  locked,
  lockedReason,
  onAgent,
  onReadOnly,
  onOpenChanges,
  onOpenJobs,
}: {
  cwd: string;
  agent: string;
  readOnly: boolean;
  profiles: AgentProfile[] | null;
  changes: Changes | null;
  runningJobs: number;
  /** No se puede reconfigurar ahora (turno en marcha, sesión de una terminal, petición en vuelo). */
  locked: boolean;
  lockedReason?: string;
  onAgent: (agent: string | null) => void;
  onReadOnly: (readOnly: boolean) => void;
  onOpenChanges: () => void;
  onOpenJobs: () => void;
}) {
  const dirty = changes?.isRepo && changes.files > 0;
  return (
    <div className="code-bar" role="toolbar" aria-label="Sesión de código">
      <span className="code-bar__project" title={cwd}>
        <StrokeIcon d={ICON.folder} size={14} />
        <span className="code-bar__project-name">{projectName(cwd)}</span>
      </span>
      <ProfileSelect value={agent} profiles={profiles} disabled={locked} title={locked ? lockedReason : undefined} onChange={onAgent} />
      <button
        type="button"
        className="code-bar__toggle"
        role="switch"
        aria-checked={readOnly}
        disabled={locked}
        title={
          locked
            ? lockedReason
            : readOnly
              ? 'Solo lectura: el agente no puede cambiar nada. Pulsa para permitir cambios.'
              : 'El agente puede cambiar ficheros y ejecutar comandos (con sus confirmaciones). Pulsa para dejarlo en solo lectura.'
        }
        onClick={() => onReadOnly(!readOnly)}
      >
        <span className="code-bar__toggle-dot" aria-hidden="true" />
        Solo lectura
      </button>
      <span className="code-bar__spacer" />
      {runningJobs > 0 && (
        <button type="button" className="code-bar__chip" onClick={onOpenJobs} title="Procesos en segundo plano">
          <StrokeIcon d={ICON.terminal} size={14} />
          {runningJobs} en marcha
        </button>
      )}
      <button
        type="button"
        className="code-bar__chip"
        data-dirty={dirty || undefined}
        onClick={onOpenChanges}
        title="Ver los cambios del árbol de trabajo"
      >
        {dirty && (
          <>
            <span className="code-bar__added">+{changes.added}</span>
            <span className="code-bar__deleted">−{changes.deleted}</span>
          </>
        )}
        {changesLabel(changes)}
      </button>
    </div>
  );
}
