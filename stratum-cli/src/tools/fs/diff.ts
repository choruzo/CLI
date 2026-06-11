/**
 * Generador de unified diff sin dependencias externas.
 *
 * Implementa un diff line-based con LCS (programación dinámica). Para proteger
 * memoria en archivos enormes, si el producto de líneas supera un límite se
 * recurre a un fallback simple de prefijo/sufijo común.
 */

type DiffOp = { kind: 'equal' | 'del' | 'add'; line: string };

const MAX_DP_CELLS = 4_000_000; // ~2000x2000 líneas

function diffLines(a: string[], b: string[]): DiffOp[] {
  // Recortar prefijo y sufijo comunes — abarata el DP en el caso típico
  // de ediciones localizadas.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'equal', line: a[i]! });

  if (midA.length * midB.length > MAX_DP_CELLS) {
    // Fallback: bloque completo del/add
    for (const line of midA) ops.push({ kind: 'del', line });
    for (const line of midB) ops.push({ kind: 'add', line });
  } else {
    ops.push(...lcsDiff(midA, midB));
  }

  for (let i = endA; i < a.length; i++) ops.push({ kind: 'equal', line: a[i]! });
  return ops;
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = longitud LCS de a[i..] y b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++]! });
  while (j < m) ops.push({ kind: 'add', line: b[j++]! });
  return ops;
}

/**
 * Genera un unified diff (formato `diff -u`) entre dos contenidos.
 * `context` controla las líneas de contexto alrededor de cada hunk.
 */
export function generateUnifiedDiff(
  path: string,
  before: string,
  after: string,
  context = 3,
): string {
  if (before === after) return '(no changes)';

  const a = before.split('\n');
  const b = after.split('\n');
  const ops = diffLines(a, b);

  // Agrupar en hunks con `context` líneas de contexto
  type Hunk = { startA: number; startB: number; lines: string[]; countA: number; countB: number };
  const hunks: Hunk[] = [];

  let lineA = 0;
  let lineB = 0;
  let current: Hunk | null = null;
  let trailingEqual = 0;

  const flush = () => {
    if (!current) return;
    // recortar el contexto sobrante al final del hunk
    while (trailingEqual > context) {
      current.lines.pop();
      current.countA--;
      current.countB--;
      trailingEqual--;
    }
    hunks.push(current);
    current = null;
    trailingEqual = 0;
  };

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (op.kind === 'equal') {
      if (current) {
        current.lines.push(' ' + op.line);
        current.countA++;
        current.countB++;
        trailingEqual++;
        if (trailingEqual > context * 2) flush();
      }
      lineA++;
      lineB++;
    } else {
      if (!current) {
        // abrir hunk con hasta `context` líneas de contexto previas
        const ctxLines: string[] = [];
        for (let c = Math.max(0, k - context); c < k; c++) {
          if (ops[c]!.kind === 'equal') ctxLines.push(' ' + ops[c]!.line);
        }
        current = {
          startA: lineA - ctxLines.length + 1,
          startB: lineB - ctxLines.length + 1,
          lines: [...ctxLines],
          countA: ctxLines.length,
          countB: ctxLines.length,
        };
      }
      trailingEqual = 0;
      if (op.kind === 'del') {
        current.lines.push('-' + op.line);
        current.countA++;
        lineA++;
      } else {
        current.lines.push('+' + op.line);
        current.countB++;
        lineB++;
      }
    }
  }
  flush();

  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  for (const h of hunks) {
    out.push(`@@ -${h.startA},${h.countA} +${h.startB},${h.countB} @@`);
    out.push(...h.lines);
  }
  return out.join('\n');
}
