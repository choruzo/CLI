/**
 * M22 — validar un vigilante nuevo contra el catálogo de conectores, sin
 * conectar con ninguno: el conector existe, la comprobación la declara su
 * manifiesto, los argumentos casan con su esquema cerrado y el intervalo no baja
 * del mínimo de la comprobación. Lo usan la propuesta del agente y la CLI
 * (fase 3); el almacén solo guarda lo que salió de aquí. Sin I/O.
 */
import { z } from 'zod';
import { WATCH_LIMITS } from '../protocol/index.js';
import {
  validateCheckArgs,
  neutralizeCheckText,
  type CheckArgValue,
} from '../connectors/checks.js';
import { checksOf, type ConnectorManifest } from '../connectors/manifest.js';
import { WatchConditionSchema, type WatchCondition } from './condition.js';

const MAX_INTERVAL_SEC = 86_400;

/** Lo que pide quien crea un vigilante. */
export interface WatchRequest {
  name: string;
  connector: string;
  check: string;
  args?: unknown;
  condition: unknown;
  intervalSec?: number;
  cooldownMinutes?: number;
  notifyResolved?: boolean;
  origin: 'agent' | 'person';
}

/** Un vigilante ya validado, listo para el almacén. */
export interface WatchDefinition {
  name: string;
  connector: string;
  check: string;
  args: Record<string, CheckArgValue>;
  condition: WatchCondition;
  intervalSec: number;
  cooldownMinutes: number;
  notifyResolved: boolean;
  origin: 'agent' | 'person';
}

export type WatchDefinitionOutcome =
  | { ok: true; definition: WatchDefinition }
  | { ok: false; error: string };

/** Lo justo del catálogo. */
export interface WatchCatalog {
  get(id: string): { manifest: ConnectorManifest } | undefined;
}

const RequestSchema = z
  .object({
    name: z.string(),
    connector: z.string(),
    check: z.string(),
    args: z.unknown().optional(),
    condition: z.unknown(),
    intervalSec: z.number().int().optional(),
    cooldownMinutes: z.number().int().min(0).max(WATCH_LIMITS.maxCooldownMinutes).optional(),
    notifyResolved: z.boolean().optional(),
    origin: z.enum(['agent', 'person']),
  })
  .strict();

function zodMessage(err: z.ZodError, what: string): string {
  const issue = err.issues[0];
  const path = issue?.path.join('.');
  return `Invalid ${what}${path ? ` (${path})` : ''}: ${issue?.message ?? 'not valid'}`;
}

export function defineWatch(request: WatchRequest, catalog: WatchCatalog): WatchDefinitionOutcome {
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error, 'watch') };
  const r = parsed.data;

  const name = neutralizeCheckText(r.name, WATCH_LIMITS.nameChars + 1);
  if (!name) return { ok: false, error: 'The watch needs a name.' };
  if ([...name].length > WATCH_LIMITS.nameChars) {
    return { ok: false, error: `The name admits at most ${WATCH_LIMITS.nameChars} characters.` };
  }

  const entry = catalog.get(r.connector);
  if (!entry) return { ok: false, error: `Unknown connector "${r.connector}".` };
  const checks = checksOf(entry.manifest);
  const check = checks.find((c) => c.tool === r.check);
  if (!check) {
    const offered = checks.map((c) => c.tool);
    return {
      ok: false,
      error:
        offered.length > 0
          ? `Connector "${r.connector}" has no check "${r.check}"; its checks: ${offered.join(', ')}.`
          : `Connector "${r.connector}" has no checks.`,
    };
  }

  const args = validateCheckArgs(check, r.args ?? {});
  if (!args.ok) return { ok: false, error: args.error };

  const condition = WatchConditionSchema.safeParse(r.condition);
  if (!condition.success) return { ok: false, error: zodMessage(condition.error, 'condition') };

  const intervalSec = r.intervalSec ?? check.minIntervalSec;
  if (intervalSec < check.minIntervalSec || intervalSec > MAX_INTERVAL_SEC) {
    return {
      ok: false,
      error: `The interval of check "${check.tool}" goes from ${check.minIntervalSec} to ${MAX_INTERVAL_SEC} seconds.`,
    };
  }

  return {
    ok: true,
    definition: {
      name,
      connector: r.connector,
      check: check.tool,
      args: args.args,
      condition: condition.data,
      intervalSec,
      cooldownMinutes: r.cooldownMinutes ?? WATCH_LIMITS.defaultCooldownMinutes,
      notifyResolved: r.notifyResolved ?? false,
      origin: r.origin,
    },
  };
}
