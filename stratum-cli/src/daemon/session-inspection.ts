/**
 * `sessions.inspect` — cómo está montada una sesión viva: lo que `chat` enseña
 * con `/profile`, `/tools`, `/env` y `/plugins`, para un cliente del protocolo
 * (el modo código de Desktop).
 *
 * Solo lee lo que ya hay en memoria: no conecta servers MCP, no carga plugins y
 * no monta nada. No lleva rutas, comandos ni la configuración de un server o de
 * un plugin, y todo texto libre sale redactado y recortado.
 */
import { embeddedAgentName } from '../agent/presets.js';
import { listSessionProfiles } from '../agent/session-profile.js';
import type { SessionHost } from '../host/session-host.js';
import { INSPECT_LIMITS, type ProtocolSessionInspection } from '../protocol/index.js';
import { redactText } from '../security/redact-output.js';
import { listEnvironments } from '../tools/environments.js';

const MCP_PREFIX = 'mcp__';

export function inspectSession(
  host: Pick<SessionHost, 'agent' | 'mcp' | 'plugins'>,
): ProtocolSessionInspection {
  const { agent } = host;
  const config = agent.getConfig();
  let truncated = false;
  const cap = <T>(items: readonly T[], max: number): T[] => {
    if (items.length <= max) return [...items];
    truncated = true;
    return items.slice(0, max);
  };
  const text = (value: string): string =>
    redactText(value, config).slice(0, INSPECT_LIMITS.reasonChars);

  const active = embeddedAgentName(agent.promptPreset) ? null : agent.getSessionProfile();
  const detection = agent.getProfileDetection();
  const requested = agent.getSessionProfileRequest();
  const profile: ProtocolSessionInspection['profile'] = active
    ? {
        requested,
        active: active.name,
        ...(requested === 'auto' && detection
          ? {
              detection: {
                detected: detection.detected,
                reasons: cap(detection.reasons, 32).map(text),
              },
            }
          : {}),
        available: cap(listSessionProfiles(config), INSPECT_LIMITS.profiles).map((p) => ({
          name: p.name,
          description: text(p.description),
          allowedTools: p.allowedTools === null ? null : cap(p.allowedTools, INSPECT_LIMITS.tools),
          hiddenTools: cap(p.hiddenTools, INSPECT_LIMITS.tools),
          source: p.source,
        })),
      }
    : null;

  const plugins = host.plugins.report();
  return {
    profile,
    tools: cap(agent.offeredToolNames(), INSPECT_LIMITS.tools).map((name) => ({
      name,
      source: name.startsWith(MCP_PREFIX) ? ('mcp' as const) : ('builtin' as const),
    })),
    mcp: cap(host.mcp.getClients(), INSPECT_LIMITS.mcpServers).map((client) => ({
      name: client.name,
      status: client.status,
      tools: client.tools.length,
    })),
    plugins: {
      enabled: plugins.enabled,
      loaded: cap(plugins.loaded, INSPECT_LIMITS.plugins).map((p) => ({
        id: p.id,
        source: p.source,
        hooks: Object.fromEntries(
          Object.entries(p.hooks).filter((e): e is [string, number] => typeof e[1] === 'number'),
        ),
      })),
      skipped: cap(plugins.skipped, INSPECT_LIMITS.plugins).map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        reason: text(s.reason),
      })),
    },
    environments: cap(listEnvironments(config), INSPECT_LIMITS.environments).map((env) => ({
      name: env.name,
      tier: env.tier,
      policy: env.policy,
      requirePlan: env.requirePlan,
      readOnly: env.readOnly,
      confirmation: env.confirmation,
      match: cap(env.match, INSPECT_LIMITS.patterns),
    })),
    truncated,
  };
}
