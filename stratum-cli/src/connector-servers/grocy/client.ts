/**
 * Cliente mínimo de la API REST de Grocy (M28). `fetch` inyectable para tests.
 *
 * - La clave solo viaja en la cabecera `GROCY-API-KEY` y se tapa en todo texto
 *   que salga (mensajes de error incluidos).
 * - `GET` solo alcanza las rutas de `READ_PATHS` y `POST` solo las de
 *   `WRITE_PATHS` (fase 3: compra, existencias, recetas, menú y deshacer). Una
 *   ruta fuera de la lista es un veto sin llamar a la red. No hay `PUT` ni
 *   `DELETE`: nada se edita ni se borra.
 * - Una escritura cuyo resultado no se sabe (plazo agotado, conexión cortada)
 *   nunca se reintenta: el error lo dice para que se compruebe antes.
 * - Sin redirecciones (`redirect: 'error'`) y con un plazo de 15 s.
 *
 * Medido el 2026-11-21 contra Grocy 4.7.1 (add-on de HAOS): la API no responde
 * por Ingress (HA devuelve 401 antes de llegar a Grocy); sí en el puerto
 * publicado del add-on (`http://<casa>:9283/api`).
 */
import { ToolUserError } from '../lib/mcp-stdio.js';

const TIMEOUT_MS = 15_000;
const CATALOG_CACHE_MS = 5 * 60_000;
export const SETUP_COMMAND = 'stratum connectors setup grocy';

/** Entidades de `/objects/<entidad>` que lee el conector. */
const OBJECT_ENTITIES = [
  'products',
  'quantity_units',
  'locations',
  'product_groups',
  'recipes',
  'recipes_pos',
  'recipes_nestings',
  'meal_plan',
  'meal_plan_sections',
  'shopping_list',
  'shopping_lists',
] as const;
export type ObjectEntity = (typeof OBJECT_ENTITIES)[number];

/** Rutas de solo lectura permitidas (sin la base `/api`). `stock_log` solo para hallar la transacción de una receta cocinada. */
const READ_PATHS = new RegExp(
  `^/(?:system/info|stock|stock/volatile|recipes/fulfillment|objects/(?:${OBJECT_ENTITIES.join('|')}|stock_log))$`,
);

/** Escrituras permitidas (M28 fase 3). Cada una la llama una tool que se confirma. */
const WRITE_PATHS =
  /^\/(?:stock\/shoppinglist\/(?:add-product|remove-product)|stock\/products\/[1-9]\d{0,9}\/(?:add|consume|open)|recipes\/[1-9]\d{0,9}\/(?:consume|add-not-fulfilled-products-to-shoppinglist)|stock\/transactions\/[A-Za-z0-9]{1,40}\/undo|objects\/meal_plan)$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function notConfigured(): ToolUserError {
  return new ToolUserError(
    `Grocy no está configurado: la persona debe ejecutar \`${SETUP_COMMAND}\`.`,
  );
}

/**
 * Normaliza `GROCY_URL` a la base de la API, terminada en `/api` (se admite
 * también sin él: `http://casa:9283`). `null` si no vale.
 */
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
  const path = u.pathname.replace(/\/+$/, '');
  u.pathname = path.endsWith('/api') ? path : `${path}/api`;
  return u;
}

/** Una URL de Ingress de HA nunca llega a la API de Grocy (medido: 401). */
function looksLikeIngress(u: URL): boolean {
  return /\/api\/hassio_ingress\//.test(u.pathname) || /\/hassio\/ingress\//.test(u.pathname);
}

function errorCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const cause = (err as { cause?: unknown }).cause;
  if (isRecord(cause) && typeof cause.code === 'string') return cause.code;
  const own = (err as { code?: unknown }).code;
  return typeof own === 'string' ? own : null;
}

export interface GrocyClientOptions {
  fetch: typeof fetch;
  url?: string;
  apiKey?: string;
  /** Reloj para la caché; por defecto `Date.now`. */
  now?: () => number;
}

export interface GrocyClient {
  readonly host: string;
  /** `path` sin la base (`/stock`, `/objects/recipes`…); `query` sin codificar. */
  get(
    path: string,
    query?: Record<string, string> | [string, string][],
    signal?: AbortSignal,
  ): Promise<unknown>;
  /**
   * `/objects/<entidad>` como lista de registros. Las tablas de catálogo
   * (productos, unidades, ubicaciones…) se guardan 5 min; el resto, nunca.
   */
  objects(entity: ObjectEntity, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
  /** Escritura: `null` si Grocy no devolvió cuerpo (204). */
  post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Tablas que cambian poco: se guardan unos minutos. */
const CACHED: ReadonlySet<ObjectEntity> = new Set([
  'products',
  'quantity_units',
  'locations',
  'product_groups',
  'shopping_lists',
  'meal_plan_sections',
]);

/** `null` si falta la URL o la clave, o la URL no vale. */
export function createGrocyClient(opts: GrocyClientOptions): GrocyClient | null {
  const base = parseBaseUrl(opts.url);
  const key = opts.apiKey?.trim();
  if (!base || !key) return null;
  const prefix = base.origin + base.pathname;
  const host = base.host;
  const ingress = looksLikeIngress(base);
  const now = opts.now ?? Date.now;

  /** Quita la clave de cualquier texto que vaya a salir. */
  const scrub = (text: string): string => text.split(key).join('***');

  function networkError(err: unknown): ToolUserError {
    const code = errorCode(err);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new ToolUserError(
        `No se resuelve el nombre ${host} desde la caja de conectores: usa el nombre completo con dominio o la IP en GROCY_URL (p. ej. http://192.168.1.10:9283/api). La persona lo cambia con \`${SETUP_COMMAND} --name GROCY_URL\`.`,
      );
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return new ToolUserError('Consulta a Grocy cancelada.');
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      return new ToolUserError(`No se llega a Grocy en ${host} (tiempo de espera agotado).`);
    }
    const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
    if (cause instanceof Error && /redirect/i.test(cause.message)) {
      return new ToolUserError(
        `Grocy en ${host} respondió con una redirección, y no se sigue: usa en GROCY_URL la dirección de la API (el puerto publicado del add-on, terminada en /api).`,
      );
    }
    return new ToolUserError(
      `No se llega a Grocy en ${host}. Si es el add-on de Home Assistant, su puerto tiene que estar publicado (Ajustes → Complementos → Grocy → Red).`,
    );
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string> | [string, string][] | undefined,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const allowed = method === 'GET' ? READ_PATHS : WRITE_PATHS;
    if (!allowed.test(path)) throw new ToolUserError('Ruta de Grocy no permitida.');
    const qs = query ? new URLSearchParams(query).toString() : '';
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = { 'GROCY-API-KEY': key!, Accept: 'application/json' };
    const init: RequestInit = { method, headers, redirect: 'error', signal: sig };
    if (method === 'POST') {
      // Grocy exige este Content-Type en todo POST, también en los que no leen cuerpo.
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    let res: Response;
    try {
      res = await opts.fetch(prefix + path + (qs ? `?${qs}` : ''), init);
    } catch (err) {
      const e = networkError(err);
      // Si la petición pudo llegar, el resultado de una escritura no se sabe.
      const code = errorCode(err);
      const neverSent = code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED';
      if (method === 'POST' && !neverSent) {
        throw new ToolUserError(
          `${e.message} No sé si Grocy llegó a hacer el cambio: compruébalo (con las tools de lectura) antes de repetirlo.`,
        );
      }
      throw e;
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ToolUserError(`Respuesta de Grocy en ${host} no válida.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ToolUserError(
        ingress
          ? `Grocy no responde por el Ingress de Home Assistant (HTTP ${res.status}): GROCY_URL tiene que ser el puerto publicado del add-on (p. ej. http://homeassistant.local:9283/api). La persona lo cambia con \`${SETUP_COMMAND} --name GROCY_URL\`.`
          : `Grocy rechazó la clave de API (HTTP ${res.status}): la persona debe crear otra en Grocy (Ajustes → Gestionar claves de API) y guardarla con \`${SETUP_COMMAND}\`.`,
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j: unknown = JSON.parse(text);
        if (isRecord(j) && typeof j.error_message === 'string') {
          detail = scrub(j.error_message).replace(/\s+/g, ' ').slice(0, 200);
        }
      } catch {
        // un cuerpo que no es JSON no se enseña
      }
      throw new ToolUserError(`Grocy respondió HTTP ${res.status}${detail ? `: ${detail}` : ''}.`);
    }
    if (method === 'POST' && text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolUserError(`Respuesta de Grocy en ${host} no válida.`);
    }
  }

  const cache = new Map<ObjectEntity, { at: number; rows: Record<string, unknown>[] }>();

  return {
    host,
    get: (path, query, signal) => request('GET', path, query, undefined, signal),
    post: (path, body, signal) => request('POST', path, undefined, body, signal),
    async objects(entity, signal) {
      const hit = cache.get(entity);
      if (hit && now() - hit.at < CATALOG_CACHE_MS) return hit.rows;
      const data = await request('GET', `/objects/${entity}`, undefined, undefined, signal);
      if (!Array.isArray(data)) {
        throw new ToolUserError(`Respuesta de Grocy en ${host} no válida (${entity}).`);
      }
      const rows = data.filter(isRecord);
      if (CACHED.has(entity)) cache.set(entity, { at: now(), rows });
      return rows;
    },
  };
}
