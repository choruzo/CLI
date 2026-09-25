import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, makeHome, send, waitForIdle, waitForReady } from './harness.mjs';
import { REPORT_BODY } from './mock-llm.mjs';

const NOTE = 'Contenido secreto de la nota';

describe('subida y descarga de ficheros (E2E)', () => {
  let app;
  let saveDir;
  before(async () => {
    const home = makeHome();
    // Fuera del workspace: lo que el usuario «elige» en el diálogo nativo.
    const picks = join(home, 'elegidos');
    saveDir = join(home, 'descargas');
    mkdirSync(picks, { recursive: true });
    mkdirSync(saveDir, { recursive: true });
    writeFileSync(join(picks, 'nota.txt'), `${NOTE}\nsegunda línea\n`);
    app = await launch({
      home,
      env: { STRATUM_E2E_PICK: join(picks, 'nota.txt'), STRATUM_E2E_SAVE_DIR: saveDir },
    });
    await waitForReady(app.session);
  });
  after(async () => {
    await app?.close();
  });

  it('adjunta un fichero y el asistente lo lee desde inputs/', async () => {
    const s = app.session;
    await s.clickButton('Adjuntar ficheros');
    await s.waitFor(() => s.button('Quitar nota.txt'), { message: 'el chip del adjunto' });
    await send(s, 'lee el adjunto, por favor');
    await s.waitForText(`El adjunto dice: ${NOTE}`, { timeout: 60_000 });
    await waitForIdle(s);
    // La copia vive en el workspace de la conversación, no en la ruta elegida.
    const copied = await s.execute(
      `return [...document.querySelectorAll('.tool-call__name')].map((n) => n.textContent)`,
    );
    assert.ok(copied.includes('read_file'), `tools: ${copied}`);
  });

  it('el asistente genera un fichero y se descarga con «Guardar como…»', async () => {
    const s = app.session;
    await send(s, 'genera un informe');
    await s.waitFor(
      () => s.execute(`return [...document.querySelectorAll('.file-card__name')].some((n) => n.textContent === 'informe.md')`),
      { timeout: 60_000, message: 'la tarjeta de informe.md' },
    );
    await waitForIdle(s);
    await s.clickButton('Guardar como…');
    await s.waitForText('Guardado.');
    const target = join(saveDir, 'informe.md');
    assert.ok(existsSync(target), 'no se guardó el fichero');
    assert.equal(readFileSync(target, 'utf8'), REPORT_BODY);
  });
});
