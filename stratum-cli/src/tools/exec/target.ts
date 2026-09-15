/**
 * Hito 16 — `ExecutionTarget`: dónde se ejecuta un comando (§2 de
 * `CLI-DOC/Orientacion-Infraestructura.md`). Puro, sin I/O.
 *
 * La sintaxis (`parseTarget`) va separada de la existencia (`resolveTarget`):
 * la primera no necesita config y la segunda sí (el inventario SSH).
 */
import type { StratumConfig } from '../../config/schema.js';
import { resolveHost } from '../ssh/inventory.js';

export type ExecutionTarget = { kind: 'local' } | { kind: 'ssh'; alias: string };
export type TargetKind = ExecutionTarget['kind'];

/** Kinds con sintaxis reservada para hitos siguientes (§2): se rechazan con un mensaje claro. */
const RESERVED_KINDS = new Set(['container', 'pod', 'winrm']);

export type TargetParse = { ok: true; target: ExecutionTarget } | { ok: false; error: string };

export function parseTarget(raw?: string): TargetParse {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'local') return { ok: true, target: { kind: 'local' } };

  const sep = value.indexOf(':');
  const kind = sep === -1 ? value : value.slice(0, sep);
  const rest = sep === -1 ? '' : value.slice(sep + 1).trim();

  if (kind === 'ssh') {
    if (!rest) {
      return { ok: false, error: 'An ssh target needs a host alias: "ssh:<alias>".' };
    }
    return { ok: true, target: { kind: 'ssh', alias: rest } };
  }
  if (RESERVED_KINDS.has(kind)) {
    return {
      ok: false,
      error: `Target kind "${kind}" is not available yet. Available targets: "local" and "ssh:<alias>".`,
    };
  }
  return { ok: false, error: `Unknown target "${value}". Use "local" or "ssh:<alias>".` };
}

/** Comprueba que el target existe en esta config (hoy: el alias SSH en el inventario). */
export function resolveTarget(
  target: ExecutionTarget,
  config: StratumConfig,
): { ok: true } | { ok: false; error: string } {
  if (target.kind === 'local') return { ok: true };
  try {
    resolveHost(config, target.alias);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function formatTarget(target: ExecutionTarget): string {
  return target.kind === 'local' ? 'local' : `ssh:${target.alias}`;
}

/** Los alias SSH son claves libres de un `z.record`: todo atributo XML se escapa. */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
