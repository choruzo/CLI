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
    /**
     * `false` para un dato que no es secreto pero que se configura igual (la URL
     * de Home Assistant): se teclea con eco. Por defecto, secreto.
     */
    sensitive: z.boolean().optional(),
  })
  .strict();

/**
 * M21 — un conector que se autoriza con OAuth (Google). El `setup` de la CLI
 * pide el cliente (id y secreto, que la persona creó en su Google Cloud), abre
 * el navegador y recoge el **refresh token** en `127.0.0.1` con PKCE: ese
 * secreto nunca se teclea. Los tres nombres son secretos del manifiesto y le
 * llegan al conector como los demás. Los puntos de autorización y de token no
 * salen del manifiesto: los fija el código del proveedor (`oauth-google.ts`).
 */
const OAuthSchema = z
  .object({
    provider: z.literal('google'),
    scopes: z
      .array(z.string().regex(/^https:\/\/www\.googleapis\.com\/auth\/[a-z][a-z0-9._]{0,63}$/))
      .min(1)
      .max(10),
    clientId: z.string().regex(SECRET_NAME_RE),
    clientSecret: z.string().regex(SECRET_NAME_RE),
    refreshToken: z.string().regex(SECRET_NAME_RE),
  })
  .strict();

export type ConnectorOAuth = z.infer<typeof OAuthSchema>;

/** Intervalo mínimo de un vigilante (M22): nunca menos de un minuto. */
export const CHECK_MIN_INTERVAL_SEC = 60;
const CHECK_MAX_INTERVAL_SEC = 86_400;
const CHECK_MAX_ARGS = 8;
const CHECK_MAX = 10;

/**
 * M22 — un argumento de una comprobación. Es un esquema **cerrado** (no JSON
 * Schema libre): el daemon valida con él los argumentos fijos de un vigilante
 * al crearlo, sin conectar con el conector.
 */
const CheckArgSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    type: z.enum(['string', 'number', 'integer', 'boolean']),
    required: z.boolean(),
    description: z.string().min(1).max(200),
    /** Solo `string`. */
    maxLength: z.number().int().min(1).max(500).optional(),
    /** Solo `string`; se ancla entera (`^(?:…)$`). */
    pattern: z.string().min(1).max(200).optional(),
    /** Solo `string`. */
    enum: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    /** Solo `number` e `integer`. */
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const isString = a.type === 'string';
    const isNumber = a.type === 'number' || a.type === 'integer';
    if (!isString && (a.maxLength !== undefined || a.pattern !== undefined || a.enum)) {
      ctx.addIssue({ code: 'custom', message: 'maxLength/pattern/enum only apply to strings' });
    }
    if (!isNumber && (a.minimum !== undefined || a.maximum !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'minimum/maximum only apply to numbers' });
    }
    if (a.minimum !== undefined && a.maximum !== undefined && a.minimum > a.maximum) {
      ctx.addIssue({ code: 'custom', message: 'minimum is greater than maximum' });
    }
    if (a.pattern !== undefined) {
      try {
        new RegExp(`^(?:${a.pattern})$`, 'u');
      } catch {
        ctx.addIssue({ code: 'custom', message: 'pattern is not a valid regular expression' });
      }
    }
  });

export type ConnectorCheckArg = z.infer<typeof CheckArgSchema>;

/**
 * M22 — una comprobación: una tool **de solo lectura** del conector que, además
 * del texto para el modelo, devuelve un resultado estructurado
 * (`structuredContent`: `{ estado, valor?, detalle }`, `checks.ts`). Sobre ella
 * se declaran los vigilantes, que el daemon evalúa sin el LLM.
 */
const CheckSchema = z
  .object({
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    summary: z.string().min(1).max(200),
    /** Intervalo mínimo entre dos evaluaciones (más largo para lo que pesa). */
    minIntervalSec: z.number().int().min(CHECK_MIN_INTERVAL_SEC).max(CHECK_MAX_INTERVAL_SEC),
    args: z.array(CheckArgSchema).max(CHECK_MAX_ARGS),
  })
  .strict();

export type ConnectorCheck = z.infer<typeof CheckSchema>;

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
    oauth: OAuthSchema.optional(),
    tools: z.array(ToolSchema).min(1),
    checks: z.array(CheckSchema).max(CHECK_MAX).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.checks) {
      const tools = new Map(m.tools.map((t) => [t.name, t]));
      const seenChecks = new Set<string>();
      for (const c of m.checks) {
        const tool = tools.get(c.tool);
        if (!tool) {
          ctx.addIssue({
            code: 'custom',
            message: `check "${c.tool}" is not a tool`,
            path: ['checks'],
          });
        } else if (!tool.readOnly) {
          ctx.addIssue({
            code: 'custom',
            message: `check "${c.tool}" is not a read-only tool`,
            path: ['checks'],
          });
        }
        if (seenChecks.has(c.tool)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate check "${c.tool}"`,
            path: ['checks'],
          });
        }
        seenChecks.add(c.tool);
        const argNames = c.args.map((a) => a.name);
        if (new Set(argNames).size !== argNames.length) {
          ctx.addIssue({
            code: 'custom',
            message: `check "${c.tool}" repeats an argument`,
            path: ['checks'],
          });
        }
      }
    }
    if (m.oauth) {
      const names = new Set(m.secrets.map((s) => s.name));
      const roles = [m.oauth.clientId, m.oauth.clientSecret, m.oauth.refreshToken];
      for (const name of roles) {
        if (!names.has(name)) {
          ctx.addIssue({ code: 'custom', message: `"${name}" is not a secret`, path: ['oauth'] });
        }
      }
      if (new Set(roles).size !== roles.length) {
        ctx.addIssue({ code: 'custom', message: 'repeated secret names', path: ['oauth'] });
      }
    }
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

/** Comprobaciones del manifiesto (M22); `[]` si no declara ninguna. */
export function checksOf(manifest: ConnectorManifest): ConnectorCheck[] {
  return manifest.checks ?? [];
}

/** Tools que el manifiesto declara de solo lectura. */
export function readOnlyToolsOf(manifest: ConnectorManifest): string[] {
  return manifest.tools.filter((t) => t.readOnly).map((t) => t.name);
}
