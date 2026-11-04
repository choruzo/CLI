import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * M18 — reglas de los canales externos que se fijan sobre el código:
 *
 *  1. Solo `channels/telegram/api.ts` habla con Telegram: ningún otro fichero
 *     de `src/` nombra `api.telegram.org` ni llama a `fetch` dentro de
 *     `channels/`. El daemon sigue sin TCP ni HTTP propio (ver
 *     `daemon/architecture.test.ts`); la salida a internet del canal está aquí.
 *  2. Sin webhook: nada de `channels/` escucha ni importa `http`/`https`.
 */

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = walk(src).map((path) => ({
  file: relative(src, path).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
}));

const API = 'channels/telegram/api.ts';

describe('arquitectura de los canales (M18)', () => {
  it('solo api.ts nombra api.telegram.org', () => {
    const naming = files.filter((f) => f.text.includes('api.telegram.org')).map((f) => f.file);
    expect(naming).toEqual([API]);
  });

  it('en channels/, solo api.ts hace peticiones, y ninguno escucha ni importa http', () => {
    for (const { file, text } of files.filter((f) => f.file.startsWith('channels/'))) {
      if (file !== API) expect(/\bfetch\s*\(/.test(text), file).toBe(false);
      expect(/from\s+['"](node:)?(http|https|http2|net|dgram|tls)['"]/.test(text), file).toBe(
        false,
      );
      expect(/\.listen\s*\(/.test(text), file).toBe(false);
    }
  });
});
