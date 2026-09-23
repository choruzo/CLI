/**
 * Tokenizador mínimo de JSON para el editor de Avanzado (D5). No valida (eso
 * lo hace el sidecar contra el schema): solo colorea, y tolera texto a medio
 * escribir — lo que no reconoce sale como `plain`. Lineal: una sola pasada.
 */

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'plain';

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

const TOKEN =
  /("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|([^"\d{}[\],:tfn-]+|[\s\S])/g;

export function tokenizeJson(text: string): JsonToken[] {
  const out: JsonToken[] = [];
  const push = (kind: JsonTokenKind, t: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === 'plain') last.text += t;
    else out.push({ kind, text: t });
  };
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
    if (m[1] !== undefined) {
      push(m[2] !== undefined ? 'key' : 'string', m[1]);
      if (m[2] !== undefined) {
        const colon = m[2];
        const spaces = colon.slice(0, -1);
        if (spaces) push('plain', spaces);
        push('punct', ':');
      }
    } else if (m[3] !== undefined) push('number', m[3]);
    else if (m[4] !== undefined) push('literal', m[4]);
    else if (m[5] !== undefined) push('punct', m[5]);
    else push('plain', m[0]);
  }
  return out;
}
