/**
 * Lectura de las tablas de Grocy a tipos pequeños. Todo campo se lee con
 * cuidado: lo que falta o no tiene la forma esperada es `null`, nunca 0.
 * Formas medidas el 2026-11-21 contra Grocy 4.7.1.
 */
import { ToolUserError } from '../lib/mcp-stdio.js';
import { isRecord, type GrocyClient } from './client.js';
import { normalizeName, num, numOrNull } from './format.js';

export interface Product {
  id: number;
  name: string;
  locationId: number | null;
  groupId: number | null;
  minStock: number | null;
  quStock: number | null;
  /** Días de consumo por defecto al añadir: -1 = no caduca; 0 = Grocy pondría hoy. */
  defaultDueDays: number | null;
  canOpen: boolean;
  active: boolean;
}

export interface Unit {
  id: number;
  name: string;
  plural: string | null;
}

export interface Named {
  id: number;
  name: string | null;
  sort: number | null;
}

export interface StockEntry {
  productId: number;
  amount: number | null;
  opened: number | null;
  bestBefore: unknown;
  dueType: unknown;
}

export interface Recipe {
  id: number;
  name: string;
  description: unknown;
  baseServings: number | null;
  desiredServings: number | null;
  /** Producto que produce la receta al cocinarla (eso no se puede deshacer en Grocy). */
  producesProductId: number | null;
}

export interface RecipePos {
  recipeId: number;
  productId: number | null;
  amount: number | null;
  note: unknown;
  quId: number | null;
  group: unknown;
}

export interface Nesting {
  recipeId: number;
  includesId: number;
  servings: number | null;
}

export interface Fulfillment {
  recipeId: number;
  fulfilled: boolean | null;
  withShoppingList: boolean | null;
  missingCount: number | null;
  costs: number | null;
  costsPerServing: number | null;
  pricesIncomplete: boolean;
}

export interface MealPlanEntry {
  day: unknown;
  type: unknown;
  recipeId: number | null;
  recipeServings: number | null;
  note: unknown;
  productId: number | null;
  productAmount: number | null;
  productQuId: number | null;
  sectionId: number | null;
  done: boolean;
}

export interface ShoppingRow {
  listId: number | null;
  productId: number | null;
  amount: number | null;
  quId: number | null;
  note: unknown;
  done: boolean;
}

export interface Volatile {
  due: StockEntry[];
  overdue: StockEntry[];
  expired: StockEntry[];
  missing: {
    productId: number | null;
    name: unknown;
    amountMissing: number | null;
    partly: boolean;
  }[];
}

function id(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

function flag(v: unknown): boolean | null {
  if (v === 1 || v === '1' || v === true) return true;
  if (v === 0 || v === '0' || v === false) return false;
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export function toProduct(r: Record<string, unknown>): Product | null {
  const pid = id(r.id);
  const name = str(r.name);
  if (pid === null || !name) return null;
  return {
    id: pid,
    name,
    locationId: id(r.location_id),
    groupId: id(r.product_group_id),
    minStock: numOrNull(r.min_stock_amount),
    quStock: id(r.qu_id_stock),
    active: flag(r.active) !== false,
    defaultDueDays: numOrNull(r.default_best_before_days),
    canOpen: flag(r.disable_open) !== true,
  };
}

export function toStockEntry(r: unknown): StockEntry | null {
  if (!isRecord(r)) return null;
  const pid = id(r.product_id);
  if (pid === null) return null;
  // Un producto padre suma el de sus hijos en `amount_aggregated`.
  const aggregated = flag(r.is_aggregated_amount) === true;
  return {
    productId: pid,
    amount: numOrNull(aggregated ? r.amount_aggregated : r.amount),
    opened: numOrNull(aggregated ? r.amount_opened_aggregated : r.amount_opened),
    bestBefore: r.best_before_date,
    dueType: numOrNull(r.due_type),
  };
}

export function toStock(v: unknown): StockEntry[] {
  if (!Array.isArray(v)) throw new ToolUserError('Respuesta de Grocy no válida (stock).');
  return v.map(toStockEntry).filter((e): e is StockEntry => e !== null);
}

export function toVolatile(v: unknown): Volatile {
  if (!isRecord(v)) throw new ToolUserError('Respuesta de Grocy no válida (stock/volatile).');
  const list = (k: string): StockEntry[] =>
    (Array.isArray(v[k]) ? (v[k] as unknown[]) : [])
      .map(toStockEntry)
      .filter((e): e is StockEntry => e !== null);
  const missing = (Array.isArray(v.missing_products) ? v.missing_products : [])
    .filter(isRecord)
    .map((m) => ({
      productId: id(m.id ?? m.product_id),
      name: m.name,
      amountMissing: numOrNull(m.amount_missing),
      partly: flag(m.is_partly_in_stock) === true,
    }));
  return {
    due: list('due_products'),
    overdue: list('overdue_products'),
    expired: list('expired_products'),
    missing,
  };
}

export function toRecipe(r: Record<string, unknown>): Recipe | null {
  const rid = id(r.id);
  const name = str(r.name);
  if (rid === null || !name) return null;
  return {
    id: rid,
    name,
    description: r.description,
    baseServings: numOrNull(r.base_servings),
    desiredServings: numOrNull(r.desired_servings),
    producesProductId: id(r.product_id),
  };
}

/**
 * Solo las recetas de la persona (`type` `normal`). Las internas que Grocy
 * crea para el menú tienen otro tipo; sin `type` (otra versión) se cuentan.
 */
export function isUserRecipe(r: Record<string, unknown>): boolean {
  return r.type === undefined || r.type === null || r.type === 'normal';
}

export function toRecipePos(r: Record<string, unknown>): RecipePos | null {
  const rid = id(r.recipe_id);
  if (rid === null) return null;
  return {
    recipeId: rid,
    productId: id(r.product_id),
    amount: numOrNull(r.amount),
    note: r.note,
    quId: id(r.qu_id),
    group: r.ingredient_group,
  };
}

export function toNesting(r: Record<string, unknown>): Nesting | null {
  const rid = id(r.recipe_id);
  const inc = id(r.includes_recipe_id);
  if (rid === null || inc === null) return null;
  return { recipeId: rid, includesId: inc, servings: numOrNull(r.servings) };
}

/** En `/recipes/fulfillment` el `id` vale siempre 1: la receta es `recipe_id` (medido). */
export function toFulfillment(v: unknown): Map<number, Fulfillment> {
  if (!Array.isArray(v))
    throw new ToolUserError('Respuesta de Grocy no válida (recipes/fulfillment).');
  const out = new Map<number, Fulfillment>();
  for (const r of v) {
    if (!isRecord(r)) continue;
    const rid = id(r.recipe_id);
    if (rid === null) continue;
    out.set(rid, {
      recipeId: rid,
      fulfilled: flag(r.need_fulfilled),
      withShoppingList: flag(r.need_fulfilled_with_shopping_list),
      missingCount: numOrNull(r.missing_products_count),
      costs: numOrNull(r.costs),
      costsPerServing: numOrNull(r.costs_per_serving),
      pricesIncomplete: flag(r.prices_incomplete) !== false,
    });
  }
  return out;
}

export function toMealPlan(r: Record<string, unknown>): MealPlanEntry {
  return {
    day: r.day,
    type: r.type,
    recipeId: id(r.recipe_id),
    recipeServings: numOrNull(r.recipe_servings),
    note: r.note,
    productId: id(r.product_id),
    productAmount: numOrNull(r.product_amount),
    productQuId: id(r.product_qu_id),
    sectionId: id(r.section_id),
    done: flag(r.done) === true,
  };
}

export function toShoppingRow(r: Record<string, unknown>): ShoppingRow {
  return {
    listId: id(r.shopping_list_id),
    productId: id(r.product_id),
    amount: numOrNull(r.amount),
    quId: id(r.qu_id),
    note: r.note,
    done: flag(r.done) === true,
  };
}

function compact<T>(
  rows: Record<string, unknown>[],
  f: (r: Record<string, unknown>) => T | null,
): T[] {
  return rows.map(f).filter((x): x is T => x !== null);
}

/** Catálogo: productos, unidades, ubicaciones y grupos, por id. */
export interface Catalog {
  products: Map<number, Product>;
  units: Map<number, Unit>;
  locations: Map<number, Named>;
}

export async function loadCatalog(c: GrocyClient, signal?: AbortSignal): Promise<Catalog> {
  const [products, units, locations] = await Promise.all([
    c.objects('products', signal),
    c.objects('quantity_units', signal),
    c.objects('locations', signal),
  ]);
  const unitList = compact(units, (r): Unit | null => {
    const uid = id(r.id);
    const name = str(r.name);
    return uid === null || !name ? null : { id: uid, name, plural: str(r.name_plural) };
  });
  const locList = compact(locations, (r): Named | null => {
    const lid = id(r.id);
    return lid === null ? null : { id: lid, name: str(r.name), sort: null };
  });
  return {
    products: new Map(compact(products, toProduct).map((p) => [p.id, p])),
    units: new Map(unitList.map((u) => [u.id, u])),
    locations: new Map(locList.map((l) => [l.id, l])),
  };
}

/** `4 Packs`, `1 Piece`, `2,5` (sin unidad conocida). Sin cantidad: «sin dato». */
export function amountText(amount: number | null, quId: number | null, cat: Catalog): string {
  if (amount === null) return 'cantidad: sin dato';
  const u = quId === null ? undefined : cat.units.get(quId);
  if (!u) return num(amount);
  const name = amount === 1 ? u.name : (u.plural ?? u.name);
  return `${num(amount)} ${name}`;
}

/** Existencias por producto (una fila por producto en `/stock`). */
export function stockByProduct(stock: StockEntry[]): Map<number, StockEntry> {
  return new Map(stock.map((e) => [e.productId, e]));
}

/** ¿Casa `query` (ya normalizado) con este nombre? Sin distinguir `_`, tildes ni mayúsculas. */
export function nameMatches(name: string, query: string): boolean {
  return normalizeName(name).includes(query);
}
