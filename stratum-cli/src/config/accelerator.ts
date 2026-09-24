/**
 * Atajos de teclado globales de Stratum Desktop (D6): `desktop.globalHotkey`.
 *
 * La gramática es la de los *accelerators* de Tauri (`tauri-plugin-global-shortcut`,
 * crate `global-hotkey`): modificadores y una tecla unidos por `+`, sin
 * distinguir mayúsculas. Aquí se acepta un subconjunto conservador —las teclas
 * que ese parser reconoce con seguridad— y se exige al menos un modificador
 * distinto de Shift: un atajo global sin él secuestraría una tecla de escritura
 * en todo el sistema. Rust vuelve a parsearlo al registrarlo; esta validación
 * existe para marcar el error en Ajustes antes de guardar.
 *
 * Puro y sin dependencias: lo importan el schema de la config y el webview.
 */

export const DEFAULT_GLOBAL_HOTKEY = 'CommandOrControl+Shift+Space';

/** Modificadores en su forma canónica, en el orden en que se escriben. */
const MODIFIERS = ['CommandOrControl', 'Control', 'Alt', 'Shift', 'Super'] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  commandorcontrol: 'CommandOrControl',
  commandorctrl: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  cmdorcontrol: 'CommandOrControl',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  command: 'Super',
  cmd: 'Super',
};

const NAMED_KEYS = [
  'Space',
  'Enter',
  'Tab',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Delete',
  'Backspace',
  'Backquote',
  'Minus',
  'Equal',
  'Comma',
  'Period',
  'Slash',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
  'Backslash',
] as const;

/** Todas las teclas admitidas, en forma canónica (también las usa el test de Rust). */
export const ACCELERATOR_KEYS: readonly string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...'0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...NAMED_KEYS,
];

const KEY_BY_LOWER = new Map(ACCELERATOR_KEYS.map((k) => [k.toLowerCase(), k]));

export type AcceleratorParse = { ok: true; accelerator: string } | { ok: false; error: string };

/**
 * Valida y normaliza (`ctrl+shift+space` → `Control+Shift+Space`). La cadena
 * vacía no se acepta aquí: en la config significa «sin atajo» y lo decide quien
 * llama.
 */
export function parseAccelerator(raw: string): AcceleratorParse {
  const parts = raw
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { ok: false, error: 'El atajo está vacío' };
  const keyPart = parts[parts.length - 1];
  const key = KEY_BY_LOWER.get(keyPart.toLowerCase());
  if (!key) {
    if (MODIFIER_ALIASES[keyPart.toLowerCase()]) {
      return { ok: false, error: 'Falta la tecla después de los modificadores' };
    }
    return { ok: false, error: `Tecla no admitida: «${keyPart}»` };
  }
  const mods = new Set<Modifier>();
  for (const p of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[p.toLowerCase()];
    if (!mod) return { ok: false, error: `Modificador no reconocido: «${p}»` };
    if (mods.has(mod)) return { ok: false, error: `Modificador repetido: «${p}»` };
    mods.add(mod);
  }
  if (mods.has('CommandOrControl') && (mods.has('Control') || mods.has('Super'))) {
    // En Windows/Linux CommandOrControl ya es Control.
    return { ok: false, error: 'CommandOrControl no se combina con Control ni Super' };
  }
  if ([...mods].every((m) => m === 'Shift')) {
    return {
      ok: false,
      error:
        'Un atajo global necesita Control, Alt o Super: sin ellos ocuparía una tecla de escritura en todo el sistema',
    };
  }
  const ordered = MODIFIERS.filter((m) => mods.has(m));
  return { ok: true, accelerator: [...ordered, key].join('+') };
}

/**
 * `KeyboardEvent.code` → tecla canónica (captura del atajo en Ajustes).
 * `null` para teclas que no se admiten o que son solo modificadores.
 */
export function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const arrows: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };
  if (arrows[code]) return arrows[code];
  return (NAMED_KEYS as readonly string[]).includes(code) ? code : null;
}

/** Atajo a partir de una pulsación (captura en Ajustes); `null` si no forma uno válido. */
export function acceleratorFromEvent(e: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  parts.push(key);
  const parsed = parseAccelerator(parts.join('+'));
  return parsed.ok ? parsed.accelerator : null;
}
