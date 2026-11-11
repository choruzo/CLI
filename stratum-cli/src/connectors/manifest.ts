/**
 * M20 — el manifiesto de un conector (`connectors/<id>/connector.json`,
 * `docs/PRD_STRATUM_DOT.md` §23.11). Sin I/O: el esquema y su lectura.
 *
 * Un conector es un server MCP **propio** (vive en este repo y va dentro de la
 * imagen de la caja), que corre en la caja de conectores. El manifiesto dice
 * qué es, qué tools tiene y cuáles solo leen, a qué hosts se conecta y qué
 * secretos pide. Lo que no se declare `readOnly` se confirma cada vez.
 */
import { z } from 'zod';

/** Versión del formato de `connector.json` que entiende este core. */
export const CONNECTOR_MANIFEST_VERSION = 1;

/**
 * Id de un conector: también es el nombre de su server MCP (`mcp__<id>__…`),
 * de su carpeta en el paquete y en la imagen, y un argumento de la orden que
 * lo lanza. Por eso es tan cerrado.
 */
export const CONNECTOR_ID_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

/** Nombre de una variable de entorno que lleva un secreto (fase 4). */
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

const ToolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    /** Solo lee: no pide confirmación (no da más autoridad que `curl` en la caja). */
    readOnly: z.boolean(),
    summary: z.string().min(1).max(200),
  })
  .strict();

const SecretSchema = z
  .object({
    name: z.string().regex(SECRET_NAME_RE),
    description: z.string().min(1).max(200),
  })
  .strict();

export const ConnectorManifestSchema = z
  .object({
    schemaVersion: z.literal(CONNECTOR_MANIFEST_VERSION),
    id: z.string().regex(CONNECTOR_ID_RE),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
    /** Agentes que pueden activarlo. En v1, solo el `companion`. */
    agents: z.array(z.literal('companion')).min(1),
    /** Informativo en v1: la caja tiene salida a internet (A2). */
    hosts: z.array(z.string().min(1).max(253)),
    secrets: z.array(SecretSchema),
    tools: z.array(ToolSchema).min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const t of m.tools) {
      if (seen.has(t.name)) {
        ctx.addIssue({ code: 'custom', message: `duplicate tool "${t.name}"`, path: ['tools'] });
      }
      seen.add(t.name);
    }
  });

export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

/** Valida un manifiesto ya parseado. Lanza con un mensaje legible. */
export function parseConnectorManifest(raw: unknown, source: string): ConnectorManifest {
  const r = ConnectorManifestSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    const path = issue.path.join('.');
    throw new Error(
      `Invalid connector manifest ${source}: ${path ? `${path}: ` : ''}${issue.message}`,
    );
  }
  return r.data;
}

/** Tools que el manifiesto declara de solo lectura. */
export function readOnlyToolsOf(manifest: ConnectorManifest): string[] {
  return manifest.tools.filter((t) => t.readOnly).map((t) => t.name);
}
