import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileTail } from './tail.js';

describe('FileTail', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'file-tail-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('con presupuesto lee por tramos y entrega cada línea una vez, aunque un carácter quede partido', async () => {
    const file = join(dir, 't.jsonl');
    // «é» son dos bytes: con tramos de 7 bytes alguno cae a mitad de carácter.
    const lines = Array.from({ length: 40 }, (_, i) => `é${i}é`);
    writeFileSync(file, lines.join('\n') + '\n');
    const got: string[] = [];
    const tail = new FileTail(
      file,
      (l) => got.push(l),
      () => got.push('RESET'),
    );
    let polls = 0;
    for (;;) {
      const read = await tail.poll(7);
      expect(read).not.toBeNull();
      expect(read!).toBeLessThanOrEqual(7);
      if (read === 0) break;
      polls++;
    }
    expect(polls).toBeGreaterThan(10);
    expect(got).toEqual(lines);
  });

  it('sin fichero devuelve 0; un sondeo en curso hace que el segundo devuelva null', async () => {
    const file = join(dir, 'nada.jsonl');
    const tail = new FileTail(
      file,
      () => undefined,
      () => undefined,
    );
    expect(await tail.poll()).toBe(0);
    appendFileSync(file, 'a\n');
    const [first, second] = await Promise.all([tail.poll(), tail.poll()]);
    expect(first).toBe(2);
    expect(second).toBeNull();
  });
});
