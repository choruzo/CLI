/**
 * Cliente WebDriver (W3C) mínimo para la suite E2E (D7): lo justo para hablar
 * con tauri-driver sin arrastrar webdriverio y sus cientos de dependencias.
 * Cada método es una petición HTTP del protocolo.
 */

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export class WebDriverError extends Error {}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.value?.error) {
    const v = json.value ?? {};
    throw new WebDriverError(`${method} ${path}: ${v.error ?? res.status} ${v.message ?? ''}`.trim());
  }
  return json.value;
}

export class Session {
  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  /** Abre la app (tauri-driver la lanza) y devuelve la sesión. */
  static async create(driverUrl, application, timeoutMs = 60_000) {
    const started = Date.now();
    let lastError;
    // tauri-driver tarda un poco en escuchar tras lanzarse.
    while (Date.now() - started < timeoutMs) {
      try {
        const value = await call(driverUrl, 'POST', '/session', {
          capabilities: {
            alwaysMatch: { 'tauri:options': { application } },
          },
        });
        return new Session(driverUrl, value.sessionId);
      } catch (err) {
        lastError = err;
        if (!(err instanceof TypeError)) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw lastError;
  }

  #call(method, path, body) {
    return call(this.base, method, `/session/${this.id}${path}`, body);
  }

  async close() {
    await this.#call('DELETE', '').catch(() => undefined);
  }

  /** Ejecuta JS en la página. `args` llegan como `arguments[i]`. */
  execute(script, ...args) {
    return this.#call('POST', '/execute/sync', { script, args });
  }

  async find(css) {
    const v = await this.#call('POST', '/element', { using: 'css selector', value: css });
    return v[ELEMENT];
  }

  async findAll(css) {
    const v = await this.#call('POST', '/elements', { using: 'css selector', value: css });
    return v.map((e) => e[ELEMENT]);
  }

  click(el) {
    return this.#call('POST', `/element/${el}/click`, {});
  }

  /** Teclea de verdad (eventos de teclado): React ve cada cambio. */
  type(el, text) {
    return this.#call('POST', `/element/${el}/value`, { text });
  }

  /** Doble clic de ratón (API de acciones) en el centro del elemento. */
  async doubleClick(el) {
    await this.#call('POST', '/actions', {
      actions: [
        {
          type: 'pointer',
          id: 'raton',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', origin: { [ELEMENT]: el }, x: 0, y: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    await this.#call('DELETE', '/actions');
  }

  clear(el) {
    return this.#call('POST', `/element/${el}/clear`, {});
  }

  text(el) {
    return this.#call('GET', `/element/${el}/text`);
  }

  attribute(el, name) {
    return this.#call('GET', `/element/${el}/attribute/${name}`);
  }

  screenshot() {
    return this.#call('GET', '/screenshot');
  }

  /** Espera a que `fn` devuelva algo verdadero y lo devuelve. */
  async waitFor(fn, { timeout = 20_000, interval = 200, message = 'condición' } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
      try {
        last = await fn();
        if (last) return last;
      } catch (err) {
        last = err;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Tiempo agotado esperando ${message} (último: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
  }

  /** Espera a un elemento visible por CSS. */
  waitForElement(css, opts = {}) {
    return this.waitFor(
      async () => {
        const [el] = await this.findAll(css);
        return el ?? null;
      },
      { message: css, ...opts },
    );
  }

  /**
   * Botón (o enlace) por su texto o nombre accesible, en el DOM actual. Con
   * `contains`, basta con que el texto lo incluya.
   */
  async button(name, { contains = false } = {}) {
    const found = await this.execute(
      `const [name, contains] = arguments;
       const all = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="option"]')];
       const matches = (t) => (contains ? t.includes(name) : t === name);
       const el = all.find((b) => !b.closest('[inert]') && !b.disabled && (matches((b.getAttribute('aria-label') || '').trim()) || matches(b.textContent.trim())));
       if (!el) return null;
       el.setAttribute('data-e2e-target', '1');
       return true;`,
      name,
      contains,
    );
    if (!found) return null;
    const el = await this.find('[data-e2e-target="1"]');
    await this.execute(`document.querySelector('[data-e2e-target="1"]')?.removeAttribute('data-e2e-target')`);
    return el;
  }

  async clickButton(name, { contains = false, ...opts } = {}) {
    const el = await this.waitFor(() => this.button(name, { contains }), {
      message: `botón «${name}»`,
      ...opts,
    });
    await this.click(el);
  }

  /** Texto visible de toda la página (para asserts gruesos). */
  bodyText() {
    return this.execute('return document.body.innerText');
  }

  waitForText(text, opts = {}) {
    return this.waitFor(async () => (await this.bodyText()).includes(text), {
      message: `el texto «${text}»`,
      ...opts,
    });
  }
}
