/**
 * Hito 16 — `ExecutionTarget`: dónde se ejecuta un comando (§2 de
 * `CLI-DOC/Orientacion-Infraestructura.md`). Puro, sin I/O.
 *
 * La sintaxis (`parseTarget`) va separada de la existencia (`resolveTarget`):
 * la primera no necesita config y la segunda sí (el inventario SSH).
 */
import type { StratumConfig } from '../../config/schema.js';
import { resolveHost } from '../ssh/inventory.js';

export type ExecutionTarget =
  | { kind: 'local' }
  | { kind: 'ssh'; alias: string }
  /** M13 — la caja de Stratum (`src/box/`): solo contenedores que creó Stratum. */
  | { kind: 'container'; name: string };
export type TargetKind = ExecutionTarget['kind'];

/** Kinds con sintaxis reservada para hitos siguientes (§2): se rechazan con un mensaje claro. */
const RESERVED_KINDS = new Set(['pod', 'winrm']);

const AVAILABLE = '"local", "ssh:<alias>" or "container:<box>"';

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
  if (kind === 'container') {
    if (!rest) {
      return { ok: false, error: 'A container target needs the box name: "container:<box>".' };
    }
    return { ok: true, target: { kind: 'container', name: rest } };
  }
  if (RESERVED_KINDS.has(kind)) {
    return {
      ok: false,
      error: `Target kind "${kind}" is not available yet. Available targets: ${AVAILABLE}.`,
    };
  }
  return { ok: false, error: `Unknown target "${value}". Use ${AVAILABLE}.` };
}

/**
 * Comprueba que el target existe en esta config: el alias SSH en el inventario,
 * o la caja configurada y habilitada. Que la caja esté de verdad en marcha lo
 * comprueba su backend al ejecutar (necesita I/O).
 */
export function resolveTarget(
  target: ExecutionTarget,
  config: StratumConfig,
): { ok: true } | { ok: false; error: string } {
  if (target.kind === 'local') return { ok: true };
  if (target.kind === 'container') {
    const box = config.box;
    if (!box?.enabled) {
      return {
        ok: false,
        error:
          'The box is not enabled for exec (box.enabled is false in the global config). ' +
          'Use "local" or an ssh target.',
      };
    }
    if (target.name !== box.name) {
      return {
        ok: false,
        error: `Unknown box "${target.name}". The configured box is "container:${box.name}".`,
      };
    }
    return { ok: true };
  }
  try {
    resolveHost(config, target.alias);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function formatTarget(target: ExecutionTarget): string {
  switch (target.kind) {
    case 'local':
      return 'local';
    case 'ssh':
      return `ssh:${target.alias}`;
    case 'container':
      return `container:${target.name}`;
  }
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
