/**
 * Scripts **fijos** que Stratum evalúa en la página (el modelo no aporta código
 * aquí; para eso está `browser_eval`, que es mutante y se veta en read-only).
 *
 * Van como texto, no como funciones convertidas con `toString()`: el bundler
 * puede reescribir una función (nombres, helpers) y el texto que llegase a la
 * página ya no sería el que se lee aquí.
 *
 * Las referencias (`e12`) viven en un objeto no enumerable de la página
 * (`__stratumBrowser`): un elemento conserva la suya entre instantáneas, y solo
 * valen las de la última (las demás se olvidan al tomar otra).
 */

/** Gramática cerrada de teclas: nombres combinados con `+`, separados por espacios. */
export const KEYS_RE = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*( [A-Za-z0-9]+(\+[A-Za-z0-9]+)*)*$/;

/** Una referencia de la instantánea: `e` y un número. */
export const REF_RE = /^e[1-9][0-9]{0,6}$/;

const STATE = `
  const S = (() => {
    const existing = Object.getOwnPropertyDescriptor(window, '__stratumBrowser');
    if (existing && existing.value && existing.value.byEl instanceof WeakMap) return existing.value;
    const state = { next: 1, byEl: new WeakMap(), byRef: new Map() };
    Object.defineProperty(window, '__stratumBrowser', { value: state, enumerable: false });
    return state;
  })();`;

/**
 * Instantánea accesible y acotada de la página: encabezados, texto visible
 * recortado y los elementos con los que se puede interactuar, cada uno con su
 * referencia. El valor de un `input[type=password]` no sale nunca.
 * Recibe el tope de caracteres; devuelve `{ title, url, text, truncated, refs }`.
 */
export const SNAPSHOT_SCRIPT = `(maxChars) => {${STATE}
  S.byRef = new Map();
  const out = [];
  let size = 0;
  let truncated = false;
  const push = (line) => {
    if (truncated || !line) return;
    if (size + line.length + 1 > maxChars) { truncated = true; return; }
    out.push(line);
    size += line.length + 1;
  };
  const clip = (value, n) => {
    const s = String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s;
  };
  const q = (s) => JSON.stringify(s);
  const visible = (el) => {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return el.getClientRects().length > 0;
  };
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable="true"],[onclick],' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=textbox],[role=combobox],[role=option]';
  const refOf = (el) => {
    let r = S.byEl.get(el);
    if (!r) { r = 'e' + S.next++; S.byEl.set(el, r); }
    S.byRef.set(r, new WeakRef(el));
    return r;
  };
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (text.trim()) return text;
    }
    if (el.labels && el.labels.length > 0) return el.labels[0].innerText;
    return '';
  };
  const roleOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };
  const describe = (el, role) => {
    const tag = el.tagName;
    const type = tag === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    const secret = type === 'password';
    let name = labelOf(el) || el.getAttribute('title') || '';
    if (!name && role !== 'textbox') name = el.innerText || '';
    if (!name && tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) name = el.value;
    if (!name) name = el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || '';
    let line = '[' + refOf(el) + '] ' + role + ' ' + q(clip(name, 80));
    if (role === 'link') line += ' href=' + q(clip(el.getAttribute('href') || '', 200));
    if (tag === 'INPUT' && type !== 'text' && role !== 'button') line += ' type=' + type;
    if (role === 'textbox') {
      if (secret) line += ' (password)';
      else if (tag === 'INPUT' || tag === 'TEXTAREA') { if (el.value) line += ' value=' + q(clip(el.value, 100)); }
      else if (el.innerText) line += ' value=' + q(clip(el.innerText, 100));
      const ph = el.getAttribute('placeholder');
      if (ph && ph !== name) line += ' placeholder=' + q(clip(ph, 60));
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const checked = 'checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (checked) line += ' checked';
    }
    if (tag === 'SELECT') {
      const selected = el.selectedOptions && el.selectedOptions[0];
      if (selected) line += ' value=' + q(clip(selected.text, 80));
      const options = Array.from(el.options).slice(0, 12).map((o) => clip(o.text, 40));
      if (options.length > 0) line += ' options=' + q(options.join(' | ') + (el.options.length > 12 ? ' | \\u2026' : ''));
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
    return line;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'svg', 'SVG', 'IFRAME']);
  const walk = (root) => {
    for (const node of root.childNodes) {
      if (truncated) return;
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (parent && visible(parent)) push(clip(node.textContent, 300));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node;
      if (SKIP.has(el.tagName)) continue;
      if (!visible(el)) continue;
      if (el.matches(INTERACTIVE)) {
        const role = roleOf(el);
        if (role) push(describe(el, role));
        continue;
      }
      const heading = /^H([1-6])$/.exec(el.tagName);
      const nested = el.querySelector(INTERACTIVE) !== null || el.shadowRoot;
      if (heading && !nested) { push('#'.repeat(Number(heading[1])) + ' ' + clip(el.innerText, 200)); continue; }
      if (!nested) { push(clip(el.innerText, 300)); continue; }
      walk(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  if (document.body) walk(document.body);
  return { title: document.title, url: location.href, text: out.join('\\n'), truncated, refs: S.byRef.size };
}`;

/**
 * Localiza la referencia, la trae a la vista y devuelve el centro de su caja
 * (para pulsar con el ratón de verdad). Una caja vacía se pulsa con `click()`.
 */
export const LOCATE_SCRIPT = `(ref) => {${STATE}
  const weak = S.byRef.get(ref);
  const el = weak && weak.deref();
  if (!el || !el.isConnected) return { ok: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) { el.click(); return { ok: true, clicked: true }; }
  return { ok: true, clicked: false, x: r.left + r.width / 2, y: r.top + r.height / 2 };
}`;

/**
 * Enfoca la referencia y selecciona su contenido, para que el texto que se
 * escriba después lo sustituya. `editable: false` si no admite texto.
 */
export const FOCUS_SCRIPT = `(ref) => {${STATE}
  const weak = S.byRef.get(ref);
  const el = weak && weak.deref();
  if (!el || !el.isConnected) return { ok: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    if (typeof el.select === 'function') el.select();
    return { ok: true, editable: !el.disabled && !el.readOnly };
  }
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { ok: true, editable: true };
  }
  return { ok: true, editable: false };
}`;

/** Invoca un script fijo con un argumento serializado (validado antes). */
export function invoke(script: string, arg: string | number): string {
  return `(${script})(${JSON.stringify(arg)})`;
}

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

const MODIFIERS: Record<string, { key: string; code: string; keyCode: number; bit: number }> = {
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, bit: 1 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17, bit: 2 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17, bit: 2 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, bit: 4 },
  cmd: { key: 'Meta', code: 'MetaLeft', keyCode: 91, bit: 4 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, bit: 8 },
};

function keyOf(name: string): KeyDefinition | null {
  const lower = name.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return named;
  const fn = /^f([1-9]|1[0-2])$/.exec(lower);
  if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]) };
  if (/^[a-z]$/.test(lower)) {
    return {
      key: lower,
      code: `Key${lower.toUpperCase()}`,
      keyCode: lower.toUpperCase().charCodeAt(0),
      text: lower,
    };
  }
  if (/^[0-9]$/.test(lower)) {
    return { key: lower, code: `Digit${lower}`, keyCode: lower.charCodeAt(0), text: lower };
  }
  return null;
}

export interface KeyChord {
  modifiers: Array<{ key: string; code: string; keyCode: number }>;
  /** Máscara de modificadores de CDP (Alt=1, Ctrl=2, Meta=4, Shift=8). */
  mask: number;
  key: KeyDefinition;
}

/**
 * Parsea `"ctrl+a Backspace"` en acordes. `null` con el primer nombre que no
 * se conoce: la gramática es cerrada.
 */
export function parseKeys(
  keys: string,
): { ok: true; chords: KeyChord[] } | { ok: false; error: string } {
  const text = keys.trim();
  if (!KEYS_RE.test(text)) {
    return {
      ok: false,
      error:
        `"${keys}" is not a key sequence: use key names joined with "+" and separated by spaces ` +
        '(e.g. "Enter", "Tab", "ctrl+a Backspace", "shift+Tab", "ArrowDown").',
    };
  }
  const chords: KeyChord[] = [];
  for (const combo of text.split(' ')) {
    const parts = combo.split('+');
    const last = parts.pop()!;
    const key = keyOf(last);
    if (!key) return { ok: false, error: `Unknown key "${last}".` };
    let mask = 0;
    const modifiers: KeyChord['modifiers'] = [];
    for (const part of parts) {
      const mod = MODIFIERS[part.toLowerCase()];
      if (!mod)
        return { ok: false, error: `Unknown modifier "${part}" (use ctrl, alt, shift or meta).` };
      mask |= mod.bit;
      modifiers.push({ key: mod.key, code: mod.code, keyCode: mod.keyCode });
    }
    chords.push({ modifiers, mask, key });
  }
  return { ok: true, chords };
}
