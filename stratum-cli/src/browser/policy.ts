/**
 * Alcance del navegador del agente: qué URL se abre sin preguntar, cuál pide
 * confirmación y cuál no se abre nunca. Puro (sin red ni estado): lo usan las
 * tools `browser_*` (veto y confirmación), el `BrowserManager` (la política en
 * la red, con el dominio `Fetch` de CDP) y el daemon (`browser.navigate`).
 *
 * - `local`: loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`), un
 *   host de `tools.browser.allowHosts` (solo de la config global), un `file:`
 *   cuya ruta real queda dentro del `cwd` de la sesión, y `about:blank`.
 * - `blocked`: cualquier otro esquema, `file:` fuera del `cwd` (o que no se pudo
 *   comprobar: falla cerrado), link-local y metadatos de nube, una URL con
 *   credenciales o una que no parsea. Ninguna aprobación lo levanta.
 * - `approved`: un origen que la persona ya confirmó en esta sesión.
 * - `external`: todo lo demás, también la red local (se confirma, no se veta).
 *
 * Limitación conocida: un nombre se clasifica **por nombre**. Uno público que
 * resuelva a una IP privada (DNS rebinding) cuenta como externo, no como
 * privado; `web_fetch` sí lo veta al conectar (`safe-fetch.ts`), el navegador
 * resuelve por su cuenta.
 */
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { confinePath } from '../tools/fs/confine.js';
import { blockedAddressReason, isAllowedHost } from '../tools/web/safe-fetch.js';

export type UrlClass = 'local' | 'approved' | 'external' | 'blocked';

export interface UrlPolicyContext {
  /** Directorio de la sesión: el único sitio de donde se abren ficheros. */
  cwd: string;
  /** Orígenes (`esquema://host:puerto`) confirmados en esta sesión. */
  approvedOrigins: ReadonlySet<string>;
  /** `tools.browser.allowHosts`: hosts que cuentan como locales. */
  allowHosts: readonly string[];
}

export interface UrlVerdict {
  class: UrlClass;
  /** La URL ya parseada (ausente si no parsea). */
  url?: URL;
  /** Origen de una URL `http(s)`: lo que se aprueba. */
  origin?: string;
  /** Por qué está vetada, para el mensaje. */
  reason?: string;
}

/** Nombres de metadatos de nube que no se abren nunca, aunque resuelvan a otra cosa. */
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata']);

/** Host sin corchetes, en minúsculas y sin el punto final (`localhost.`). */
export function normalizedHost(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isLoopbackName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/** Esquema + host + puerto, como lo compara el navegador. */
export function originOf(url: URL): string {
  return url.origin;
}

/**
 * El destino no es internet público: loopback, red privada o reservada (por IP
 * literal), un `*.localhost`, un host de `allowHosts` o un fichero. Los
 * subrecursos hacia aquí solo pasan desde un documento local.
 */
export function isPrivateDestination(url: URL, allowHosts: readonly string[]): boolean {
  if (url.protocol === 'file:') return true;
  const host = normalizedHost(url);
  if (isLoopbackName(host)) return true;
  if (isIP(host) && blockedAddressReason(host) !== null) return true;
  return isAllowedHost(url, allowHosts);
}

function blocked(reason: string, url?: URL): UrlVerdict {
  return { class: 'blocked', reason, ...(url ? { url } : {}) };
}

/** Clasifica `raw` con su motivo. Nunca lanza: lo que no se puede decidir es `blocked`. */
export function inspectUrl(raw: string, ctx: UrlPolicyContext): UrlVerdict {
  try {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return blocked('it is not a valid URL');
    }
    if (url.href === 'about:blank') return { class: 'local', url };
    if (url.username || url.password) return blocked('URLs with credentials are not opened', url);

    if (url.protocol === 'file:') {
      // `file://servidor/…` es una ruta UNC: nunca es de la carpeta de la sesión.
      if (url.hostname) return blocked('network file paths are not opened', url);
      const path = fileURLToPath(url);
      const verdict = confinePath({ root: ctx.cwd }, path, 'read');
      return verdict.ok
        ? { class: 'local', url }
        : blocked(`only files inside the session folder are opened (${verdict.reason})`, url);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return blocked(`the ${url.protocol} scheme is not opened`, url);
    }

    const host = normalizedHost(url);
    if (METADATA_HOSTS.has(host)) return blocked('cloud metadata endpoints are not opened', url);
    if (isIP(host)) {
      const reason = blockedAddressReason(host);
      if (reason?.includes('link-local')) return blocked(`${host} is ${reason}`, url);
      if (reason?.startsWith('loopback')) return { class: 'local', url, origin: originOf(url) };
    } else if (isLoopbackName(host)) {
      return { class: 'local', url, origin: originOf(url) };
    }
    const origin = originOf(url);
    if (isAllowedHost(url, ctx.allowHosts)) return { class: 'local', url, origin };
    if (ctx.approvedOrigins.has(origin)) return { class: 'approved', url, origin };
    return { class: 'external', url, origin };
  } catch (err) {
    // Falla cerrado: una comprobación que no termina es un veto.
    return blocked(`it could not be checked (${err instanceof Error ? err.message : String(err)})`);
  }
}

export function classifyUrl(raw: string, ctx: UrlPolicyContext): UrlClass {
  return inspectUrl(raw, ctx).class;
}

/** La URL para enseñarla: sin credenciales. Una que no parsea, recortada. */
export function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return raw.slice(0, 200);
  }
}

/**
 * Qué es el documento principal a efectos de sus subrecursos: `local` (puede
 * pedir a loopback y a la red privada), `private-approved` (un origen privado
 * que la persona aprobó: también) u `other`.
 */
export type DocumentStanding = 'local' | 'private-approved' | 'other';

export function documentStanding(
  verdict: UrlVerdict,
  allowHosts: readonly string[],
): DocumentStanding {
  if (verdict.class === 'local') return 'local';
  if (
    verdict.class === 'approved' &&
    verdict.url &&
    isPrivateDestination(verdict.url, allowHosts)
  ) {
    return 'private-approved';
  }
  return 'other';
}

/**
 * Un subrecurso (script, imagen, XHR, `fetch`, un iframe…): lo vetado nunca
 * pasa; lo privado solo desde un documento local (o privado aprobado), para que
 * una página de internet no sondee la red de la persona; internet público pasa,
 * la misma salida que ya tiene `web_fetch`.
 */
export function subresourceAllowed(
  raw: string,
  standing: DocumentStanding,
  ctx: UrlPolicyContext,
): boolean {
  const verdict = inspectUrl(raw, ctx);
  if (verdict.class === 'blocked' || !verdict.url) return false;
  if (isPrivateDestination(verdict.url, ctx.allowHosts)) return standing !== 'other';
  return true;
}
