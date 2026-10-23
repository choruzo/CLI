import { describe, expect, it } from 'vitest';
import {
  addCostTotal,
  computeCostUsd,
  emptyCostTotal,
  hasBillableTokens,
  type Pricing,
} from './pricing.js';

/** Precios de juguete: 3 USD/M de entrada, 15 USD/M de salida. */
const PRICING: Pricing = { input: 3, output: 15 };

describe('computeCostUsd', () => {
  it('sin pricing no hay coste (no hay tarifa por defecto)', () => {
    expect(computeCostUsd({ promptTokens: 1000, completionTokens: 500 })).toBeUndefined();
    expect(computeCostUsd({ promptTokens: 1000, completionTokens: 500 }, null)).toBeUndefined();
  });

  it('sin promptTokens o sin completionTokens no se puede cerrar la cuenta', () => {
    expect(computeCostUsd({}, PRICING)).toBeUndefined();
    expect(computeCostUsd({ promptTokens: 1000 }, PRICING)).toBeUndefined();
    expect(computeCostUsd({ completionTokens: 500 }, PRICING)).toBeUndefined();
    expect(computeCostUsd(undefined, PRICING)).toBeUndefined();
  });

  it('sin caché cobra todo el prompt a input y la salida a output', () => {
    // 1M de entrada + 1M de salida = 3 + 15
    expect(computeCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, PRICING)).toBe(
      18,
    );
    // 1000 entrada + 500 salida = 0.003 + 0.0075
    expect(computeCostUsd({ promptTokens: 1000, completionTokens: 500 }, PRICING)).toBeCloseTo(
      0.0105,
      10,
    );
  });

  it('cachedReadTokens sin tarifa propia se cobra a input (tarifa base)', () => {
    expect(
      computeCostUsd(
        { promptTokens: 1_000_000, completionTokens: 0, cachedReadTokens: 400_000 },
        PRICING,
      ),
    ).toBe(3);
  });

  it('cachedReadTokens con cachedInput se cobra a su tarifa', () => {
    const pricing: Pricing = { input: 3, output: 15, cachedInput: 0.3 };
    // 600k sin cachear × 3 + 400k cacheados × 0.3 = 1.8 + 0.12
    expect(
      computeCostUsd(
        { promptTokens: 1_000_000, completionTokens: 0, cachedReadTokens: 400_000 },
        pricing,
      ),
    ).toBeCloseTo(1.92, 10);
  });

  it('cacheWriteTokens con cacheWrite se cobra a su tarifa; sin ella, a input', () => {
    const withRate: Pricing = { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 };
    expect(
      computeCostUsd(
        { promptTokens: 1_000_000, completionTokens: 0, cacheWriteTokens: 200_000 },
        withRate,
      ),
    ).toBeCloseTo(2.4 + 0.75, 10);
    expect(
      computeCostUsd(
        { promptTokens: 1_000_000, completionTokens: 0, cacheWriteTokens: 200_000 },
        PRICING,
      ),
    ).toBe(3);
  });

  it('caché leída y escrita a la vez no descuadra el prompt', () => {
    const pricing: Pricing = { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 };
    // 1M de prompt: 500k cacheados × 0.3 + 200k escritos × 3.75 + 300k × 3
    expect(
      computeCostUsd(
        {
          promptTokens: 1_000_000,
          completionTokens: 100_000,
          cachedReadTokens: 500_000,
          cacheWriteTokens: 200_000,
        },
        pricing,
      ),
    ).toBeCloseTo(0.15 + 0.75 + 0.9 + 1.5, 10);
  });

  it('un backend que exagera la caché nunca produce un coste negativo', () => {
    // caché reportada por encima del prompt: se recorta al prompt (todo a tarifa base).
    expect(
      computeCostUsd(
        { promptTokens: 1000, completionTokens: 0, cachedReadTokens: 5000 },
        { input: 3, output: 15 },
      ),
    ).toBe(0.003);
    expect(
      computeCostUsd(
        {
          promptTokens: 1000,
          completionTokens: 0,
          cachedReadTokens: 800,
          cacheWriteTokens: 900,
        },
        { input: 3, output: 15, cachedInput: 1, cacheWrite: 2 },
      ),
    ).toBeCloseTo((800 * 1 + 200 * 2) / 1e6, 12);
  });

  it('un backend con precio 0 cuesta 0, no undefined', () => {
    expect(
      computeCostUsd({ promptTokens: 1000, completionTokens: 500 }, { input: 0, output: 0 }),
    ).toBe(0);
  });
});

describe('hasBillableTokens', () => {
  it('hay tokens si el backend reportó prompt o completion (aunque sean 0)', () => {
    expect(hasBillableTokens({ promptTokens: 0, completionTokens: 0 })).toBe(true);
    expect(hasBillableTokens({ completionTokens: 3 })).toBe(true);
    expect(hasBillableTokens({ cachedReadTokens: 10 })).toBe(false);
    expect(hasBillableTokens({})).toBe(false);
    expect(hasBillableTokens(undefined)).toBe(false);
  });
});

describe('addCostTotal', () => {
  it('acumula los costes de las requests del turno', () => {
    let total = emptyCostTotal();
    total = addCostTotal(total, 0.1, true);
    total = addCostTotal(total, 0.2, true);
    expect(total.incomplete).toBe(false);
    expect(total.costUsd).toBeCloseTo(0.3, 10);
  });

  it('una request sin tokens facturables no cambia nada', () => {
    const total = addCostTotal(emptyCostTotal(), undefined, false);
    expect(total).toEqual({ incomplete: false });
    expect(total.costUsd).toBeUndefined();
  });

  it('una request con tokens y sin precio deja el total incompleto, y es pegajoso', () => {
    let total = addCostTotal(emptyCostTotal(), 0.1, true);
    total = addCostTotal(total, undefined, true);
    expect(total.incomplete).toBe(true);
    // Un tramo posterior con precio NO resucita el importe parcial.
    total = addCostTotal(total, 0.5, true);
    expect(total.incomplete).toBe(true);
  });

  it('el coste 0 se acumula como cualquier otro (backend gratis)', () => {
    const total = addCostTotal(emptyCostTotal(), 0, true);
    expect(total).toEqual({ costUsd: 0, incomplete: false });
  });

  it('es pura', () => {
    const base = { costUsd: 1, incomplete: false };
    addCostTotal(base, 2, true);
    expect(base).toEqual({ costUsd: 1, incomplete: false });
  });
});
