/**
 * Ayudas compartidas por las tools de lectura (`tools.ts`) y de escritura
 * (`write-tools.ts`) del conector Grocy: argumentos, nombres, recetas.
 */
import { z } from 'zod';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { type GrocyClient } from './client.js';
import {
  amountText,
  isUserRecipe,
  loadCatalog,
  nameMatches,
  stockByProduct,
  toFulfillment,
  toNesting,
  toRecipe,
  toRecipePos,
  toStock,
  type Catalog,
  type Fulfillment,
  type Nesting,
  type Recipe,
  type RecipePos,
  type StockEntry,
} from './data.js';
import {
  NO_DATA,
  addDays,
  displayName,
  dueText,
  normalizeName,
  num,
  parseDay,
  safeField,
} from './format.js';

export const MAX_CANDIDATES = 10;

// --- Argumentos --------------------------------------------------------------

export function parseArgs<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ToolUserError(`Argumento inválido: ${issue?.message ?? 'argumentos no válidos'}.`);
}

export const texto = (field: string) =>
  z
    .string({ message: `${field} debe ser un texto` })
    .trim()
    .min(1, `${field} no puede ir vacío`)
    .max(100, `${field} admite como máximo 100 caracteres`);

export const intIn = (field: string, min: number, max: number) =>
  z
    .number({ message: `${field} debe ser un número entero entre ${min} y ${max}` })
    .int(`${field} debe ser un número entero entre ${min} y ${max}`)
    .min(min, `${field} debe estar entre ${min} y ${max}`)
    .max(max, `${field} debe estar entre ${min} y ${max}`);

// --- Ayudas de salida --------------------------------------------------------

export function productName(cat: Catalog, productId: number | null): string {
  if (productId === null) return NO_DATA;
  const p = cat.products.get(productId);
  return p ? displayName(p.name) : `producto #${productId}`;
}

export function locationName(cat: Catalog, locationId: number | null): string | null {
  if (locationId === null) return null;
  const name = cat.locations.get(locationId)?.name;
  return name ? safeField(name, 40) : null;
}

/** `Caja de leche · 4 Packs (1 abierto) · no caduca · Trastero`. */
export function stockLine(cat: Catalog, e: StockEntry, today: string): string {
  const p = cat.products.get(e.productId);
  const parts = [productName(cat, e.productId), amountText(e.amount, p?.quStock ?? null, cat)];
  if (e.opened !== null && e.opened > 0)
    parts[1] += ` (${num(e.opened)} abierto${e.opened === 1 ? '' : 's'})`;
  parts.push(dueText(e.bestBefore, e.dueType, today));
  const loc = locationName(cat, p?.locationId ?? null);
  if (loc) parts.push(loc);
  return `- ${parts.join(' · ')}`;
}

export function capped(lines: string[], max: number, what: string, hint = ''): string[] {
  if (lines.length <= max) return lines;
  return [
    ...lines.slice(0, max),
    `  … y ${lines.length - max} ${what} más.${hint ? ` ${hint}` : ''}`,
  ];
}

export function servingsText(n: number | null): string {
  if (n === null) return 'raciones: sin dato';
  return `${num(n)} ${n === 1 ? 'ración' : 'raciones'}`;
}

/** Cómo está una receta respecto a la despensa. Nunca «hay de todo» sin ingredientes enlazados. */
export function recipeStatus(
  linked: number,
  f: Fulfillment | undefined,
  outOfStock: string[],
): { text: string; rank: number; cookable: boolean } {
  if (linked === 0) {
    return {
      text: 'sin ingredientes enlazados en Grocy (están solo en la descripción): no se puede saber si hay de todo',
      rank: 4,
      cookable: false,
    };
  }
  if (!f || f.fulfilled === null) return { text: 'estado: sin dato', rank: 3, cookable: false };
  if (f.fulfilled) return { text: 'se puede hacer con lo que hay', rank: 0, cookable: true };
  const missing =
    f.missingCount === null
      ? 'faltan ingredientes'
      : `${f.missingCount === 1 ? 'falta' : 'faltan'} ${num(f.missingCount)} de ${linked} ingrediente${linked === 1 ? '' : 's'}`;
  const without = outOfStock.length > 0 ? `; sin existencias: ${outOfStock.join(', ')}` : '';
  if (f.withShoppingList) {
    return {
      text: `${missing}, pero se puede hacer contando lo que ya está en la lista de la compra${without}`,
      rank: 1,
      cookable: false,
    };
  }
  return { text: `${missing}${without}`, rank: 2, cookable: false };
}

export function hasStock(stock: Map<number, StockEntry>, productId: number | null): boolean {
  if (productId === null) return false;
  const e = stock.get(productId);
  return !!e && e.amount !== null && e.amount > 0;
}

export interface RecipeData {
  recipes: Recipe[];
  pos: RecipePos[];
  nestings: Nesting[];
  fulfillment: Map<number, Fulfillment>;
  stock: Map<number, StockEntry>;
  cat: Catalog;
}

export async function loadRecipes(c: GrocyClient, signal?: AbortSignal): Promise<RecipeData> {
  const [recipesRaw, posRaw, nestRaw, fRaw, stockRaw, cat] = await Promise.all([
    c.objects('recipes', signal),
    c.objects('recipes_pos', signal),
    c.objects('recipes_nestings', signal),
    c.get('/recipes/fulfillment', undefined, signal),
    c.get('/stock', undefined, signal),
    loadCatalog(c, signal),
  ]);
  return {
    recipes: recipesRaw
      .filter(isUserRecipe)
      .map(toRecipe)
      .filter((r): r is Recipe => r !== null),
    pos: posRaw.map(toRecipePos).filter((p): p is RecipePos => p !== null),
    nestings: nestRaw.map(toNesting).filter((n): n is Nesting => n !== null),
    fulfillment: toFulfillment(fRaw),
    stock: stockByProduct(toStock(stockRaw)),
    cat,
  };
}

export function linkedOf(d: RecipeData, recipeId: number): { pos: RecipePos[]; nested: number } {
  return {
    pos: d.pos.filter((p) => p.recipeId === recipeId),
    nested: d.nestings.filter((n) => n.recipeId === recipeId).length,
  };
}

export function outOfStockNames(d: RecipeData, pos: RecipePos[]): string[] {
  return [
    ...new Set(
      pos
        .filter((p) => p.productId !== null && !hasStock(d.stock, p.productId))
        .map((p) => productName(d.cat, p.productId)),
    ),
  ];
}

/** Por id o por nombre; varias coincidencias → los candidatos con su id, sin adivinar. */
export function findRecipe(d: RecipeData, ref: number | string): Recipe {
  if (typeof ref === 'number' || /^#?\d+$/.test(ref)) {
    const rid = typeof ref === 'number' ? ref : Number(ref.replace('#', ''));
    const r = d.recipes.find((x) => x.id === rid);
    if (!r)
      throw new ToolUserError(
        `No hay ninguna receta con id ${rid}: usa grocy_recetas para verlas.`,
      );
    return r;
  }
  const q = normalizeName(ref);
  const exact = d.recipes.filter((r) => normalizeName(r.name) === q);
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length > 1 ? exact : d.recipes.filter((r) => nameMatches(r.name, q));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) {
    throw new ToolUserError(
      `No hay ninguna receta que se llame «${safeField(ref, 60)}»: usa grocy_recetas para buscarla.`,
    );
  }
  const list = partial.slice(0, MAX_CANDIDATES).map((r) => `- #${r.id} ${displayName(r.name)}`);
  throw new ToolUserError(
    [
      `Hay ${partial.length} recetas que casan con «${safeField(ref, 60)}»; repite con el id (receta: número):`,
      ...list,
    ].join('\n'),
  );
}

/** `hoy`, `mañana` o `AAAA-MM-DD`. */
export function parseFrom(value: string | undefined, today: string, field = 'desde'): string {
  if (value === undefined) return today;
  const v = normalizeName(value);
  if (v === 'hoy') return today;
  if (v === 'manana') return addDays(today, 1);
  const day = parseDay(value);
  if (!day || value.length !== 10) {
    throw new ToolUserError(
      `Argumento inválido: ${field} debe ser «hoy», «mañana» o una fecha AAAA-MM-DD.`,
    );
  }
  return day;
}
