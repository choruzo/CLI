/**
 * M21 — la autorización OAuth de Google para `stratum connectors setup google`
 * (`docs/PRD_STRATUM_DOT.md` §23.11). Solo corre en la CLI y solo mientras dura
 * el `setup`: nunca en el daemon ni en la caja.
 *
 * Flujo de una «App de escritorio» (RFC 8252):
 * - Un servidor HTTP en `127.0.0.1`, con puerto efímero, recoge el código.
 * - PKCE S256 y un `state` aleatorio: solo vale la vuelta que trae ese `state`.
 *   Lo demás que llegue al puerto se ignora y se sigue esperando.
 * - El código se cambia por los tokens. Solo se guarda el **refresh token**: el
 *   access token lo saca el conector en la caja, en memoria.
 * - Tiene que conceder todos los ámbitos pedidos: Google deja desmarcar casillas,
 *   y un token a medias es un conector que falla a ratos.
 *
 * Los puntos de Google van fijos aquí, no en el manifiesto. Ningún mensaje lleva
 * el secreto del cliente, el código ni un token.
 */
import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Lo que tarda la persona en autorizar en el navegador, como mucho. */
export const OAUTH_WAIT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 20_000;

export class OAuthError extends Error {
  override readonly name = 'OAuthError';
}

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  /** Abre la URL en el navegador; `false` si no pudo (se enseña para copiarla). */
  openBrowser: (url: string) => Promise<boolean>;
  /** Mensajes para la persona (la URL incluida, que no lleva secretos). */
  out: (text: string) => void;
  fetch?: typeof fetch;
  waitMs?: number;
  signal?: AbortSignal;
}

export interface GoogleOAuthResult {
  refreshToken: string;
  /** Ámbitos concedidos, tal como los devuelve Google. */
  scopes: string[];
}

const base64url = (buf: Buffer): string => buf.toString('base64url');

/**
 * El cliente del JSON que descarga Google Cloud al crear un ID de cliente
 * («App de escritorio»: clave `installed`). Así la persona no teclea el
 * secreto: se lee del fichero, nunca de un argumento ni del entorno.
 * @throws OAuthError si no es un JSON de cliente de escritorio.
 */
export function parseGoogleClientJson(text: string): { clientId: string; clientSecret: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OAuthError(
      'El fichero no es JSON: descárgalo de nuevo en Google Cloud (Credenciales).',
    );
  }
  const root = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  if (root.web !== undefined && root.installed === undefined) {
    throw new OAuthError(
      'Ese cliente OAuth es de tipo «Aplicación web»: crea uno de tipo «App de escritorio».',
    );
  }
  const installed = root.installed as Record<string, unknown> | undefined;
  const clientId = typeof installed?.client_id === 'string' ? installed.client_id.trim() : '';
  const clientSecret =
    typeof installed?.client_secret === 'string' ? installed.client_secret.trim() : '';
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret === '') {
    throw new OAuthError(
      'El fichero no tiene un cliente de escritorio válido (installed.client_id y client_secret).',
    );
  }
  return { clientId, clientSecret };
}

/** `verifier` y `challenge` de PKCE (RFC 7636, S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function googleAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  challenge: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: p.scopes.join(' '),
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    // Sin `offline` no hay refresh token; sin `consent`, Google no lo repite si
    // la cuenta ya había autorizado este cliente.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

const PAGE = (title: string, text: string): string =>
  `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto">` +
  `<h1>${title}</h1><p>${text}</p></body></html>`;

/** Lo que trae la vuelta del navegador con el `state` correcto. */
type Callback = { code: string } | { error: string };

/**
 * Espera en `127.0.0.1` la vuelta con `state`. Resuelve con la primera que lo
 * traiga; lo que no lo trae (otra pestaña, un favicon, un intento ajeno) recibe
 * un 404 y no cuenta.
 */
function listen(state: string): Promise<{
  redirectUri: string;
  result: Promise<Callback>;
  close: () => void;
}> {
  return new Promise((resolveListen, rejectListen) => {
    let settle: (c: Callback) => void = () => {};
    const result = new Promise<Callback>((resolve) => {
      settle = resolve;
    });
    let done = false;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (status: number, html: string) => {
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
      };
      if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state) {
        send(404, PAGE('Stratum', 'Nada que hacer aquí.'));
        return;
      }
      if (done) {
        send(200, PAGE('Stratum', 'Ya está: puedes cerrar esta pestaña.'));
        return;
      }
      done = true;
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (code) {
        send(
          200,
          PAGE(
            'Autorizado',
            'Stratum ya tiene el permiso. Puedes cerrar esta pestaña y volver al terminal.',
          ),
        );
        settle({ code });
      } else {
        send(400, PAGE('Sin autorizar', 'No se concedió el permiso. Vuelve al terminal.'));
        settle({ error: error ?? 'no code' });
      }
    });
    server.on('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveListen({
        redirectUri: `http://127.0.0.1:${port}/`,
        result,
        close: () => {
          server.close();
          server.closeAllConnections?.();
        },
      });
    });
  });
}

/** Quita los secretos de un texto que va a enseñarse. */
function scrubber(secrets: string[]): (text: string) => string {
  const real = secrets.filter((s) => s.length >= 4);
  return (text) => real.reduce((t, s) => t.split(s).join('***'), text);
}

function wait<T>(p: Promise<T>, ms: number, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OAuthError(`No llegó la autorización en ${Math.round(ms / 60_000)} min.`)),
      ms,
    );
    const onAbort = () => reject(new OAuthError('Cancelado.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * Lleva a la persona por la autorización y devuelve el refresh token.
 * @throws OAuthError con un mensaje para la persona, sin secretos.
 */
export async function authorizeGoogle(opts: GoogleOAuthOptions): Promise<GoogleOAuthResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const state = base64url(randomBytes(16));
  const { verifier, challenge } = pkcePair();
  const callback = await listen(state);
  try {
    const url = googleAuthUrl({
      clientId: opts.clientId,
      redirectUri: callback.redirectUri,
      scopes: opts.scopes,
      challenge,
      state,
    });
    const opened = await opts.openBrowser(url);
    opts.out(
      opened
        ? `Se ha abierto el navegador para autorizar a Stratum. Si no lo ves, abre esta URL:\n${url}\n`
        : `Abre esta URL en el navegador de este equipo para autorizar a Stratum:\n${url}\n`,
    );
    opts.out('Esperando la autorización (Ctrl+C cancela)…\n');
    const got = await wait(callback.result, opts.waitMs ?? OAUTH_WAIT_MS, opts.signal);
    if ('error' in got) {
      throw new OAuthError(
        got.error === 'access_denied'
          ? 'No se concedió el permiso en el navegador.'
          : `Google no autorizó (${got.error.slice(0, 80)}).`,
      );
    }
    const scrub = scrubber([opts.clientSecret, got.code, verifier]);
    return await exchange(doFetch, {
      code: got.code,
      verifier,
      redirectUri: callback.redirectUri,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      scopes: opts.scopes,
      scrub,
    });
  } finally {
    callback.close();
  }
}

async function exchange(
  doFetch: typeof fetch,
  p: {
    code: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
    scopes: readonly string[];
    scrub: (text: string) => string;
  },
): Promise<GoogleOAuthResult> {
  let res: Response;
  try {
    res = await doFetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: p.code,
        code_verifier: p.verifier,
        redirect_uri: p.redirectUri,
        client_id: p.clientId,
        client_secret: p.clientSecret,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError('No se pudo hablar con Google para canjear la autorización.');
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    /* sin cuerpo legible: cuenta el estado HTTP */
  }
  if (!res.ok) {
    const err = typeof body.error === 'string' ? p.scrub(body.error).slice(0, 80) : '';
    const hint =
      err === 'invalid_client'
        ? ': el ID o el secreto del cliente no son correctos'
        : err
          ? ` (${err})`
          : '';
    throw new OAuthError(`Google rechazó el canje (HTTP ${res.status})${hint}.`);
  }
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  if (!refreshToken) {
    throw new OAuthError('Google no devolvió un refresh token: vuelve a intentarlo.');
  }
  const granted = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [];
  const missing = p.scopes.filter((s) => !granted.includes(s));
  if (missing.length > 0) {
    const short = missing.map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(', ');
    throw new OAuthError(
      `Faltan permisos (${short}): al autorizar, marca todas las casillas. No se ha guardado nada.`,
    );
  }
  return { refreshToken, scopes: granted };
}
