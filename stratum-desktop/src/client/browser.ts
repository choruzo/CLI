/**
 * El navegador de una sesión, visto desde Desktop. El navegador **vive en el
 * daemon** (lo maneja el agente con sus tools `browser_*`); aquí solo se pide
 * su estado y una captura para enseñarla (`browser.screen`, solo lectura), y la
 * persona puede moverlo con la sesión en reposo (`browser.navigate`: atrás,
 * adelante, recargar, o ir a una dirección **local**). Lo que no es local lo
 * abre el agente, con su confirmación; Desktop no lo aprueba por otro camino.
 *
 * Las capturas no se guardan: la que se ve es la última que contestó el daemon.
 */
import { toCommandError, type CommandError, type NativeBridge } from '../ipc/native';
import { parseBrowserView } from '../protocol/results';
import { describeFailure } from './actions';

export type BrowserView = NonNullable<ReturnType<typeof parseBrowserView>>;
export type BrowserStatus = BrowserView['browser'];
export type BrowserScreen = NonNullable<BrowserView['screen']>;
export type BrowserAction = 'goto' | 'back' | 'forward' | 'reload';

/** Cada cuánto se pide la captura: como la pantalla de la caja en Dot. */
export const BROWSER_POLL_MS = { inUse: 1_000, idle: 4_000, hidden: 15_000 } as const;

export type BrowserResult = { ok: true; view: BrowserView } | { ok: false; message: string };

/** Por qué no hay navegador, para una persona. */
export function describeUnavailable(reason: string | undefined): string {
  switch (reason) {
    case 'disabled':
      return 'El navegador está desactivado en la configuración (tools.browser.enabled).';
    case 'not-found':
      return 'No se encontró Edge ni Chrome en este equipo. Instala uno o indica su ruta en tools.browser.executable.';
    case 'peer-hosted':
      return 'Esta sesión la aloja una terminal: su navegador vive en ese proceso y no se ve desde aquí.';
    case 'not-supported':
      return 'Este agente no tiene navegador.';
    default:
      return 'El navegador no está disponible para esta sesión.';
  }
}

export function describeBrowserFailure(what: string, error: CommandError): string {
  if (error.kind === 'rejected') {
    if (error.reason === 'needs-approval') {
      return 'Desde aquí solo se abren direcciones locales (localhost) o sitios ya aprobados. Pídele al agente que abra esa página: te pedirá confirmación.';
    }
    if (error.reason === 'blocked-url') return 'Esa dirección no se puede abrir en el navegador de la sesión.';
    if (error.code === 'BUSY') return 'El agente está trabajando: el navegador es suyo hasta que acabe el turno.';
    if (error.reason === 'peer-hosted') return describeUnavailable('peer-hosted');
  }
  return describeFailure(what, error);
}

/** Estado y captura actuales. Solo lectura: repetirla es seguro. */
export async function readBrowser(native: NativeBridge, sessionId: string): Promise<BrowserResult> {
  try {
    const view = parseBrowserView(await native.browserScreen(sessionId));
    return view ? { ok: true, view } : { ok: false, message: 'Lo que contestó el daemon sobre el navegador no se entiende.' };
  } catch (err) {
    return { ok: false, message: describeBrowserFailure('No se pudo leer el navegador', toCommandError(err)) };
  }
}

/** Mover el navegador de la sesión. Mutante: sin respuesta no se repite. */
export async function moveBrowser(
  native: NativeBridge,
  sessionId: string,
  action: BrowserAction,
  url?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await native.browserNavigate(sessionId, action, url);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: describeBrowserFailure('No se pudo navegar', toCommandError(err)) };
  }
}

/**
 * Lo que se teclea en la barra → una URL. Sin esquema se asume `http://` (lo
 * normal es `localhost:3000`). `null` si no es una dirección http(s).
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
