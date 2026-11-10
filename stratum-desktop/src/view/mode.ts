/**
 * Los dos modos de Desktop: **chat** (el asistente embebido, en una carpeta de
 * Desktop) y **código** (el agente de código de la CLI, en la carpeta de un
 * proyecto). Es una vista de la interfaz, nada más: las sesiones son las mismas
 * del daemon y el modo solo decide cuáles se listan y qué herramientas de la
 * interfaz se enseñan. Puro.
 */
import type { ProtocolOverviewSnapshot, ProtocolSession } from '../protocol';

export type AppMode = 'chat' | 'code';

export const APP_MODES: readonly AppMode[] = ['chat', 'code'];

export const MODE_LABEL: Record<AppMode, string> = { chat: 'Chat', code: 'Código' };

/** Agentes embebidos (`agent/presets.ts`): no son de un proyecto. */
const EMBEDDED_AGENTS: readonly string[] = ['assistant', 'companion'];

/** En qué modo se mira una sesión: lo dice su agente, no quién la abrió. */
export function modeOfAgent(agent: string): AppMode {
  return EMBEDDED_AGENTS.includes(agent) ? 'chat' : 'code';
}

export function modeOfSession(session: Pick<ProtocolSession, 'agent'>): AppMode {
  return modeOfAgent(session.agent);
}

const MODE_KEY = 'stratum.desktop.mode';
const PROJECT_KEY = 'stratum.desktop.code.project';

/** El último modo usado (comodidad de la interfaz). */
export function loadMode(): AppMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'code' ? 'code' : 'chat';
  } catch {
    return 'chat';
  }
}

export function saveMode(mode: AppMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* no crítico */
  }
}

/** La última carpeta de proyecto elegida: se propone para la sesión siguiente. */
export function loadLastProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

export function saveLastProject(cwd: string): void {
  try {
    localStorage.setItem(PROJECT_KEY, cwd);
  } catch {
    /* no crítico */
  }
}

/** Nombre corto de una carpeta: su último tramo (`C:\src\app\` → `app`). */
export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Cuántas carpetas recientes se proponen. */
export const MAX_RECENT_PROJECTS = 6;

/**
 * Carpetas de las sesiones de código que el daemon conoce, la más reciente
 * primero y sin repetir. Sale de la foto de conjunto: Desktop no guarda una
 * lista propia de proyectos.
 */
export function recentProjects(overview: Pick<ProtocolOverviewSnapshot, 'sessions'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const sessions = overview.sessions
    .filter((s) => s.state !== 'closed' && modeOfSession(s) === 'code' && s.cwd)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sessions) {
    // Windows no distingue mayúsculas ni la barra final: una carpeta, una entrada.
    const key = s.cwd.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.cwd);
    if (out.length === MAX_RECENT_PROJECTS) break;
  }
  return out;
}
