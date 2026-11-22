import { describe, expect, it } from 'vitest';
import { toYaml } from './yaml.js';

describe('toYaml', () => {
  it('escalares', () => {
    expect(toYaml('hola')).toBe('hola');
    expect(toYaml(3)).toBe('3');
    expect(toYaml(true)).toBe('true');
    expect(toYaml(null)).toBe('null');
    expect(toYaml({ a: 1, b: false, c: null, d: 'x' })).toBe('a: 1\nb: false\nc: null\nd: x');
  });

  it('pone comillas a lo que un lector de YAML leería como otra cosa', () => {
    const quoted = [
      '',
      'a: b',
      'termina:',
      'con # almohadilla',
      'línea\nsiguiente',
      '- guion',
      '[lista]',
      '{mapa}',
      '*alias',
      '!etiqueta',
      '"ya con comillas"',
      ' espacios ',
      '123',
      '-00:30:00',
      '12:30:00',
      '2026-11-22',
      'true',
      'No',
      'null',
      '~',
    ];
    for (const s of quoted) expect(toYaml({ k: s }), s).toBe(`k: ${JSON.stringify(s)}`);
    for (const s of ['sunset', 'light.turn_on', 'binary_sensor.x', 'con espacios', 'a-b']) {
      expect(toYaml({ k: s }), s).toBe(`k: ${s}`);
    }
  });

  it('claves con comillas si lo necesitan', () => {
    expect(toYaml({ 'a: b': 1, '': 2 })).toBe('"a: b": 1\n"": 2');
  });

  it('anidados y listas', () => {
    const v = {
      id: '1732813243567',
      triggers: [{ trigger: 'state', entity_id: ['binary_sensor.x'], from: 'off', to: 'on' }],
      conditions: [{ condition: 'or', conditions: [{ condition: 'sun', before: 'sunrise' }] }],
      mode: 'single',
    };
    expect(toYaml(v)).toBe(
      [
        'id: "1732813243567"',
        'triggers:',
        '  - trigger: state',
        '    entity_id:',
        '      - binary_sensor.x',
        '    from: "off"',
        '    to: "on"',
        'conditions:',
        '  - condition: or',
        '    conditions:',
        '      - condition: sun',
        '        before: sunrise',
        'mode: single',
      ].join('\n'),
    );
  });

  it('listas de listas y de escalares', () => {
    expect(toYaml([['a', 'b'], 'c', 1])).toBe('- - a\n  - b\n- c\n- 1');
  });

  it('vacíos como {} y []', () => {
    expect(toYaml({})).toBe('{}');
    expect(toYaml([])).toBe('[]');
    expect(toYaml({ a: {}, b: [], c: [{}] })).toBe('a: {}\nb: []\nc:\n  - {}');
  });

  it('es determinista y salta lo undefined', () => {
    const v = { b: 1, a: undefined, c: 'x' };
    expect(toYaml(v)).toBe('b: 1\nc: x');
    expect(toYaml(v)).toBe(toYaml(v));
  });
});
