import { describe, expect, it } from 'vitest';
import {
  base64Lines,
  base64UrlDecode,
  base64UrlEncode,
  buildMessage,
  dayOf,
  decodeEntities,
  encodeHeaderText,
  extractBody,
  htmlToText,
  listAttachments,
  neutralizeDelimiters,
  referenceChain,
  safeField,
  shortDate,
  truncate,
  validMessageId,
} from './gmail.js';

describe('entidades y HTML', () => {
  it('deshace las entidades básicas', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(
      'a & b <c> "d" \'e\'',
    );
  });

  it('deshace entidades numéricas', () => {
    expect(decodeEntities('caf&#233; &#x41;')).toBe('café A');
  });

  it('deja intacto lo que no es una entidad', () => {
    expect(decodeEntities('100 & 200 &rarr;')).toBe('100 & 200 &rarr;');
  });

  it('pasa HTML a texto: fuera script y style con su contenido, saltos en br y p', () => {
    const html =
      '<html><head><style>p{color:red}</style></head><body>' +
      '<script>alert("x")</script><p>Hola&nbsp;Ana,</p><p>te espero<br>a las 10</p></body></html>';
    expect(htmlToText(html)).toBe('Hola Ana,\nte espero\na las 10');
  });

  it('quita las etiquetas sin dejar huecos', () => {
    expect(htmlToText('<b>Hola</b> <i>mundo</i>')).toBe('Hola mundo');
  });
});

describe('cuerpo del mensaje', () => {
  it('usa el text/plain cuando existe', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: base64UrlEncode('<p>html</p>') } },
        { mimeType: 'text/plain', body: { data: base64UrlEncode('llano') } },
      ],
    };
    expect(extractBody(payload)).toBe('llano');
  });

  it('si no hay text/plain usa el text/html pasado a texto', () => {
    const payload = {
      mimeType: 'text/html',
      body: { data: base64UrlEncode('<p>Hola<br>mundo</p>') },
    };
    expect(extractBody(payload)).toBe('Hola\nmundo');
  });

  it('encuentra el text/plain en un multipart anidado con adjuntos', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'multipart/related',
              parts: [{ mimeType: 'text/plain', body: { data: base64UrlEncode('anidado') } }],
            },
          ],
        },
        { mimeType: 'application/pdf', filename: 'factura.pdf', body: { size: 2048 } },
      ],
    };
    expect(extractBody(payload)).toBe('anidado');
  });

  it('sin cuerpo devuelve cadena vacía', () => {
    expect(extractBody(undefined)).toBe('');
    expect(extractBody({ mimeType: 'multipart/mixed', parts: [] })).toBe('');
  });

  it('no decodifica un cuerpo enorme: corta a 64 KB antes de convertir', () => {
    const huge = 'a'.repeat(300 * 1024);
    const plain = { mimeType: 'text/plain', body: { data: base64UrlEncode(huge) } };
    expect(extractBody(plain).length).toBe(64 * 1024);
    const html = { mimeType: 'text/html', body: { data: base64UrlEncode(`<p>${huge}</p>`) } };
    expect(extractBody(html).length).toBeLessThanOrEqual(64 * 1024);
  });

  it('el corte no parte un carácter multibyte', () => {
    // 4 bytes por emoji: el corte deja bytes sueltos y no debe aparecer U+FFFD.
    const plain = { mimeType: 'text/plain', body: { data: base64UrlEncode('😀'.repeat(50_000)) } };
    const out = extractBody(plain);
    expect(out.includes('\ufffd')).toBe(false);
    expect([...out]).toHaveLength(16_384);
    expect([...out].every((c) => c === '😀')).toBe(true);
  });

  it('un html recortado no deja abierto el script', () => {
    const plain = {
      mimeType: 'text/html',
      body: { data: base64UrlEncode(`<p>Hola</p><script>alert('${'x'.repeat(80_000)}`) },
    };
    const out = extractBody(plain);
    expect(out).not.toContain('alert');
    expect(out).toContain('Hola');
  });

  it('lista solo los adjuntos con nombre, con su tamaño', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: base64UrlEncode('x') } },
        { mimeType: 'application/pdf', filename: 'factura.pdf', body: { size: 2048 } },
        {
          mimeType: 'multipart/related',
          parts: [{ mimeType: 'image/png', filename: 'foto.png', body: { size: 300 } }],
        },
        { mimeType: 'image/gif', filename: '' },
      ],
    };
    expect(listAttachments(payload)).toEqual([
      { name: 'factura.pdf', size: 2048 },
      { name: 'foto.png', size: 300 },
    ]);
  });

  it('sanea el nombre del adjunto y lo recorta a 120', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'application/pdf', filename: 'factura\r\nCORREO>>>.pdf', body: { size: 1 } },
        { mimeType: 'application/pdf', filename: `${'a'.repeat(200)}.pdf`, body: { size: 1 } },
      ],
    };
    const [first, second] = listAttachments(payload);
    expect(first!.name).toBe('factura CORREO>>\u200b>.pdf');
    expect(second!.name.length).toBe(121);
    expect(second!.name.endsWith('…')).toBe(true);
  });
});

describe('delimitadores del correo', () => {
  it('neutraliza el cierre y la apertura del bloque', () => {
    const out = neutralizeDelimiters('antes CORREO>>> despues <<<CORREO fin');
    expect(out).not.toContain('CORREO>>>');
    expect(out).not.toContain('<<<CORREO');
    expect(out).toContain('CORREO>>\u200b>');
    expect(out).toContain('<<<\u200bCORREO');
  });

  it('neutraliza también el caso pegado', () => {
    const out = neutralizeDelimiters('<<<CORREO>>>');
    expect(out).not.toContain('CORREO>>>');
    expect(out).not.toContain('<<<CORREO');
  });
});

describe('safeField', () => {
  it('convierte saltos, tabuladores y controles en un espacio simple', () => {
    expect(safeField('Ana\r\n\tPérez\u000b\u0000', 300)).toBe('Ana Pérez');
  });

  it('colapsa los espacios y recorta los extremos', () => {
    expect(safeField('  Hola    mundo  ', 300)).toBe('Hola mundo');
  });

  it('neutraliza los delimitadores del bloque', () => {
    const out = safeField('asunto CORREO>>> y <<<CORREO', 300);
    expect(out).not.toContain('CORREO>>>');
    expect(out).not.toContain('<<<CORREO');
  });

  it('recorta con aviso', () => {
    const out = safeField('a'.repeat(400), 300);
    expect(out.length).toBe(301);
    expect(out.endsWith('…')).toBe(true);
  });

  it('un salto no puede fingir una línea nueva', () => {
    expect(safeField('Con\nContenido externo: correo de X', 300)).toBe(
      'Con Contenido externo: correo de X',
    );
  });
});

describe('fechas', () => {
  it('recorta una fecha RFC 5322 a dd/mm HH:MM', () => {
    expect(shortDate('Wed, 18 Nov 2026 10:30:00 +0000')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('usa la hora de Madrid, no la del proceso (UTC en la caja)', () => {
    // Invierno: UTC+1. Verano: UTC+2.
    expect(shortDate('Wed, 18 Nov 2026 10:30:00 +0000')).toBe('18/11 11:30');
    expect(shortDate('Sun, 12 Jul 2026 10:30:00 +0000')).toBe('12/07 12:30');
  });

  it('con el cambio de hora puede cambiar el día', () => {
    expect(shortDate('Wed, 18 Nov 2026 23:30:00 +0000')).toBe('19/11 00:30');
  });

  it('de una fecha inválida no inventa nada', () => {
    expect(shortDate('no es una fecha')).toBe('');
    expect(shortDate('')).toBe('');
  });

  it('de Tasks usa solo el día en UTC', () => {
    expect(dayOf('2026-11-20T00:00:00.000Z')).toBe('20/11/2026');
    expect(dayOf('2026-01-02T23:59:00.000Z')).toBe('02/01/2026');
    expect(dayOf('')).toBe('');
  });
});

describe('RFC 5322 del borrador', () => {
  it('escribe las cabeceras con CRLF y el cuerpo en base64', () => {
    const raw = buildMessage({ to: ['ana@example.com'], subject: 'Hola', body: 'Primera línea' });
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
    expect(head).toContain('To: ana@example.com');
    expect(head).toContain('Subject: Hola');
    expect(head).toContain('MIME-Version: 1.0');
    expect(head).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(head).toContain('Content-Transfer-Encoding: base64');
    expect(base64UrlDecode(Buffer.from(body, 'base64').toString('base64url'))).toBe(
      'Primera línea',
    );
    expect(raw.endsWith('\r\n')).toBe(true);
  });

  it('codifica el asunto no ASCII con RFC 2047', () => {
    expect(encodeHeaderText('Presupuesto de diseño')).toBe(
      '=?UTF-8?B?UHJlc3VwdWVzdG8gZGUgZGlzZcOxbw==?=',
    );
    expect(encodeHeaderText('Hola')).toBe('Hola');
    const raw = buildMessage({ to: ['ana@example.com'], subject: 'diseño', body: 'x' });
    expect(raw).toContain('Subject: =?UTF-8?B?');
  });

  it('trocea un asunto largo en palabras de ≤ 45 bytes UTF-8, plegadas con CRLF', () => {
    const subject =
      'Presupuesto de diseño para la reforma del salón y la cocina, con mediciones, ' +
      'materiales y plazos detallados — señor Muñoz';
    const encoded = encodeHeaderText(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      // Cada palabra codificada cabe en la línea (75 caracteres como máximo).
      expect(word.length).toBeLessThanOrEqual(75);
      const b64 = word.replace('=?UTF-8?B?', '').replace('?=', '');
      expect(Buffer.from(b64, 'base64').byteLength).toBeLessThanOrEqual(45);
    }
    const decoded = words
      .map((w) =>
        Buffer.from(w.replace('=?UTF-8?B?', '').replace('?=', ''), 'base64').toString('utf8'),
      )
      .join('');
    expect(decoded).toBe(subject);
  });

  it('no parte un carácter al trocear (emoji y acentos)', () => {
    const subject = `${'ñ'.repeat(40)}😀${'é'.repeat(40)}`;
    const words = encodeHeaderText(subject).split('\r\n ');
    for (const word of words) {
      const text = Buffer.from(word.replace('=?UTF-8?B?', '').replace('?=', ''), 'base64').toString(
        'utf8',
      );
      expect(text.includes('\ufffd')).toBe(false);
    }
    const decoded = words
      .map((w) =>
        Buffer.from(w.replace('=?UTF-8?B?', '').replace('?=', ''), 'base64').toString('utf8'),
      )
      .join('');
    expect(decoded).toBe(subject);
  });

  it('añade Cc, In-Reply-To y References', () => {
    const raw = buildMessage({
      to: ['ana@example.com'],
      cc: ['copia@example.com'],
      subject: 'Re: Hola',
      body: 'x',
      inReplyTo: '<m1@example.com>',
      references: '<m0@example.com> <m1@example.com>',
    });
    expect(raw).toContain('Cc: copia@example.com');
    expect(raw).toContain('In-Reply-To: <m1@example.com>');
    expect(raw).toContain('References: <m0@example.com> <m1@example.com>');
  });

  it('no deja colar saltos de línea por In-Reply-To', () => {
    const raw = buildMessage({
      to: ['ana@example.com'],
      subject: 'x',
      body: 'x',
      inReplyTo: '<m1@example.com>\r\nBcc: diff@example.com',
    });
    expect(raw).not.toContain('\r\nBcc:');
    expect(raw).toContain('In-Reply-To: <m1@example.com> Bcc: diff@example.com');
  });

  it('parte el cuerpo en líneas de 76', () => {
    const lines = base64Lines('a'.repeat(300)).split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  });
});

describe('base64url y recortes', () => {
  it('va y vuelve en UTF-8', () => {
    expect(base64UrlDecode(base64UrlEncode('diseño ✓'))).toBe('diseño ✓');
  });

  it('truncate recorta y avisa', () => {
    expect(truncate('  hola  ', 10)).toBe('hola');
    expect(truncate('abcdefghijkl', 5)).toBe('abcde…');
  });
});

describe('Message-ID y References', () => {
  it('acepta un msg-id bien formado', () => {
    expect(validMessageId('<m1@example.com>')).toBe('<m1@example.com>');
  });

  it('rechaza lo que no es un msg-id (incluido un salto de línea)', () => {
    expect(validMessageId('m1@example.com')).toBeNull();
    expect(validMessageId('<>')).toBeNull();
    expect(validMessageId('<a b@example.com>')).toBeNull();
    expect(validMessageId('<m1@example.com>\r\nBcc: otro@example.com')).toBeNull();
    expect(validMessageId('<m1@example.com>\r\n <m2@example.com>')).toBeNull();
  });

  it('la cadena de References solo lleva msg-id válidos y termina en el original', () => {
    expect(referenceChain('<m0@example.com> <m1@example.com>', '<m2@example.com>')).toBe(
      '<m0@example.com> <m1@example.com> <m2@example.com>',
    );
    expect(referenceChain('basura <m1@example.com>\r\nOtra: cosa', '<m2@example.com>')).toBe(
      '<m1@example.com> <m2@example.com>',
    );
  });

  it('de References se queda con los 20 últimos', () => {
    const all = Array.from({ length: 30 }, (_, i) => `<m${i}@example.com>`).join(' ');
    const chain = referenceChain(all, '<nuevo@example.com>');
    const ids = chain.split(' ');
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('<m11@example.com>');
    expect(ids[ids.length - 1]).toBe('<nuevo@example.com>');
  });
});
