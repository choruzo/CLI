import type { AgentProfile } from '../../client/code-actions';
import { projectName } from '../../view/mode';
import { ICON, StrokeIcon } from '../chat/icons';
import { ProfileSelect } from './CodeBar';

/**
 * Lo que hay que decidir antes del primer mensaje de una sesión de código: en
 * qué carpeta trabaja el agente (se elige en el diálogo del sistema; las
 * recientes salen de las sesiones que el daemon conoce) y con qué perfil.
 * Nada se abre hasta enviar el mensaje.
 */
export function ProjectPicker({
  project,
  recent,
  profiles,
  agent,
  picking,
  disabled,
  onPick,
  onProject,
  onAgent,
}: {
  project: string | null;
  recent: string[];
  profiles: AgentProfile[] | null;
  agent: string;
  /** El diálogo de carpetas está abierto. */
  picking: boolean;
  disabled: boolean;
  onPick: () => void;
  onProject: (cwd: string) => void;
  onAgent: (agent: string | null) => void;
}) {
  const others = recent.filter((cwd) => cwd !== project);
  return (
    <div className="project-picker" role="group" aria-label="Proyecto de la sesión nueva">
      <div className="project-picker__row">
        <span className="project-picker__current" data-empty={!project || undefined} title={project ?? undefined}>
          <StrokeIcon d={ICON.folder} size={14} />
          {project ? (
            <>
              <span className="project-picker__name">{projectName(project)}</span>
              <span className="project-picker__path">{project}</span>
            </>
          ) : (
            <span className="project-picker__path">Elige la carpeta del proyecto para empezar</span>
          )}
        </span>
        <button
          type="button"
          className={project ? 'button button--small' : 'button button--primary button--small'}
          onClick={onPick}
          disabled={disabled || picking}
        >
          {picking ? 'Eligiendo…' : project ? 'Cambiar…' : 'Elegir carpeta…'}
        </button>
        <ProfileSelect value={agent} profiles={profiles} disabled={disabled} onChange={onAgent} />
      </div>
      {others.length > 0 && (
        <div className="project-picker__recent" role="group" aria-label="Proyectos recientes">
          <span className="project-picker__label">Recientes</span>
          {others.map((cwd) => (
            <button
              key={cwd}
              type="button"
              className="chip"
              title={cwd}
              disabled={disabled}
              onClick={() => onProject(cwd)}
            >
              {projectName(cwd)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
