/**
 * Tools de escritura del conector Grocy (M28 fase 3). Ninguna es `readOnly`, así
 * que el runtime pide confirmación de cada llamada. Cada una hace un solo
 * cambio acotado, y nada se edita ni se borra.
 *
 * Decisiones tomadas a partir del código de Grocy 4.7.1 (leído el 2026-11-21):
 * - **Añadir existencias** sin fecha pone *hoy* como fecha de consumo si el
 *   producto no tiene días por defecto (`default_best_before_days` 0, todos los
 *   de la persona). Aquí la fecha se exige en ese caso, y la ubicación se manda
 *   explícita (el controlador no pone la del producto).
 * - **Cocinar una receta** no comprueba si hay de todo: descuenta lo que hay y
 *   calla lo que falta. Aquí solo se cocina si Grocy dice que hay de todo y la
 *   receta tiene ingredientes enlazados. Tampoco devuelve la transacción: se
 *   busca en `stock_log` por `recipe_id`.
 * - **Quitar de la compra** toca una sola fila por llamada (sin mirar la lista):
 *   se repite y se relee hasta quitar lo pedido, y si el producto está en más de
 *   una lista, no se toca.
 * - **Apuntar a la compra** sin nota borra la que ya tenía la fila: se reenvía la nota existente.
 * - **Deshacer** solo lo que hizo el propio conector en este proceso.
 * - Antes de escribir, la versión de Grocy tiene que ser 4.x; si no, no se escribe.
 */
import { z } from 'zod';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { isRecord, type GrocyClient } from './client.js';
import {
  amountText,
  loadCatalog,
  nameMatches,
  stockByProduct,
  toShoppingRow,
  toStock,
  type Catalog,
  type Product,
  type ShoppingRow,
} from './data.js';
import {
  NEVER_DUE,
  displayName,
  normalizeName,
  num,
  parseDay,
  safeField,
  todayIn,
} from './format.js';
import {
  MAX_CANDIDATES,
  findRecipe,
  intIn,
  linkedOf,
  loadRecipes,
  locationName,
  outOfStockNames,
  parseArgs,
  parseFrom,
  productName,
  recipeStatus,
  servingsText,
  texto,
} from './shared.js';

const MAX_AMOUNT = 1000;
const MAX_NOTE = 200;
const MAX_REMOVE_CALLS = 60;
const VERSION_CACHE_MS = 5 * 60_000;
const EPS = 1e-6;

// --- Argumentos --------------------------------------------------------------

const productRef = z.union([z.number().int().positive(), texto('producto')], {
  message: 'producto debe ser el id (número) o el nombre del producto',
});
const recipeRef = z.union([z.number().int().positive(), texto('receta')], {
  message: 'receta debe ser el id (número) o el nombre de la receta',
});
const amount = (field: string) =>
  z
    .number({ message: `${field} debe ser un número mayor que 0` })
    .positive(`${field} debe ser mayor que 0`)
    .max(MAX_AMOUNT, `${field} admite como máximo ${MAX_AMOUNT}`);
const note = z
  .string({ message: 'nota debe ser un texto' })
  .trim()
  .min(1, 'nota no puede ir vacía')
  .max(MAX_NOTE, `nota admite como máximo ${MAX_NOTE} caracteres`);

const ApuntarSchema = z
  .object({ producto: productRef, cantidad: amount('cantidad').optional(), nota: note.optional() })
  .strict();
const QuitarSchema = z
  .object({ producto: productRef, cantidad: amount('cantidad').optional() })
  .strict();
const RecetaSchema = z.object({ receta: recipeRef }).strict();
const AnadirSchema = z
  .object({
    producto: productRef,
    cantidad: amount('cantidad'),
    caducidad: z
      .string({ message: 'caducidad debe ser una fecha AAAA-MM-DD o «no caduca»' })
      .trim()
      .optional(),
    precio: z
      .number({ message: 'precio debe ser un número' })
      .min(0, 'precio no puede ser negativo')
      .max(100_000, 'precio demasiado alto')
      .optional(),
    ubicacion: texto('ubicacion').optional(),
  })
  .strict();
const ConsumirSchema = z
  .object({
    producto: productRef,
    cantidad: amount('cantidad'),
    estropeado: z.boolean({ message: 'estropeado debe ser true o false' }).optional(),
  })
  .strict();
const AbrirSchema = z
  .object({ producto: productRef, cantidad: amount('cantidad').optional() })
  .strict();
const MenuAnadirSchema = z
  .object({
    dia: z.string({ message: 'dia debe ser «hoy», «mañana» o una fecha AAAA-MM-DD' }).trim(),
    receta: recipeRef,
    raciones: intIn('raciones', 1, 50).optional(),
    seccion: texto('seccion').optional(),
  })
  .strict();
const TRANSACTION_RE = /^[A-Za-z0-9]{1,40}$/;
const DeshacerSchema = z
  .object({
    transaccion: z
      .string({ message: 'transaccion debe ser el id que dio la tool al hacer el cambio' })
      .trim()
      .regex(TRANSACTION_RE, 'transaccion debe ser el id que dio la tool al hacer el cambio'),
  })
  .strict();

const PRODUCT_PROP = {
  oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }],
  description: 'El producto: su nombre (sin tildes ni mayúsculas da igual) o su id.',
};
const RECIPE_PROP = {
  oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }],
  description: 'La receta: su id (de grocy_recetas) o su nombre.',
};

// --- Ayudas ------------------------------------------------------------------

/** Por id o por nombre; varias coincidencias → los candidatos con su id, sin adivinar. */
export function findProduct(cat: Catalog, ref: number | string): Product {
  const active = [...cat.products.values()].filter((p) => p.active);
  if (typeof ref === 'number' || /^#?\d+$/.test(ref)) {
    const pid = typeof ref === 'number' ? ref : Number(ref.replace('#', ''));
    const p = active.find((x) => x.id === pid);
    if (!p) {
      throw new ToolUserError(
        `No hay ningún producto activo con id ${pid}: usa grocy_despensa con texto para buscarlo.`,
      );
    }
    return p;
  }
  const q = normalizeName(ref);
  const exact = active.filter((p) => normalizeName(p.name) === q);
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length > 1 ? exact : active.filter((p) => nameMatches(p.name, q));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) {
    throw new ToolUserError(
      `No hay ningún producto en Grocy que se llame «${safeField(ref, 60)}». Búscalo con grocy_despensa (texto); crear productos nuevos no se puede desde aquí.`,
    );
  }
  const list = partial.slice(0, MAX_CANDIDATES).map((p) => `- #${p.id} ${displayName(p.name)}`);
  throw new ToolUserError(
    [
      `Hay ${partial.length} productos que casan con «${safeField(ref, 60)}»; repite con el id (producto: número) o pregunta cuál:`,
      ...list,
    ].join('\n'),
  );
}

function unitOf(cat: Catalog, p: Product, n: number): string {
  return amountText(n, p.quStock, cat);
}

/** Transacción de una respuesta de add/consume/open (filas de `stock_log`). */
function transactionOf(res: unknown): string | null {
  const rows = Array.isArray(res) ? res : [];
  for (const r of rows) {
    if (
      isRecord(r) &&
      typeof r.transaction_id === 'string' &&
      TRANSACTION_RE.test(r.transaction_id)
    ) {
      return r.transaction_id;
    }
  }
  return null;
}

async function stockAmount(
  c: GrocyClient,
  productId: number,
  signal?: AbortSignal,
): Promise<number> {
  const stock = stockByProduct(toStock(await c.get('/stock', undefined, signal)));
  return stock.get(productId)?.amount ?? 0;
}

async function shoppingRows(c: GrocyClient, signal?: AbortSignal): Promise<ShoppingRow[]> {
  return (await c.objects('shopping_list', signal)).map(toShoppingRow);
}

function sumRows(rows: ShoppingRow[]): number {
  return rows.reduce((acc, r) => acc + (r.amount ?? 0), 0);
}

// --- Tools -------------------------------------------------------------------

export function createGrocyWriteTools(need: () => GrocyClient, now: () => number): ConnectorTool[] {
  /** Transacciones hechas por este conector (solo esas se deshacen). */
  const mine = new Map<string, string>();
  let version: { at: number; ok: true } | null = null;

  /** Solo se escribe en Grocy 4.x: en otra versión la API podría no ser la leída. */
  async function writable(signal?: AbortSignal): Promise<GrocyClient> {
    const c = need();
    if (version && now() - version.at < VERSION_CACHE_MS) return c;
    const info = await c.get('/system/info', undefined, signal);
    const v =
      isRecord(info) &&
      isRecord(info.grocy_version) &&
      typeof info.grocy_version.Version === 'string'
        ? info.grocy_version.Version
        : null;
    if (!v || !/^4\./.test(v)) {
      throw new ToolUserError(
        `Grocy ${v ? safeField(v, 20) : 'de versión desconocida'}: este conector solo escribe en Grocy 4.x, y no ha cambiado nada.`,
      );
    }
    version = { at: now(), ok: true };
    return c;
  }

  function remember(tx: string | null, what: string): string {
    if (!tx)
      return 'Grocy no devolvió la transacción: este cambio no se puede deshacer desde aquí.';
    mine.set(tx, what);
    return `Transacción ${tx} (para deshacerlo: grocy_deshacer).`;
  }

  async function defaultList(
    c: GrocyClient,
    signal?: AbortSignal,
  ): Promise<{ id: number; name: string }> {
    const lists = (await c.objects('shopping_lists', signal))
      .filter((l) => typeof l.id === 'number')
      .sort((a, b) => (a.id as number) - (b.id as number));
    const first = lists[0];
    if (!first) return { id: 1, name: 'Lista de la compra' };
    return {
      id: first.id as number,
      name: safeField(first.name, 60) || `lista #${String(first.id)}`,
    };
  }

  const apuntar: ConnectorTool = {
    name: 'grocy_compra_apuntar',
    description:
      'Apunta un producto en la lista de la compra de Grocy (pide aprobación). Si ya estaba, suma la cantidad. ' +
      'La cantidad va en la unidad del producto que enseña grocy_despensa.',
    inputSchema: {
      type: 'object',
      properties: {
        producto: PRODUCT_PROP,
        cantidad: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: MAX_AMOUNT,
          description: 'Cuánto (por defecto 1).',
        },
        nota: { type: 'string', description: 'Nota para la lista (p. ej. «la de marca blanca»).' },
      },
      required: ['producto'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(ApuntarSchema, args);
      const c = await writable(signal);
      const cat = await loadCatalog(c, signal);
      const p = findProduct(cat, a.producto);
      const list = await defaultList(c, signal);
      const before = (await shoppingRows(c, signal)).filter(
        (r) => r.productId === p.id && (r.listId ?? 1) === list.id,
      );
      const n = a.cantidad ?? 1;
      const body: Record<string, unknown> = {
        product_id: p.id,
        list_id: list.id,
        product_amount: n,
      };
      if (p.quStock !== null) body.qu_id = p.quStock;
      // Grocy sustituye la nota de la fila existente por la que llega (sin nota, la borra).
      const keep = before
        .map((r) => (typeof r.note === 'string' && r.note !== '' ? r.note : null))
        .find(Boolean);
      const noteToSend = a.nota ?? keep ?? undefined;
      if (noteToSend !== undefined) body.note = noteToSend;
      await c.post('/stock/shoppinglist/add-product', body, signal);
      const after = (await shoppingRows(c, signal)).filter((r) => r.productId === p.id && !r.done);
      return [
        `Apuntado en «${list.name}»: ${displayName(p.name)} · ${unitOf(cat, p, n)}${a.nota ? ` · nota: ${safeField(a.nota, MAX_NOTE)}` : ''}.`,
        `Ahora hay en la lista: ${unitOf(cat, p, sumRows(after))}.`,
      ].join('\n');
    },
  };

  const quitar: ConnectorTool = {
    name: 'grocy_compra_quitar',
    description:
      'Quita un producto de la lista de la compra de Grocy (pide aprobación): la cantidad dada o, sin cantidad, todo.',
    inputSchema: {
      type: 'object',
      properties: {
        producto: PRODUCT_PROP,
        cantidad: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: MAX_AMOUNT,
          description: 'Cuánto quitar (sin ella, todo).',
        },
      },
      required: ['producto'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(QuitarSchema, args);
      const c = await writable(signal);
      const cat = await loadCatalog(c, signal);
      const p = findProduct(cat, a.producto);
      const rowsOf = async () =>
        (await shoppingRows(c, signal)).filter((r) => r.productId === p.id);
      const start = await rowsOf();
      if (start.length === 0) return `${displayName(p.name)} no está en la lista de la compra.`;
      if (new Set(start.map((r) => r.listId ?? 1)).size > 1) {
        throw new ToolUserError(
          `${displayName(p.name)} está en más de una lista de la compra, y Grocy no deja elegir de cuál se quita: quítalo en Grocy. No ha cambiado nada.`,
        );
      }
      if (a.cantidad !== undefined && new Set(start.map((r) => r.quId)).size > 1) {
        throw new ToolUserError(
          `${displayName(p.name)} está apuntado en unidades distintas: quítalo entero (sin cantidad) o en Grocy. No ha cambiado nada.`,
        );
      }
      const total = sumRows(start);
      const target = Math.min(a.cantidad ?? total, total);
      const listId = start[0]!.listId ?? 1;
      let current = start;
      let removed = 0;
      for (let i = 0; i < MAX_REMOVE_CALLS && removed < target - EPS; i++) {
        const first = [...current].sort((x, y) => (x.amount ?? 0) - (y.amount ?? 0))[0];
        if (!first) break;
        const step = Math.min(target - removed, first.amount ?? target - removed);
        await c.post(
          '/stock/shoppinglist/remove-product',
          { product_id: p.id, list_id: listId, product_amount: step },
          signal,
        );
        const next = await rowsOf();
        const done = total - sumRows(next);
        if (done <= removed + EPS) {
          throw new ToolUserError(
            `Grocy no quitó nada de ${displayName(p.name)} (llevaba ${num(removed)} de ${num(target)}). Mira la lista con grocy_compra.`,
          );
        }
        removed = done;
        current = next;
      }
      const left = sumRows(current);
      const qu = start[0]!.quId;
      return [
        `Quitado de la lista: ${displayName(p.name)} · ${amountText(removed, qu, cat)}.`,
        left > EPS ? `Queda en la lista: ${amountText(left, qu, cat)}.` : 'Ya no está en la lista.',
      ].join('\n');
    },
  };

  const compraReceta: ConnectorTool = {
    name: 'grocy_compra_receta',
    description:
      'Apunta en la lista de la compra lo que falta para una receta (pide aprobación), según los ingredientes ' +
      'enlazados en Grocy y descontando lo que ya está en la lista.',
    inputSchema: {
      type: 'object',
      properties: { receta: RECIPE_PROP },
      required: ['receta'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(RecetaSchema, args);
      const c = await writable(signal);
      const d = await loadRecipes(c, signal);
      const r = findRecipe(d, a.receta);
      const { pos, nested } = linkedOf(d, r.id);
      if (pos.length + nested === 0) {
        throw new ToolUserError(
          `La receta #${r.id} no tiene ingredientes enlazados en Grocy (están solo en su descripción): Grocy no sabe qué falta. Apunta cada cosa con grocy_compra_apuntar. No ha cambiado nada.`,
        );
      }
      const f = d.fulfillment.get(r.id);
      if (f?.fulfilled === true)
        return `Para la receta #${r.id} ${displayName(r.name)} no falta nada: no he apuntado nada.`;
      if (f?.withShoppingList === true) {
        return `Lo que falta para la receta #${r.id} ${displayName(r.name)} ya está en la lista de la compra: no he apuntado nada.`;
      }
      const before = await shoppingRows(c, signal);
      await c.post(`/recipes/${r.id}/add-not-fulfilled-products-to-shoppinglist`, {}, signal);
      const after = await shoppingRows(c, signal);
      const ids = new Set(pos.map((p) => p.productId).filter((x): x is number => x !== null));
      const lines = [
        `Apuntado en la lista de la compra lo que falta para #${r.id} ${displayName(r.name)}:`,
      ];
      for (const pid of ids) {
        const was = sumRows(before.filter((x) => x.productId === pid));
        const now2 = after.filter((x) => x.productId === pid);
        const diff = sumRows(now2) - was;
        if (diff > EPS)
          lines.push(
            `- ${productName(d.cat, pid)} · +${amountText(diff, now2[0]?.quId ?? null, d.cat)}`,
          );
      }
      if (lines.length === 1)
        lines.push('- (Grocy no añadió nada nuevo; mira la lista con grocy_compra.)');
      return lines.join('\n');
    },
  };

  const anadir: ConnectorTool = {
    name: 'grocy_despensa_anadir',
    description:
      'Añade existencias de un producto a la despensa de Grocy, como una compra (pide aprobación). La cantidad va en la ' +
      'unidad del producto. Si el producto no tiene caducidad por defecto, hace falta caducidad (AAAA-MM-DD o «no caduca»).',
    inputSchema: {
      type: 'object',
      properties: {
        producto: PRODUCT_PROP,
        cantidad: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: MAX_AMOUNT,
          description: 'Cuánto se añade.',
        },
        caducidad: { type: 'string', description: 'Fecha de consumo AAAA-MM-DD, o «no caduca».' },
        precio: { type: 'number', minimum: 0, description: 'Precio por unidad (opcional).' },
        ubicacion: {
          type: 'string',
          description: 'Dónde se guarda (por defecto, la del producto).',
        },
      },
      required: ['producto', 'cantidad'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(AnadirSchema, args);
      const c = await writable(signal);
      const cat = await loadCatalog(c, signal);
      const p = findProduct(cat, a.producto);
      let due: string | undefined;
      if (a.caducidad !== undefined) {
        const v = normalizeName(a.caducidad);
        if (v === 'no caduca' || v === 'nunca') due = NEVER_DUE;
        else {
          const d = parseDay(a.caducidad);
          if (!d || a.caducidad.length !== 10) {
            throw new ToolUserError(
              'Argumento inválido: caducidad debe ser una fecha AAAA-MM-DD o «no caduca».',
            );
          }
          due = d;
        }
      } else if (p.defaultDueDays === -1) {
        due = NEVER_DUE;
      } else if (p.defaultDueDays === null || p.defaultDueDays <= 0) {
        // Grocy pondría hoy como fecha de consumo: se pregunta en vez de inventarla.
        throw new ToolUserError(
          `${displayName(p.name)} no tiene caducidad por defecto en Grocy, y sin fecha Grocy pondría la de hoy. Pregunta la fecha de consumo (caducidad: AAAA-MM-DD) o si no caduca (caducidad: «no caduca»). No ha cambiado nada.`,
        );
      }
      let locationId = p.locationId;
      if (a.ubicacion !== undefined) {
        const q = normalizeName(a.ubicacion);
        const locs = [...cat.locations.values()].filter((l) => l.name && nameMatches(l.name, q));
        if (locs.length !== 1) {
          const all = [...cat.locations.values()]
            .map((l) => safeField(l.name ?? '', 40))
            .filter(Boolean);
          throw new ToolUserError(
            `${locs.length === 0 ? 'No hay ninguna' : 'Hay varias'} ubicación «${safeField(a.ubicacion, 40)}» en Grocy. Las que hay: ${all.join(', ')}. No ha cambiado nada.`,
          );
        }
        locationId = locs[0]!.id;
      }
      const body: Record<string, unknown> = { amount: a.cantidad, transaction_type: 'purchase' };
      if (due !== undefined) body.best_before_date = due;
      if (locationId !== null) body.location_id = locationId;
      if (a.precio !== undefined) body.price = a.precio;
      const res = await c.post(`/stock/products/${p.id}/add`, body, signal);
      const left = await stockAmount(c, p.id, signal);
      const when =
        due === NEVER_DUE
          ? 'no caduca'
          : due
            ? `consumo ${due}`
            : `consumo según los días por defecto del producto`;
      const loc = locationName(cat, locationId);
      return [
        `Añadido a la despensa: ${displayName(p.name)} · ${unitOf(cat, p, a.cantidad)} · ${when}${loc ? ` · ${loc}` : ''}.`,
        `Ahora hay: ${unitOf(cat, p, left)}.`,
        remember(
          transactionOf(res),
          `añadir ${unitOf(cat, p, a.cantidad)} de ${displayName(p.name)}`,
        ),
      ].join('\n');
    },
  };

  const consumir: ConnectorTool = {
    name: 'grocy_despensa_consumir',
    description:
      'Consume (gasta) una cantidad de un producto de la despensa de Grocy (pide aprobación). Con estropeado: true, ' +
      'se tira por estropeado. La cantidad va en la unidad del producto.',
    inputSchema: {
      type: 'object',
      properties: {
        producto: PRODUCT_PROP,
        cantidad: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: MAX_AMOUNT,
          description: 'Cuánto se consume.',
        },
        estropeado: { type: 'boolean', description: 'Se tira por estropeado (por defecto no).' },
      },
      required: ['producto', 'cantidad'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(ConsumirSchema, args);
      const c = await writable(signal);
      const cat = await loadCatalog(c, signal);
      const p = findProduct(cat, a.producto);
      const have = await stockAmount(c, p.id, signal);
      if (a.cantidad > have + EPS) {
        throw new ToolUserError(
          `Solo hay ${unitOf(cat, p, have)} de ${displayName(p.name)} en Grocy: no se puede consumir ${unitOf(cat, p, a.cantidad)}. No ha cambiado nada.`,
        );
      }
      const res = await c.post(
        `/stock/products/${p.id}/consume`,
        { amount: a.cantidad, spoiled: a.estropeado === true, transaction_type: 'consume' },
        signal,
      );
      const left = await stockAmount(c, p.id, signal);
      return [
        `${a.estropeado ? 'Tirado por estropeado' : 'Consumido'}: ${displayName(p.name)} · ${unitOf(cat, p, a.cantidad)}.`,
        `Queda: ${unitOf(cat, p, left)}.`,
        remember(
          transactionOf(res),
          `consumir ${unitOf(cat, p, a.cantidad)} de ${displayName(p.name)}`,
        ),
      ].join('\n');
    },
  };

  const abrir: ConnectorTool = {
    name: 'grocy_despensa_abrir',
    description:
      'Marca como abierta una cantidad de un producto de la despensa de Grocy (pide aprobación).',
    inputSchema: {
      type: 'object',
      properties: {
        producto: PRODUCT_PROP,
        cantidad: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: MAX_AMOUNT,
          description: 'Cuánto se abre (por defecto 1).',
        },
      },
      required: ['producto'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(AbrirSchema, args);
      const c = await writable(signal);
      const cat = await loadCatalog(c, signal);
      const p = findProduct(cat, a.producto);
      if (!p.canOpen)
        throw new ToolUserError(
          `${displayName(p.name)} no se puede abrir en Grocy. No ha cambiado nada.`,
        );
      const n = a.cantidad ?? 1;
      const res = await c.post(`/stock/products/${p.id}/open`, { amount: n }, signal);
      return [
        `Marcado como abierto: ${displayName(p.name)} · ${unitOf(cat, p, n)}.`,
        remember(transactionOf(res), `abrir ${unitOf(cat, p, n)} de ${displayName(p.name)}`),
      ].join('\n');
    },
  };

  const cocinar: ConnectorTool = {
    name: 'grocy_receta_cocinar',
    description:
      'Marca una receta como cocinada: descuenta sus ingredientes de la despensa de Grocy (pide aprobación). Solo si ' +
      'Grocy dice que hay de todo y la receta tiene ingredientes enlazados.',
    inputSchema: {
      type: 'object',
      properties: { receta: RECIPE_PROP },
      required: ['receta'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(RecetaSchema, args);
      const c = await writable(signal);
      const d = await loadRecipes(c, signal);
      const r = findRecipe(d, a.receta);
      const { pos, nested } = linkedOf(d, r.id);
      const status = recipeStatus(
        pos.length + nested,
        d.fulfillment.get(r.id),
        outOfStockNames(d, pos),
      );
      if (pos.length + nested === 0) {
        throw new ToolUserError(
          `La receta #${r.id} no tiene ingredientes enlazados en Grocy: no hay nada que descontar. Si quieres, consume cada ingrediente con grocy_despensa_consumir. No ha cambiado nada.`,
        );
      }
      if (!status.cookable) {
        // Grocy descontaría lo que hay sin avisar de lo que falta.
        throw new ToolUserError(
          `No la marco como cocinada: ${status.text}. Grocy descontaría solo lo que hay. Consume a mano lo que se haya usado (grocy_despensa_consumir). No ha cambiado nada.`,
        );
      }
      await c.post(`/recipes/${r.id}/consume`, {}, signal);
      let tx: string | null = null;
      try {
        const log = await c.get(
          '/objects/stock_log',
          [
            ['query[]', `recipe_id=${r.id}`],
            ['query[]', 'undone=0'],
            ['order', 'id:desc'],
            ['limit', '1'],
          ],
          signal,
        );
        tx = transactionOf(log);
      } catch {
        tx = null;
      }
      const lines = [
        `Cocinada: #${r.id} ${displayName(r.name)} (${servingsText(r.desiredServings)}). Descontado de la despensa:`,
        ...pos.map((p) => `- ${productName(d.cat, p.productId)}`),
      ];
      if (r.producesProductId !== null) {
        lines.push(
          `Además añade ${productName(d.cat, r.producesProductId)} a la despensa; eso Grocy no deja deshacerlo.`,
        );
      }
      lines.push(remember(tx, `cocinar la receta #${r.id}`));
      return lines.join('\n');
    },
  };

  const menuAnadir: ConnectorTool = {
    name: 'grocy_menu_anadir',
    description: 'Añade una receta al menú de Grocy para un día (pide aprobación).',
    inputSchema: {
      type: 'object',
      properties: {
        dia: { type: 'string', description: '«hoy», «mañana» o una fecha AAAA-MM-DD.' },
        receta: RECIPE_PROP,
        raciones: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Raciones (por defecto, las de la receta).',
        },
        seccion: {
          type: 'string',
          description: 'Sección del menú (comida, cena…), si Grocy tiene secciones.',
        },
      },
      required: ['dia', 'receta'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(MenuAnadirSchema, args);
      const c = await writable(signal);
      const today = todayIn(now());
      const day = parseFrom(a.dia, today, 'dia');
      const d = await loadRecipes(c, signal);
      const r = findRecipe(d, a.receta);
      let sectionId = -1;
      let sectionName: string | null = null;
      if (a.seccion !== undefined) {
        const q = normalizeName(a.seccion);
        const secs = (await c.objects('meal_plan_sections', signal)).filter(
          (s) => typeof s.id === 'number' && typeof s.name === 'string' && nameMatches(s.name, q),
        );
        if (secs.length !== 1) {
          throw new ToolUserError(
            `${secs.length === 0 ? 'No hay ninguna' : 'Hay varias'} sección «${safeField(a.seccion, 40)}» en el menú de Grocy: repite sin seccion. No ha cambiado nada.`,
          );
        }
        sectionId = secs[0]!.id as number;
        sectionName = safeField(secs[0]!.name, 40);
      }
      const servings = a.raciones ?? r.desiredServings ?? 1;
      await c.post(
        '/objects/meal_plan',
        { day, type: 'recipe', recipe_id: r.id, recipe_servings: servings, section_id: sectionId },
        signal,
      );
      return [
        `Añadida al menú del ${day}${sectionName ? ` (${sectionName})` : ''}: #${r.id} ${displayName(r.name)} · ${servingsText(servings)}.`,
        'Para quitarla, desde Grocy (aquí no se borra nada del menú).',
      ].join('\n');
    },
  };

  const deshacer: ConnectorTool = {
    name: 'grocy_deshacer',
    description:
      'Deshace en Grocy un cambio de existencias que hiciste tú en esta conversación (añadir, consumir, abrir o ' +
      'cocinar), con la transacción que dio esa tool (pide aprobación).',
    inputSchema: {
      type: 'object',
      properties: {
        transaccion: { type: 'string', description: 'El id de transacción que dio la tool.' },
      },
      required: ['transaccion'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(DeshacerSchema, args);
      need();
      const what = mine.get(a.transaccion);
      if (!what) {
        throw new ToolUserError(
          'Solo deshago cambios que hice yo desde que se conectó Grocy en esta conversación. Lo demás se deshace en Grocy (Diario de existencias). No ha cambiado nada.',
        );
      }
      const c = await writable(signal);
      await c.post(`/stock/transactions/${encodeURIComponent(a.transaccion)}/undo`, {}, signal);
      mine.delete(a.transaccion);
      return `Deshecho en Grocy: ${what} (transacción ${a.transaccion}).`;
    },
  };

  return [apuntar, quitar, compraReceta, anadir, consumir, abrir, cocinar, menuAnadir, deshacer];
}
