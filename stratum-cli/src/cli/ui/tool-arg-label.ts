/**
 * Etiqueta de una tool call: el argumento que la identifica. Helper puro,
 * compartido por `<ToolCallBlock>` y `<AgentTree>`.
 */

/**
 * Argumentos que dicen qué hace la llamada, por orden de preferencia. El orden
 * de las claves lo decide el modelo: tomar la primera daba `read_file: 700`
 * cuando `limit` llegaba antes que `path`.
 */
const IDENTIFYING_KEYS = [
  'command',
  'path',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'url',
  'task',
  'jobId',
  'name',
];

/**
 * Texto de un argumento que no es un escalar. `String()` de un array de objetos
 * (las preguntas de `question`) da `[object Object],[object Object]`: se enseña
 * el primer texto del primer elemento y cuántos más hay.
 */
export function labelOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (!Array.isArray(value)) return JSON.stringify(value);
  const first: unknown = value[0];
  const head =
    typeof first === 'object' && first !== null
      ? (Object.values(first).find((v): v is string => typeof v === 'string') ??
        JSON.stringify(first))
      : String(first ?? '');
  return value.length > 1 ? `${head} (+${value.length - 1})` : head;
}

/** El argumento que identifica la llamada; a falta de uno conocido, el primero. */
export function primaryArg(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const key =
    IDENTIFYING_KEYS.find((k) => typeof input[k] === 'string' && input[k] !== '') ?? keys[0]!;
  return labelOf(input[key]);
}

/**
 * Las últimas `max` entradas de una lista y cuántas quedan fuera. Lo que se
 * pinta en la zona viva del terminal tiene que caber en él: si la supera, Ink
 * borra y repinta la pantalla entera en cada fotograma y el terminal parpadea.
 */
export function tailWindow<T>(items: readonly T[], max: number): { hidden: number; visible: T[] } {
  const keep = Math.max(1, Math.floor(max));
  if (items.length <= keep) return { hidden: 0, visible: [...items] };
  return { hidden: items.length - keep, visible: items.slice(-keep) };
}
