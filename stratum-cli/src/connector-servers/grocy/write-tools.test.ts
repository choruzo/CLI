/**
 * Tools de escritura de Grocy (M28 fase 3) contra un Grocy falso **con estado**:
 * existencias y lista de la compra en memoria que los POST modifican, y un
 * registro de cada llamada (método, ruta, consulta y cuerpo).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import { createGrocyTools } from './tools.js';

const KEY = 'clave-SECRETA-123';
const NOW = Date.parse('2026-11-21T10:00:00Z');

type Row = Record<string, unknown>;

function fixture<T = Row[]>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  queryAll: [string, string][];
  body: Row | null;
}

/** Todo lo que sale de una tool (salida o error), para comprobar que la clave nunca sale. */
const SEEN: string[] = [];

function makeWorld(opts: { version?: string | null } = {}) {
  const version = opts.version === undefined ? '4.7.1' : opts.version;
  const world = {
    calls: [] as Call[],
    time: NOW,
    /** Ruta → objeto de respuesta propio (GET) o `() => Response`. */
    over: {} as Record<string, unknown>,
    products: [
      ...fixture('products').map((p) => ({ ...p, default_best_before_days: 0, disable_open: 0 })),
      {
        id: 20,
        name: 'Pollo_asado',
        active: 1,
        location_id: 2,
        qu_id_stock: 2,
        default_best_before_days: 0,
      },
      {
        id: 21,
        name: 'Leche_de_avena',
        active: 1,
        location_id: 2,
        qu_id_stock: 3,
        default_best_before_days: 0,
      },
      {
        id: 22,
        name: 'Tomate triturado',
        active: 1,
        location_id: 3,
        qu_id_stock: 2,
        default_best_before_days: 0,
      },
      {
        id: 23,
        name: 'Fantasma',
        active: 0,
        location_id: 3,
        qu_id_stock: 2,
        default_best_before_days: 0,
      },
    ] as Row[],
    stock: new Map<number, number>(
      fixture('stock').map((s) => [s.product_id as number, s.amount as number]),
    ),
    shopping: fixture('shopping_list').map((r) => ({ ...r })),
    nextRowId: 100,
    tx: 'abc123',
    undone: new Set<string>(),
    stockLog: [{ transaction_id: 'abc123' }] as unknown,
    /** Filas que añade «apuntar lo que falta de una receta». */
    missingRows: [] as Row[],
    noopRemove: false,
    posts: () => world.calls.filter((c) => c.method === 'POST'),
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status });

  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : null;
    world.calls.push({
      method,
      path,
      query: Object.fromEntries(u.searchParams),
      queryAll: [...u.searchParams],
      body,
    });
    const o = world.over[path];
    if (typeof o === 'function') return (o as () => Response)();
    if (path in world.over) return json(o);

    if (method === 'GET') {
      if (path === '/system/info') {
        return json(version === null ? {} : { grocy_version: { Version: version } });
      }
      if (path === '/objects/products') return json(world.products);
      if (path === '/objects/shopping_list') return json(world.shopping);
      if (path === '/objects/stock_log') return json(world.stockLog);
      if (path === '/stock') {
        return json(
          [...world.stock].map(([product_id, amount]) => ({
            product_id,
            amount,
            amount_aggregated: amount,
            is_aggregated_amount: 0,
            amount_opened: 0,
            best_before_date: '2999-12-31',
            due_type: 1,
          })),
        );
      }
      const name = {
        '/objects/quantity_units': 'quantity_units',
        '/objects/locations': 'locations',
        '/objects/product_groups': 'product_groups',
        '/objects/recipes': 'recipes',
        '/objects/recipes_pos': 'recipes_pos',
        '/objects/recipes_nestings': 'recipes_nestings',
        '/objects/meal_plan': 'meal_plan',
        '/objects/meal_plan_sections': 'meal_plan_sections',
        '/objects/shopping_lists': 'shopping_lists',
        '/recipes/fulfillment': 'fulfillment',
      }[path];
      return name ? json(fixture<unknown>(name)) : json({}, 404);
    }

    // POST
    const b = body ?? {};
    let m: RegExpExecArray | null;
    if (path === '/stock/shoppinglist/add-product') {
      const row = world.shopping.find(
        (r) => r.product_id === b.product_id && ((r.shopping_list_id as number) ?? 1) === b.list_id,
      );
      if (row) {
        row.amount = (row.amount as number) + (b.product_amount as number);
        row.note = b.note ?? null;
      } else {
        world.shopping.push({
          id: world.nextRowId++,
          shopping_list_id: b.list_id,
          product_id: b.product_id,
          amount: b.product_amount,
          qu_id: b.qu_id ?? null,
          note: b.note ?? null,
          done: 0,
        });
      }
      return new Response(null, { status: 204 });
    }
    if (path === '/stock/shoppinglist/remove-product') {
      if (world.noopRemove) return new Response(null, { status: 204 });
      // Resta de UNA fila: la primera por id.
      const rows = world.shopping
        .filter((r) => r.product_id === b.product_id)
        .sort((x, y) => (x.id as number) - (y.id as number));
      const row = rows[0];
      if (row) {
        row.amount = (row.amount as number) - (b.product_amount as number);
        if ((row.amount as number) <= 0) world.shopping.splice(world.shopping.indexOf(row), 1);
      }
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/stock\/products\/(\d+)\/(add|consume|open)$/.exec(path))) {
      const pid = Number(m[1]);
      if (m[2] === 'add') world.stock.set(pid, (world.stock.get(pid) ?? 0) + (b.amount as number));
      if (m[2] === 'consume')
        world.stock.set(pid, (world.stock.get(pid) ?? 0) - (b.amount as number));
      return json([{ id: 1, transaction_id: world.tx, product_id: pid }]);
    }
    if ((m = /^\/recipes\/(\d+)\/add-not-fulfilled-products-to-shoppinglist$/.exec(path))) {
      for (const r of world.missingRows) world.shopping.push({ id: world.nextRowId++, ...r });
      return new Response(null, { status: 204 });
    }
    if (/^\/recipes\/\d+\/consume$/.test(path)) return new Response(null, { status: 204 });
    if ((m = /^\/stock\/transactions\/([A-Za-z0-9]+)\/undo$/.exec(path))) {
      if (world.undone.has(m[1]!))
        return json({ error_message: 'Transaction was already undone' }, 400);
      world.undone.add(m[1]!);
      return new Response(null, { status: 204 });
    }
    if (path === '/objects/meal_plan') return json({ created_object_id: 7 });
    return json({}, 404);
  }) as typeof fetch;

  const tools = createGrocyTools({
    fetch: f,
    url: 'http://grocy.casa:9283/api',
    apiKey: KEY,
    now: () => world.time,
  });
  const tool = (name: string): ConnectorTool<never> =>
    tools.find((t) => t.name === name)! as unknown as ConnectorTool<never>;

  /** Llama a una tool y devuelve su texto; un fallo (ToolUserError) lo devuelve como `error`. */
  async function call(
    name: string,
    args: unknown,
  ): Promise<{ text: string; error: string | null }> {
    try {
      const out = (await (tool(name).handler as (a: unknown) => Promise<unknown>)(args)) as
        | string
        | { text: string };
      const text = typeof out === 'string' ? out : out.text;
      SEEN.push(text);
      return { text, error: null };
    } catch (err) {
      expect(err).toBeInstanceOf(ToolUserError);
      const msg = (err as Error).message;
      SEEN.push(msg);
      return { text: '', error: msg };
    }
  }

  return { world, tools, call };
}

const WRITE_TOOLS = [
  'grocy_compra_apuntar',
  'grocy_compra_quitar',
  'grocy_compra_receta',
  'grocy_despensa_anadir',
  'grocy_despensa_consumir',
  'grocy_despensa_abrir',
  'grocy_receta_cocinar',
  'grocy_menu_anadir',
  'grocy_deshacer',
];
const VALID_ARGS: Record<string, unknown> = {
  grocy_compra_apuntar: { producto: 1 },
  grocy_compra_quitar: { producto: 1 },
  grocy_compra_receta: { receta: 4 },
  grocy_despensa_anadir: { producto: 1, cantidad: 1, caducidad: 'no caduca' },
  grocy_despensa_consumir: { producto: 1, cantidad: 1 },
  grocy_despensa_abrir: { producto: 1 },
  grocy_receta_cocinar: { receta: 1 },
  grocy_menu_anadir: { dia: 'hoy', receta: 1 },
  grocy_deshacer: { transaccion: 'abc123' },
};
const PRODUCT = (id: number) => (w: ReturnType<typeof makeWorld>) =>
  w.world.products.find((p) => p.id === id)!;

describe('versión y configuración', () => {
  it('Grocy 3.x: ninguna tool de escritura escribe, y dicen por qué', async () => {
    const w = makeWorld({ version: '3.3.2' });
    for (const name of WRITE_TOOLS.filter((n) => n !== 'grocy_deshacer')) {
      const r = await w.call(name, VALID_ARGS[name]);
      expect(r.error, name).toContain('solo escribe en Grocy 4.x');
      expect(r.error).toContain('3.3.2');
    }
    expect(w.world.posts()).toHaveLength(0);
  });

  it('sin grocy_version tampoco se escribe', async () => {
    const w = makeWorld({ version: null });
    const r = await w.call('grocy_compra_apuntar', { producto: 1 });
    expect(r.error).toContain('solo escribe en Grocy 4.x');
    expect(r.error).toContain('versión desconocida');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('con 4.7.1 la versión se consulta una vez y se renueva a los 5 minutos', async () => {
    const w = makeWorld();
    await w.call('grocy_despensa_abrir', { producto: 1 });
    await w.call('grocy_despensa_abrir', { producto: 1 });
    const infos = () => w.world.calls.filter((c) => c.path === '/system/info');
    expect(infos()).toHaveLength(1);
    w.world.time += 5 * 60_000;
    await w.call('grocy_despensa_abrir', { producto: 1 });
    expect(infos()).toHaveLength(2);
  });

  it('sin configurar, las nueve dicen que Grocy no está configurado', async () => {
    let called = 0;
    const tools = createGrocyTools({
      fetch: (async () => {
        called += 1;
        return new Response('[]');
      }) as typeof fetch,
    });
    for (const name of WRITE_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      let msg = '';
      try {
        await t.handler(VALID_ARGS[name]);
      } catch (err) {
        expect(err).toBeInstanceOf(ToolUserError);
        msg = (err as Error).message;
      }
      expect(msg, name).toContain('Grocy no está configurado');
    }
    expect(called).toBe(0);
  });

  it('ninguna es de solo lectura según su descripción de entrada: argumentos de más son inválidos', async () => {
    const w = makeWorld();
    for (const name of WRITE_TOOLS) {
      const r = await w.call(name, { ...(VALID_ARGS[name] as object), foo: 1 });
      expect(r.error, name).toMatch(/^Argumento inválido/);
    }
    expect(w.world.calls).toHaveLength(0);
  });
});

describe('búsqueda de producto', () => {
  it('por id, por nombre y con el exacto ganando al que lo contiene', async () => {
    const w = makeWorld();
    for (const producto of [7, 'pollo', 'POLLO', '#7']) {
      const r = await w.call('grocy_despensa_abrir', { producto });
      expect(r.text, String(producto)).toContain('Marcado como abierto: Pollo ·');
    }
    // «leche» también está dentro de «Leche de avena», pero gana el exacto.
    const leche = await w.call('grocy_despensa_abrir', { producto: 'leche' });
    expect(leche.text).toContain('Marcado como abierto: Leche ·');
    expect(w.world.posts().every((p) => /\/products\/(7|1)\/open$/.test(p.path))).toBe(true);
  });

  it('un nombre ambiguo da los candidatos y no escribe', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_despensa_abrir', { producto: 'tomate' });
    expect(r.error).toContain('Hay 2 productos que casan con «tomate»');
    expect(r.error).toContain('- #6 Tomate frito');
    expect(r.error).toContain('- #22 Tomate triturado');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('un producto inexistente es un error; uno inactivo no se encuentra', async () => {
    const w = makeWorld();
    expect((await w.call('grocy_despensa_abrir', { producto: 'zzz' })).error).toContain(
      'No hay ningún producto en Grocy que se llame «zzz»',
    );
    expect((await w.call('grocy_despensa_abrir', { producto: 999 })).error).toContain(
      'No hay ningún producto activo con id 999',
    );
    expect((await w.call('grocy_despensa_abrir', { producto: 23 })).error).toContain(
      'No hay ningún producto activo con id 23',
    );
    expect((await w.call('grocy_despensa_abrir', { producto: 'fantasma' })).error).toContain(
      'se llame «fantasma»',
    );
    expect(w.world.posts()).toHaveLength(0);
  });
});

describe('grocy_compra_apuntar', () => {
  it('manda producto, la lista de id menor, cantidad y la unidad del producto', async () => {
    const w = makeWorld();
    w.world.over['/objects/shopping_lists'] = [
      { id: 5, name: 'Otra' },
      { id: 2, name: 'Principal' },
    ];
    const r = await w.call('grocy_compra_apuntar', { producto: 'nata cocina' });
    expect(w.world.posts()).toHaveLength(1);
    expect(w.world.posts()[0]!.path).toBe('/stock/shoppinglist/add-product');
    // Sin fila previa y sin nota: no se manda `note`.
    expect(w.world.posts()[0]!.body).toEqual({
      product_id: 2,
      list_id: 2,
      product_amount: 1,
      qu_id: 2,
    });
    expect(r.text).toContain('Apuntado en «Principal»: Nata cocina · 1 Piece.');
    expect(r.text).toContain('Ahora hay en la lista: 1 Piece.');
  });

  it('sin nota reenvía la de la fila existente; con nota, la nueva', async () => {
    const w = makeWorld();
    const keep = await w.call('grocy_compra_apuntar', { producto: 'agua', cantidad: 2 });
    expect(w.world.posts()[0]!.body).toEqual({
      product_id: 5,
      list_id: 1,
      product_amount: 2,
      qu_id: 2,
      note: 'con gas',
    });
    expect(keep.text).toContain('Ahora hay en la lista: 8 Pieces.');
    await w.call('grocy_compra_apuntar', { producto: 'agua', nota: 'sin gas' });
    expect(w.world.posts()[1]!.body).toMatchObject({ note: 'sin gas' });
    const again = await w.call('grocy_compra_apuntar', { producto: 'agua', cantidad: 1 });
    expect(w.world.posts()[2]!.body).toMatchObject({ note: 'sin gas' });
    expect(again.text).toContain('Ahora hay en la lista: 10 Pieces.');
  });

  it('valida la cantidad', async () => {
    const w = makeWorld();
    for (const cantidad of [0, -1, 1001]) {
      expect((await w.call('grocy_compra_apuntar', { producto: 1, cantidad })).error).toMatch(
        /^Argumento inválido/,
      );
    }
    expect(w.world.posts()).toHaveLength(0);
  });
});

describe('grocy_compra_quitar', () => {
  it('sin cantidad quita hasta vaciarlo, una fila por llamada', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_quitar', { producto: 'leche' });
    const posts = w.world.posts();
    expect(posts).toHaveLength(5);
    for (const p of posts) {
      expect(p.path).toBe('/stock/shoppinglist/remove-product');
      expect(p.body).toEqual({ product_id: 1, list_id: 1, product_amount: 1 });
    }
    expect(r.text).toContain('Quitado de la lista: Leche · 5 Packs.');
    expect(r.text).toContain('Ya no está en la lista.');
    expect(w.world.shopping.some((x) => x.product_id === 1)).toBe(false);
  });

  it('con cantidad: 2 quedan 3 y nunca quita más de lo pedido', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_quitar', { producto: 'leche', cantidad: 2 });
    const asked = w.world.posts().reduce((n, p) => n + (p.body!.product_amount as number), 0);
    expect(asked).toBe(2);
    expect(r.text).toContain('Quitado de la lista: Leche · 2 Packs.');
    expect(r.text).toContain('Queda en la lista: 3 Packs.');
    const left = w.world.shopping
      .filter((x) => x.product_id === 1)
      .reduce((n, x) => n + (x.amount as number), 0);
    expect(left).toBe(3);
  });

  it('una cantidad mayor que la apuntada quita solo lo que hay', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_quitar', { producto: 'leche', cantidad: 100 });
    const asked = w.world.posts().reduce((n, p) => n + (p.body!.product_amount as number), 0);
    expect(asked).toBe(5);
    expect(r.text).toContain('Ya no está en la lista.');
  });

  it('en filas de dos listas es un error y no se toca nada', async () => {
    const w = makeWorld();
    w.world.shopping.push({
      id: 99,
      shopping_list_id: 2,
      product_id: 1,
      amount: 1,
      qu_id: 3,
      note: null,
      done: 0,
    });
    const r = await w.call('grocy_compra_quitar', { producto: 'leche' });
    expect(r.error).toContain('más de una lista de la compra');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('en unidades distintas con cantidad es un error', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_quitar', { producto: 'pollo', cantidad: 1 });
    expect(r.error).toContain('unidades distintas');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('un producto que no está en la lista no escribe', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_quitar', { producto: 'nata cocina' });
    expect(r.text).toContain('Nata cocina no está en la lista de la compra.');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('si Grocy no quita nada, lo dice en vez de repetir sin fin', async () => {
    const w = makeWorld();
    w.world.noopRemove = true;
    const r = await w.call('grocy_compra_quitar', { producto: 'leche' });
    expect(r.error).toContain('Grocy no quitó nada');
    expect(w.world.posts()).toHaveLength(1);
  });
});

describe('grocy_compra_receta', () => {
  it('sin ingredientes enlazados es un error y no escribe', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_receta', { receta: 3 });
    expect(r.error).toContain('no tiene ingredientes enlazados');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('si ya se puede hacer, no falta nada y no escribe', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_receta', { receta: 1 });
    expect(r.text).toContain('no falta nada');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('si lo que falta ya está en la lista, no escribe', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_receta', { receta: 2 });
    expect(r.text).toContain('ya está en la lista de la compra');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('con faltas llama a Grocy y lista lo añadido', async () => {
    const w = makeWorld();
    w.world.missingRows = [
      { shopping_list_id: 1, product_id: 12, amount: 3, qu_id: 2, note: null, done: 0 },
    ];
    const r = await w.call('grocy_compra_receta', { receta: 4 });
    expect(w.world.posts()).toHaveLength(1);
    expect(w.world.posts()[0]!.path).toBe('/recipes/4/add-not-fulfilled-products-to-shoppinglist');
    expect(r.text).toContain('lo que falta para #4 Pollo al horno');
    expect(r.text).toContain('- Patatas · +3 Pieces');
  });

  it('si Grocy no añade nada, lo dice', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_compra_receta', { receta: 4 });
    expect(r.text).toContain('Grocy no añadió nada nuevo');
  });
});

describe('grocy_despensa_anadir', () => {
  it('sin caducidad y sin días por defecto pide la fecha y no escribe', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_despensa_anadir', { producto: 'leche', cantidad: 2 });
    expect(r.error).toContain('Pregunta la fecha de consumo');
    expect(r.error).toContain('No ha cambiado nada');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('«no caduca» manda 2999-12-31, siempre como compra y con la ubicación del producto', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_despensa_anadir', {
      producto: 'leche',
      cantidad: 2,
      caducidad: 'no caduca',
    });
    expect(w.world.posts()).toHaveLength(1);
    expect(w.world.posts()[0]!.path).toBe('/stock/products/1/add');
    expect(w.world.posts()[0]!.body).toEqual({
      amount: 2,
      transaction_type: 'purchase',
      best_before_date: '2999-12-31',
      location_id: 2,
    });
    expect(r.text).toContain('Añadido a la despensa: Leche · 2 Packs · no caduca · Fridge.');
    expect(r.text).toContain('Ahora hay: 6 Packs.');
    expect(r.text).toContain('Transacción abc123');
  });

  it('default_best_before_days -1 sin caducidad manda 2999-12-31', async () => {
    const w = makeWorld();
    PRODUCT(1)(w).default_best_before_days = -1;
    await w.call('grocy_despensa_anadir', { producto: 1, cantidad: 1 });
    expect(w.world.posts()[0]!.body).toMatchObject({ best_before_date: '2999-12-31' });
  });

  it('con días por defecto > 0 no manda fecha: la pone Grocy', async () => {
    const w = makeWorld();
    PRODUCT(1)(w).default_best_before_days = 7;
    const r = await w.call('grocy_despensa_anadir', { producto: 1, cantidad: 1 });
    expect(w.world.posts()[0]!.body).toEqual({
      amount: 1,
      transaction_type: 'purchase',
      location_id: 2,
    });
    expect(r.text).toContain('días por defecto del producto');
  });

  it('una fecha válida y el precio se mandan tal cual', async () => {
    const w = makeWorld();
    await w.call('grocy_despensa_anadir', {
      producto: 1,
      cantidad: 1,
      caducidad: '2026-12-01',
      precio: 1.2,
    });
    expect(w.world.posts()[0]!.body).toMatchObject({ best_before_date: '2026-12-01', price: 1.2 });
  });

  it('una fecha que no vale es inválida y no escribe', async () => {
    const w = makeWorld();
    for (const caducidad of ['2026-02-30', 'mañana', '2026-1-5', '']) {
      const r = await w.call('grocy_despensa_anadir', { producto: 1, cantidad: 1, caducidad });
      expect(r.error, caducidad).toMatch(/^Argumento inválido/);
    }
    expect(w.world.posts()).toHaveLength(0);
  });

  it('ubicacion pisa la del producto; una inexistente es un error', async () => {
    const w = makeWorld();
    await w.call('grocy_despensa_anadir', {
      producto: 'leche',
      cantidad: 1,
      caducidad: 'no caduca',
      ubicacion: 'trastero',
    });
    expect(w.world.posts()[0]!.body).toMatchObject({ location_id: 3 });
    const bad = await w.call('grocy_despensa_anadir', {
      producto: 'leche',
      cantidad: 1,
      caducidad: 'no caduca',
      ubicacion: 'bodega',
    });
    expect(bad.error).toContain('No hay ninguna ubicación «bodega»');
    expect(bad.error).toContain('Fridge, Trastero');
    expect(w.world.posts()).toHaveLength(1);
  });

  it('sin la transacción en la respuesta, dice que no se puede deshacer', async () => {
    const w = makeWorld();
    w.world.over['/stock/products/1/add'] = () => new Response('[]');
    const r = await w.call('grocy_despensa_anadir', {
      producto: 1,
      cantidad: 1,
      caducidad: 'no caduca',
    });
    expect(r.text).toContain('no se puede deshacer desde aquí');
  });
});

describe('grocy_despensa_consumir', () => {
  it('más de lo que hay es un error y no escribe', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_despensa_consumir', { producto: 'leche', cantidad: 9 });
    expect(r.error).toContain('Solo hay 4 Packs de Leche');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('consume y dice lo que queda', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_despensa_consumir', { producto: 'leche', cantidad: 1 });
    expect(w.world.posts()[0]!.path).toBe('/stock/products/1/consume');
    expect(w.world.posts()[0]!.body).toEqual({
      amount: 1,
      spoiled: false,
      transaction_type: 'consume',
    });
    expect(r.text).toContain('Consumido: Leche · 1 Pack.');
    expect(r.text).toContain('Queda: 3 Packs.');
    expect(r.text).toContain('Transacción abc123');
  });

  it('estropeado: true se manda como spoiled y se dice', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_despensa_consumir', {
      producto: 'leche',
      cantidad: 1,
      estropeado: true,
    });
    expect(w.world.posts()[0]!.body).toMatchObject({ spoiled: true });
    expect(r.text).toContain('Tirado por estropeado: Leche · 1 Pack.');
  });

  it('un producto sin existencias no se puede consumir', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_despensa_consumir', { producto: 'tomate frito', cantidad: 1 });
    expect(r.error).toContain('Solo hay 0 Pieces de Tomate frito');
    expect(w.world.posts()).toHaveLength(0);
  });
});

describe('grocy_despensa_abrir', () => {
  it('un producto que no se puede abrir es un error y no escribe', async () => {
    const w = makeWorld();
    PRODUCT(1)(w).disable_open = 1;
    const r = await w.call('grocy_despensa_abrir', { producto: 'leche' });
    expect(r.error).toContain('no se puede abrir en Grocy');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('por defecto abre 1', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_despensa_abrir', { producto: 'leche' });
    expect(w.world.posts()[0]!.path).toBe('/stock/products/1/open');
    expect(w.world.posts()[0]!.body).toEqual({ amount: 1 });
    expect(r.text).toContain('Marcado como abierto: Leche · 1 Pack.');
    expect(r.text).toContain('Transacción abc123');
    await w.call('grocy_despensa_abrir', { producto: 'leche', cantidad: 2 });
    expect(w.world.posts()[1]!.body).toEqual({ amount: 2 });
  });
});

describe('grocy_receta_cocinar', () => {
  it('sin ingredientes enlazados es un error, aunque Grocy diga que hay de todo', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_receta_cocinar', { receta: 3 });
    expect(r.error).toContain('no tiene ingredientes enlazados');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('con faltas es un error y no escribe', async () => {
    const w = makeWorld();
    for (const receta of [2, 4]) {
      const r = await w.call('grocy_receta_cocinar', { receta });
      expect(r.error, String(receta)).toContain('No la marco como cocinada');
    }
    expect(w.world.posts()).toHaveLength(0);
  });

  it('cocinable: consume y busca la transacción en stock_log', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_receta_cocinar', { receta: 1 });
    expect(w.world.posts()).toHaveLength(1);
    expect(w.world.posts()[0]!.path).toBe('/recipes/1/consume');
    const log = w.world.calls.find((c) => c.path === '/objects/stock_log')!;
    expect(log.method).toBe('GET');
    expect(log.queryAll.filter(([k]) => k === 'query[]').map(([, v]) => v)).toEqual([
      'recipe_id=1',
      'undone=0',
    ]);
    expect(log.query.order).toBe('id:desc');
    expect(log.query.limit).toBe('1');
    expect(r.text).toContain('Cocinada: #1 Espaguetis con nata');
    expect(r.text).toContain('Transacción abc123');
    expect(r.text).not.toContain('no deja deshacerlo');
  });

  it('si stock_log falla, la receta queda cocinada pero sin deshacer', async () => {
    const w = makeWorld();
    w.world.over['/objects/stock_log'] = () => new Response('{}', { status: 500 });
    const r = await w.call('grocy_receta_cocinar', { receta: 1 });
    expect(r.error).toBeNull();
    expect(r.text).toContain('Cocinada: #1');
    expect(r.text).toContain('no se puede deshacer desde aquí');
  });

  it('una receta que produce un producto avisa de que eso no se deshace', async () => {
    const w = makeWorld();
    w.world.over['/objects/recipes'] = (fixture('recipes') as Row[]).map((r) =>
      r.id === 1 ? { ...r, product_id: 6 } : r,
    );
    const r = await w.call('grocy_receta_cocinar', { receta: 1 });
    expect(r.text).toContain('Además añade Tomate frito a la despensa');
    expect(r.text).toContain('no deja deshacerlo');
  });
});

describe('grocy_menu_anadir', () => {
  it('manda día, receta, raciones de la receta y la sección sin nombre', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_menu_anadir', { dia: 'hoy', receta: 1 });
    expect(w.world.posts()).toHaveLength(1);
    expect(w.world.posts()[0]!.path).toBe('/objects/meal_plan');
    expect(w.world.posts()[0]!.body).toEqual({
      day: '2026-11-21',
      type: 'recipe',
      recipe_id: 1,
      recipe_servings: 2,
      section_id: -1,
    });
    expect(r.text).toContain(
      'Añadida al menú del 2026-11-21: #1 Espaguetis con nata · 2 raciones.',
    );
  });

  it('«mañana» con el reloj fijo es 2026-11-22; raciones pisa las de la receta', async () => {
    const w = makeWorld();
    await w.call('grocy_menu_anadir', { dia: 'mañana', receta: 'espaguetis', raciones: 4 });
    expect(w.world.posts()[0]!.body).toMatchObject({ day: '2026-11-22', recipe_servings: 4 });
    await w.call('grocy_menu_anadir', { dia: '2026-12-01', receta: 1 });
    expect(w.world.posts()[1]!.body).toMatchObject({ day: '2026-12-01' });
  });

  it('seccion busca por nombre; una inexistente es un error', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_menu_anadir', { dia: 'hoy', receta: 1, seccion: 'comida' });
    expect(w.world.posts()[0]!.body).toMatchObject({ section_id: 5 });
    expect(r.text).toContain('(Comida)');
    const bad = await w.call('grocy_menu_anadir', { dia: 'hoy', receta: 1, seccion: 'cena' });
    expect(bad.error).toContain('No hay ninguna sección «cena»');
    expect(w.world.posts()).toHaveLength(1);
  });

  it('un día que no es hoy, mañana ni fecha válida es inválido', async () => {
    const w = makeWorld();
    for (const dia of ['ayer', '2026-02-30']) {
      expect((await w.call('grocy_menu_anadir', { dia, receta: 1 })).error, dia).toMatch(
        /^Argumento inválido/,
      );
    }
    expect(w.world.posts()).toHaveLength(0);
  });

  it('una receta inexistente es un error', async () => {
    const w = makeWorld();
    expect((await w.call('grocy_menu_anadir', { dia: 'hoy', receta: 99 })).error).toContain(
      'No hay ninguna receta con id 99',
    );
    expect(w.world.posts()).toHaveLength(0);
  });
});

describe('grocy_deshacer', () => {
  it('una transacción que no salió de este conjunto de tools es un error y no escribe', async () => {
    const w = makeWorld();
    const r = await w.call('grocy_deshacer', { transaccion: 'abc123' });
    expect(r.error).toContain('Solo deshago cambios que hice yo');
    expect(w.world.posts()).toHaveLength(0);
  });

  it('deshace lo que hizo el conector, y solo una vez', async () => {
    const w = makeWorld();
    await w.call('grocy_despensa_anadir', { producto: 1, cantidad: 1, caducidad: 'no caduca' });
    const r = await w.call('grocy_deshacer', { transaccion: 'abc123' });
    const undo = w.world.posts().at(-1)!;
    expect(undo.path).toBe('/stock/transactions/abc123/undo');
    expect(r.text).toContain('Deshecho en Grocy');
    expect(r.text).toContain('abc123');
    const n = w.world.posts().length;
    const again = await w.call('grocy_deshacer', { transaccion: 'abc123' });
    expect(again.error).toContain('Solo deshago cambios que hice yo');
    expect(w.world.posts()).toHaveLength(n);
  });

  it('un id con caracteres raros es inválido', async () => {
    const w = makeWorld();
    for (const transaccion of ['a/b', '../x', 'a b', '', 'x'.repeat(41), 'a%2Fb']) {
      expect((await w.call('grocy_deshacer', { transaccion })).error, transaccion).toMatch(
        /^Argumento inválido/,
      );
    }
    expect(w.world.calls).toHaveLength(0);
  });
});

describe('la clave', () => {
  it('ningún mensaje de ninguna tool la contiene, ni siquiera el de un error de Grocy que la repite', async () => {
    const w = makeWorld();
    w.world.over['/stock/products/1/consume'] = () =>
      new Response(JSON.stringify({ error_message: `fallo con ${KEY}` }), { status: 400 });
    const r = await w.call('grocy_despensa_consumir', { producto: 1, cantidad: 1 });
    expect(r.error).toContain('fallo con ***');
    expect(SEEN.length).toBeGreaterThan(50);
    for (const s of SEEN) expect(s).not.toContain(KEY);
  });
});
