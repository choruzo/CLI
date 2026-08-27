import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sshUploadTool, sshDownloadTool } from './sftp.js';
import { resetSshRuntime, closeSshPool } from './runtime.js';
import { startTestServer, type TestServer } from './test-server.js';
import { configWithHost, toolContext } from './ssh-test-utils.js';

describe('ssh_upload / ssh_download', () => {
  let server: TestServer;
  let dir: string;
  let config: ReturnType<typeof configWithHost>;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-sftp-'));
    // Una sola config por test: el pool es un singleton por objeto de config.
    config = configWithHost('dev', server.port);
  });

  afterEach(async () => {
    await closeSshPool();
    resetSshRuntime();
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx() {
    return toolContext(config, { cwd: dir });
  }

  it('sube un fichero y lo recupera con el mismo contenido', async () => {
    const content = 'contenido de prueba\ncon dos líneas\n';
    const source = join(dir, 'origen.txt');
    const remote = join(dir, 'remoto.txt');
    const back = join(dir, 'vuelta.txt');
    writeFileSync(source, content, 'utf-8');

    const up = await sshUploadTool.execute(
      { host: 'dev', localPath: source, remotePath: remote },
      ctx(),
    );
    expect(up.ok).toBe(true);
    if (up.ok) expect(up.output).toContain('dev:');
    expect(readFileSync(remote, 'utf-8')).toBe(content);

    const down = await sshDownloadTool.execute(
      { host: 'dev', remotePath: remote, localPath: back },
      ctx(),
    );
    expect(down.ok).toBe(true);
    expect(readFileSync(back, 'utf-8')).toBe(content);
  });

  it('resuelve rutas locales relativas contra el cwd del contexto', async () => {
    writeFileSync(join(dir, 'relativo.txt'), 'ok', 'utf-8');
    const result = await sshUploadTool.execute(
      { host: 'dev', localPath: 'relativo.txt', remotePath: join(dir, 'subido.txt') },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, 'subido.txt'), 'utf-8')).toBe('ok');
  });

  it('crea el directorio local de destino al descargar', async () => {
    const remote = join(dir, 'fuente.txt');
    writeFileSync(remote, 'datos', 'utf-8');
    const target = join(dir, 'nueva', 'carpeta', 'destino.txt');

    const result = await sshDownloadTool.execute(
      { host: 'dev', remotePath: remote, localPath: target },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('datos');
  });

  it('da un error recuperable y claro si el fichero local no existe', async () => {
    const result = await sshUploadTool.execute(
      { host: 'dev', localPath: join(dir, 'no-existe.txt'), remotePath: '/tmp/x' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.recoverable).toBe(true);
    expect(result.error).toContain('no existe');
  });

  it('rechaza subir un directorio en vez de un fichero', async () => {
    const subdir = join(dir, 'carpeta');
    mkdirSync(subdir);
    const result = await sshUploadTool.execute(
      { host: 'dev', localPath: subdir, remotePath: '/tmp/x' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('es un directorio');
  });

  it('falla de forma recuperable al descargar un fichero remoto inexistente', async () => {
    const result = await sshDownloadTool.execute(
      { host: 'dev', remotePath: join(dir, 'fantasma.txt'), localPath: join(dir, 'x.txt') },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.recoverable).toBe(true);
  });
});
