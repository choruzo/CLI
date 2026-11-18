/**
 * Tabla de modos del conector CRTM: cada modo es un GTFS abierto del Consorcio
 * Regional de Transportes de Madrid, publicado como un item de ArcGIS. Todo lo
 * que sabe de dónde sale un modo vive aquí: añadir otro es una fila nueva en
 * `FEED_MODES` (más su `connector.json` y su atribución) y nada más; cada modo
 * tiene su índice y su gestor y, si uno falla, los demás siguen.
 *
 * Medido el 2026-11-17: los zips se bajan de `…/content/items/<itemId>/data`
 * (sin redirección) y los metadatos (`modified`, en ms epoch) de
 * `…/content/items/<itemId>?f=json`.
 *
 * Los tres feeds de autobús comparten el mismo `stops.txt` del CRTM (8 408
 * paradas `par_8_<n>`, con `parent_station` hacia los intercambiadores
 * `est_90_<n>`), pero cada red sirve un subconjunto distinto: un mismo id de
 * parada puede estar en dos índices a la vez, y por eso el id de las tools
 * lleva el modo delante (`urbano:par_8_06002`).
 */

export type ModeId = 'metro' | 'ml' | 'emt' | 'urbano' | 'interurbano';

export interface FeedMode {
  id: ModeId;
  /** Nombre de cara a la persona («Metro Ligero»). */
  label: string;
  /** Item de ArcGIS que publica el GTFS. */
  itemId: string;
  /** Nombre del zip en el CRTM (solo informativo). */
  zipName: string;
  /** La EMT pide su propia atribución además de la del CRTM. */
  emtAttribution: boolean;
  /**
   * El `trip_id` lleva la hora local de salida (`…_06:05:00_…`) y manda sobre
   * `stop_times.txt`. Medido el 2026-11-17 en Metro Ligero: el 100 % de sus
   * viajes salen en `stop_times` una hora antes que su etiqueta (05:05 frente a
   * 06:05), y solo la etiqueta casa con el servicio real (de 06:00 a 01:30). Se
   * corrige viaje a viaje con la diferencia, y solo si es un número entero de
   * horas de como mucho 3 (un desfase de zona horaria, no otro dato): así
   * sirve igual si el feed viene en UTC y cambia la hora.
   */
  tripIdClock: boolean;
}

export const FEED_MODES: readonly FeedMode[] = [
  {
    id: 'metro',
    label: 'Metro',
    itemId: '5c7f2951962540d69ffe8f640d94c246',
    zipName: 'google_transit_M4.zip',
    emtAttribution: false,
    tripIdClock: false,
  },
  {
    id: 'ml',
    label: 'Metro Ligero',
    itemId: 'aaed26cc0ff64b0c947ac0bc3e033196',
    zipName: 'google_transit_M10.zip',
    emtAttribution: false,
    tripIdClock: true,
  },
  {
    id: 'emt',
    label: 'EMT',
    itemId: '868df0e58fca47e79b942902dffd7da0',
    zipName: 'google_transit_M6.zip',
    emtAttribution: true,
    tripIdClock: false,
  },
  // Medido el 2026-11-18 en M9 y M89: el `trip_id` lleva la hora local cuando la
  // lleva (`…_05:40:00_…`) y esa etiqueta coincide con la primera salida de
  // `stop_times` en 23 972 de los 24 055 viajes etiquetados de M89 (y en 7 083 de
  // 7 090 de M9). Los 83 y 7 que difieren lo hacen en horas enteras y son casos
  // sueltos, no un desfase de zona horaria: manda `stop_times`.
  {
    id: 'urbano',
    label: 'Autobús urbano',
    itemId: '357e63c2904f43aeb5d8a267a64346d8',
    zipName: 'google_transit_M9.zip',
    emtAttribution: false,
    tripIdClock: false,
  },
  {
    id: 'interurbano',
    label: 'Autobús interurbano',
    itemId: '885399f83408473c8d815e40c5e702b7',
    zipName: 'google_transit_M89.zip',
    emtAttribution: false,
    tripIdClock: false,
  },
];

export const MODE_IDS: readonly ModeId[] = FEED_MODES.map((m) => m.id);

export function feedMode(id: ModeId): FeedMode {
  const m = FEED_MODES.find((f) => f.id === id);
  if (!m) throw new Error(`Modo desconocido: ${id}`);
  return m;
}

export function isModeId(text: string): text is ModeId {
  return (MODE_IDS as readonly string[]).includes(text);
}

const ARCGIS = 'https://www.arcgis.com/sharing/rest/content/items';

export function dataUrl(mode: FeedMode): string {
  return `${ARCGIS}/${mode.itemId}/data`;
}

export function metaUrl(mode: FeedMode): string {
  return `${ARCGIS}/${mode.itemId}?f=json`;
}
