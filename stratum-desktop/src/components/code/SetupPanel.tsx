import { useCallback, useEffect, useRef, useState } from 'react';
import { loadInspection, type Inspection, type Loaded } from '../../client/code-actions';
import type { NativeBridge } from '../../ipc/native';

type Environment = Inspection['environments'][number];
type Profile = NonNullable<Inspection['profile']>['available'][number];

const TIER_LABEL: Record<Environment['tier'], string> = {
  production: 'producción',
  staging: 'preproducción',
  development: 'desarrollo',
};

/** Las reglas de un entorno, como las cuenta `/env` en la terminal. */
export function environmentRules(env: Environment): string {
  if (env.readOnly) return 'solo lectura: cualquier cambio se rechaza';
  const rules: string[] = [];
  if (env.requirePlan) rules.push('los cambios piden un plan aprobado');
  if (env.policy === 'confirm-always') {
    rules.push(
      env.confirmation === 'typed'
        ? 'cada cambio pide teclear el alias del destino'
        : 'cada cambio pide confirmación',
    );
  } else if (env.policy === 'allow') {
    rules.push('los cambios se ejecutan sin confirmación');
  } else if (env.confirmation === 'typed') {
    rules.push('lo destructivo pide teclear el alias del destino');
  }
  return rules.length > 0 ? rules.join('; ') : 'confirmaciones normales';
}

/** Qué tools deja ver un perfil de sesión. */
export function profileTools(profile: Profile): string {
  if (profile.allowedTools !== null) return profile.allowedTools.join(', ') || 'ninguna';
  return profile.hiddenTools.length > 0 ? `todas salvo ${profile.hiddenTools.join(', ')}` : 'todas';
}

/** Las tools MCP por server (`mcp__server__tool`); las que no encajan, en «otros». */
export function groupTools(tools: Inspection['tools']): { builtin: string[]; mcp: [string, string[]][] } {
  const builtin: string[] = [];
  const servers = new Map<string, string[]>();
  for (const tool of tools) {
    if (tool.source === 'builtin') {
      builtin.push(tool.name);
      continue;
    }
    const match = /^mcp__(.+?)__(.+)$/.exec(tool.name);
    const server = match?.[1] ?? 'otros';
    servers.set(server, [...(servers.get(server) ?? []), match?.[2] ?? tool.name]);
  }
  return { builtin, mcp: [...servers.entries()] };
}

/**
 * Cómo está montada la sesión de código que se mira: su perfil de sesión (que
 * se puede cambiar en reposo), las tools que recibe el modelo, los servers MCP,
 * los plugins y los entornos. Es lo que `/profile`, `/tools`, `/plugins` y
 * `/env` enseñan en la terminal. Se lee al abrirlo y al cambiar `refreshKey`;
 * sin sondeo y sin estado optimista: el perfil nuevo se ve cuando lo publica
 * el daemon.
 */
export function SetupPanel({
  native,
  sessionId,
  refreshKey,
  connected,
  locked,
  activeTarget,
  activeEnvironment,
  onProfile,
}: {
  native: NativeBridge;
  /** `null`: no hay sesión de código que mirar. */
  sessionId: string | null;
  refreshKey: string;
  connected: boolean;
  /** Por qué no se puede cambiar el perfil ahora; `null` si se puede. */
  locked: string | null;
  activeTarget: string | null;
  activeEnvironment: string | null;
  onProfile: (profile: string) => void;
}) {
  const [state, setState] = useState<Loaded<Inspection> | null>(null);
  const [loading, setLoading] = useState(false);
  const round = useRef(0);

  const refresh = useCallback(() => {
    if (!sessionId || !connected) return;
    const mine = ++round.current;
    setLoading(true);
    void loadInspection(native, sessionId).then((result) => {
      if (mine !== round.current) return;
      setLoading(false);
      setState(result);
    });
  }, [native, sessionId, connected]);

  useEffect(() => {
    setState(null);
    setLoading(false);
    return () => {
      round.current++;
    };
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const inspection = state?.ok ? state.value : null;
  const tools = inspection ? groupTools(inspection.tools) : null;

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Montaje</h2>
        {sessionId && (
          <button type="button" className="button button--small" onClick={refresh} disabled={loading || !connected}>
            {loading ? 'Leyendo…' : 'Actualizar'}
          </button>
        )}
      </div>
      <div className="side-panel__body">
        {!sessionId ? (
          <p className="side-panel__empty">
            Abre una sesión de código para ver su perfil, sus tools y sus entornos.
          </p>
        ) : state && !state.ok ? (
          <p className="notice" data-tone="warning" role="alert">
            {state.message}
          </p>
        ) : !inspection ? (
          <p className="side-panel__empty">Leyendo cómo está montada la sesión…</p>
        ) : (
          <>
            {inspection.truncated && (
              <p className="notice" data-tone="warning">
                La lista es más larga de lo que cabe aquí: se enseña recortada.
              </p>
            )}
            {inspection.profile && (
              <section className="conv-group" aria-label="Perfil de sesión">
                <h3 className="conv-group__title">Perfil de sesión</h3>
                <p className="side-panel__empty">
                  Qué tools ve el modelo. No cambia ninguna confirmación.
                  {inspection.profile.requested === 'auto' &&
                    (inspection.profile.detection?.detected
                      ? ` Elegido solo (auto): ${inspection.profile.detection.reasons.join(', ')}.`
                      : ' Elegido solo (auto): sin infraestructura a la vista.')}
                </p>
                {locked && <p className="side-panel__empty">{locked}</p>}
                <ul className="setup-list" role="radiogroup" aria-label="Perfil de sesión">
                  {inspection.profile.available.map((p) => {
                    const active = p.name === inspection.profile!.active;
                    return (
                      <li key={p.name}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className="setup-option"
                          data-active={active || undefined}
                          disabled={locked !== null || active}
                          onClick={() => onProfile(p.name)}
                        >
                          <strong className="setup-option__name">
                            {p.name}
                            {p.source === 'config' && <span className="setup-tag">config</span>}
                          </strong>
                          <span className="setup-option__detail">{p.description}</span>
                          <span className="setup-option__detail">Tools: {profileTools(p)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section className="conv-group" aria-label="Tools">
              <h3 className="conv-group__title">Tools · {inspection.tools.length}</h3>
              <p className="side-panel__empty">Las que recibiría el modelo en un turno empezado ahora.</p>
              <ul className="setup-chips">
                {tools!.builtin.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
              {tools!.mcp.map(([server, names]) => (
                <div key={server} className="setup-block">
                  <strong className="setup-block__title">MCP · {server}</strong>
                  <ul className="setup-chips">
                    {names.map((name) => (
                      <li key={name}>
                        <code>{name}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>

            {inspection.mcp.length > 0 && (
              <section className="conv-group" aria-label="Servers MCP">
                <h3 className="conv-group__title">Servers MCP</h3>
                <ul className="setup-list">
                  {inspection.mcp.map((server) => (
                    <li key={server.name} className="setup-row">
                      <strong>{server.name}</strong>
                      <span className="setup-row__meta" data-status={server.status}>
                        {server.status} · {server.tools} {server.tools === 1 ? 'tool' : 'tools'}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="conv-group" aria-label="Entornos">
              <h3 className="conv-group__title">Entornos</h3>
              <p className="side-panel__empty">
                Contexto activo: <code>{activeTarget ?? 'local'}</code>
                {activeEnvironment ? ` → ${activeEnvironment}` : ' (sin entorno)'}
              </p>
              {inspection.environments.length === 0 ? (
                <p className="side-panel__empty">
                  No hay entornos definidos: se añaden en la sección «environments» de la config.
                </p>
              ) : (
                <ul className="setup-list">
                  {inspection.environments.map((env) => (
                    <li key={env.name} className="setup-row" data-active={env.name === activeEnvironment || undefined}>
                      <strong>
                        {env.name} <span className="setup-tag" data-tier={env.tier}>{TIER_LABEL[env.tier]}</span>
                      </strong>
                      <span className="setup-row__meta">
                        <code>{env.match.join(', ')}</code>
                      </span>
                      <span className="setup-row__meta">{environmentRules(env)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="conv-group" aria-label="Plugins">
              <h3 className="conv-group__title">Plugins</h3>
              {!inspection.plugins.enabled ? (
                <p className="side-panel__empty">Los plugins están desactivados en esta sesión.</p>
              ) : inspection.plugins.loaded.length === 0 && inspection.plugins.skipped.length === 0 ? (
                <p className="side-panel__empty">Esta sesión no tiene plugins.</p>
              ) : (
                <ul className="setup-list">
                  {inspection.plugins.loaded.map((plugin) => (
                    <li key={plugin.id} className="setup-row">
                      <strong>{plugin.id}</strong>
                      <span className="setup-row__meta">
                        {Object.entries(plugin.hooks)
                          .map(([hook, n]) => `${hook} ×${n}`)
                          .join(' · ') || 'sin hooks'}
                      </span>
                    </li>
                  ))}
                  {inspection.plugins.skipped.map((skip, i) => (
                    <li key={`skip-${i}`} className="setup-row" data-skipped>
                      <strong>{skip.id ?? 'sin nombre'} · omitido</strong>
                      <span className="setup-row__meta">{skip.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
