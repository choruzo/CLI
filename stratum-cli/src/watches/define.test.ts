/**
 * M22 — validar un vigilante nuevo contra el catálogo de conectores, sin
 * conectar con ninguno: conector, comprobación declarada, argumentos del
 * esquema cerrado, condición y un intervalo que no baje del mínimo.
 */
import { describe, expect, it } from 'vitest';
import { WATCH_LIMITS } from '../protocol/index.js';
import { parseConnectorManifest, type ConnectorManifest } from '../connectors/manifest.js';
import { defineWatch, type WatchCatalog, type WatchRequest } from './define.js';
import type { WatchDefinition } from './define.js';

const manifest = (raw: Record<string, unknown>): ConnectorManifest =>
  parseConnectorManifest(raw, 'test');

const HOME = manifest({
  schemaVersion: 1,
  id: 'home-assistant',
  version: '1.0.0',
  name: 'Home Assistant',
  description: 'La casa',
  agents: ['companion'],
  hosts: [],
  secrets: [],
  tools: [
    { name: 'ha_comprobar', readOnly: true, summary: 'estado' },
    { name: 'ha_encender', readOnly: false, summary: 'enciende' },
  ],
  checks: [
    {
      tool: 'ha_comprobar',
      summary: 'estado de una entidad',
      minIntervalSec: 120,
      args: [
        {
          name: 'entity_id',
          type: 'string',
          required: true,
          description: 'entidad',
          pattern: '[a-z_]+\\.[a-z0-9_]+',
        },
      ],
    },
  ],
});

const PLAIN = manifest({
  schemaVersion: 1,
  id: 'sin-checks',
  version: '1.0.0',
  name: 'Sin comprobaciones',
  description: 'nada',
  agents: ['companion'],
  hosts: [],
  secrets: [],
  tools: [{ name: 'algo', readOnly: true, summary: 'algo' }],
});

const catalog: WatchCatalog = {
  get: (id) =>
    id === HOME.id ? { manifest: HOME } : id === PLAIN.id ? { manifest: PLAIN } : undefined,
};

const request = (over: Partial<WatchRequest> = {}): WatchRequest => ({
  name: 'Salón',
  connector: 'home-assistant',
  check: 'ha_comprobar',
  args: { entity_id: 'light.salon' },
  condition: { kind: 'state-is', values: ['off'] },
  origin: 'person',
  ...over,
});

const error = (over: Partial<WatchRequest> = {}): string => {
  const outcome = defineWatch(request(over), catalog);
  return outcome.ok ? 'OK' : outcome.error;
};

const defined = (over: Partial<WatchRequest> = {}): WatchDefinition => {
  const outcome = defineWatch(request(over), catalog);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.definition;
};

describe('M22 — defineWatch', () => {
  it('acepta un vigilante que casa con la comprobación y rellena los valores por defecto', () => {
    expect(defined()).toEqual({
      name: 'Salón',
      connector: 'home-assistant',
      check: 'ha_comprobar',
      args: { entity_id: 'light.salon' },
      condition: { kind: 'state-is', values: ['off'] },
      // El mínimo de la comprobación, no el del formato.
      intervalSec: 120,
      cooldownMinutes: WATCH_LIMITS.defaultCooldownMinutes,
      notifyResolved: false,
      origin: 'person',
    });
  });

  it('un conector desconocido', () => {
    expect(error({ connector: 'nube' })).toBe('Unknown connector "nube".');
  });

  it('una comprobación desconocida, listando las que hay', () => {
    expect(error({ check: 'ha_resumen' })).toBe(
      'Connector "home-assistant" has no check "ha_resumen"; its checks: ha_comprobar.',
    );
    expect(error({ connector: 'sin-checks', check: 'algo', args: {} })).toBe(
      'Connector "sin-checks" has no checks.',
    );
  });

  it('argumentos que no casan con el esquema cerrado de la comprobación', () => {
    expect(error({ args: {} })).toBe('Argument "entity_id" is required');
    expect(error({ args: { entity_id: 'light.salon', extra: 1 } })).toBe(
      'Unknown argument "extra" for check "ha_comprobar"',
    );
    expect(error({ args: { entity_id: 'no-vale' } })).toBe(
      'Argument "entity_id" does not have the expected format',
    );
    expect(error({ args: 'no es un objeto' })).toBe('Arguments must be an object');
    // Los obligatorios vacíos tampoco.
    expect(error({ args: { entity_id: '' } })).toBe('Argument "entity_id" must not be empty');
  });

  it('una condición inválida', () => {
    expect(error({ condition: { kind: 'equals', values: ['off'] } })).toContain(
      'Invalid condition',
    );
    expect(error({ condition: { kind: 'state-is', values: [] } })).toContain('Invalid condition');
  });

  it('un intervalo por debajo del mínimo o por encima del máximo', () => {
    expect(error({ intervalSec: 119 })).toBe(
      'The interval of check "ha_comprobar" goes from 120 to 86400 seconds.',
    );
    expect(error({ intervalSec: 86_401 })).toBe(
      'The interval of check "ha_comprobar" goes from 120 to 86400 seconds.',
    );
    expect(defined({ intervalSec: 86_400 }).intervalSec).toBe(86_400);
    expect(defined({ intervalSec: 300 }).intervalSec).toBe(300);
  });

  it('un nombre vacío o demasiado largo', () => {
    expect(error({ name: '   ' })).toBe('The watch needs a name.');
    expect(error({ name: '\n\t' })).toBe('The watch needs a name.');
    expect(error({ name: 'x'.repeat(WATCH_LIMITS.nameChars + 1) })).toBe(
      `The name admits at most ${WATCH_LIMITS.nameChars} characters.`,
    );
    // Los saltos de línea se neutralizan: cabe el mismo texto en una línea.
    expect(defined({ name: '  Salón\nde la casa  ' }).name).toBe('Salón de la casa');
    expect(defined({ name: 'x'.repeat(WATCH_LIMITS.nameChars) }).name).toHaveLength(
      WATCH_LIMITS.nameChars,
    );
  });

  it('un descanso fuera de rango, o campos de más en la petición', () => {
    expect(error({ cooldownMinutes: -1 })).toContain('Invalid watch');
    expect(error({ cooldownMinutes: WATCH_LIMITS.maxCooldownMinutes + 1 })).toContain(
      'Invalid watch',
    );
    expect(defined({ cooldownMinutes: 0 }).cooldownMinutes).toBe(0);
    expect(defined({ notifyResolved: true }).notifyResolved).toBe(true);
    // Estricto: lo que no se conoce no se cuela.
    expect(error({ ...(request() as object), extra: true } as Partial<WatchRequest>)).toContain(
      'Invalid watch',
    );
  });
});
