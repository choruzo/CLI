/**
 * Cliente mínimo de la API REST de Home Assistant. `fetch` inyectable para tests.
 * El token solo viaja en la cabecera `Authorization` y nunca aparece en un texto
 * de salida ni de error. Solo se llama a rutas `/api/...` bajo la URL base.
 */
import { ToolUserError } from '../lib/mcp-stdio.js';

const TIMEOUT_MS = 15_000;
const CACHE_MS = 5 * 60_000;
const SETUP_COMMAND = 'stratum connectors setup home-assistant';
const AREAS_TEMPLATE =
  "{% for s in states %}{{ s.entity_id }}|{{ area_name(s.entity_id) or '' }}\n{% endfor %}";

/** La entidad pedida no existe (404): las tools deciden cómo decirlo. */
export class HaNotFoundError extends ToolUserError {}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string | null;
}

export interface HaConfig {
  name: string | null;
  version: string | null;
  timeZone: string | null;
  /** Unidad de temperatura del sistema de unidades (p. ej. `°C`). */
  temperatureUnit: string | null;
}

export interface HaClientOptions {
  fetch: typeof fetch;
  url?: string;
  token?: string;
  /** Reloj para la caché; por defecto `Date.now`. */
  now?: () => number;
}

export interface HaClient {
  readonly host: string;
  getJson(path: string, signal?: AbortSignal): Promise<unknown>;
  postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
  getConfig(signal?: AbortSignal): Promise<HaConfig>;
  /** `entity_id` → área. `null` si no se pudieron obtener (sin dato, nunca un error). */
  getAreas(signal?: AbortSignal): Promise<Map<string, string> | null>;
  getStates(signal?: AbortSignal): Promise<HaState[]>;
}

export function notConfigured(): ToolUserError {
  return new ToolUserError(
    `Home Assistant no está configurado: la persona debe ejecutar \`${SETUP_COMMAND}\`.`,
  );
}

/** Normaliza la URL base. `null` si no vale. */
export function parseBaseUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function errorCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const cause = (err as { cause?: unknown }).cause;
  if (isRecord(cause) && typeof cause.code === 'string') return cause.code;
  const own = (err as { code?: unknown }).code;
  return typeof own === 'string' ? own : null;
}

function toState(v: unknown): HaState | null {
  if (!isRecord(v) || typeof v.entity_id !== 'string') return null;
  return {
    entity_id: v.entity_id,
    state: typeof v.state === 'string' ? v.state : String(v.state ?? ''),
    attributes: isRecord(v.attributes) ? v.attributes : {},
    last_changed: strOrNull(v.last_changed),
  };
}

export function toStates(v: unknown): HaState[] {
  return (Array.isArray(v) ? v : []).map(toState).filter((s): s is HaState => s !== null);
}

/** `null` si falta la URL o el token, o la URL no vale. */
export function createHaClient(opts: HaClientOptions): HaClient | null {
  const base = parseBaseUrl(opts.url);
  const token = opts.token?.trim();
  if (!base || !token) return null;
  const prefix = base.origin + base.pathname.replace(/\/+$/, '');
  const host = base.host;
  const now = opts.now ?? Date.now;

  /** Quita el token de cualquier texto que vaya a salir. */
  const scrub = (text: string): string => text.split(token).join('***');

  function networkError(err: unknown): ToolUserError {
    const code = errorCode(err);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new ToolUserError(
        `No se resuelve el nombre ${host} desde la caja de conectores: usa el nombre completo con dominio (p. ej. homeassistant.home) o la IP en HA_URL. La caja sí llega a la red local; lo que no resuelve son los nombres cortos sin dominio. La persona lo cambia con \`stratum connectors setup home-assistant --name HA_URL\`.`,
        'unreachable',
      );
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return new ToolUserError('Consulta a Home Assistant cancelada.');
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      return new ToolUserError(
        `No se llega a Home Assistant en ${host} (tiempo de espera agotado).`,
        'unreachable',
      );
    }
    const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
    if (cause instanceof Error && /redirect/i.test(cause.message)) {
      return new ToolUserError(
        `Home Assistant en ${host} respondió con una redirección, y no se sigue: usa en HA_URL la dirección final.`,
        'unreachable',
      );
    }
    // ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, ETIMEDOUT y el resto.
    return new ToolUserError(`No se llega a Home Assistant en ${host}.`, 'unreachable');
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (!path.startsWith('/api/')) throw new ToolUserError('Ruta no permitida.');
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/plain',
    };
    const init: RequestInit = { method, headers, redirect: 'error', signal: sig };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await opts.fetch(prefix + path, init);
    } catch (err) {
      throw networkError(err);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ToolUserError(`Respuesta de Home Assistant en ${host} no válida.`);
    }
    if (res.ok) return text;
    if (res.status === 401 || res.status === 403) {
      throw new ToolUserError(
        `Home Assistant rechazó el token (HTTP ${res.status}): la persona debe renovarlo con \`${SETUP_COMMAND}\`.`,
        'auth',
      );
    }
    const entity = /^\/api\/states\/(.+)$/.exec(path);
    if (res.status === 404 && entity) {
      throw new HaNotFoundError(
        `La entidad ${decodeURIComponent(entity[1]!)} no existe: usa ha_buscar.`,
      );
    }
    let detail = '';
    try {
      const j: unknown = JSON.parse(text);
      if (isRecord(j) && typeof j.message === 'string') detail = scrub(j.message).slice(0, 200);
    } catch {
      // un cuerpo que no es JSON no se enseña
    }
    throw new ToolUserError(
      `Home Assistant respondió HTTP ${res.status}${detail ? `: ${detail}` : ''}.`,
    );
  }

  function parse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolUserError(`Respuesta de Home Assistant en ${host} no válida.`);
    }
  }

  let configCache: { at: number; value: HaConfig } | null = null;
  let areasCache: { at: number; value: Map<string, string> } | null = null;

  const client: HaClient = {
    host,
    async getJson(path, signal) {
      return parse(await request('GET', path, undefined, signal));
    },
    async postJson(path, body, signal) {
      return parse(await request('POST', path, body, signal));
    },
    async getConfig(signal) {
      if (configCache && now() - configCache.at < CACHE_MS) return configCache.value;
      const data = await client.getJson('/api/config', signal);
      const c = isRecord(data) ? data : {};
      const units = isRecord(c.unit_system) ? c.unit_system : {};
      const value: HaConfig = {
        name: strOrNull(c.location_name),
        version: strOrNull(c.version),
        timeZone: strOrNull(c.time_zone),
        temperatureUnit: strOrNull(units.temperature),
      };
      configCache = { at: now(), value };
      return value;
    },
    async getAreas(signal) {
      if (areasCache && now() - areasCache.at < CACHE_MS) return areasCache.value;
      try {
        const text = await request('POST', '/api/template', { template: AREAS_TEMPLATE }, signal);
        const map = new Map<string, string>();
        for (const line of text.split('\n')) {
          const i = line.indexOf('|');
          if (i <= 0) continue;
          const area = line.slice(i + 1).trim();
          if (area) map.set(line.slice(0, i).trim(), area);
        }
        areasCache = { at: now(), value: map };
        return map;
      } catch {
        return null;
      }
    },
    async getStates(signal) {
      return toStates(await client.getJson('/api/states', signal));
    },
  };
  return client;
}
