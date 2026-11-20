/**
 * Autorización OAuth de Google (refresh token → access token) y helper común de
 * llamadas a Gmail, Tasks y Calendar. `fetch` y el reloj son inyectables para los tests.
 *
 * El access token vive solo en memoria (nunca en disco) y no puede aparecer en
 * un texto de salida ni de error: todo mensaje que incluya texto de una
 * respuesta pasa por `scrub`.
 */
import { ToolUserError } from '../lib/mcp-stdio.js';

export const SETUP_COMMAND = 'stratum connectors setup google';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 15_000;
/** Margen para no usar un token a punto de caducar. */
const EXPIRY_MARGIN_S = 60;
const MAX_DETAIL = 200;
/** Tope del cuerpo de una respuesta: por encima no se acumula en memoria. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Segmento de ruta de un envío: este conector jamás lo pide (solo lo veta). */
const SEND_SEGMENT = 'send';

/** Las únicas APIs a las que se puede llamar. */
const ALLOWED_PREFIXES = [
  'https://gmail.googleapis.com/gmail/v1/users/me/',
  'https://tasks.googleapis.com/tasks/v1/',
  'https://www.googleapis.com/calendar/v3/',
];

const CALENDAR_PREFIX = 'https://www.googleapis.com/calendar/v3/';
/**
 * Dentro de Calendar, solo la lista de calendarios y los eventos de uno (o uno
 * de ellos): nada de `move`, `quickAdd`, `import`, `watch`, ACL ni ajustes.
 */
const CALENDAR_PATH_RE =
  /^\/calendar\/v3\/(?:users\/me\/calendarList|calendars\/[^/]+\/events(?:\/[^/]+)?)$/;
/** Métodos de `events` que caben en `events/<id>` y no son un evento. */
const CALENDAR_EVENT_VERBS = new Set(['quickAdd', 'import', 'watch', 'instances']);

function tooBig(): ToolUserError {
  return new ToolUserError('La respuesta de Google es demasiado grande');
}

/**
 * Lee el cuerpo con tope (5 MB): se mira `Content-Length` y, si no basta, se lee
 * por trozos abortando en cuanto se pasa. Nunca se acumula una respuesta enorme.
 */
async function readBody(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw tooBig();
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type ApiMethod = 'GET' | 'POST' | 'PATCH';

/** La API dijo 404: cada tool decide cómo contarlo. */
export class GoogleNotFoundError extends ToolUserError {}

export function notConfigured(): ToolUserError {
  return new ToolUserError(
    `Google no está configurado: la persona debe ejecutar \`${SETUP_COMMAND}\`.`,
  );
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const cause = (err as { cause?: unknown }).cause;
  if (isRecord(cause) && typeof cause.code === 'string') return cause.code;
  const own = (err as { code?: unknown }).code;
  return typeof own === 'string' ? own : null;
}

export interface GoogleAuthOptions {
  fetch: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** Reloj de la caché del token; por defecto `Date.now`. */
  now?: () => number;
}

export interface GoogleAuth {
  /** Access token válido: se renueva solo cuando caduca o se invalida. */
  accessToken(signal?: AbortSignal): Promise<string>;
  /** Petición a Gmail o Tasks. Cualquier otra URL se rechaza. */
  api(method: ApiMethod, url: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Quita de un texto los secretos conocidos (client secret, refresh y access token). */
  scrub(text: string): string;
}

/** `null` si falta alguna credencial: el server arranca igual y cada tool avisa. */
export function createGoogleAuth(opts: GoogleAuthOptions): GoogleAuth | null {
  const clientId = opts.clientId?.trim() ?? '';
  const clientSecret = opts.clientSecret?.trim() ?? '';
  const refreshToken = opts.refreshToken?.trim() ?? '';
  if (!clientId || !clientSecret || !refreshToken) return null;

  const now = opts.now ?? Date.now;
  /** Todos los secretos vistos (los access token rotan) para poder tacharlos. */
  const secrets = new Set<string>([clientSecret, refreshToken]);

  const scrub = (text: string): string => {
    let out = text;
    for (const s of secrets) if (s) out = out.split(s).join('***');
    return out;
  };

  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  function networkError(err: unknown): ToolUserError {
    if (err instanceof Error && err.name === 'AbortError') {
      return new ToolUserError('Petición a Google cancelada.');
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      return new ToolUserError('Google no respondió a tiempo (tiempo de espera agotado).');
    }
    const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
    if (cause instanceof Error && /redirect/i.test(cause.message)) {
      return new ToolUserError('Google respondió con una redirección, y no se sigue.');
    }
    const code = errorCode(err);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new ToolUserError(
        'No se resuelve el nombre de Google desde la caja de conectores: revisa la red.',
      );
    }
    return new ToolUserError('No se llega a Google desde la caja de conectores.');
  }

  function timedSignal(signal: AbortSignal | undefined): AbortSignal {
    const t = AbortSignal.timeout(TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, t]) : t;
  }

  /** Cambia el refresh token por un access token nuevo. */
  async function renew(signal: AbortSignal | undefined): Promise<string> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });
    let res: Response;
    try {
      res = await opts.fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        redirect: 'error',
        signal: timedSignal(signal),
      });
    } catch (err) {
      throw networkError(err);
    }
    let text: string;
    try {
      text = await readBody(res);
    } catch (err) {
      if (err instanceof ToolUserError) throw err;
      throw new ToolUserError('Respuesta de Google no válida al renovar la autorización.');
    }
    const data = parseJson(text);
    if (!res.ok) {
      const code = isRecord(data) && typeof data.error === 'string' ? data.error : '';
      if (res.status === 400 && code === 'invalid_grant') {
        throw new ToolUserError(
          `Google rechazó la autorización (revocada o caducada): la persona debe repetir \`${SETUP_COMMAND}\`.`,
        );
      }
      const detail = code ? `: ${scrub(code).slice(0, MAX_DETAIL)}` : '';
      throw new ToolUserError(
        `Google respondió HTTP ${res.status} al renovar la autorización${detail}.`,
      );
    }
    const token = isRecord(data) && typeof data.access_token === 'string' ? data.access_token : '';
    if (!token) {
      throw new ToolUserError(
        `Google no devolvió un token al renovar la autorización: la persona debe repetir \`${SETUP_COMMAND}\`.`,
      );
    }
    const expiresIn =
      isRecord(data) && typeof data.expires_in === 'number' && data.expires_in > 0
        ? data.expires_in
        : 3600;
    secrets.add(token);
    cached = {
      token,
      expiresAt: now() + Math.max(0, expiresIn - EXPIRY_MARGIN_S) * 1000,
    };
    return token;
  }

  async function accessToken(signal?: AbortSignal): Promise<string> {
    const c = cached;
    if (c && now() < c.expiresAt) return c.token;
    // Dos peticiones a la vez comparten la misma renovación (una sola promesa en vuelo).
    if (!inflight) {
      inflight = renew(signal).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function apiError(status: number, text: string): ToolUserError {
    let detail = '';
    const data = parseJson(text);
    if (isRecord(data)) {
      const e = data.error;
      const msg =
        typeof e === 'string'
          ? e
          : isRecord(e) && typeof e.message === 'string'
            ? e.message
            : typeof data.error_description === 'string'
              ? data.error_description
              : '';
      if (msg) detail = scrub(msg).slice(0, MAX_DETAIL);
    }
    const suffix = detail ? `: ${detail}` : '';
    if (status === 404) return new GoogleNotFoundError(`Google no encontró el recurso${suffix}.`);
    if (status === 401 || status === 403) {
      return new ToolUserError(
        `Google rechazó la autorización (HTTP ${status})${suffix}: la persona debe repetir \`${SETUP_COMMAND}\`.`,
      );
    }
    return new ToolUserError(`Google respondió HTTP ${status}${suffix}.`);
  }

  async function send(
    method: ApiMethod,
    url: string,
    token: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers, redirect: 'error', signal: timedSignal(signal) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      return await opts.fetch(url, init);
    } catch (err) {
      throw networkError(err);
    }
  }

  return {
    accessToken,
    scrub,

    async api(method, url, body, signal) {
      // El prefijo se mira sobre la URL ya normalizada (como la verá `fetch`):
      // un `..` en la ruta no puede sacarla de lo permitido.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ToolUserError('URL de Google no permitida por este conector.');
      }
      if (!ALLOWED_PREFIXES.some((p) => url.startsWith(p) && parsed.href.startsWith(p))) {
        throw new ToolUserError('URL de Google no permitida por este conector.');
      }
      const segments = parsed.pathname.split('/').filter(Boolean);
      // Nada de envíos, ni siquiera dentro de los prefijos permitidos: decide el
      // último segmento de la ruta, y `?` (la query) no forma parte del path, así
      // que también cubre la variante con parámetros.
      if (segments[segments.length - 1] === SEND_SEGMENT) {
        throw new ToolUserError(
          'Este conector no envía correo: se crea un borrador y la persona lo envía desde Gmail.',
        );
      }
      if (url.startsWith(CALENDAR_PREFIX)) {
        const last = segments[segments.length - 1] ?? '';
        if (!CALENDAR_PATH_RE.test(parsed.pathname) || CALENDAR_EVENT_VERBS.has(last)) {
          throw new ToolUserError('URL de Google no permitida por este conector.');
        }
        // Una escritura en el calendario nunca avisa a los asistentes.
        if (method !== 'GET' && parsed.searchParams.get('sendUpdates') !== 'none') {
          throw new ToolUserError(
            'Este conector no avisa a nadie: toda escritura en el calendario lleva sendUpdates=none.',
          );
        }
      }
      let token = await accessToken(signal);
      let usedToken = token;
      let res = await send(method, url, usedToken, body, signal);
      if (res.status === 401) {
        // Solo se tira la caché si el token que falló es el que sigue cacheado
        // (otra petición pudo renovarlo ya); el cuerpo descartado se cancela.
        if (cached?.token === usedToken) cached = null;
        await res.body?.cancel().catch(() => {});
        usedToken = await accessToken(signal);
        res = await send(method, url, usedToken, body, signal);
      }
      let text: string;
      try {
        text = await readBody(res);
      } catch (err) {
        if (err instanceof ToolUserError) throw err;
        throw new ToolUserError('Respuesta de Google no válida.');
      }
      if (!res.ok) throw apiError(res.status, text);
      if (text.trim() === '') return undefined;
      const data = parseJson(text);
      if (data === null) throw new ToolUserError('Respuesta de Google no válida.');
      return data;
    },
  };
}
