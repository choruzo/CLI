/**
 * Núcleos de Cercanías y Rodalies. El feed no trae núcleo ni comunidad: el
 * núcleo es el prefijo de dos dígitos del `route_id` (`10T0001C1` → `10`,
 * Madrid). La tabla es propia y un test falla si el `routes.txt` real trae un
 * prefijo que no está aquí.
 */

export interface Nucleo {
  /** Prefijo de dos dígitos del `route_id`. */
  prefix: string;
  /** Slug estable, el que aceptan las tools. */
  id: string;
  name: string;
  comunidad: string;
  /** Otros nombres con los que la gente lo llama. */
  aliases?: string[];
}

export const NUCLEOS: Nucleo[] = [
  { prefix: '10', id: 'madrid', name: 'Madrid', comunidad: 'Comunidad de Madrid' },
  { prefix: '20', id: 'asturias', name: 'Asturias', comunidad: 'Principado de Asturias' },
  { prefix: '30', id: 'sevilla', name: 'Sevilla', comunidad: 'Andalucía' },
  { prefix: '31', id: 'cadiz', name: 'Cádiz', comunidad: 'Andalucía' },
  { prefix: '32', id: 'malaga', name: 'Málaga', comunidad: 'Andalucía' },
  { prefix: '40', id: 'valencia', name: 'Valencia', comunidad: 'Comunitat Valenciana' },
  {
    prefix: '41',
    id: 'murcia-alicante',
    name: 'Murcia/Alicante',
    comunidad: 'Región de Murcia y Comunitat Valenciana',
    aliases: ['murcia', 'alicante'],
  },
  { prefix: '45', id: 'cartagena', name: 'Cartagena', comunidad: 'Región de Murcia' },
  { prefix: '46', id: 'ferrol', name: 'Ferrol', comunidad: 'Galicia' },
  { prefix: '47', id: 'leon', name: 'León', comunidad: 'Castilla y León' },
  {
    prefix: '51',
    id: 'rodalies',
    name: 'Rodalies de Catalunya',
    comunidad: 'Cataluña',
    aliases: ['barcelona', 'catalunya', 'cataluna'],
  },
  { prefix: '60', id: 'bilbao', name: 'Bilbao', comunidad: 'País Vasco' },
  { prefix: '61', id: 'san-sebastian', name: 'San Sebastián', comunidad: 'País Vasco' },
  { prefix: '62', id: 'santander', name: 'Santander', comunidad: 'Cantabria' },
  { prefix: '70', id: 'zaragoza', name: 'Zaragoza', comunidad: 'Aragón' },
];

const BY_PREFIX = new Map(NUCLEOS.map((n) => [n.prefix, n]));
const BY_ID = new Map(NUCLEOS.map((n) => [n.id, n]));

/** Núcleo de un `route_id` (con o sin relleno), o `undefined` si el prefijo no se conoce. */
export function nucleoOfRoute(routeId: string): Nucleo | undefined {
  return BY_PREFIX.get(routeId.trim().slice(0, 2));
}

export function nucleoById(id: string): Nucleo | undefined {
  return BY_ID.get(id);
}
