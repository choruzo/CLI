import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { csvRows, splitCsvLine } from './csv.js';

async function parse(chunks: Array<string | Buffer>) {
  const out = [];
  for await (const r of csvRows(Readable.from(chunks))) out.push(r);
  return out;
}

describe('splitCsvLine', () => {
  it('recorta los campos y respeta comas dentro de comillas', () => {
    expect(splitCsvLine('a  ,"b, c" , d')).toEqual(['a', 'b, c', 'd']);
  });
  it('comillas escapadas', () => {
    expect(splitCsvLine('"di ""hola""",x')).toEqual(['di "hola"', 'x']);
  });
});

describe('csvRows', () => {
  it('cabecera por nombre, CRLF y relleno de espacios', async () => {
    const rows = await parse(['route_id,short\r\n10T0001C1  ,C1  \r\n10T0002C1  ,C2  \r\n']);
    expect(rows).toEqual([
      { route_id: '10T0001C1', short: 'C1' },
      { route_id: '10T0002C1', short: 'C2' },
    ]);
  });

  it('quita el BOM inicial', async () => {
    const rows = await parse(['﻿a,b\n1,2\n']);
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('un campo entrecomillado puede llevar saltos de línea', async () => {
    const rows = await parse(['a,b\n"uno\ndos",x\n3,4']);
    expect(rows).toEqual([
      { a: 'uno\ndos', b: 'x' },
      { a: '3', b: '4' },
    ]);
  });

  it('trozos partidos en mitad de una línea y de un carácter UTF-8', async () => {
    const buf = Buffer.from('nombre,x\nAlcalá de Henares,1\nÑandú,2\n', 'utf8');
    const cut = buf.indexOf(0xc3) + 1; // parte la «á» por la mitad
    const rows = await parse([
      buf.subarray(0, cut),
      buf.subarray(cut, cut + 7),
      buf.subarray(cut + 7),
    ]);
    expect(rows).toEqual([
      { nombre: 'Alcalá de Henares', x: '1' },
      { nombre: 'Ñandú', x: '2' },
    ]);
  });

  it('las filas cortas rellenan con vacío y las líneas en blanco se ignoran', async () => {
    const rows = await parse(['a,b,c\n\n1,2\n']);
    expect(rows).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});
