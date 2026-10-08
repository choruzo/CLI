/**
 * Forma canónica de un valor JSON: las claves de cada objeto ordenadas, a todos
 * los niveles. Dos valores que solo difieren en el orden de sus claves quedan
 * idénticos byte a byte al serializarlos, que es lo que compara una caché de
 * prefijo.
 *
 * - El orden de los arrays se conserva (`required`, `enum`, `anyOf`: ahí sí
 *   puede significar algo).
 * - Ningún tipo ni valor cambia, y el original no se muta: se devuelve una copia.
 * - El orden es por unidades de código, no por configuración regional: no puede
 *   depender de la máquina.
 */
export function canonicalJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item)) as T;
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // `fromEntries` define propiedades propias: una clave `__proto__` no toca el prototipo.
  return Object.fromEntries(keys.map((key) => [key, canonicalJson(source[key])])) as T;
}
