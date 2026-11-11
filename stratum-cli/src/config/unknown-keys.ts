import { z } from 'zod';

/**
 * M18 — claves que el schema no conoce. Un `z.object` no estricto (el raíz y
 * casi todas las secciones) **descarta** lo que no declara sin decir nada: una
 * `models.<id>.vision` de primer nivel, en vez de bajo
 * `provider.providers.<alias>`, dejó al asistente sin visión en la prueba real
 * de M18. Esto recorre el JSON de una capa junto al schema y devuelve la ruta
 * de cada clave que se perdería, para avisar (nunca para rechazar: una config
 * de un Stratum algo más nuevo, con una clave que este aún no tiene, sigue
 * cargando).
 *
 * Solo mira los objetos que **descartan**: uno `.strict()` ya da un error de
 * validación, y uno `.passthrough()` o con `catchall` conserva lo suyo.
 */
export function findUnknownKeys(schema: z.ZodTypeAny, value: unknown): string[][] {
  const found: string[][] = [];
  walk(schema, value, [], found);
  return found;
}

/** Tope de claves que se recorren (un fichero enorme no bloquea la carga). */
const MAX_FOUND = 50;

function walk(schema: z.ZodTypeAny, value: unknown, path: string[], found: string[][]): void {
  if (found.length >= MAX_FOUND || value === undefined || value === null) return;
  const s = unwrap(schema);

  if (s instanceof z.ZodObject) {
    if (!isRecord(value)) return;
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const def = s._def as { unknownKeys: string; catchall: z.ZodTypeAny };
    const drops = def.unknownKeys === 'strip' && def.catchall instanceof z.ZodNever;
    for (const [key, child] of Object.entries(value)) {
      const known = Object.prototype.hasOwnProperty.call(shape, key) ? shape[key] : undefined;
      if (known) walk(known, child, [...path, key], found);
      else if (drops) found.push([...path, key]);
      else if (!(def.catchall instanceof z.ZodNever))
        walk(def.catchall, child, [...path, key], found);
      if (found.length >= MAX_FOUND) return;
    }
    return;
  }
  if (s instanceof z.ZodRecord) {
    if (!isRecord(value)) return;
    const valueType = s._def.valueType as z.ZodTypeAny;
    for (const [key, child] of Object.entries(value)) walk(valueType, child, [...path, key], found);
    return;
  }
  if (s instanceof z.ZodArray) {
    if (!Array.isArray(value)) return;
    const item = s._def.type as z.ZodTypeAny;
    value.forEach((child, i) => walk(item, child, [...path, String(i)], found));
    return;
  }
  if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) {
    // La opción que valida es la que cuenta; si ninguna valida, la validación
    // ya lo dirá.
    const options = (
      s instanceof z.ZodUnion ? s._def.options : [...s._def.options.values()]
    ) as z.ZodTypeAny[];
    const match = options.find((o) => o.safeParse(value).success);
    if (match) walk(match, value, path, found);
    return;
  }
  if (s instanceof z.ZodIntersection) {
    // Cada lado descartaría lo del otro: solo se avisa de lo que ninguno conoce.
    const left: string[][] = [];
    const right: string[][] = [];
    walk(s._def.left as z.ZodTypeAny, value, path, left);
    walk(s._def.right as z.ZodTypeAny, value, path, right);
    const inRight = new Set(right.map((p) => p.join('\u0000')));
    for (const p of left) if (inRight.has(p.join('\u0000'))) found.push(p);
  }
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (let i = 0; i < 20; i++) {
    if (
      s instanceof z.ZodOptional ||
      s instanceof z.ZodNullable ||
      s instanceof z.ZodDefault ||
      s instanceof z.ZodCatch ||
      s instanceof z.ZodReadonly
    ) {
      s = s._def.innerType as z.ZodTypeAny;
    } else if (s instanceof z.ZodEffects) {
      s = s._def.schema as z.ZodTypeAny;
    } else if (s instanceof z.ZodLazy) {
      s = s._def.getter() as z.ZodTypeAny;
    } else if (s instanceof z.ZodBranded) {
      s = s._def.type as z.ZodTypeAny;
    } else if (s instanceof z.ZodPipeline) {
      s = s._def.in as z.ZodTypeAny;
    } else {
      return s;
    }
  }
  return s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Pista para el error que ya pasó una vez: la visión (o el precio) de un modelo
 * declarada fuera de `provider.providers.<alias>`.
 */
export function unknownKeyHint(path: readonly string[]): string {
  if (path.length === 1 && path[0] === 'models') {
    return (
      ' Los ajustes de un modelo (vision, pricing…) van en ' +
      '"provider.providers.<alias>.models.<id>".'
    );
  }
  return '';
}
