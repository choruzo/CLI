import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext, ToolResult } from '../../agent/types.js';
import { readSharedImage } from '../../images/shared.js';
import { createSendImageTool, exchangeFile } from './send-image.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let root: string;
let exchange: string;
let shared: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stratum-send-image-'));
  exchange = join(root, 'exchange');
  shared = join(root, 'shared');
  mkdirSync(exchange);
  writeFileSync(join(exchange, 'chart.png'), PNG);
  writeFileSync(join(exchange, 'notes.txt'), 'hola');
  writeFileSync(join(root, 'secret.png'), PNG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctx = {} as ToolContext;
const tool = (screen = false) =>
  createSendImageTool({
    exchangeDir: exchange,
    sharedDir: shared,
    screen: screen ? { kind: 'container', name: 'box' } : null,
  });

function error(r: ToolResult): string {
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
}

describe('send_image (6E)', () => {
  it('una imagen de /exchange se copia al almacén y sale como shared, con su pie', async () => {
    const r = await tool().execute({ path: '/exchange/chart.png', caption: ' mira ' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shared).toMatchObject({ mime: 'image/png', bytes: PNG.length, caption: 'mira' });
    expect(readSharedImage(r.shared!.id, shared)?.data.equals(PNG)).toBe(true);
    // Una ruta relativa se lee dentro de /exchange.
    expect((await tool().execute({ path: 'chart.png' }, ctx)).ok).toBe(true);
  });

  it('nada fuera de /exchange: .., absoluta de otra carpeta, ni un enlace que sale', async () => {
    let linked = true;
    try {
      symlinkSync(join(root, 'secret.png'), join(exchange, 'link.png'));
    } catch {
      // Sin permiso para enlaces (Windows sin modo desarrollador): se prueba lo demás.
      linked = false;
    }
    for (const path of ['/exchange/../secret.png', '../secret.png', '/etc/passwd', '/exchange']) {
      expect(error(await tool().execute({ path }, ctx))).toMatch(/inside \/exchange|not found/);
    }
    if (linked) {
      expect(typeof exchangeFile('/exchange/link.png', exchange)).not.toBe('string');
      expect(error(await tool().execute({ path: '/exchange/link.png' }, ctx))).toMatch(
        /inside \/exchange/,
      );
    }
  });

  it('lo que no es una imagen no sale', async () => {
    expect(error(await tool().execute({ path: '/exchange/notes.txt' }, ctx))).toMatch(
      /not a PNG, JPEG, WebP or GIF/,
    );
  });

  it('o path o screen; screen sin pantalla en la caja no vale', async () => {
    expect(error(await tool().execute({}, ctx))).toMatch(/either path/);
    expect(error(await tool().execute({ path: 'chart.png', screen: true }, ctx))).toMatch(
      /either path/,
    );
    expect(error(await tool().execute({ screen: true }, ctx))).toMatch(/no screen/);
  });
});
