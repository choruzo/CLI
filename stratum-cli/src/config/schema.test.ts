import { describe, expect, it } from 'vitest';
import { SnapshotsConfigSchema, StratumConfigSchema } from './schema.js';

function parseProvider(extra: Record<string, unknown>) {
  return StratumConfigSchema.parse({
    provider: {
      default: 'gateway',
      providers: {
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:4000/v1',
          ...extra,
        },
      },
    },
  }).provider?.providers.gateway;
}

describe('pricing en el schema de config (UX-3)', () => {
  it('acepta precio por millón de tokens, con sus dos tarifas opcionales', () => {
    const cfg = parseProvider({
      pricing: { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
    });
    expect(cfg?.pricing).toEqual({ input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 });
  });

  it('es opcional: sin pricing no se inventa ninguna tarifa', () => {
    expect(parseProvider({})?.pricing).toBeUndefined();
  });

  it('solo exige input y output; la caché es opcional', () => {
    expect(parseProvider({ pricing: { input: 1, output: 2 } })?.pricing).toEqual({
      input: 1,
      output: 2,
    });
    expect(() => parseProvider({ pricing: { input: 1 } })).toThrow();
    expect(() => parseProvider({ pricing: { output: 2 } })).toThrow();
  });

  it('rechaza precios negativos', () => {
    expect(() => parseProvider({ pricing: { input: -1, output: 2 } })).toThrow();
    expect(() => parseProvider({ pricing: { input: 1, output: -2 } })).toThrow();
    expect(() => parseProvider({ pricing: { input: 1, output: 2, cachedInput: -0.1 } })).toThrow();
  });

  it('rechaza claves desconocidas (una errata no puede pasar por tarifa)', () => {
    expect(() => parseProvider({ pricing: { input: 1, output: 2, inputPerMillion: 1 } })).toThrow();
    expect(() => parseProvider({ pricing: { input: 1, output: 2, cached: 1 } })).toThrow();
  });

  it('admite precio por modelo, que gana al del provider', () => {
    const cfg = parseProvider({
      model: 'claude-sonnet-4-5',
      pricing: { input: 3, output: 15 },
      models: { 'claude-sonnet-4-5': { pricing: { input: 3, output: 15, cachedInput: 0.3 } } },
    });
    expect(cfg?.models?.['claude-sonnet-4-5']?.pricing).toEqual({
      input: 3,
      output: 15,
      cachedInput: 0.3,
    });
  });
});

/**
 * Sección `snapshots` de `.stratumrc.json` (UX-1): defaults y validación.
 * Los invariantes del almacén (dónde vive el repo de la sombra, límites por
 * lotes) no son config: solo `enabled`, `maxFileBytes` y `retentionDays`.
 */

describe('snapshots en la config (UX-1)', () => {
  it('aplica los defaults del brief: activo, 2 MiB y 7 días', () => {
    expect(SnapshotsConfigSchema.parse({})).toEqual({
      enabled: true,
      maxFileBytes: 2 * 1024 * 1024,
      retentionDays: 7,
      timeoutMs: 20_000,
      maxFiles: 20_000,
    });
  });

  it('sin sección en el fichero, la config trae la sección con defaults', () => {
    const parsed = StratumConfigSchema.parse({});
    expect(parsed.snapshots).toEqual({
      enabled: true,
      maxFileBytes: 2 * 1024 * 1024,
      retentionDays: 7,
      timeoutMs: 20_000,
      maxFiles: 20_000,
    });
  });

  it('respeta los valores del usuario, incluido retentionDays 0 (no purgar)', () => {
    expect(
      SnapshotsConfigSchema.parse({
        enabled: false,
        maxFileBytes: 1024,
        retentionDays: 0,
        timeoutMs: 5000,
        maxFiles: 100,
      }),
    ).toEqual({
      enabled: false,
      maxFileBytes: 1024,
      retentionDays: 0,
      timeoutMs: 5000,
      maxFiles: 100,
    });
  });

  it('rechaza tamaños y retenciones imposibles', () => {
    expect(SnapshotsConfigSchema.safeParse({ maxFileBytes: 0 }).success).toBe(false);
    expect(SnapshotsConfigSchema.safeParse({ maxFileBytes: 1.5 }).success).toBe(false);
    expect(SnapshotsConfigSchema.safeParse({ retentionDays: -1 }).success).toBe(false);
    expect(SnapshotsConfigSchema.safeParse({ timeoutMs: 0 }).success).toBe(false);
    expect(SnapshotsConfigSchema.safeParse({ maxFiles: 0 }).success).toBe(false);
    expect(SnapshotsConfigSchema.safeParse({ enabled: 'sí' }).success).toBe(false);
  });
});

describe('retención de carpetas de Desktop (desktop.workspaces)', () => {
  const parse = (workspaces: Record<string, unknown> = {}) =>
    StratumConfigSchema.parse({ desktop: { workspaces } }).desktop.workspaces;

  it('por defecto comprime a los 7 días y elimina a los 5 meses (150)', () => {
    const w = parse();
    expect(w.compressAfterDays).toBe(7);
    expect(w.deleteAfterDays).toBe(150);
    // Sin sección `desktop` entera, igual.
    expect(StratumConfigSchema.parse({}).desktop.workspaces.deleteAfterDays).toBe(150);
  });

  it('se configura, y 0 desactiva cada etapa', () => {
    expect(parse({ compressAfterDays: 3, deleteAfterDays: 60 })).toMatchObject({
      compressAfterDays: 3,
      deleteAfterDays: 60,
    });
    expect(parse({ compressAfterDays: 0, deleteAfterDays: 5 }).compressAfterDays).toBe(0);
    expect(parse({ deleteAfterDays: 0 }).deleteAfterDays).toBe(0);
  });

  it('deleteAfterDays tiene que ser mayor que compressAfterDays salvo con 0', () => {
    expect(() => parse({ compressAfterDays: 10, deleteAfterDays: 5 })).toThrow(
      /mayor que compressAfterDays/,
    );
    expect(() => parse({ compressAfterDays: 7, deleteAfterDays: 7 })).toThrow(
      /mayor que compressAfterDays/,
    );
    // Con compressAfterDays por defecto (7), un delete de 5 es incoherente.
    expect(() => parse({ deleteAfterDays: 5 })).toThrow(/mayor que compressAfterDays/);
    expect(() => parse({ compressAfterDays: 0, deleteAfterDays: 5 })).not.toThrow();
  });
});
