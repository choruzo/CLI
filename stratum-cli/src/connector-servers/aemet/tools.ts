/**
 * Tools del conector AEMET (el tiempo y los avisos oficiales de España):
 * `aemet_municipios`, `aemet_prevision`, `aemet_por_horas` y `aemet_avisos`.
 * Todas de solo lectura; cada salida es texto breve en español ya masticado para
 * un agente, con la atribución de la licencia como última línea.
 *
 * La atribución es condición de la licencia de AEMET («autorizado el uso de la
 * información y su reproducción citando a AEMET como autora»), así que va en
 * **toda** salida y también en los errores, y nunca se insinúa que AEMET
 * respalde este uso.
 *
 * Lo que el feed no trae es «sin dato», nunca 0 (un 0 del feed sí es un 0). Un
 * municipio sin previsión no se inventa: se dice y, si su fila de la tabla trae
 * un vecino, se ofrece la previsión de ese vecino dejando claro que es la suya,
 * no la del municipio pedido.
 */
import { z } from 'zod';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { addDays, hhmm, madridParts } from '../renfe/time.js';
import {
  AemetNoDisponible,
  SinPrevision,
  type Dia,
  type Diaria,
  type DiaHorario,
  type Horaria,
} from './forecast.js';
import {
  buscarMunicipios,
  municipioPorCodigo,
  MAX_SIMILITUD,
  type Municipio,
  type MunicipioConPuntos,
} from './municipios.js';
import { PROVINCIAS, provinciaNombre } from './provincias.js';
import type { Aviso } from './warnings.js';

export interface AemetContext {
  /** Previsión diaria y horaria (en los tests, con `fetch` y reloj inyectados). */
  forecast: {
    diaria(ine: string): Promise<Diaria>;
    horaria(ine: string): Promise<Horaria>;
  };
  /** Avisos Meteoalerta por zona o por provincia, y cuántos CAP no se pudieron descargar. */
  avisos: {
    avisosPara(filtro: { zona?: string; provincia?: string }): Promise<Aviso[]>;
    noDescargados?: number;
  };
  now?: () => Date;
}

/**
 * Atribución de la licencia, la misma en toda salida y en todo error: AEMET como
 * autora de los datos, sin dar a entender que respalda este uso.
 */
export const ATRIBUCION = 'Fuente: AEMET (© AEMET, https://www.aemet.es)';

/** Candidatos que se enseñan como máximo. */
const MAX_CANDIDATOS = 10;
/** Avisos que se listan como máximo. */
const MAX_AVISOS = 12;
const DEFAULT_DIAS = 3;
const DEFAULT_HORAS = 12;
const MAX_NOMBRE = 80;

/** Días de la semana de `YYYYMMDD` (`0` del `getUTCDay` es domingo). */
const DIAS_SEMANA = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
] as const;

/**
 * Tramos del día por orden de preferencia: el `00-24` si trae dato y, si no, los
 * del día del más largo al más corto.
 */
const PERIODOS = ['00-24', '12-24', '00-12', '12-18', '06-12', '18-24', '00-06'] as const;

// --- Argumentos --------------------------------------------------------------

function text(name: string, max = MAX_NOMBRE) {
  const msg = `${name} debe ser un texto de 1 a ${max} caracteres`;
  return z.string({ message: msg }).trim().min(1, msg).max(max, msg);
}

function intRange(name: string, lo: number, hi: number) {
  const msg = `${name} debe ser un entero entre ${lo} y ${hi}`;
  return z.number({ message: msg }).int(msg).min(lo, msg).max(hi, msg).optional();
}

function parseArgs<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ToolUserError(`Argumento inválido: ${issue?.message ?? 'argumentos no válidos'}.`);
}

const MunicipiosSchema = z.object({ nombre: text('nombre') });
const PrevisionSchema = z.object({ municipio: text('municipio'), dias: intRange('dias', 1, 7) });
const PorHorasSchema = z.object({ municipio: text('municipio'), horas: intRange('horas', 6, 48) });
const AvisosSchema = z.object({
  municipio: text('municipio').optional(),
  provincia: text('provincia', 40).optional(),
});

// --- Fechas y textos ---------------------------------------------------------

/** Día de la tabla de fechas del feed (`2026-11-17` o `20261117`) → `YYYYMMDD`. */
function ymdDe(fecha: string): string {
  return fecha.replaceAll('-', '');
}

function ddmm(ymd: string): string {
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}`;
}

function diaSemana(ymd: string): string {
  const t = new Date(
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))),
  );
  return DIAS_SEMANA[t.getUTCDay()] ?? '';
}

/** `hoy`, `mañana`, `ayer` o `el DD/MM`, comparando días de Madrid. */
function diaRelativo(ymd: string, hoyYmd: string): string {
  if (ymd === hoyYmd) return 'hoy';
  if (ymd === addDays(hoyYmd, 1)) return 'mañana';
  if (ymd === addDays(hoyYmd, -1)) return 'ayer';
  return `el ${ddmm(ymd)}`;
}

/** `hoy 19:00` / `mañana 23:59` / `el 20/11 a las 08:00` de un instante ISO. */
function instanteRelativo(iso: string, ahora: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'sin dato';
  const p = madridParts(new Date(t));
  const ymd = p.ymd;
  const dia = diaRelativo(ymd, madridParts(ahora).ymd);
  const hora = hhmm(p.secs);
  return dia.startsWith('el ') ? `${dia} a las ${hora}` : `${dia} ${hora}`;
}

/** `17/11 a las 19:05` del `<elaborado>` del feed; `sin dato` si no se puede leer. */
function elaboradoTexto(elaborado: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(elaborado.trim());
  return m ? `${m[3]}/${m[2]} a las ${m[4]}:${m[5]}` : 'sin dato';
}

function finish(body: readonly string[]): string {
  return [...body, ATRIBUCION].join('\n');
}

function etiqueta(m: Municipio): string {
  return `${m.visible} (${m.provincia}, ${m.code})`;
}

/** Detalle de un `AEMET no responde`: el mensaje sin el prefijo. */
function detalle(err: Error): string {
  return err.message.replace(/^AEMET no responde:\s*/, '');
}

function noDisponibleTexto(err: Error): string {
  return `AEMET no responde ahora mismo (${detalle(err)}); prueba en unos minutos.`;
}

/**
 * Ejecuta una petición a AEMET traduciendo «no responde» a un `ToolUserError`
 * que orienta (los avisos lanzan `Error` genérico con ese mismo prefijo).
 */
async function conAemet<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AemetNoDisponible) throw new ToolUserError(noDisponibleTexto(err));
    if (err instanceof Error && /^AEMET no responde/.test(err.message)) {
      throw new ToolUserError(noDisponibleTexto(err));
    }
    throw err;
  }
}

// --- Municipios --------------------------------------------------------------

function datosDe(m: MunicipioConPuntos): Municipio {
  return {
    code: m.code,
    name: m.name,
    visible: m.visible,
    zona: m.zona,
    lat: m.lat,
    lon: m.lon,
    hab: m.hab,
    province: m.province,
    provincia: m.provincia,
    flags: m.flags,
  };
}

function candidatosTexto(hits: readonly MunicipioConPuntos[], input: string, arg: string): string {
  const shown = hits.slice(0, MAX_CANDIDATOS);
  const lines = [
    `«${input}» coincide con ${hits.length} municipios. Repite con el código INE en \`${arg}\` (por ejemplo ${arg}: "${shown[0]!.code}"); no adivino cuál es:`,
    ...shown.map((m) => `- ${m.visible} · ${m.provincia} · ${m.code}`),
  ];
  if (hits.length > shown.length) {
    lines.push(`(y ${hits.length - shown.length} más: afina el nombre o usa el código INE)`);
  }
  return lines.join('\n');
}

/**
 * Texto de una búsqueda por similitud: es una **aproximación**, así que nunca se
 * resuelve sola (ni con un único candidato) y siempre pide el código INE.
 */
function aproximacionTexto(
  hits: readonly MunicipioConPuntos[],
  input: string,
  arg: string,
): string {
  const shown = hits.slice(0, MAX_SIMILITUD);
  const nombres = shown.map((m) => m.visible);
  const lista =
    nombres.length === 1
      ? nombres[0]!
      : `${nombres.slice(0, -1).join(', ')} o ${nombres[nombres.length - 1]!}`;
  return [
    `No encuentro «${input}». ¿Quizá ${lista}? Repite con el código INE en \`${arg}\` (es una aproximación, no una coincidencia):`,
    ...shown.map((m) => `- ${m.visible} · ${m.provincia} · ${m.code}`),
  ].join('\n');
}

/** Texto de un municipio que no aparece ni por aproximación. */
function sinMunicipioTexto(input: string): string {
  return `No encuentro ningún municipio llamado «${input}»; busca con aemet_municipios (por nombre sin acentos ni artículos, como "la acebeda", o por el código INE de 5 dígitos).`;
}

type Lugar = { ok: true; m: Municipio } | { ok: false; text: string };

/**
 * Municipio por nombre (sin acentos ni mayúsculas) o por código INE. Con varios
 * candidatos devuelve la lista con provincia y código, sin elegir por su cuenta.
 * Lo que sale solo por similitud (nivel `2`) es una aproximación: se pregunta
 * siempre, aunque sea un único candidato. Los que no tienen previsión propia
 * siguen valiendo aquí: lo dice la previsión.
 */
function resolverLugar(input: string, arg = 'municipio'): Lugar {
  const hits = buscarMunicipios(input);
  if (hits.length === 0) {
    return { ok: false, text: finish([sinMunicipioTexto(input)]) };
  }
  const nivel = hits[0]!.nivel;
  if (nivel === 2) {
    return { ok: false, text: finish([aproximacionTexto(hits, input, arg)]) };
  }
  const mejores = hits.filter((h) => h.nivel === nivel);
  if (mejores.length > 1) {
    return { ok: false, text: finish([candidatosTexto(mejores, input, arg)]) };
  }
  return { ok: true, m: datosDe(mejores[0]!) };
}

/** Provincia por nombre (sin acentos ni mayúsculas) o código INE de 2 dígitos. */
function resolverProvincia(
  input: string,
): { ok: true; code: string } | { ok: false; text: string } {
  const raw = input.trim();
  if (/^\d{1,2}$/.test(raw)) {
    const code = raw.padStart(2, '0');
    if (PROVINCIAS[code]) return { ok: true, code };
  }
  const norm = raw.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const found = Object.entries(PROVINCIAS).filter(
    ([, nombre]) => nombre.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '') === norm,
  );
  if (found.length === 1) return { ok: true, code: found[0]![0] };
  const nombres = Object.entries(PROVINCIAS)
    .map(([code, nombre]) => `${nombre} (${code})`)
    .join(', ');
  return {
    ok: false,
    text: finish([`No reconozco la provincia «${input}». Las 52 son: ${nombres}.`]),
  };
}

// --- Previsión ---------------------------------------------------------------

type Resultado<T> =
  | { ok: true; dato: T; m: Municipio; nota: readonly string[] }
  | { ok: false; text: string };

function noHayPrevision(m: Municipio): string {
  return finish([
    `AEMET no publica previsión para ${etiqueta(m)}. Prueba con un municipio de al lado o con la capital de su provincia; búscalos con aemet_municipios (por ejemplo "${m.provincia}").`,
  ]);
}

/**
 * Previsión del municipio. Un municipio sin previsión no se sustituye por su
 * vecino sin decirlo: si la tabla trae `nearest`, se devuelve la del vecino con
 * una nota que deja claro que es de otro municipio.
 */
async function previsionDe<T extends Diaria | Horaria>(
  ctx: AemetContext,
  m: Municipio,
  pedir: (ine: string) => Promise<T>,
): Promise<Resultado<T>> {
  const flags = m.flags;
  const cercano = flags !== undefined && !flags.forecast ? flags.nearest : null;
  if (cercano !== null) return previsionDelVecino(m, cercano, pedir);
  try {
    return { ok: true, dato: await conAemet(() => pedir(m.code)), m, nota: [] };
  } catch (err) {
    if (!(err instanceof SinPrevision)) throw err;
    const vecino = flags !== undefined && 'nearest' in flags ? flags.nearest : null;
    if (vecino !== null) return previsionDelVecino(m, vecino, pedir);
    return { ok: false, text: noHayPrevision(m) };
  }
}

async function previsionDelVecino<T extends Diaria | Horaria>(
  m: Municipio,
  codigo: string,
  pedir: (ine: string) => Promise<T>,
): Promise<Resultado<T>> {
  const v = municipioPorCodigo(codigo);
  if (!v) return { ok: false, text: noHayPrevision(m) };
  const nota = [
    `AEMET no publica previsión para ${etiqueta(m)}.`,
    `La de ${etiqueta(v)}, el municipio del que se segregó, es esta (es de otro municipio, no suya):`,
  ];
  try {
    return { ok: true, dato: await conAemet(() => pedir(codigo)), m: v, nota };
  } catch (err) {
    if (err instanceof SinPrevision) return { ok: false, text: noHayPrevision(m) };
    throw err;
  }
}

/** Primer tramo con dato de un registro por periodo (`null` si ninguno). */
function porPeriodo(
  rec: Record<string, number | null>,
  preferidos: readonly string[] = PERIODOS,
): number | null {
  for (const p of preferidos) {
    const v = rec[p];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Descripción del cielo del primer tramo que la trae. */
function cieloDe(estado: Record<string, { descripcion: string }>): string | null {
  for (const p of PERIODOS) {
    const e = estado[p];
    if (e && e.descripcion.trim() !== '') return e.descripcion.trim();
  }
  return null;
}

function vientoDe(
  vientos: Record<string, { direccion: string | null; velocidad: number | null }>,
): { direccion: string | null; velocidad: number | null } {
  for (const p of PERIODOS) {
    const v = vientos[p];
    if (v && (v.direccion !== null || v.velocidad !== null)) return v;
  }
  return { direccion: null, velocidad: null };
}

function vientoTexto(
  direccion: string | null,
  velocidad: number | null,
  racha: number | null,
): string {
  if (velocidad === null) return 'viento sin dato';
  const dir = direccion === null ? '' : `${direccion} `;
  return `viento ${dir}${velocidad} km/h${racha === null ? '' : ` (rachas ${racha})`}`;
}

function temperaturaTexto(d: Dia): string {
  const max = d.temperatura.maxima;
  const min = d.temperatura.minima;
  if (max !== null && min !== null) return `${min} a ${max} °C`;
  if (max !== null) return `máxima ${max} °C`;
  if (min !== null) return `mínima ${min} °C`;
  return 'temperatura sin dato';
}

function lineaDia(d: Dia): string {
  const fecha = ymdDe(d.fecha);
  const cielo = cieloDe(d.estadoCielo) ?? 'cielo sin dato';
  const prob = porPeriodo(d.probPrecipitacion);
  const lluvia = prob === null ? 'lluvia sin dato' : `lluvia ${prob} %`;
  const v = vientoDe(d.viento);
  const partes = [
    `${diaSemana(fecha)} ${ddmm(fecha)}`,
    cielo,
    temperaturaTexto(d),
    lluvia,
    vientoTexto(v.direccion, v.velocidad, porPeriodo(d.rachaMax)),
  ];
  return `- ${partes.join(' · ')}`;
}

/** Un tramo de hora del feed (`1319` = de las 13 a las 19; `1901` = de 19 a 01). */
interface Tramo {
  ini: number;
  fin: number;
  valor: number;
}

function tramos(rec: Record<string, number | null>): Tramo[] {
  const out: Tramo[] = [];
  for (const [p, v] of Object.entries(rec)) {
    if (!/^\d{4}$/.test(p) || v === null) continue;
    out.push({ ini: Number(p.slice(0, 2)), fin: Number(p.slice(2, 4)), valor: v });
  }
  return out;
}

/**
 * Probabilidad de lluvia de una hora. Los tramos de 4 dígitos valen para su día:
 * uno que no envuelve (`1319`, de 13 a 19) solo cubre esas horas; uno que
 * envuelve (`1901`, de las 19 a la 01) cubre desde su hora de inicio hasta el
 * final del día, y las horas **anteriores a su fin** pertenecen al tramo
 * envolvente del día anterior (las 00:00 del 18 llevan la probabilidad del
 * `1901` del 17, no la del `1901` del 18).
 */
function probEnHora(dia: DiaHorario, anterior: DiaHorario | null, hora: number): number | null {
  const propios = tramos(dia.probPrecipitacion);
  for (const t of propios) {
    if (t.ini <= t.fin && hora >= t.ini && hora < t.fin) return t.valor;
  }
  for (const t of propios) if (t.ini > t.fin && hora >= t.ini) return t.valor;
  if (anterior !== null) {
    for (const t of tramos(anterior.probPrecipitacion)) {
      if (t.ini > t.fin && hora < t.fin) return t.valor;
    }
  }
  return null;
}

function lineaHora(d: DiaHorario, anterior: DiaHorario | null, hora: number): string {
  const h = String(hora).padStart(2, '0');
  const descripcion = d.estadoCielo[h]?.descripcion.trim();
  const cielo = descripcion === undefined || descripcion === '' ? null : descripcion;
  const temp = d.temperatura[h] ?? null;
  const prob = probEnHora(d, anterior, hora);
  const mm = d.precipitacion[h] ?? null;
  const inapreciable = d.precipitacionInapreciable[h] === true;
  const lluvia =
    prob !== null
      ? `lluvia ${prob} %`
      : inapreciable
        ? 'precipitación inapreciable'
        : mm !== null
          ? `${mm} mm`
          : 'lluvia sin dato';
  const v = d.viento[h] ?? { direccion: null, velocidad: null };
  const partes = [
    `${h}:00`,
    cielo ?? 'cielo sin dato',
    temp === null ? 'temperatura sin dato' : `${temp} °C`,
    lluvia,
    vientoTexto(v.direccion, v.velocidad, d.rachaMax[h] ?? null),
  ];
  return `- ${partes.join(' · ')}`;
}

/** ¿La hora existe en alguno de los registros horarios del día? */
function hayHora(d: DiaHorario, hora: number): boolean {
  const h = String(hora).padStart(2, '0');
  return (
    Object.hasOwn(d.estadoCielo, h) ||
    Object.hasOwn(d.temperatura, h) ||
    Object.hasOwn(d.viento, h) ||
    Object.hasOwn(d.precipitacion, h)
  );
}

function ortoOcaso(d: DiaHorario): string {
  if (d.orto === null && d.ocaso === null) return 'sin orto ni ocaso';
  const partes: string[] = [];
  if (d.orto !== null) partes.push(`orto ${d.orto}`);
  if (d.ocaso !== null) partes.push(`ocaso ${d.ocaso}`);
  return partes.join(', ');
}

// --- Avisos ------------------------------------------------------------------

function nivelTexto(a: Aviso): string {
  const nivel = a.nivel ?? null;
  if (nivel !== null) return `Nivel ${nivel}`;
  const porSeveridad: Record<string, string> = {
    minor: 'Nivel amarillo',
    moderate: 'Nivel amarillo',
    severe: 'Nivel naranja',
    extreme: 'Nivel rojo',
  };
  return porSeveridad[a.severity.toLowerCase()] ?? 'Nivel sin dato';
}

function fenomenoTexto(a: Aviso): string {
  const partes = (a.fenomeno ?? '').split(';');
  const nombre = (partes[1] ?? partes[0] ?? '').trim();
  if (nombre !== '') return nombre;
  const evento = a.event
    .replace(/^Aviso de\s+/i, '')
    .replace(/\s+de nivel .*$/i, '')
    .trim();
  return evento === '' ? 'Fenómeno sin dato' : evento;
}

function parametroTexto(a: Aviso): string {
  const partes = (a.parametro ?? '').split(';');
  const nombre = (partes[1] ?? '').trim();
  const valor = (partes[2] ?? '').trim();
  return nombre === '' || valor === '' ? '' : `${nombre}: ${valor}`;
}

function lineaAviso(a: Aviso, ahora: Date, previsto = false): string {
  const fin = instanteRelativo(a.expires, ahora);
  const partes = [
    previsto ? 'Previsto' : '',
    nivelTexto(a),
    fenomenoTexto(a),
    parametroTexto(a),
    a.areaDesc.trim(),
    `de ${instanteRelativo(a.onset, ahora)} a ${fin === 'sin dato' ? 'fin sin dato' : fin}`,
  ];
  return `- ${partes.filter((p) => p !== '').join(' · ')}`;
}

/** Un aviso puede venir en varios CAP del RSS: se cuenta una vez por `id`. */
function sinDuplicados(lista: readonly Aviso[]): Aviso[] {
  const vistos = new Set<string>();
  const out: Aviso[] = [];
  for (const a of lista) {
    if (vistos.has(a.id)) continue;
    vistos.add(a.id);
    out.push(a);
  }
  return out;
}

interface Reparto {
  /** `onset` ≤ ahora (o sin `onset` legible): el aviso ya está en vigor. */
  activos: Aviso[];
  /** `onset` futuro: está publicado, pero aún no empieza. */
  previstos: Aviso[];
}

function reparto(lista: readonly Aviso[], ahora: Date): Reparto {
  const activos: Aviso[] = [];
  const previstos: Aviso[] = [];
  const t = ahora.getTime();
  for (const a of lista) {
    const onset = Date.parse(a.onset);
    // Sin `onset` legible no se esconde: cuenta como activo.
    if (Number.isFinite(onset) && onset > t) previstos.push(a);
    else activos.push(a);
  }
  return { activos, previstos };
}

const ORDEN_NIVEL: Record<string, number> = { rojo: 0, naranja: 1, amarillo: 2, 'sin nivel': 3 };

function cuentaPorNivel(lista: readonly Aviso[]): string[] {
  const cuenta = new Map<string, number>();
  for (const a of lista) {
    const nivel = a.nivel ?? 'sin nivel';
    cuenta.set(nivel, (cuenta.get(nivel) ?? 0) + 1);
  }
  return [...cuenta]
    .sort(([x], [y]) => (ORDEN_NIVEL[x] ?? 9) - (ORDEN_NIVEL[y] ?? 9))
    .map(([nivel, n]) => `${nivel}: ${n}`);
}

function desglose(lista: readonly Aviso[]): string {
  if (lista.length === 0) return '';
  return ` (${cuentaPorNivel(lista).join(', ')})`;
}

/** `Activos: 1 (amarillo: 1) · Previstos: 0`, que es lo que titula toda salida de avisos. */
function recuento(r: Reparto): string {
  return `Activos: ${r.activos.length}${desglose(r.activos)} · Previstos: ${r.previstos.length}${desglose(r.previstos)}`;
}

/** Las líneas de los avisos, activos primero, acotadas y sin perder ninguno en silencio. */
function lineasAvisos(r: Reparto, ahora: Date): string[] {
  const total = r.activos.length + r.previstos.length;
  const activos = r.activos.slice(0, MAX_AVISOS).map((a) => lineaAviso(a, ahora, false));
  const hueco = Math.max(0, MAX_AVISOS - activos.length);
  const previstos = r.previstos.slice(0, hueco).map((a) => lineaAviso(a, ahora, true));
  const out = [...activos, ...previstos];
  if (total > out.length) {
    out.push(
      `(y ${total - out.length} avisos más: filtra por provincia o por municipio, o por nivel, para ver el resto)`,
    );
  }
  return out;
}

/** «(N avisos no se pudieron descargar)»: el RSS trae más de los que se pudieron leer. */
function notaDescargas(noDescargados: number): string[] {
  if (noDescargados <= 0) return [];
  return [
    noDescargados === 1
      ? '(1 aviso no se pudo descargar)'
      : `(${noDescargados} avisos no se pudieron descargar)`,
  ];
}

// --- Tools -------------------------------------------------------------------

const MUNICIPIO_PROP = {
  type: 'string',
  description:
    'Municipio por nombre (sin acentos ni mayúsculas: "getafe") o por código INE de 5 dígitos ("28065").',
};

function buildTools(ctx: AemetContext): ConnectorTool[] {
  const ahora = (): Date => (ctx.now ?? ((): Date => new Date()))();

  // aemet_municipios ------------------------------------------------------------
  const municipios: ConnectorTool = {
    name: 'aemet_municipios',
    description:
      'Busca municipios de España por nombre (sin acentos ni mayúsculas) o por código INE de 5 dígitos y devuelve su provincia y su código. ' +
      'Con varios candidatos los lista todos sin elegir por ti: repite con el código INE en aemet_prevision, aemet_por_horas o aemet_avisos. ' +
      'Úsala cuando el nombre sea ambiguo, cuando no sepas el código o para saber si AEMET tiene previsión de ese municipio.',
    inputSchema: {
      type: 'object',
      properties: {
        nombre: {
          type: 'string',
          description: 'Nombre del municipio ("getafe", "la acebeda") o su código INE ("28065").',
        },
      },
      required: ['nombre'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = parseArgs(MunicipiosSchema, args);
      const hits = buscarMunicipios(a.nombre);
      if (hits.length === 0) {
        throw new ToolUserError(sinMunicipioTexto(a.nombre));
      }
      const mejor = hits[0]!.nivel;
      const mejores = hits.filter((h) => h.nivel === mejor);
      // La similitud es una aproximación: se presenta como tal y se pide el código.
      if (mejor === 2) return finish([aproximacionTexto(mejores, a.nombre, 'municipio')]);
      const shown = mejores.slice(0, MAX_CANDIDATOS);
      const lines = [
        mejores.length === 1
          ? `«${a.nombre}» → 1 municipio:`
          : `«${a.nombre}» → ${mejores.length} municipios${mejores.length > shown.length ? ` (los ${shown.length} primeros)` : ''}:`,
        ...shown.map((m) => `- ${m.visible} · ${m.provincia} · ${m.code}`),
      ];
      if (mejores.length > shown.length) {
        lines.push('Afina el nombre o indica la provincia en la consulta.');
      }
      lines.push(
        'Repite con ese código INE en `municipio` (aemet_prevision, aemet_por_horas o aemet_avisos).',
      );
      const raro = shown.find((m) => m.flags !== undefined && !m.flags.forecast);
      if (raro) {
        lines.push(`Nota: AEMET no publica previsión propia de ${raro.visible}.`);
      }
      return finish(lines);
    },
  };

  // aemet_prevision -------------------------------------------------------------
  const prevision: ConnectorTool = {
    name: 'aemet_prevision',
    description:
      'Previsión diaria oficial de AEMET para un municipio de España, de 1 a 7 días (3 por defecto): por día, el cielo, la temperatura mínima y máxima, ' +
      'la probabilidad de lluvia y el viento con rachas, en texto breve. Dice también cuándo se elaboró. ' +
      '`municipio` es un nombre o un código INE; si el nombre es ambiguo devuelve los candidatos con su código. ' +
      'Si AEMET no publica previsión de ese municipio lo dice y, cuando lo sabe, ofrece la del municipio vecino advirtiendo de que es de otro. ' +
      'Para el detalle hora a hora usa aemet_por_horas; para avisos, aemet_avisos.',
    inputSchema: {
      type: 'object',
      properties: {
        municipio: MUNICIPIO_PROP,
        dias: {
          type: 'integer',
          minimum: 1,
          maximum: 7,
          description: 'Días de previsión, de 1 a 7 (por defecto 3).',
        },
      },
      required: ['municipio'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = parseArgs(PrevisionSchema, args);
      const lugar = resolverLugar(a.municipio);
      if (!lugar.ok) return lugar.text;
      const r = await previsionDe(ctx, lugar.m, (ine) => ctx.forecast.diaria(ine));
      if (!r.ok) return r.text;
      const dias = r.dato.dias.slice(0, a.dias ?? DEFAULT_DIAS);
      if (dias.length === 0) {
        throw new ToolUserError(
          `AEMET no da ningún día de previsión para ${etiqueta(r.m)}; prueba con el municipio de al lado (aemet_municipios).`,
        );
      }
      const cabecera =
        dias.length === 1
          ? `Previsión de ${etiqueta(r.m)} para 1 día:`
          : `Previsión de ${etiqueta(r.m)} para ${dias.length} días:`;
      return finish([
        ...r.nota,
        cabecera,
        ...dias.map(lineaDia),
        `Elaborado el ${elaboradoTexto(r.dato.elaborado)}.`,
      ]);
    },
  };

  // aemet_por_horas -------------------------------------------------------------
  const porHoras: ConnectorTool = {
    name: 'aemet_por_horas',
    description:
      'Previsión hora a hora oficial de AEMET para un municipio de España, desde la hora actual, de 6 a 48 horas (12 por defecto): por hora, ' +
      'el cielo, la temperatura, la probabilidad de lluvia (o los litros) y el viento. Incluye el orto y el ocaso de cada día que cubre. ' +
      'Úsala para «¿va a llover esta tarde?» o «¿qué tiempo hará mañana por la mañana?»; para el resumen por días, aemet_prevision. ' +
      'Si AEMET no publica previsión de ese municipio lo dice y ofrece la del vecino advirtiendo de que es de otro.',
    inputSchema: {
      type: 'object',
      properties: {
        municipio: MUNICIPIO_PROP,
        horas: {
          type: 'integer',
          minimum: 6,
          maximum: 48,
          description: 'Horas que se enseñan, de 6 a 48 (por defecto 12).',
        },
      },
      required: ['municipio'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = parseArgs(PorHorasSchema, args);
      const lugar = resolverLugar(a.municipio);
      if (!lugar.ok) return lugar.text;
      const r = await previsionDe(ctx, lugar.m, (ine) => ctx.forecast.horaria(ine));
      if (!r.ok) return r.text;
      const ahoraMadrid = madridParts(ahora());
      const hoyYmd = ahoraMadrid.ymd;
      const desdeHora = Math.floor(ahoraMadrid.secs / 3600);
      const quedan = a.horas ?? DEFAULT_HORAS;
      const body: string[] = [...r.nota];
      body.push(
        `Por horas en ${etiqueta(r.m)} desde ahora (hora de Madrid: ${hhmm(ahoraMadrid.secs)}), ${quedan} horas:`,
      );
      let pintadas = 0;
      const dias = r.dato.dias;
      for (const [i, d] of dias.entries()) {
        if (pintadas >= quedan) break;
        const fecha = ymdDe(d.fecha);
        const anterior = i > 0 ? dias[i - 1]! : null;
        const lineas: string[] = [];
        const primera = fecha === hoyYmd ? desdeHora : 0;
        for (let h = primera; h < 24 && pintadas < quedan; h++) {
          if (!hayHora(d, h)) continue;
          lineas.push(lineaHora(d, anterior, h));
          pintadas++;
        }
        if (lineas.length > 0) {
          const dia =
            fecha === hoyYmd ? `Hoy ${ddmm(fecha)}` : `${diaSemana(fecha)} ${ddmm(fecha)}`;
          body.push(`${dia.charAt(0).toUpperCase()}${dia.slice(1)}: ${ortoOcaso(d)}.`, ...lineas);
        }
      }
      if (pintadas === 0) {
        throw new ToolUserError(
          `AEMET no da la previsión por horas de ${etiqueta(r.m)} desde ahora; mira la diaria con aemet_prevision.`,
        );
      }
      body.push(`Elaborado el ${elaboradoTexto(r.dato.elaborado)}.`);
      return finish(body);
    },
  };

  // aemet_avisos ----------------------------------------------------------------
  const avisosTool: ConnectorTool = {
    name: 'aemet_avisos',
    description:
      'Avisos Meteoalerta oficiales de AEMET: por un municipio (los de su zona Meteoalerta), por una provincia (nombre o código INE de 2 dígitos) ' +
      'o, sin argumentos, el resumen de toda España por nivel. Separa y cuenta los **activos** (ya en vigor) de los **previstos** (publicados, pero que aún no empiezan), ' +
      'y en cada uno da el nivel (amarillo, naranja o rojo), el fenómeno, el valor que se espera, la zona y su vigencia en hora de Madrid. ' +
      'Es la fuente que vale para «¿hay alerta por viento en A Coruña?»; no la sustituyas por una previsión.',
    inputSchema: {
      type: 'object',
      properties: {
        municipio: {
          type: 'string',
          description:
            'Municipio por nombre o código INE: devuelve los avisos de su zona Meteoalerta.',
        },
        provincia: {
          type: 'string',
          description:
            'Provincia por nombre ("A Coruña", "Lugo") o por código INE de 2 dígitos ("15").',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = parseArgs(AvisosSchema, args);
      const ahoraDate = ahora();
      if (a.municipio !== undefined) {
        const lugar = resolverLugar(a.municipio);
        if (!lugar.ok) return lugar.text;
        const lista = sinDuplicados(
          await conAemet(() => ctx.avisos.avisosPara({ zona: lugar.m.zona })),
        );
        const r = reparto(lista, ahoraDate);
        if (lista.length === 0) {
          return finish([
            `No hay avisos activos ni previstos para ${etiqueta(lugar.m)} ahora mismo.`,
            'Mira los de toda España con aemet_avisos sin argumentos, o los de la provincia con `provincia`.',
            ...notaDescargas(ctx.avisos.noDescargados ?? 0),
          ]);
        }
        return finish([
          `Avisos para ${etiqueta(lugar.m)}, zona Meteoalerta ${lugar.m.zona}: ${recuento(r)}`,
          ...lineasAvisos(r, ahoraDate),
          ...notaDescargas(ctx.avisos.noDescargados ?? 0),
        ]);
      }
      if (a.provincia !== undefined) {
        const prov = resolverProvincia(a.provincia);
        if (!prov.ok) return prov.text;
        const lista = sinDuplicados(
          await conAemet(() => ctx.avisos.avisosPara({ provincia: prov.code })),
        );
        const nombre = provinciaNombre(prov.code);
        const r = reparto(lista, ahoraDate);
        if (lista.length === 0) {
          return finish([
            `No hay avisos activos ni previstos para la provincia de ${nombre} ahora mismo.`,
            'Mira los de toda España con aemet_avisos sin argumentos, o los de un municipio con `municipio`.',
            ...notaDescargas(ctx.avisos.noDescargados ?? 0),
          ]);
        }
        return finish([
          `Avisos para la provincia de ${nombre}: ${recuento(r)}`,
          ...lineasAvisos(r, ahoraDate),
          ...notaDescargas(ctx.avisos.noDescargados ?? 0),
        ]);
      }
      const todos = sinDuplicados(await conAemet(() => ctx.avisos.avisosPara({})));
      if (todos.length === 0) {
        return finish([
          'No hay avisos activos ni previstos en España ahora mismo.',
          'Mira la previsión con aemet_prevision o aemet_por_horas.',
          ...notaDescargas(ctx.avisos.noDescargados ?? 0),
        ]);
      }
      const r = reparto(todos, ahoraDate);
      return finish([
        `Avisos de España: ${recuento(r)}`,
        'Filtra con `municipio` o `provincia` para ver los de una zona.',
        ...notaDescargas(ctx.avisos.noDescargados ?? 0),
      ]);
    },
  };

  return [municipios, prevision, porHoras, avisosTool];
}

/**
 * Las tools de verdad. La atribución de la licencia va en toda salida —la pone
 * cada handler como última línea— y también en todo `ToolUserError`, que se
 * envuelve aquí para añadírsela: es condición de la licencia de AEMET, no un
 * adorno. No toca los demás errores (un fallo interno no es un dato de AEMET).
 */
export function createAemetTools(ctx: AemetContext): ConnectorTool[] {
  return buildTools(ctx).map((tool) => ({
    ...tool,
    handler: async (args, signal) => {
      try {
        return await tool.handler(args, signal);
      } catch (err) {
        if (err instanceof ToolUserError) {
          throw new ToolUserError(`${err.message}\n${ATRIBUCION}`);
        }
        throw err;
      }
    },
  }));
}
