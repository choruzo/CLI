import { describe, expect, it } from 'vitest';
import { normalizeName, tidyLabel } from './normalize.js';

describe('normalizeName', () => {
  it('minúsculas, sin acentos ni puntuación, espacios colapsados', () => {
    expect(normalizeName('  Alcalá   de  Henares ')).toBe('alcala de henares');
    expect(normalizeName('Madrid-Chamartín-Clara Campoamor')).toBe(
      'madrid chamartin clara campoamor',
    );
    expect(normalizeName('S.Sebast. de los Reyes')).toBe('s sebast de los reyes');
  });

  it('alias de abreviaturas', () => {
    expect(normalizeName('Pza. Catalunya')).toBe('plaza catalunya');
    expect(normalizeName('Pl Catalunya')).toBe('plaza catalunya');
    expect(normalizeName('Sta. Eulàlia')).toBe('santa eulalia');
    expect(normalizeName('St Andreu')).toBe('sant andreu');
  });

  it('«estación de» al principio no distingue nada', () => {
    expect(normalizeName('Estación de Atocha')).toBe('atocha');
    expect(normalizeName('Estació de Sants')).toBe('sants');
  });
});

describe('tidyLabel', () => {
  it('colapsa el relleno del feed', () => {
    expect(tidyLabel('Principe Pio                -Aeropuerto-T4      ')).toBe(
      'Principe Pio-Aeropuerto-T4',
    );
  });
});
