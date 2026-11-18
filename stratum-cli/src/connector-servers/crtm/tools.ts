/**
 * Tools del conector CRTM (transporte público de Madrid con los GTFS abiertos del
 * Consorcio): `transporte_paradas`, `transporte_lineas`, `transporte_salidas` y
 * `transporte_trayecto`. Todas de solo lectura; cada salida es texto breve en
 * español ya masticado para un agente, con la atribución de la licencia como
 * última línea.
 *
 * Sin tiempo real en esta versión: todo es «según horario». Metro Ligero, los
 * autobuses urbanos de los municipios y los interurbanos tienen horas exactas; la
 * EMT (y Metro, si vuelve a tener horario vigente) funciona por frecuencia: se
 * dice cada cuánto pasa en la ventana vigente, nunca una hora inventada. Un modo
 * cuyo calendario no cubre hoy no da horas (ni el caducado ni frecuencias de
 * referencia): dice que no hay horario vigente.
 *
 * Las tres redes de autobús comparten números de línea (el 1 circula en la EMT y
 * en varios municipios), así que una línea se identifica por `modo` y, cuando el
 * número se repite dentro de la misma red, por su id `modo:<route_id>`. Nunca se
 * elige por su cuenta entre varios candidatos.
 */
import { z } from 'zod';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { dateEs, hhmm, madridParts, parseClock } from '../renfe/time.js';
import { MODE_IDS, feedMode, type ModeId } from './feeds.js';
import { lineRef, lineTag, parseLineRef, parseStationRef, stationRef } from './names.js';
import {
  searchStations,
  serviceDays,
  type ExactPass,
  type Hit,
  type ModeIndex,
  type RouteInfo,
  type StationInfo,
} from './queries.js';
import {
  freqState,
  freqStateText,
  groupWindows,
  minutesUntil,
  rideText,
  type FreqGroup,
} from './schedule.js';

export interface CrtmContext {
  /** Abre el índice del modo (quien lo abre lo cierra); `null` si todavía no hay. */
  open(mode: ModeId): Promise<ModeIndex | null>;
  /** Por qué no hay índice de un modo (preparando, o el último fallo). */
  unavailable(mode: ModeId): string;
  now?: () => Date;
}

/** Candidatos que se enseñan como máximo. */
const MAX_CANDIDATES = 10;
/** Paradas por sentido que enseña el detalle de una línea. */
const MAX_LINE_STOPS = 80;
/** Líneas que lista `transporte_lineas` sin `linea`. */
const MAX_LINES = 80;
/** Resultados por defecto de salidas y trayectos. */
const DEFAULT_MAX = 8;
const DEFAULT_TRAYECTO_MAX = 5;

// --- Argumentos --------------------------------------------------------------

function text(name: string, max = 100) {
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

const MODO_MSG =
  'modo debe ser "metro", "ml" (Metro Ligero), "emt" (EMT de Madrid), "urbano" (autobuses urbanos de otros municipios) o "interurbano" (autobuses interurbanos)';
const MODE_ALIASES: Record<string, ModeId> = {
  metro: 'metro',
  'metro ligero': 'ml',
  metroligero: 'ml',
  ligero: 'ml',
  ml: 'ml',
  emt: 'emt',
  bus: 'emt',
  autobus: 'emt',
  autobuses: 'emt',
  urbano: 'urbano',
  urbanos: 'urbano',
  'bus urbano': 'urbano',
  'autobus urbano': 'urbano',
  'autobuses urbanos': 'urbano',
  municipal: 'urbano',
  interurbano: 'interurbano',
  interurbanos: 'interurbano',
  'bus interurbano': 'interurbano',
  'autobus interurbano': 'interurbano',
  'autobuses interurbanos': 'interurbano',
};
const modo = z.string({ message: MODO_MSG }).transform((raw, ctx): ModeId => {
  const key = raw.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const found = Object.hasOwn(MODE_ALIASES, key) ? MODE_ALIASES[key] : undefined;
  if (!found) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: MODO_MSG });
    return z.NEVER;
  }
  return found;
});

const CLOCK_MSG = 'desde debe ser una hora "HH:MM" de hoy (hora de Madrid)';
const desde = z
  .string({ message: CLOCK_MSG })
  .trim()
  .regex(/^\d{1,2}:\d{2}$/, CLOCK_MSG)
  .optional();

const ParadasSchema = z.object({
  nombre: text('nombre').optional(),
  modo: modo.optional(),
  linea: text('linea', 30).optional(),
});
const LineasSchema = z.object({ modo: modo.optional(), linea: text('linea', 30).optional() });
const SalidasSchema = z.object({
  parada: text('parada'),
  modo: modo.optional(),
  linea: text('linea', 30).optional(),
  destino: text('destino').optional(),
  desde,
  max: intRange('max', 1, 20),
});
const TrayectoSchema = z.object({
  origen: text('origen'),
  destino: text('destino'),
  modo: modo.optional(),
  desde,
  max: intRange('max', 1, 8),
});

// --- Atribución y avisos -----------------------------------------------------

function publishedYmd(ix: ModeIndex): string {
  const ms = Number(ix.meta.feedModified);
  return Number.isFinite(ms) && ms > 0 ? madridParts(new Date(ms)).ymd : '';
}

/**
 * Línea de atribución de la licencia: el CRTM y la fecha de publicación de los
 * horarios (por modo si no coinciden) y, si interviene la EMT, su propia
 * atribución. Nunca insinúa que el CRTM o la EMT respalden este uso.
 */
export function attribution(indexes: ModeIndex[]): string {
  const byMode = new Map<ModeId, string>();
  for (const ix of indexes) byMode.set(ix.mode, publishedYmd(ix));
  const dates = [...byMode].filter(([, d]) => d !== '');
  const distinct = new Set(dates.map(([, d]) => d));
  let published = '';
  // Sin modo solo si todos los modos abiertos comparten fecha; si no, cada fecha con su modo.
  if (distinct.size === 1 && dates.length === byMode.size) {
    published = ` · horarios publicados el ${dateEs([...distinct][0]!)}`;
  } else if (dates.length > 0) {
    published = ` · horarios publicados el ${dates
      .map(([m, d]) => `${dateEs(d)} (${feedMode(m).label})`)
      .join(', ')}`;
  }
  const lines = [`Origen de los datos: CRTM (Powered by CRTM, https://www.crtm.es)${published}`];
  if ([...byMode.keys()].some((m) => feedMode(m).emtAttribution)) {
    lines.push('Datos de EMT Madrid (Powered by EMT de Madrid)');
  }
  return lines.join('\n');
}

function finish(body: string[], indexes: ModeIndex[]): string {
  return [...body, attribution(indexes)].join('\n');
}

// --- Modos e índices ---------------------------------------------------------

interface Opened {
  ixs: Map<ModeId, ModeIndex>;
  missing: ModeId[];
}

/**
 * Abre los índices de los modos pedidos. Si se pidió uno solo y no está, o no
 * hay ninguno, `ToolUserError`; si faltan algunos, se sigue con los que hay y
 * `missing` lo dice (la salida lo avisa).
 */
async function openModes(ctx: CrtmContext, modes: readonly ModeId[]): Promise<Opened> {
  const ixs = new Map<ModeId, ModeIndex>();
  const missing: ModeId[] = [];
  for (const m of modes) {
    const ix = await ctx.open(m);
    if (ix) ixs.set(m, ix);
    else missing.push(m);
  }
  if (ixs.size === 0 || (modes.length === 1 && missing.length > 0)) {
    for (const ix of ixs.values()) ix.close();
    throw new ToolUserError(ctx.unavailable(missing[0]!));
  }
  return { ixs, missing };
}

async function withModes<T>(
  ctx: CrtmContext,
  modes: readonly ModeId[],
  fn: (o: Opened) => Promise<T> | T,
): Promise<T> {
  const o = await openModes(ctx, modes);
  try {
    return await fn(o);
  } finally {
    for (const ix of o.ixs.values()) ix.close();
  }
}

function missingNote(o: Opened): string[] {
  if (o.missing.length === 0) return [];
  const labels = o.missing.map((m) => feedMode(m).label).join(', ');
  return [`Nota: los horarios de ${labels} aún no están listos; esto no los incluye.`];
}

/** Modo que implica el nombre de una línea (`ML1` → ml, `L1` → metro), si lo implica. */
function lineModeHint(linea: string): ModeId | null {
  const t = linea.trim();
  if (/^ML\d+$/i.test(t)) return 'ml';
  if (/^L(\d+|R)$/i.test(t)) return 'metro';
  return null;
}

function scope(modeArg: ModeId | undefined, linea: string | undefined): readonly ModeId[] {
  if (modeArg) return [modeArg];
  const hint = linea ? lineModeHint(linea) : null;
  return hint ? [hint] : MODE_IDS;
}

// --- Líneas ------------------------------------------------------------------

function routeById(ix: ModeIndex): Map<string, RouteInfo> {
  return new Map(ix.routes().map((r) => [r.id, r]));
}

function linesLabel(ix: ModeIndex, stationId: string, max = 8): string {
  const tags = ix.routesAt(stationId).map((r) => lineTag(ix.mode, r.shortName));
  if (tags.length === 0) return 'sin líneas';
  return tags.length > max ? `${tags.slice(0, max).join(', ')}…` : tags.join(', ');
}

interface LineMatch {
  ix: ModeIndex;
  route: RouteInfo;
}

interface FoundLine extends LineMatch {
  tag: string;
}

/**
 * Líneas que responden a `linea` en los modos abiertos: por nombre corto (`1`,
 * `ML1`, `625`) o por su id `modo:<route_id>` (`urbano:9__1__040_`), que es como
 * se pide una concreta cuando varias redes o municipios comparten número.
 */
function matchLines(o: Opened, linea: string): LineMatch[] {
  const ref = parseLineRef(linea);
  const out: LineMatch[] = [];
  if (ref) {
    const ix = o.ixs.get(ref.mode);
    if (ix) for (const route of ix.findRoutes(ref.lineId)) out.push({ ix, route });
    return out;
  }
  for (const ix of o.ixs.values()) {
    for (const route of ix.findRoutes(linea)) out.push({ ix, route });
  }
  const order = (m: ModeId) => MODE_IDS.indexOf(m);
  return out.sort(
    (a, b) =>
      order(a.ix.mode) - order(b.ix.mode) ||
      naturalCompare(a.route.shortName, b.route.shortName) ||
      a.route.id.localeCompare(b.route.id),
  );
}

/** «- 625 · Autobús interurbano · MADRID (Moncloa)-MONTE ROZAS · interurbano:8__625___» */
function lineCandidate(m: LineMatch): string {
  const label = feedMode(m.ix.mode).label;
  const long = m.route.longName ? ` · ${m.route.longName}` : '';
  return `- ${lineTag(m.ix.mode, m.route.shortName)} · ${label}${long} · ${lineRef(m.ix.mode, m.route.id)}`;
}

/** La línea pedida en los modos abiertos; si no es una sola, `ToolUserError` que dice qué hacer. */
function findLine(o: Opened, linea: string, tool: string): FoundLine {
  const found = matchLines(o, linea);
  if (found.length === 0) {
    const modes = [...o.ixs.keys()].join('" o "');
    throw new ToolUserError(
      `No encuentro la línea «${linea}». Mira las líneas con transporte_lineas (modo "${modes}") y repite con su nombre corto o con su id (por ejemplo "metro:1" o "interurbano:8__625___").`,
    );
  }
  if (found.length > 1) {
    const shown = found.slice(0, MAX_CANDIDATES);
    const lines = [
      `La línea «${linea}» no es una sola: hay ${found.length} líneas con ese número. Repite ${tool} indicando modo ("metro", "ml", "emt", "urbano" o "interurbano") o con el id de la que quieras:`,
      ...shown.map(lineCandidate),
    ];
    if (found.length > shown.length) {
      lines.push(`(y ${found.length - shown.length} más: afina con modo)`);
    }
    throw new ToolUserError(lines.join('\n'));
  }
  const f = found[0]!;
  return { ix: f.ix, route: f.route, tag: lineTag(f.ix.mode, f.route.shortName) };
}

/** ¿La estación la sirve alguna de esas líneas (por nombre corto o por id `modo:línea`, en su modo)? */
function servedByLine(o: Opened, station: StationInfo, linea: string): boolean {
  const ix = o.ixs.get(station.mode)!;
  const ids = new Set(
    matchLines(o, linea)
      .filter((m) => m.ix.mode === station.mode)
      .map((m) => m.route.id),
  );
  return ix.routesAt(station.id).some((r) => ids.has(r.id));
}

// --- Estaciones --------------------------------------------------------------

type Resolution =
  | { kind: 'one'; station: StationInfo }
  | { kind: 'group'; stations: StationInfo[] }
  | { kind: 'text'; text: string };

function candidateLine(o: Opened, s: StationInfo): string {
  const ix = o.ixs.get(s.mode)!;
  return `- ${s.name} · ${feedMode(s.mode).label} (${linesLabel(ix, s.id)}) · ${stationRef(s.mode, s.id)}`;
}

function indexesOf(o: Opened, hits: Hit[]): ModeIndex[] {
  return [...new Set(hits.map((h) => h.station.mode))].map((m) => o.ixs.get(m)!);
}

function candidatesText(o: Opened, hits: Hit[], input: string, arg: string, tool: string): string {
  const shown = hits.slice(0, MAX_CANDIDATES);
  const first = shown[0]!.station;
  const lines = [
    `«${input}» coincide con ${hits.length} paradas o estaciones. Repite ${tool} con el id de la que quieras (por ejemplo ${arg}: "${stationRef(first.mode, first.id)}"), o afina con modo y linea:`,
    ...shown.map((h) => candidateLine(o, h.station)),
  ];
  if (hits.length > shown.length) {
    lines.push(
      `(y ${hits.length - shown.length} más: afina con modo, linea o un nombre más largo)`,
    );
  }
  return finish([...lines, ...missingNote(o)], indexesOf(o, shown));
}

/**
 * Estación por id estable (`emt:4514`) o por nombre. Varios candidatos → los
 * devuelve con su id, no adivina. Con `linea`, solo cuentan las que esa línea
 * sirve, y con `sameName` varias paradas con el mismo nombre (los dos sentidos de
 * una calle de la EMT) valen juntas.
 */
function resolveStation(
  o: Opened,
  input: string,
  arg: string,
  tool: string,
  opts: { linea?: string; sameName?: boolean } = {},
): Resolution {
  const ref = parseStationRef(input);
  if (ref) {
    const ix = o.ixs.get(ref.mode);
    if (!ix) {
      return {
        kind: 'text',
        text: finish(
          [
            `No tengo los horarios de ${feedMode(ref.mode).label} cargados ahora; prueba de nuevo en un momento.`,
          ],
          [...o.ixs.values()],
        ),
      };
    }
    const s = ix.station(ref.stationId);
    if (!s) {
      return {
        kind: 'text',
        text: finish(
          [
            `No encuentro la parada con id «${input}». Busca el id con transporte_paradas (nombre).`,
          ],
          [ix],
        ),
      };
    }
    return { kind: 'one', station: s };
  }
  const pool = [...o.ixs.values()].flatMap((ix) => ix.stations());
  let hits = searchStations(pool, input);
  if (opts.linea) hits = hits.filter((h) => servedByLine(o, h.station, opts.linea!));
  if (hits.length === 0) {
    const where = opts.linea ? ` servida por la línea ${opts.linea}` : '';
    return {
      kind: 'text',
      text: finish(
        [
          `No encuentro ninguna parada o estación${where} llamada «${input}». Prueba con otro nombre o busca con transporte_paradas.`,
        ],
        [...o.ixs.values()],
      ),
    };
  }
  const best = hits.filter((h) => h.level === hits[0]!.level);
  if (best.length === 1) return { kind: 'one', station: best[0]!.station };
  if (
    opts.sameName &&
    opts.linea &&
    best.every(
      (h) => h.station.mode === best[0]!.station.mode && h.station.norm === best[0]!.station.norm,
    )
  ) {
    return { kind: 'group', stations: best.map((h) => h.station) };
  }
  return { kind: 'text', text: candidatesText(o, hits, input, arg, tool) };
}

// --- Servicio ----------------------------------------------------------------

interface Clock {
  ymd: string;
  secs: number;
  /** Texto de la hora de consulta (`18:36`). */
  label: string;
}

function clockOf(ctx: CrtmContext, desdeArg: string | undefined): Clock {
  const now = madridParts((ctx.now ?? (() => new Date()))());
  const secs = desdeArg !== undefined ? (parseClock(desdeArg) ?? now.secs) : now.secs;
  return { ymd: now.ymd, secs, label: hhmm(secs) };
}

/** Si el calendario del modo no cubre hoy, el texto que lo dice; si lo cubre, `null`. */
function notCoveredText(ix: ModeIndex, ymd: string): string | null {
  if (ix.covers(ymd)) return null;
  const { firstDate, lastDate } = ix.meta;
  let when = 'su calendario no tiene fechas';
  if (lastDate && lastDate < ymd) when = `su calendario acaba el ${dateEs(lastDate)}`;
  else if (firstDate && firstDate > ymd) when = `su calendario empieza el ${dateEs(firstDate)}`;
  else if (lastDate)
    when = `hoy no tiene servicio en su calendario, que llega hasta el ${dateEs(lastDate)}`;
  return `El horario de ${feedMode(ix.mode).label} publicado por el CRTM no cubre hoy (${when}). Sin horario vigente; las estaciones y líneas sí están.`;
}

/** Hasta cuántos segundos de espera se dice «en N min» (más lejos, solo la hora). */
const MAX_WAIT_TEXT = 3 * 3600;

/** `18:42 (en 6 min)`, o `mañana 06:05` si cae en el día siguiente. */
function passTime(abs: number, now: number): string {
  if (abs >= 86400) return `mañana ${hhmm(abs)}`;
  const m = abs - now <= MAX_WAIT_TEXT ? minutesUntil(abs, now) : null;
  return m ? `${hhmm(abs)} (${m})` : hhmm(abs);
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
}

interface Passes {
  exact: ExactPass[];
  groups: FreqGroup[];
}

/** Salidas de hora exacta (hoy, ayer pasada la medianoche y mañana) y grupos por frecuencia. */
function collectPasses(
  ix: ModeIndex,
  stationIds: string[],
  clock: Clock,
  opts: { destIds?: string[]; routeIds?: string[] },
): Passes {
  const days = serviceDays(clock.ymd).filter((d, i) => i === 0 || ix.covers(d.ymd));
  const exact: ExactPass[] = [];
  const seen = new Set<string>();
  for (const day of days) {
    for (const p of ix.exactPasses(stationIds, day, clock.secs, opts)) {
      const k = `${p.routeId}|${p.direction}|${p.headsign}|${p.dep}`;
      if (seen.has(k)) continue;
      seen.add(k);
      exact.push(p);
    }
  }
  exact.sort((a, b) => a.dep - b.dep);
  // El servicio por frecuencia mira hoy y el día anterior (sus ventanas pasadas de las 24:00).
  const batches = days
    .filter((d) => d.offset >= 0)
    .map((d) => ({ shift: -d.offset, windows: ix.freqWindows(stationIds, d.ymd, opts) }));
  return { exact, groups: groupWindows(batches) };
}

function sortGroups(groups: FreqGroup[], routes: Map<string, RouteInfo>): FreqGroup[] {
  const name = (id: string) => routes.get(id)?.shortName ?? id;
  return [...groups].sort(
    (a, b) =>
      naturalCompare(name(a.routeId), name(b.routeId)) ||
      a.direction - b.direction ||
      a.headsign.localeCompare(b.headsign, 'es'),
  );
}

/** Prefijo de la etiqueta en listas por frecuencia: la EMT lo lleva («EMT 27»); Metro y Metro Ligero ya son claros. */
function modeWord(mode: ModeId): string {
  return mode === 'emt' ? 'EMT ' : '';
}

// --- Filtros de las tools ----------------------------------------------------

/**
 * Ids de las líneas pedidas en el modo; error que orienta si no existe. `linea`
 * admite el nombre corto o el id `modo:<route_id>`: con el id se filtra una sola
 * de las líneas que comparten número.
 */
function lineFilter(ix: ModeIndex, linea: string | undefined): string[] | undefined {
  if (!linea) return undefined;
  const ref = parseLineRef(linea);
  const ids = ref
    ? ref.mode === ix.mode
      ? ix.findRoutes(ref.lineId).map((r) => r.id)
      : []
    : ix.findRoutes(linea).map((r) => r.id);
  if (ids.length === 0) {
    throw new ToolUserError(
      `No encuentro la línea «${linea}» en ${feedMode(ix.mode).label}. Mira las líneas con transporte_lineas (modo "${ix.mode}").`,
    );
  }
  return ids;
}

/** Estaciones del destino pedido (las de mejor coincidencia del nombre) en el modo. */
function destFilter(ix: ModeIndex, destino: string | undefined): string[] | undefined {
  if (!destino) return undefined;
  const ref = parseStationRef(destino);
  if (ref && ref.mode === ix.mode && ix.station(ref.stationId)) return [ref.stationId];
  const hits = searchStations(ix.stations(), destino);
  if (hits.length === 0) {
    throw new ToolUserError(
      `No encuentro «${destino}» entre las paradas de ${feedMode(ix.mode).label}. Busca el nombre con transporte_paradas (modo "${ix.mode}").`,
    );
  }
  return hits.filter((h) => h.level === hits[0]!.level).map((h) => h.station.id);
}

function lineStopsText(line: FoundLine, withIds: boolean, o: Opened): string {
  const { ix, route, tag } = line;
  const dirs = ix.lineDirections(route.id);
  const out = [
    `Línea ${tag} de ${feedMode(ix.mode).label}: ${route.longName || 'sin descripción'}.`,
  ];
  for (const d of dirs) {
    out.push(`Sentido ${d.headsign || 'sin destino'} (${d.stops.length} paradas):`);
    const shown = d.stops.slice(0, MAX_LINE_STOPS);
    if (withIds) {
      shown.forEach((s, i) =>
        out.push(`${i + 1}. ${s.name} · ${stationRef(ix.mode, s.stationId)}`),
      );
    } else {
      out.push(shown.map((s) => s.name).join(' → '));
    }
    if (d.stops.length > shown.length) out.push(`(y ${d.stops.length - shown.length} paradas más)`);
  }
  if (dirs.length === 0) out.push('Esta línea no tiene paradas con horario.');
  if (!withIds) out.push('Para los ids de las paradas usa transporte_paradas con linea y modo.');
  return finish([...out, ...missingNote(o)], [ix]);
}

// --- Tools -------------------------------------------------------------------

const MODO_PROP = {
  type: 'string',
  enum: ['metro', 'ml', 'emt', 'urbano', 'interurbano'],
  description:
    'Modo: "metro", "ml" (Metro Ligero), "emt" (EMT de Madrid), "urbano" (autobuses urbanos de los demás municipios) o "interurbano" (autobuses interurbanos).',
};
const DESDE_PROP = {
  type: 'string',
  description: 'Hora de hoy "HH:MM" (Madrid) desde la que mirar; por defecto, ahora.',
};

function buildTools(ctx: CrtmContext): ConnectorTool[] {
  // transporte_paradas ----------------------------------------------------------
  const paradas: ConnectorTool = {
    name: 'transporte_paradas',
    description:
      'Busca estaciones de Metro y Metro Ligero y paradas de autobús (EMT de Madrid, urbanos de los demás municipios e interurbanos) por nombre ' +
      '(sin acentos ni mayúsculas), o lista las paradas de una línea en orden (con `linea` y `modo`, sin `nombre`). Devuelve el modo, las líneas ' +
      'que paran y un id "modo:id" (por ejemplo "emt:4514", "ml:est_10_1", "interurbano:par_8_06002") para usarlo en transporte_salidas y ' +
      'transporte_trayecto. Si hay varias coincidencias las lista; filtra con `modo` o `linea`.',
    inputSchema: {
      type: 'object',
      properties: {
        nombre: {
          type: 'string',
          description: 'Nombre de la estación o parada ("Plaza de Castilla").',
        },
        modo: MODO_PROP,
        linea: {
          type: 'string',
          description:
            'Línea ("L1" con modo metro, "ML1", "27" con modo emt, "625" interurbana) o su id "modo:línea" ("urbano:9__1__040_") cuando varias ' +
            'líneas comparten número: filtra o, sin nombre, lista sus paradas.',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = parseArgs(ParadasSchema, args);
      if (!a.nombre && !a.linea) {
        throw new ToolUserError(
          'Indica `nombre` (estación o parada que buscas) o `linea` junto con `modo` (para listar sus paradas en orden).',
        );
      }
      return withModes(ctx, scope(a.modo, a.linea), (o) => {
        if (!a.nombre) return lineStopsText(findLine(o, a.linea!, 'transporte_paradas'), true, o);
        let hits = searchStations(
          [...o.ixs.values()].flatMap((ix) => ix.stations()),
          a.nombre,
        );
        if (a.linea) hits = hits.filter((h) => servedByLine(o, h.station, a.linea!));
        if (hits.length === 0) {
          throw new ToolUserError(
            `No encuentro ninguna parada o estación llamada «${a.nombre}»${a.linea ? ` en la línea ${a.linea}` : ''}. Prueba con otro nombre o sin acentos.`,
          );
        }
        const shown = hits.slice(0, MAX_CANDIDATES);
        const lines = [
          hits.length === 1
            ? 'Encontrada 1 parada o estación:'
            : `Encontradas ${hits.length} paradas o estaciones${hits.length > shown.length ? ` (primeras ${shown.length})` : ''}:`,
          ...shown.map((h) => candidateLine(o, h.station)),
        ];
        if (hits.length > shown.length) {
          lines.push('Afina con modo, linea o un nombre más largo para ver el resto.');
        }
        lines.push('Usa el id "modo:id" en transporte_salidas o transporte_trayecto.');
        return finish([...lines, ...missingNote(o)], indexesOf(o, shown));
      });
    },
  };

  // transporte_lineas -----------------------------------------------------------
  const lineas: ConnectorTool = {
    name: 'transporte_lineas',
    description:
      'Líneas de un modo (Metro, Metro Ligero, EMT, autobuses urbanos de los demás municipios o interurbanos) con sus extremos. Con `linea`, las ' +
      'paradas en orden de sus dos sentidos; si el número está en varias redes y no se da `modo`, devuelve los candidatos con su id. ' +
      'Úsala para saber qué líneas hay o por dónde pasa una; para horarios usa transporte_salidas.',
    inputSchema: {
      type: 'object',
      properties: {
        modo: MODO_PROP,
        linea: {
          type: 'string',
          description: 'Línea concreta ("L1", "ML1", "27", "625"), o su id "modo:línea", opcional.',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = parseArgs(LineasSchema, args);
      if (!a.modo && !a.linea) {
        throw new ToolUserError(
          'modo debe ser "metro", "ml" (Metro Ligero), "emt" (EMT de Madrid), "urbano" (autobuses urbanos de otros municipios) o "interurbano" (autobuses interurbanos); o indica `linea` para buscarla en todas las redes.',
        );
      }
      return withModes(ctx, scope(a.modo, a.linea), (o) => {
        const ix = a.modo ? o.ixs.get(a.modo)! : null;
        if (a.linea) return lineStopsText(findLine(o, a.linea, 'transporte_lineas'), false, o);
        const mode = a.modo!;
        const routes = ix!.routes();
        const shown = routes.slice(0, MAX_LINES);
        // En los autobuses el número se repite entre municipios: si pasa, se dice el id con el que pedir cada una.
        const perName = new Map<string, number>();
        for (const r of routes) perName.set(r.shortName, (perName.get(r.shortName) ?? 0) + 1);
        const repeated = [...perName.values()].some((n) => n > 1);
        const lines = [
          `Líneas de ${feedMode(mode).label} (${routes.length}):`,
          ...shown.map((r) => {
            const id = (perName.get(r.shortName) ?? 0) > 1 ? ` · ${lineRef(mode, r.id)}` : '';
            return `- ${lineTag(mode, r.shortName)} · ${r.longName || 'sin descripción'}${id}`;
          }),
        ];
        if (routes.length > shown.length) {
          lines.push(`(y ${routes.length - shown.length} más: pide una con \`linea\`)`);
        }
        lines.push(
          repeated
            ? 'Con `linea` ves sus paradas en orden; donde el número se repite (varios municipios con la misma línea), usa el id.'
            : 'Con `linea` ves sus paradas en orden.',
        );
        return finish(lines, [ix!]);
      });
    },
  };

  // transporte_salidas ----------------------------------------------------------
  const salidas: ConnectorTool = {
    name: 'transporte_salidas',
    description:
      'Próximas salidas desde una parada o estación de Madrid según horario (sin tiempo real): Metro Ligero, autobuses urbanos de los municipios y ' +
      'autobuses interurbanos con hora exacta y minutos que faltan; EMT con la frecuencia vigente ("cada 8 min hasta las 09:00"). Metro no tiene ' +
      'horario vigente publicado: lo dice. ' +
      '`parada` es un nombre o un id "modo:id"; si el nombre es ambiguo devuelve las candidatas con su id. ' +
      '`linea` y `destino` filtran; `desde` cambia la hora. Para cómo ir de A a B en una línea usa transporte_trayecto.',
    inputSchema: {
      type: 'object',
      properties: {
        parada: {
          type: 'string',
          description: 'Nombre de la parada o estación, o id "modo:id" ("emt:4514").',
        },
        modo: MODO_PROP,
        linea: {
          type: 'string',
          description: 'Solo esta línea ("ML1", "27", "625"), o su id "modo:línea", opcional.',
        },
        destino: {
          type: 'string',
          description: 'Solo los que después paran en este destino (nombre), opcional.',
        },
        desde: DESDE_PROP,
        max: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Máximo de salidas o líneas (por defecto 8).',
        },
      },
      required: ['parada'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = parseArgs(SalidasSchema, args);
      const max = a.max ?? DEFAULT_MAX;
      const ref = parseStationRef(a.parada);
      return withModes(ctx, ref ? [ref.mode] : scope(a.modo, a.linea), (o) => {
        const r = resolveStation(o, a.parada, 'parada', 'transporte_salidas', {
          linea: a.linea,
          sameName: true,
        });
        if (r.kind === 'text') return r.text;
        const stations = r.kind === 'one' ? [r.station] : r.stations;
        const ix = o.ixs.get(stations[0]!.mode)!;
        const routeIds = lineFilter(ix, a.linea);
        const destIds = destFilter(ix, a.destino);
        const clock = clockOf(ctx, a.desde);
        const label = feedMode(ix.mode).label;
        const where =
          stations.length === 1
            ? `${stations[0]!.name} (${label}, ${stationRef(ix.mode, stations[0]!.id)})`
            : `${stations[0]!.name} (${label}, ${stations.length} paradas con ese nombre: ${stations.map((s) => stationRef(ix.mode, s.id)).join(', ')})`;
        const notCovered = notCoveredText(ix, clock.ymd);
        if (notCovered) return finish([`Salidas desde ${where}.`, notCovered], [ix]);

        const { exact, groups } = collectPasses(
          ix,
          stations.map((s) => s.id),
          clock,
          { routeIds, destIds },
        );
        const routes = routeById(ix);
        const tagOf = (id: string) => lineTag(ix.mode, routes.get(id)?.shortName ?? id);
        const filters = [a.linea ? `línea ${a.linea}` : '', a.destino ? `hacia ${a.destino}` : ''];
        const shownFilters = filters.filter(Boolean);
        const body: string[] = [
          `Salidas desde ${where} a partir de las ${clock.label}${shownFilters.length ? ` (${shownFilters.join(', ')})` : ''}:`,
        ];

        const shownExact = exact.slice(0, max);
        for (const p of shownExact) {
          body.push(
            `- ${tagOf(p.routeId)} a ${p.headsign} · sale ${passTime(p.dep, clock.secs)} · según horario`,
          );
        }
        if (exact.length > shownExact.length) {
          body.push(
            `(hay más salidas: pide max=${Math.min(20, max + 8)} o filtra con linea o destino)`,
          );
        }
        const sorted = sortGroups(groups, routes);
        const shownGroups = sorted.slice(0, max);
        for (const g of shownGroups) {
          body.push(
            `- ${modeWord(ix.mode)}${tagOf(g.routeId)} hacia ${g.headsign} · ${freqStateText(freqState(g.windows, clock.secs))} · según horario`,
          );
        }
        if (sorted.length > shownGroups.length) {
          body.push(
            `(y ${sorted.length - shownGroups.length} líneas o sentidos más: filtra con linea o destino, o pide max=${Math.min(20, max + 8)})`,
          );
        }
        if (shownExact.length === 0 && shownGroups.length === 0) {
          body.push(
            'No hay salidas en esta parada con esos filtros según el horario (hoy puede no circular ese servicio).',
          );
        }
        return finish([...body, ...missingNote(o)], [ix]);
      });
    },
  };

  // transporte_trayecto ---------------------------------------------------------
  const trayecto: ConnectorTool = {
    name: 'transporte_trayecto',
    description:
      'Trayectos DIRECTOS (una sola línea, sin transbordos) de una parada o estación a otra del mismo modo, según horario: con hora de salida y de ' +
      'llegada cuando el modo tiene horas exactas (Metro Ligero, urbanos de los municipios e interurbanos); en EMT, la frecuencia y "unos N min de ' +
      'viaje". `origen` y `destino` son nombres o ids "modo:id". Si no hay directo lo dice y sugiere transporte_salidas.',
    inputSchema: {
      type: 'object',
      properties: {
        origen: {
          type: 'string',
          description: 'Parada o estación de origen: nombre o id "modo:id".',
        },
        destino: {
          type: 'string',
          description: 'Parada o estación de destino: nombre o id "modo:id".',
        },
        modo: MODO_PROP,
        desde: DESDE_PROP,
        max: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          description: 'Máximo de trayectos (por defecto 5).',
        },
      },
      required: ['origen', 'destino'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const a = parseArgs(TrayectoSchema, args);
      const max = a.max ?? DEFAULT_TRAYECTO_MAX;
      const oref = parseStationRef(a.origen);
      const dref = parseStationRef(a.destino);
      // Los ids dicen el modo de cada extremo; se abren los dos para poder avisar de que no coinciden.
      const refModes = [...new Set([oref?.mode, dref?.mode].filter((m): m is ModeId => !!m))];
      const modes = refModes.length > 0 ? refModes : scope(a.modo, undefined);
      return withModes(ctx, modes, (o) => {
        const orig = resolveStation(o, a.origen, 'origen', 'transporte_trayecto');
        if (orig.kind === 'text') return orig.text;
        const origin = orig.kind === 'one' ? orig.station : orig.stations[0]!;
        const ix = o.ixs.get(origin.mode)!;
        // El destino se busca en el modo del origen: solo hay directos dentro de un modo.
        const dest = resolveStation(
          dref ? o : { ixs: new Map([[ix.mode, ix]]), missing: [] },
          a.destino,
          'destino',
          'transporte_trayecto',
        );
        if (dest.kind === 'text') return dest.text;
        const target = dest.kind === 'one' ? dest.station : dest.stations[0]!;
        if (target.mode !== origin.mode) {
          return finish(
            [
              `«${origin.name}» es de ${feedMode(origin.mode).label} y «${target.name}» de ${feedMode(target.mode).label}: solo sé trayectos directos dentro de un mismo modo. Mira qué sale de cada una con transporte_salidas.`,
            ],
            [ix, o.ixs.get(target.mode)!],
          );
        }
        if (target.id === origin.id) {
          throw new ToolUserError(
            'El origen y el destino son la misma parada: indica dos distintas.',
          );
        }
        const clock = clockOf(ctx, a.desde);
        const head = `Trayectos directos de ${origin.name} a ${target.name} (${feedMode(ix.mode).label}, a partir de las ${clock.label}):`;
        const notCovered = notCoveredText(ix, clock.ymd);
        if (notCovered) return finish([head, notCovered], [ix]);

        const { exact, groups } = collectPasses(ix, [origin.id], clock, { destIds: [target.id] });
        const routes = routeById(ix);
        const tagOf = (id: string) => lineTag(ix.mode, routes.get(id)?.shortName ?? id);
        const body: string[] = [head];
        const shownExact = exact.slice(0, max);
        for (const p of shownExact) {
          const arr =
            p.arr !== null
              ? `, llega ${hhmm(p.arr)} (${Math.max(1, Math.round((p.arr - p.dep) / 60))} min de viaje)`
              : '';
          body.push(
            `- ${tagOf(p.routeId)} hacia ${p.headsign} · sale ${passTime(p.dep, clock.secs)}${arr} · según horario`,
          );
        }
        if (exact.length > shownExact.length) {
          body.push(`(hay más: pide max=${Math.min(8, max + 3)})`);
        }
        const sorted = sortGroups(groups, routes);
        const shownGroups = sorted.slice(0, max);
        for (const g of shownGroups) {
          // La duración sale de la ventana que se está diciendo (vigente o la próxima).
          const state = freqState(g.windows, clock.secs);
          const ride = state.kind === 'over' ? null : state.ride;
          body.push(
            `- ${modeWord(ix.mode)}${tagOf(g.routeId)} hacia ${g.headsign} · ${freqStateText(state)}${ride !== null ? `, ${rideText(ride)}` : ''} · según horario`,
          );
        }
        if (sorted.length > shownGroups.length) {
          body.push(
            `(y ${sorted.length - shownGroups.length} más: pide max=${Math.min(8, max + 3)})`,
          );
        }
        if (shownExact.length === 0 && shownGroups.length === 0) {
          body.push(
            `No hay trayecto directo de ${origin.name} a ${target.name} según el horario (solo miro una misma línea, sin transbordos). ` +
              'Mira qué sale del origen con transporte_salidas, o las paradas de una línea con transporte_paradas (linea y modo).',
          );
        }
        return finish([...body, ...missingNote(o)], [ix]);
      });
    },
  };

  return [paradas, lineas, salidas, trayecto];
}

/**
 * Las tools de verdad. Todo `ToolUserError` sale con su mensaje primero y la
 * atribución de la licencia después (la de los índices que esa llamada llegó a
 * abrir; sin ninguno, la genérica del CRTM): la regla es «atribución en cada
 * salida», también en los errores. Cada llamada arma sus tools con un contexto
 * que anota los índices que abre, porque el server atiende peticiones en paralelo.
 */
export function createCrtmTools(ctx: CrtmContext): ConnectorTool[] {
  return buildTools(ctx).map((tool) => ({
    ...tool,
    handler: async (args, signal) => {
      const opened: ModeIndex[] = [];
      const tracked: CrtmContext = {
        ...ctx,
        open: async (mode) => {
          const ix = await ctx.open(mode);
          if (ix) opened.push(ix);
          return ix;
        },
      };
      const inner = buildTools(tracked).find((t) => t.name === tool.name)!;
      try {
        return await inner.handler(args, signal);
      } catch (err) {
        if (err instanceof ToolUserError) {
          throw new ToolUserError(`${err.message}\n${attribution(opened)}`);
        }
        throw err;
      }
    },
  }));
}
