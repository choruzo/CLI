/**
 * Tools del conector Grocy (M28): las de lectura (fase 2): grocy_despensa,
 * grocy_recetas, grocy_receta, grocy_menu, grocy_compra y grocy_comprobar (la
 * comprobación de los vigilantes, M22). Salidas en texto breve en español,
 * nunca JSON crudo. `fetch` y reloj inyectables para testear sin red.
 *
 * Trampas medidas contra el Grocy real (PRD §23.11, M28):
 * - una receta sin ingredientes enlazados sale en `/recipes/fulfillment` como
 *   que se puede hacer: aquí se dice «sin ingredientes enlazados», nunca «hay de todo»;
 * - la cantidad real va muchas veces en la nota del ingrediente («200 gramos»): se enseña siempre;
 * - `2999-12-31` es «no caduca»;
 * - la lista de la compra repite filas del mismo producto: se agrupan;
 * - los costes vienen a 0 con `prices_incomplete`: «n/d», nunca 0.
 */
import { z } from 'zod';
import { accessCheckTool } from '../lib/access.js';
import { ToolUserError, type ConnectorTool, type ToolOutput } from '../lib/mcp-stdio.js';
import { createGrocyClient, notConfigured, type GrocyClient } from './client.js';
import {
  amountText,
  loadCatalog,
  nameMatches,
  stockByProduct,
  toMealPlan,
  toShoppingRow,
  toStock,
  toVolatile,
  type StockEntry,
} from './data.js';
import {
  EXTERNAL_NOTE,
  NEVER_DUE,
  NO_DATA,
  addDays,
  displayName,
  normalizeName,
  num,
  parseDay,
  recipeBlock,
  safeField,
  todayIn,
  weekdayDay,
} from './format.js';
import {
  capped,
  findRecipe,
  hasStock,
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
  stockLine,
  texto,
} from './shared.js';
import { createGrocyWriteTools } from './write-tools.js';

const DEFAULT_DUE_DAYS = 5;
const MAX_DUE_DAYS = 30;
const DEFAULT_PANTRY_LIMIT = 40;
const MAX_PANTRY_LIMIT = 100;
const DEFAULT_RECIPES_LIMIT = 20;
const MAX_RECIPES_LIMIT = 50;
const DEFAULT_MENU_DAYS = 7;
const MAX_MENU_DAYS = 14;
const MAX_URGENT_PER_GROUP = 25;
const MAX_DESCRIPTION = 6000;

const MAX_DETAIL = 300;

export interface GrocyOptions {
  fetch: typeof fetch;
  url?: string;
  apiKey?: string;
  now?: () => number;
}

const DespensaSchema = z
  .object({
    texto: texto('texto').optional(),
    ubicacion: texto('ubicacion').optional(),
    dias: intIn('dias', 1, MAX_DUE_DAYS).optional(),
    limite: intIn('limite', 1, MAX_PANTRY_LIMIT).optional(),
  })
  .strict();

const RecetasSchema = z
  .object({
    texto: texto('texto').optional(),
    cocinables: z.boolean({ message: 'cocinables debe ser true o false' }).optional(),
    limite: intIn('limite', 1, MAX_RECIPES_LIMIT).optional(),
  })
  .strict();

const RecetaSchema = z
  .object({
    receta: z.union([z.number().int().positive(), texto('receta')], {
      message: 'receta debe ser el id (número) o el nombre de la receta',
    }),
  })
  .strict();

const MenuSchema = z
  .object({
    desde: z
      .string({ message: 'desde debe ser «hoy», «mañana» o una fecha AAAA-MM-DD' })
      .trim()
      .optional(),
    dias: intIn('dias', 1, MAX_MENU_DAYS).optional(),
  })
  .strict();

const CompraSchema = z.object({}).strict();

const CHECK_KINDS = ['caducado', 'caduca_pronto', 'bajo_minimos'] as const;
const ComprobarSchema = z
  .object({
    que: z.enum(CHECK_KINDS, {
      message: 'que debe ser caducado, caduca_pronto o bajo_minimos',
    }),
    dias: intIn('dias', 1, MAX_DUE_DAYS).optional(),
  })
  .strict();

// --- Tools -------------------------------------------------------------------

export function createGrocyTools(opts: GrocyOptions): ConnectorTool<string | ToolOutput>[] {
  const client = createGrocyClient({
    fetch: opts.fetch,
    url: opts.url,
    apiKey: opts.apiKey,
    now: opts.now,
  });
  const now = opts.now ?? Date.now;
  const need = (): GrocyClient => {
    if (!client) throw notConfigured();
    return client;
  };

  const despensa: ConnectorTool = {
    name: 'grocy_despensa',
    description:
      'Despensa de Grocy, de solo lectura. Sin argumentos: lo urgente (caducado, consumo preferente pasado, lo que ' +
      'caduca en los próximos días y lo que está bajo mínimos). Con texto: si hay un producto y cuánto. Con ubicacion: ' +
      'lo que hay en ese sitio (nevera, trastero…).',
    inputSchema: {
      type: 'object',
      properties: {
        texto: {
          type: 'string',
          description: 'Nombre o parte del nombre del producto (p. ej. leche).',
        },
        ubicacion: {
          type: 'string',
          description: 'Ubicación de Grocy o parte de su nombre (p. ej. fridge).',
        },
        dias: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_DUE_DAYS,
          description: `Días hacia delante para «caduca pronto» (por defecto ${DEFAULT_DUE_DAYS}).`,
        },
        limite: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_PANTRY_LIMIT,
          description: `Máximo de productos en la lista (por defecto ${DEFAULT_PANTRY_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = need();
      const a = parseArgs(DespensaSchema, args);
      const today = todayIn(now());
      const days = a.dias ?? DEFAULT_DUE_DAYS;
      const limit = a.limite ?? DEFAULT_PANTRY_LIMIT;

      if (a.texto === undefined && a.ubicacion === undefined) {
        const [vRaw, sRaw, cat] = await Promise.all([
          c.get('/stock/volatile', { due_soon_days: String(days) }, signal),
          c.get('/stock', undefined, signal),
          loadCatalog(c, signal),
        ]);
        const v = toVolatile(vRaw);
        const stock = toStock(sRaw);
        const lines = [`Despensa en Grocy (hoy ${weekdayDay(today, today)}, hora de Madrid):`];
        const group = (title: string, entries: StockEntry[]): void => {
          if (entries.length === 0) return;
          lines.push(`${title} (${entries.length}):`);
          lines.push(
            ...capped(
              entries.map((e) => stockLine(cat, e, today)),
              MAX_URGENT_PER_GROUP,
              'productos',
            ),
          );
        };
        group('Caducado', v.expired);
        group('Consumo preferente pasado', v.overdue);
        group(`Caduca o vence en los próximos ${days} días`, v.due);
        if (v.missing.length > 0) {
          lines.push(`Bajo mínimos (${v.missing.length}):`);
          const missing = v.missing.map((m) => {
            const p = m.productId === null ? undefined : cat.products.get(m.productId);
            const name = p ? displayName(p.name) : displayName(m.name);
            const amount =
              m.amountMissing === null
                ? ''
                : ` · ${m.amountMissing === 1 ? 'falta' : 'faltan'} ${amountText(m.amountMissing, p?.quStock ?? null, cat)}`;
            return `- ${name}${amount}${m.partly ? ' (queda algo)' : ''}`;
          });
          lines.push(...capped(missing, MAX_URGENT_PER_GROUP, 'productos'));
        }
        if (v.expired.length + v.overdue.length + v.due.length + v.missing.length === 0) {
          lines.push(
            `Nada urgente: nada caducado, nada vence en los próximos ${days} días y nada bajo mínimos.`,
          );
        }
        const inStock = stock.filter((e) => e.amount !== null && e.amount > 0);
        const never = inStock.filter((e) => e.bestBefore === NEVER_DUE).length;
        const locs = [...cat.locations.values()]
          .map((l) => (l.name ? safeField(l.name, 40) : null))
          .filter(Boolean);
        lines.push(
          `En existencias: ${inStock.length} productos (${never} sin fecha de caducidad). Para uno concreto, usa texto` +
            (locs.length > 0 ? `; para un sitio, ubicacion (${locs.join(', ')}).` : '.'),
        );
        return lines.join('\n');
      }

      const [sRaw, cat] = await Promise.all([
        c.get('/stock', undefined, signal),
        loadCatalog(c, signal),
      ]);
      const stock = stockByProduct(toStock(sRaw));
      let locationIds: Set<number> | null = null;
      if (a.ubicacion !== undefined) {
        const q = normalizeName(a.ubicacion);
        const locs = [...cat.locations.values()].filter((l) => l.name && nameMatches(l.name, q));
        if (locs.length === 0) {
          const all = [...cat.locations.values()]
            .map((l) => safeField(l.name ?? '', 40))
            .filter(Boolean);
          throw new ToolUserError(
            `No hay ninguna ubicación «${safeField(a.ubicacion, 40)}» en Grocy. Las que hay: ${all.join(', ') || NO_DATA}.`,
          );
        }
        locationIds = new Set(locs.map((l) => l.id));
      }
      const q = a.texto === undefined ? null : normalizeName(a.texto);
      const products = [...cat.products.values()].filter(
        (p) =>
          p.active &&
          (q === null || nameMatches(p.name, q)) &&
          (locationIds === null || (p.locationId !== null && locationIds.has(p.locationId))),
      );
      // Con solo ubicación, lo que hay; con texto, también lo que no hay (es la respuesta a «¿tengo…?»).
      const shown = q === null ? products.filter((p) => hasStock(stock, p.id)) : products;
      const what = [
        q !== null ? `«${safeField(a.texto, 40)}»` : null,
        locationIds !== null
          ? `en ${[...locationIds].map((id) => locationName(cat, id)).join(', ')}`
          : null,
      ]
        .filter(Boolean)
        .join(' ');
      if (shown.length === 0) {
        return q !== null
          ? `No hay ningún producto en Grocy que case con ${what}. Prueba con otra palabra (sin tildes da igual).`
          : `No hay existencias ${what} en Grocy.`;
      }
      shown.sort(
        (x, y) =>
          Number(hasStock(stock, y.id)) - Number(hasStock(stock, x.id)) ||
          x.name.localeCompare(y.name, 'es'),
      );
      const lines = [`Productos ${what} (${shown.length}, ubicación por defecto del producto):`];
      const rows = shown.map((p) => {
        const e = stock.get(p.id);
        if (e && e.amount !== null && e.amount > 0) return stockLine(cat, e, today);
        const loc = locationName(cat, p.locationId);
        return `- ${displayName(p.name)} · sin existencias${loc ? ` · ${loc}` : ''}`;
      });
      lines.push(...capped(rows, limit, 'productos', 'Afina el texto o sube limite.'));
      return lines.join('\n');
    },
  };

  const recetas: ConnectorTool = {
    name: 'grocy_recetas',
    description:
      'Recetas de Grocy, de solo lectura: si se pueden hacer con lo que hay en la despensa y qué falta. Con texto busca ' +
      'por nombre o por ingrediente («¿qué puedo hacer con pollo?»); con cocinables: true, solo las que se pueden ' +
      'hacer ya. Para los ingredientes y los pasos de una, grocy_receta.',
    inputSchema: {
      type: 'object',
      properties: {
        texto: {
          type: 'string',
          description: 'Parte del nombre de la receta o de un ingrediente.',
        },
        cocinables: {
          type: 'boolean',
          description: 'Solo las que se pueden hacer con lo que hay.',
        },
        limite: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RECIPES_LIMIT,
          description: `Máximo de recetas (por defecto ${DEFAULT_RECIPES_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(RecetasSchema, args);
      const d = await loadRecipes(need(), signal);
      if (d.recipes.length === 0) return 'No hay recetas en Grocy.';
      const q = a.texto === undefined ? null : normalizeName(a.texto);
      const rows = d.recipes.flatMap((r) => {
        const { pos, nested } = linkedOf(d, r.id);
        const byIngredient =
          q !== null && !nameMatches(r.name, q)
            ? pos
                .map((p) => (p.productId === null ? undefined : d.cat.products.get(p.productId)))
                .find((p) => p && nameMatches(p.name, q))
            : undefined;
        if (q !== null && !nameMatches(r.name, q) && !byIngredient) return [];
        const status = recipeStatus(
          pos.length + nested,
          d.fulfillment.get(r.id),
          outOfStockNames(d, pos),
        );
        if (a.cocinables && !status.cookable) return [];
        const extra = byIngredient ? ` · lleva ${displayName(byIngredient.name)}` : '';
        return [
          {
            rank: status.rank,
            name: r.name,
            line: `- #${r.id} ${displayName(r.name)} · ${servingsText(r.desiredServings)}${extra} · ${status.text}`,
          },
        ];
      });
      const unlinked = d.recipes.filter((r) => {
        const l = linkedOf(d, r.id);
        return l.pos.length + l.nested === 0;
      }).length;
      if (rows.length === 0) {
        const why = a.cocinables
          ? `Ninguna receta${q !== null ? ` con «${safeField(a.texto, 40)}»` : ''} se puede hacer ahora con lo que hay.`
          : `Ninguna receta casa con «${safeField(a.texto, 40)}» (ni por nombre ni por ingrediente enlazado).`;
        return unlinked > 0
          ? `${why} ${unlinked} de ${d.recipes.length} recetas no tienen ingredientes enlazados, y de esas Grocy no sabe si se pueden hacer.`
          : why;
      }
      rows.sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name, 'es'));
      const limit = a.limite ?? DEFAULT_RECIPES_LIMIT;
      return [
        `Recetas de Grocy (${rows.length}${rows.length > limit ? `, enseño ${limit}` : ''}):`,
        ...capped(
          rows.map((r) => r.line),
          limit,
          'recetas',
        ),
      ].join('\n');
    },
  };

  const receta: ConnectorTool = {
    name: 'grocy_receta',
    description:
      'Una receta de Grocy, de solo lectura: ingredientes enlazados con lo que hay de cada uno, si se puede hacer, y ' +
      'la descripción (ingredientes y pasos tal como están escritos). Por id o por nombre.',
    inputSchema: {
      type: 'object',
      properties: {
        receta: {
          oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }],
          description: 'El id de la receta (de grocy_recetas) o su nombre.',
        },
      },
      required: ['receta'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(RecetaSchema, args);
      const d = await loadRecipes(need(), signal);
      const r = findRecipe(d, a.receta);
      const { pos, nested } = linkedOf(d, r.id);
      const f = d.fulfillment.get(r.id);
      const status = recipeStatus(pos.length + nested, f, outOfStockNames(d, pos));
      const lines = [EXTERNAL_NOTE, `Receta #${r.id}: ${displayName(r.name, 120)}`];
      const base = r.baseServings;
      lines.push(
        `Raciones: ${servingsText(r.desiredServings)}` +
          (base !== null && r.desiredServings !== null && base !== r.desiredServings
            ? ` (las cantidades de abajo son para ${servingsText(base)}; Grocy las escala)`
            : ''),
      );
      lines.push(`Estado: ${status.text}.`);
      if (pos.length > 0) {
        lines.push(`Ingredientes enlazados (${pos.length}):`);
        let group: string | null = null;
        for (const p of pos) {
          const g = safeField(p.group, 60) || null;
          if (g !== group && g !== null) lines.push(`${g}:`);
          group = g;
          const prod = p.productId === null ? undefined : d.cat.products.get(p.productId);
          const e = p.productId === null ? undefined : d.stock.get(p.productId);
          const have =
            e && e.amount !== null && e.amount > 0
              ? `en despensa: ${amountText(e.amount, prod?.quStock ?? null, d.cat)}`
              : 'sin existencias';
          const note = safeField(p.note, 120);
          lines.push(
            `- ${productName(d.cat, p.productId)} · ${amountText(p.amount, p.quId, d.cat)}${note ? ` · nota: ${note}` : ''} · ${have}`,
          );
        }
      }
      for (const n of d.nestings.filter((x) => x.recipeId === r.id)) {
        const inc = d.recipes.find((x) => x.id === n.includesId);
        lines.push(
          `Incluye la receta #${n.includesId} ${inc ? displayName(inc.name) : NO_DATA}${n.servings !== null ? ` (${servingsText(n.servings)})` : ''}.`,
        );
      }
      if (f) {
        lines.push(
          f.pricesIncomplete
            ? 'Coste: n/d (faltan precios en Grocy).'
            : `Coste según Grocy: ${num(f.costs)} (por ración ${num(f.costsPerServing)}).`,
        );
      }
      const block = recipeBlock(r.description, MAX_DESCRIPTION);
      if (block) {
        lines.push('Descripción (tal como está en Grocy):', block);
      } else {
        lines.push('Sin descripción.');
      }
      return lines.join('\n');
    },
  };

  const menu: ConnectorTool = {
    name: 'grocy_menu',
    description:
      'Menú (planificador de comidas) de Grocy, de solo lectura: lo planificado para un día o varios, con cada receta y ' +
      'si se puede hacer. Por defecto, desde hoy los próximos 7 días.',
    inputSchema: {
      type: 'object',
      properties: {
        desde: {
          type: 'string',
          description: '«hoy», «mañana» o una fecha AAAA-MM-DD (por defecto hoy).',
        },
        dias: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MENU_DAYS,
          description: `Cuántos días desde «desde» (por defecto ${DEFAULT_MENU_DAYS}; 1 = solo ese día).`,
        },
      },
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(MenuSchema, args);
      const c = need();
      const today = todayIn(now());
      const from = parseFrom(a.desde, today);
      const days = a.dias ?? DEFAULT_MENU_DAYS;
      const to = addDays(from, days - 1);
      const [planRaw, sectionsRaw, d] = await Promise.all([
        c.objects('meal_plan', signal),
        c.objects('meal_plan_sections', signal),
        loadRecipes(c, signal),
      ]);
      const range =
        days === 1
          ? weekdayDay(from, today)
          : `del ${weekdayDay(from, today)} al ${weekdayDay(to, today)}`;
      const sections = new Map<number, { name: string | null; sort: number }>();
      for (const s of sectionsRaw) {
        if (typeof s.id === 'number') {
          sections.set(s.id, {
            name: safeField(s.name, 40) || null,
            sort: typeof s.sort_number === 'number' ? s.sort_number : 0,
          });
        }
      }
      const entries = planRaw
        .map(toMealPlan)
        .map((e) => ({ e, day: parseDay(e.day) }))
        .filter(
          (x): x is { e: ReturnType<typeof toMealPlan>; day: string } =>
            x.day !== null && x.day >= from && x.day <= to,
        );
      if (entries.length === 0) return `No hay nada en el menú de Grocy ${range}.`;
      entries.sort(
        (x, y) =>
          x.day.localeCompare(y.day) ||
          (sections.get(x.e.sectionId ?? -1)?.sort ?? 0) -
            (sections.get(y.e.sectionId ?? -1)?.sort ?? 0),
      );
      const lines = [EXTERNAL_NOTE, `Menú ${range}:`];
      let day: string | null = null;
      for (const { e, day: dd } of entries) {
        if (dd !== day) lines.push(`${weekdayDay(dd, today)}:`);
        day = dd;
        const section = sections.get(e.sectionId ?? -1)?.name;
        const prefix = `- ${section ? `${section}: ` : ''}`;
        const done = e.done ? ' (hecho)' : '';
        if (e.type === 'recipe') {
          const r = d.recipes.find((x) => x.id === e.recipeId);
          if (!r) {
            lines.push(
              `${prefix}receta #${e.recipeId ?? NO_DATA} (no está entre las recetas)${done}`,
            );
            continue;
          }
          const { pos, nested } = linkedOf(d, r.id);
          const status = recipeStatus(
            pos.length + nested,
            d.fulfillment.get(r.id),
            outOfStockNames(d, pos),
          );
          lines.push(
            `${prefix}#${r.id} ${displayName(r.name)} · ${servingsText(e.recipeServings)} · ${status.text}${done}`,
          );
        } else if (e.type === 'product') {
          lines.push(
            `${prefix}${productName(d.cat, e.productId)} · ${amountText(e.productAmount, e.productQuId, d.cat)}${done}`,
          );
        } else {
          lines.push(`${prefix}nota: ${safeField(e.note, 200) || NO_DATA}${done}`);
        }
      }
      return lines.join('\n');
    },
  };

  const compra: ConnectorTool = {
    name: 'grocy_compra',
    description:
      'Lista de la compra de Grocy, de solo lectura, agrupada por producto (Grocy puede tener el mismo producto ' +
      'apuntado varias veces).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(args, signal) {
      parseArgs(CompraSchema, args);
      const c = need();
      const [rowsRaw, listsRaw, cat] = await Promise.all([
        c.objects('shopping_list', signal),
        c.objects('shopping_lists', signal),
        loadCatalog(c, signal),
      ]);
      const rows = rowsRaw.map(toShoppingRow);
      if (rows.length === 0) return 'La lista de la compra de Grocy está vacía.';
      const listName = new Map<number, string>();
      for (const l of listsRaw) {
        if (typeof l.id === 'number') listName.set(l.id, safeField(l.name, 60) || `lista #${l.id}`);
      }
      const lines = [EXTERNAL_NOTE];
      const listIds = [...new Set(rows.map((r) => r.listId ?? -1))].sort((x, y) => x - y);
      for (const lid of listIds) {
        const mine = rows.filter((r) => (r.listId ?? -1) === lid);
        const pending = mine.filter((r) => !r.done);
        const done = mine.filter((r) => r.done);
        // Agrupado por producto; las cantidades se suman solo en la misma unidad.
        const byProduct = new Map<
          number,
          { amounts: Map<number | null, number | null>; rows: number; notes: Set<string> }
        >();
        const notes: string[] = [];
        for (const r of pending) {
          if (r.productId === null) {
            const n = safeField(r.note, 200);
            if (n) notes.push(n);
            continue;
          }
          const g = byProduct.get(r.productId) ?? {
            amounts: new Map(),
            rows: 0,
            notes: new Set<string>(),
          };
          const prev = g.amounts.has(r.quId) ? g.amounts.get(r.quId)! : 0;
          g.amounts.set(r.quId, prev === null || r.amount === null ? null : prev + r.amount);
          g.rows += 1;
          const n = safeField(r.note, 80);
          if (n) g.notes.add(n);
          byProduct.set(r.productId, g);
        }
        const name = listName.get(lid) ?? (lid === -1 ? 'sin lista' : `lista #${lid}`);
        lines.push(
          `«${name}»: ${byProduct.size} producto${byProduct.size === 1 ? '' : 's'}${notes.length > 0 ? ` y ${notes.length} nota${notes.length === 1 ? '' : 's'}` : ''} por comprar.`,
        );
        const items = [...byProduct.entries()]
          .map(([pid, g]) => {
            const amounts = [...g.amounts.entries()]
              .map(([qu, amt]) => amountText(amt, qu, cat))
              .join(' + ');
            const times = g.rows > 1 ? ` (apuntado ${g.rows} veces)` : '';
            const n = g.notes.size > 0 ? ` · nota: ${[...g.notes].join('; ')}` : '';
            return {
              name: productName(cat, pid),
              line: `- ${productName(cat, pid)} · ${amounts}${times}${n}`,
            };
          })
          .sort((x, y) => x.name.localeCompare(y.name, 'es'));
        lines.push(...items.map((i) => i.line), ...notes.map((n) => `- nota: ${n}`));
        if (done.length > 0) {
          const doneNames = [
            ...new Set(
              done
                .map((r) => (r.productId === null ? null : productName(cat, r.productId)))
                .filter(Boolean),
            ),
          ];
          lines.push(
            `Ya marcados como comprados: ${doneNames.join(', ') || `${done.length} apuntes`}.`,
          );
        }
      }
      return lines.join('\n');
    },
  };

  const comprobar: ConnectorTool<ToolOutput> = {
    name: 'grocy_comprobar',
    description:
      'Comprobación de la despensa para vigilantes, de solo lectura y en forma estructurada: caducado (caducado o ' +
      'con el consumo preferente pasado), caduca_pronto (vence en los próximos dias) o bajo_minimos. estado es ' +
      '«ninguno» o «hay», y valor, cuántos productos.',
    inputSchema: {
      type: 'object',
      properties: {
        que: { type: 'string', enum: [...CHECK_KINDS], description: 'Qué comprobar.' },
        dias: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_DUE_DAYS,
          description: `Solo con caduca_pronto: días hacia delante (por defecto ${DEFAULT_DUE_DAYS}).`,
        },
      },
      required: ['que'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        estado: { type: 'string' },
        valor: { type: ['number', 'null'] },
        detalle: { type: 'string' },
      },
      required: ['estado', 'valor', 'detalle'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const a = parseArgs(ComprobarSchema, args);
      const c = need();
      const days = a.dias ?? DEFAULT_DUE_DAYS;
      const [vRaw, cat] = await Promise.all([
        c.get('/stock/volatile', { due_soon_days: String(days) }, signal),
        loadCatalog(c, signal),
      ]);
      const v = toVolatile(vRaw);
      let names: string[];
      /** Etiqueta en singular (cero o uno) y en plural. */
      let label: [string, string];
      if (a.que === 'caducado') {
        names = [...v.expired, ...v.overdue].map((e) => productName(cat, e.productId));
        label = [
          'caducado ni con el consumo preferente pasado',
          'caducados o con el consumo preferente pasado',
        ];
      } else if (a.que === 'caduca_pronto') {
        names = v.due.map((e) => productName(cat, e.productId));
        label = [`vence en los próximos ${days} días`, `vencen en los próximos ${days} días`];
      } else {
        names = v.missing.map((m) => {
          const p = m.productId === null ? undefined : cat.products.get(m.productId);
          return p ? displayName(p.name) : displayName(m.name);
        });
        label = ['bajo mínimos', 'bajo mínimos'];
      }
      names = [...new Set(names)];
      const estado = names.length === 0 ? 'ninguno' : 'hay';
      const one = a.que === 'caducado' ? 'caducado o con el consumo preferente pasado' : label[0];
      const detalleFull =
        names.length === 0
          ? `Ningún producto ${label[0]}.`
          : names.length === 1
            ? `1 producto ${one}: ${names[0]}`
            : `${names.length} productos ${label[1]}: ${names.join(', ')}`;
      const detalle =
        detalleFull.length > MAX_DETAIL
          ? `${detalleFull.slice(0, MAX_DETAIL - 1).trimEnd()}…`
          : detalleFull;
      return {
        text: [detalle, `Para vigilantes: estado «${estado}», valor ${names.length}`].join('\n'),
        structured: { estado, valor: names.length, detalle },
      };
    },
  };

  const acceso = accessCheckTool(
    'grocy_acceso',
    'Comprobación de acceso para el diagnóstico, de solo lectura y sin argumentos: llama a la API de Grocy y dice si la clave sigue valiendo (estado «ok», «auth» o «unreachable»). No hace falta usarla salvo que la persona pregunte si la conexión funciona.',
    async (signal) => {
      await need().get('/system/info', undefined, signal);
    },
  );

  return [
    despensa,
    recetas,
    receta,
    menu,
    compra,
    comprobar,
    acceso,
    ...createGrocyWriteTools(need, now),
  ];
}
