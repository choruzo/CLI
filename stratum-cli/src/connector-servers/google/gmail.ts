/**
 * Ayudas de Gmail: base64url, entidades HTML, cuerpo de un mensaje (text/plain
 * o text/html pasado a texto), adjuntos, delimitadores del bloque de correo y
 * construcción del RFC 5322 de un borrador. Nada de red: todo es puro.
 */
import { isRecord } from './auth.js';

/** Longitud de línea del cuerpo en base64 (RFC 2045). */
const BASE64_LINE = 76;
const CRLF = '\r\n';
/** Tope de bytes que se decodifican de un cuerpo (el resto no se toca). */
const MAX_BODY_BYTES = 64 * 1024;
/** Un nombre de adjunto no necesita más. */
const MAX_ATTACHMENT_NAME = 120;
/** Palabra codificada RFC 2047: 45 bytes de UTF-8 son 60 caracteres base64 (≤ 75 con envoltorio). */
const RFC2047_BYTES = 45;
/** Cuántos msg-id se conservan de la cadena de `References`. */
const MAX_REFERENCES = 20;

/** Zona de la caja: en el contenedor el proceso corre en UTC, Madrid es la de la persona. */
const TZ = 'Europe/Madrid';

const partsFormat = new Intl.DateTimeFormat('es-ES', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface Attachment {
  name: string;
  size: number | null;
}

function asPart(v: unknown): GmailPart | null {
  return isRecord(v) ? (v as GmailPart) : null;
}

/** Valor de una cabecera (sin distinguir mayúsculas). */
export function headerOf(headers: GmailHeader[] | undefined, name: string): string {
  const wanted = name.toLowerCase();
  const found = (headers ?? []).find((h) => (h.name ?? '').toLowerCase() === wanted);
  return (found?.value ?? '').trim();
}

// --- Codificaciones ----------------------------------------------------------

export function base64UrlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function base64UrlDecode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Base64 en líneas de 76 con CRLF (cuerpo MIME). */
export function base64Lines(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += BASE64_LINE) lines.push(b64.slice(i, i + BASE64_LINE));
  return lines.join(CRLF);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Deshace las entidades HTML básicas (nombradas y numéricas). */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#[0-9]+|#x[0-9a-fA-F]+);/g, (m) => {
    const named = ENTITIES[m];
    if (named) return named;
    const dec = m.startsWith('&#x') || m.startsWith('&#X');
    const code = Number.parseInt(dec ? m.slice(3, -1) : m.slice(2, -1), dec ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** HTML a texto llano: fuera scripts y estilos, saltos en br/p, sin etiquetas. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    // Un cuerpo recortado puede dejar el `<script` abierto: se tira lo que queda.
    .replace(/<(?:script|style)\b[\s\S]*$/i, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Cuerpo y adjuntos -------------------------------------------------------

function findBody(part: GmailPart | null | undefined, mime: string): GmailPart | null {
  if (!part) return null;
  if (part.mimeType === mime && typeof part.body?.data === 'string' && part.body.data !== '') {
    return part;
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    const found = findBody(child, mime);
    if (found) return found;
  }
  return null;
}

/** Corta sin partir un par sustituto. */
function cutUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Decodifica como mucho `max` bytes: se recorta el base64 ANTES de decodificar. */
function decodeCapped(data: string, max: number): string {
  // 4 caracteres base64 → 3 bytes, así que solo hacen falta los primeros ~87k caracteres.
  const needed = Math.min(data.length, Math.ceil(max / 3) * 4);
  const text = cutUtf16(base64UrlDecode(data.slice(0, needed)), max);
  // Si el corte deja bytes sueltos de un carácter, el decodificador pone U+FFFD: sobra.
  return needed < data.length ? text.replace(/\ufffd+$/, '') : text;
}

/** Primer `text/plain` del árbol; si no hay, el `text/html` pasado a texto. */
export function extractBody(payload: unknown, maxBytes: number = MAX_BODY_BYTES): string {
  const root = asPart(payload);
  if (!root) return '';
  const plain = findBody(root, 'text/plain');
  if (plain) return decodeCapped(plain.body?.data ?? '', maxBytes);
  const html = findBody(root, 'text/html');
  if (html) return htmlToText(decodeCapped(html.body?.data ?? '', maxBytes));
  return '';
}

/** Adjuntos del mensaje: solo nombre y tamaño (nunca se descarga el contenido). */
export function listAttachments(payload: unknown): Attachment[] {
  const out: Attachment[] = [];
  const walk = (part: GmailPart | null | undefined): void => {
    if (!part) return;
    const name = safeField(part.filename ?? '', MAX_ATTACHMENT_NAME);
    if (name !== '') {
      const size = typeof part.body?.size === 'number' ? part.body.size : null;
      out.push({ name, size });
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) walk(child);
  };
  walk(asPart(payload));
  return out;
}

// --- Fechas ------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `Wed, 18 Nov 2026 10:30:00 +0000` → `18/11 11:30` (hora de Madrid, no la del proceso). */
export function shortDate(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = partsFormat.formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('day');
  const month = get('month');
  const hour = get('hour');
  const minute = get('minute');
  if (!day || !month || !hour || !minute) return '';
  return `${pad(Number(day))}/${pad(Number(month))} ${pad(Number(hour))}:${pad(Number(minute))}`;
}

/** `2026-11-20T00:00:00.000Z` → `20/11/2026` (de Tasks solo cuenta el día, en UTC). */
export function dayOf(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// --- Bloques y textos --------------------------------------------------------

const OPEN = '<<<CORREO';
const CLOSE = 'CORREO>>>';

/** Impide que el cuerpo cierre el bloque de correo desde dentro. */
export function neutralizeDelimiters(body: string): string {
  return body.split(OPEN).join(`<<<\u200bCORREO`).split(CLOSE).join(`CORREO>>\u200b>`);
}

/** Recorta y avisa. */
export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/**
 * Campo que viene del mensaje (cabecera, snippet, nombre de adjunto) listo para
 * pintar: saltos y controles a espacio, espacios colapsados, delimitadores
 * neutralizados (un `Subject` plegado podría fingir el bloque o la nota de
 * contenido externo) y recorte.
 */
export function safeField(value: string, max: number): string {
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(neutralizeDelimiters(flat), max);
}

// --- Referencias de hilo -----------------------------------------------------

const MESSAGE_ID_RE = /^<[^<>\s]{1,995}>$/;

/** Un `Message-ID` solo vale si es exactamente `<algo@dominio>`. */
export function validMessageId(value: string): string | null {
  return MESSAGE_ID_RE.test(value) ? value : null;
}

/** Cadena de `References`: los msg-id válidos, como mucho los 20 últimos. */
export function referenceChain(value: string, extra?: string): string {
  const valid = value.split(/\s+/).filter((v) => MESSAGE_ID_RE.test(v));
  if (extra) valid.push(extra);
  return valid.slice(-MAX_REFERENCES).join(' ');
}

// --- RFC 5322 ----------------------------------------------------------------

/**
 * Cabecera de texto: tal cual si es ASCII; si no, palabras codificadas RFC 2047
 * de ≤ 45 bytes UTF-8 (sin partir ningún carácter), plegadas con CRLF + espacio.
 */
export function encodeHeaderText(value: string): string {
  if (!/[^\x00-\x7f]/.test(value)) return value;
  const words: string[] = [];
  let current = '';
  for (const char of value) {
    if (Buffer.byteLength(current + char, 'utf8') > RFC2047_BYTES) {
      words.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

export interface DraftMessage {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/** Los valores que vienen de la API tampoco pueden colar un salto de línea. */
function oneLineValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Mensaje RFC 5322 en texto plano: cabeceras CRLF y cuerpo en base64. */
export function buildMessage(d: DraftMessage): string {
  const headers: string[] = [
    `To: ${d.to.join(', ')}`,
    ...(d.cc && d.cc.length > 0 ? [`Cc: ${d.cc.join(', ')}`] : []),
    `Subject: ${encodeHeaderText(d.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (d.inReplyTo) headers.push(`In-Reply-To: ${oneLineValue(d.inReplyTo)}`);
  if (d.references) headers.push(`References: ${oneLineValue(d.references)}`);
  return [...headers, '', base64Lines(d.body), ''].join(CRLF);
}
