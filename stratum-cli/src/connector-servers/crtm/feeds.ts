/**
 * Tabla de modos del conector CRTM: cada modo es un GTFS abierto del Consorcio
 * Regional de Transportes de Madrid, publicado como un item de ArcGIS. Todo lo
 * que sabe de dónde sale un modo vive aquí: añadir otro (autobuses urbanos de
 * otros municipios, M9, o interurbanos, M89) es una fila nueva en `FEED_MODES`
 * (más su `connector.json` y su atribución) y nada más; cada modo tiene su
 * índice y su gestor y, si uno falla, los demás siguen.
 *
 * Medido el 2026-11-17: los zips se bajan de `…/content/items/<itemId>/data`
 * (sin redirección) y los metadatos (`modified`, en ms epoch) de
 * `…/content/items/<itemId>?f=json`.
 */

export type ModeId = 'metro' | 'ml' | 'emt';

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
