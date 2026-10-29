/**
 * Importa el módulo de un plugin y valida la forma de su export por defecto.
 * Un `import()` propio, no `importOptional` (ese es el punto de indirección de
 * las dependencias nativas). Nunca lanza: un fallo es un motivo legible.
 */
import { pathToFileURL } from 'url';
import { z } from 'zod';
import { PLUGIN_ID_RE } from '../config/schema.js';
import { PLUGIN_API_VERSION, type StratumPlugin } from './api.js';

const PluginShape = z.object({
  id: z.string().regex(PLUGIN_ID_RE, 'minúsculas, dígitos y "-", hasta 32 caracteres'),
  apiVersion: z.number().int().positive(),
  setup: z.function(),
});

export type LoadedModule = { ok: true; plugin: StratumPlugin } | { ok: false; reason: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Valida el export por defecto (separado del `import()` para poder probarlo). */
export function validatePluginExport(value: unknown): LoadedModule {
  if (value === null || typeof value !== 'object') {
    return {
      ok: false,
      reason: 'el módulo no exporta por defecto un objeto { id, apiVersion, setup }',
    };
  }
  const parsed = PluginShape.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'export';
    return { ok: false, reason: `forma inválida (${where}: ${issue?.message ?? 'no válido'})` };
  }
  if (parsed.data.apiVersion > PLUGIN_API_VERSION) {
    return {
      ok: false,
      reason:
        `pide la API de plugins v${parsed.data.apiVersion} y esta versión de Stratum ` +
        `ofrece la v${PLUGIN_API_VERSION}: actualiza Stratum`,
    };
  }
  return { ok: true, plugin: value as StratumPlugin };
}

export async function loadPluginModule(entry: string): Promise<LoadedModule> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (err) {
    return { ok: false, reason: `no se pudo importar: ${errorText(err)}` };
  }
  const exported = (mod as { default?: unknown } | null)?.default;
  return validatePluginExport(exported);
}
