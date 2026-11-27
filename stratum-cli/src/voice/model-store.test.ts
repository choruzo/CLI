/**
 * Tests del almacén del modelo con un `fetch` falso y ficheros de verdad (unos
 * pocos bytes): lo que se prueba es la descarga, la marca, los estados, el
 * cerrojo y el borrado, no los 4 GB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { createHash } from 'crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  assertVoiceModelLoadable,
  downloadVoiceModel,
  formatBytes,
  removeVoiceModel,
  resealVoiceModel,
  voiceModelStatus,
  VOICE_MODEL_LOCK_STALE_MS,
  VOICE_MODEL_MARKER,
  VoiceModelBusyError,
  VoiceModelDownloadError,
  VoiceModelIntegrityError,
  VoiceModelManifestError,
  VoiceModelNotReadyError,
  VoiceModelPathError,
  VoiceModelSpaceError,
  type VoiceModelFileStatus,
} from './model-store.js';
import type { VoiceModelFile } from './manifest.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const CONTENT_A = 'aaaa';
const CONTENT_B = 'bbbbbbbb';

/** Manifiesto pequeño: dos ficheros, como los de verdad pero de 12 bytes. */
const SMALL_MANIFEST: readonly VoiceModelFile[] = [
  {
    path: 'a.bin',
    size: CONTENT_A.length,
    sha256: sha(CONTENT_A),
    // Las URLs del manifiesto son de Hugging Face: la descarga no sale de ahí.
    url: 'https://huggingface.co/istupakov/test/a.bin',
  },
  {
    path: 'b.bin',
    size: CONTENT_B.length,
    sha256: sha(CONTENT_B),
    url: 'https://huggingface.co/istupakov/test/b.bin',
  },
];

const A_URL = SMALL_MANIFEST[0]!.url;

interface Served {
  body?: string;
  status?: number;
  /** Cuerpo mayor que el declarado en el manifiesto. */
  oversized?: boolean;
}

/** `fetch` falso: sirve lo que le digan por URL. */
function fakeFetch(served: Record<string, Served> = {}): typeof fetch {
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = url.endsWith('/a.bin') ? 'a.bin' : url.endsWith('/b.bin') ? 'b.bin' : '';
    const entry = served[key] ?? { body: key === 'a.bin' ? CONTENT_A : CONTENT_B };
    if (entry.status !== undefined && entry.status !== 200) {
      return new Response('nope', { status: entry.status });
    }
    const body = entry.oversized ? `${key === 'a.bin' ? CONTENT_A : CONTENT_B}EXTRA` : entry.body;
    return new Response(body ?? '');
  }) as typeof fetch;
  return impl;
}

const freeSpace = async (): Promise<{ bavail: number; bsize: number }> => ({
  bavail: 100 * 1024 * 1024,
  bsize: 1024,
});

let root: string;
let dir: string;

beforeEach(() => {
  // `realpath`: el estado exige que la ruta no pase por ningún enlace, y en
  // macOS el temporal del sistema ya es un enlace (`/var` → `/private/var`).
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stratum-voice-')));
  dir = join(root, 'canary-1b-v2');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const status = async (verify = false) =>
  voiceModelStatus({ dir, verify, manifest: SMALL_MANIFEST });

const download = async (extra: Partial<Parameters<typeof downloadVoiceModel>[0]> = {}) =>
  downloadVoiceModel({
    dir,
    manifest: SMALL_MANIFEST,
    fetch: fakeFetch(),
    statfs: freeSpace,
    now: () => 1_700_000_000_000,
    ...extra,
  });

/** Espera a que algo se cumpla (los procesos hijos van a su ritmo). */
async function until(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('la condición no se cumplió a tiempo');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('descarga del modelo de voz', () => {
  it('baja los ficheros, escribe la marca y deja el estado en ready', async () => {
    const progress: number[] = [];
    await download({ onProgress: (p) => progress.push(p.bytes) });
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, 'a.bin'), 'utf-8')).toBe(CONTENT_A);
    expect(readFileSync(join(dir, 'b.bin'), 'utf-8')).toBe(CONTENT_B);

    const marker = JSON.parse(readFileSync(join(dir, VOICE_MODEL_MARKER), 'utf-8'));
    expect(marker.schemaVersion).toBe(1);
    expect(marker.model).toBe('canary-1b-v2');
    expect(marker.files.map((f: { path: string }) => f.path)).toEqual(['a.bin', 'b.bin']);
    expect(marker.files[0].sha256).toBe(sha(CONTENT_A));
    expect(marker.files[0].mtimeMs).toBe(statSync(join(dir, 'a.bin')).mtimeMs);
    // La marca apunta también el inodo: es lo que detecta un fichero cambiado
    // sin recalcular 4 GB de SHA en cada arranque.
    expect(marker.files[0].ino).toBe(String(lstatSync(join(dir, 'a.bin'), { bigint: true }).ino));

    const state = await status();
    expect(state.state).toBe('ready');
    expect(state.files.map((f: VoiceModelFileStatus) => f.size)).toEqual([
      CONTENT_A.length,
      CONTENT_B.length,
    ]);
    // Sin `verify` no se calcula ninguna suma: no puede salir `true`.
    expect(state.files.every((f) => f.sha256Ok === undefined)).toBe(true);

    // El progreso avanza y acaba en el total.
    expect(progress.at(-1)).toBe(CONTENT_A.length + CONTENT_B.length);
    expect(progress).toEqual([...progress].sort((x, y) => x - y));

    // No quedan temporales ni `.old` al lado.
    expect(readdirSync(root).filter((n) => n.startsWith('.canary-1b-v2.'))).toEqual([]);
  });

  it('una descarga nueva aparta la anterior y la sustituye', async () => {
    await download();
    writeFileSync(join(dir, 'a.bin'), 'xxxx');
    const state = await status();
    expect(state.state).toBe('corrupt');

    await download();
    expect(readFileSync(join(dir, 'a.bin'), 'utf-8')).toBe(CONTENT_A);
    expect((await status()).state).toBe('ready');
    expect(readdirSync(root).filter((n) => n.startsWith('.canary-1b-v2.old-'))).toEqual([]);
  });

  it('una suma que no cuadra no deja ni el directorio ni el temporal', async () => {
    const manifest: readonly VoiceModelFile[] = [
      { ...SMALL_MANIFEST[0]!, sha256: sha('otra cosa') },
    ];
    await expect(download({ manifest })).rejects.toBeInstanceOf(VoiceModelIntegrityError);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(root).filter((n) => n.startsWith('.canary-1b-v2.tmp-'))).toEqual([]);
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  it('un cuerpo más grande que el tamaño esperado aborta en ese momento', async () => {
    await expect(download({ fetch: fakeFetch({ 'a.bin': { oversized: true } }) })).rejects.toThrow(
      /pasa de los/,
    );
    expect(existsSync(dir)).toBe(false);
  });

  it('un HTTP que no es 2xx es un error y no publica nada', async () => {
    const failing = fakeFetch({ 'b.bin': { status: 500 } });
    await expect(download({ fetch: failing })).rejects.toBeInstanceOf(VoiceModelDownloadError);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  it('abortar a mitad borra el temporal', async () => {
    const controller = new AbortController();
    await expect(
      download({
        signal: controller.signal,
        onProgress: (p) => {
          if (p.bytes > 0) controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(root).filter((n) => n.startsWith('.canary-1b-v2.tmp-'))).toEqual([]);
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  it('sin espacio suficiente no se baja nada', async () => {
    const noSpace = async (): Promise<{ bavail: number; bsize: number }> => ({
      bavail: 1,
      bsize: 1024,
    });
    await expect(download({ statfs: noSpace })).rejects.toBeInstanceOf(VoiceModelSpaceError);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  it('los restos de una pasada anterior se borran antes de empezar', async () => {
    const leftover = join(root, '.canary-1b-v2.tmp-0123abcd');
    mkdirSync(leftover);
    writeFileSync(join(leftover, 'a.bin'), 'basura');
    await download();
    expect(existsSync(leftover)).toBe(false);
    expect((await status()).state).toBe('ready');
  });

  it('un resto con un nombre que no es el nuestro no se toca', async () => {
    // Ni un `.tmp` sin el prefijo, ni uno con un sufijo que no es [0-9a-z-].
    const raros = ['.canary-1b-v2.tmp-BAD!', 'canary-1b-v2.tmp-abc', '.canary-1b-v2.tmp-'];
    for (const name of raros) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'f'), 'no se toca');
    }
    await download();
    for (const name of raros) expect(existsSync(join(root, name))).toBe(true);
  });

  it('un `.old` bueno sin modelo en su sitio se restaura antes de seguir', async () => {
    // Es la única copia que queda: borrarla sería perder el modelo.
    await download();
    const old = join(root, '.canary-1b-v2.old-abc123');
    renameSync(dir, old);

    const noSpace = async (): Promise<{ bavail: number; bsize: number }> => ({
      bavail: 0,
      bsize: 0,
    });
    await expect(download({ statfs: noSpace })).rejects.toBeInstanceOf(VoiceModelSpaceError);
    // La descarga no llegó a empezar, así que lo que hay en `dir` es el `.old`.
    expect((await status()).state).toBe('ready');
    expect(existsSync(old)).toBe(false);
  });

  it('un `.old` a medias no se restaura, y sin modelo bueno tampoco se borra', async () => {
    const old = join(root, '.canary-1b-v2.old-abc123');
    mkdirSync(old);
    writeFileSync(join(old, 'a.bin'), CONTENT_A);
    const noSpace = async (): Promise<{ bavail: number; bsize: number }> => ({
      bavail: 0,
      bsize: 0,
    });
    await expect(download({ statfs: noSpace })).rejects.toBeInstanceOf(VoiceModelSpaceError);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(old)).toBe(true);
    // Con un modelo bueno ya publicado, la copia sobra y se tira.
    await download();
    expect((await status()).state).toBe('ready');
    await download();
    expect(existsSync(old)).toBe(false);
  });

  it('lo que `remove` dejó a medias (`.trash`) se tira y nunca se restaura', async () => {
    await download();
    const trash = join(root, '.canary-1b-v2.trash-abc123');
    renameSync(dir, trash);
    const noSpace = async (): Promise<{ bavail: number; bsize: number }> => ({
      bavail: 0,
      bsize: 0,
    });
    await expect(download({ statfs: noSpace })).rejects.toBeInstanceOf(VoiceModelSpaceError);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(trash)).toBe(false);
  });

  it('el directorio tiene que llamarse canary-1b-v2', async () => {
    const otro = join(root, 'otro-modelo');
    await expect(
      downloadVoiceModel({
        dir: otro,
        manifest: SMALL_MANIFEST,
        fetch: fakeFetch(),
        statfs: freeSpace,
      }),
    ).rejects.toBeInstanceOf(VoiceModelPathError);
    expect(existsSync(otro)).toBe(false);
    await expect(removeVoiceModel({ dir: otro })).rejects.toBeInstanceOf(VoiceModelPathError);
  });

  it('un padre que es un enlace no se toca', async () => {
    const real = join(root, 'real');
    mkdirSync(real);
    const link = join(root, 'enlace');
    try {
      symlinkSync(real, link, 'junction');
    } catch {
      // Windows sin permisos para crear enlaces: la regla la cubre el código.
      return;
    }
    await expect(
      downloadVoiceModel({
        dir: join(link, 'canary-1b-v2'),
        manifest: SMALL_MANIFEST,
        fetch: fakeFetch(),
        statfs: freeSpace,
      }),
    ).rejects.toBeInstanceOf(VoiceModelPathError);
    expect(existsSync(join(real, 'canary-1b-v2'))).toBe(false);
  });

  it('un manifiesto con rutas que no son nombres de fichero no se acepta', async () => {
    const escapes: readonly VoiceModelFile[] = [
      { path: '../fuera.bin', size: 4, sha256: sha('aaaa'), url: A_URL },
    ];
    await expect(download({ manifest: escapes })).rejects.toBeInstanceOf(VoiceModelManifestError);
    expect(existsSync(dir)).toBe(false);

    const absoluta: readonly VoiceModelFile[] = [
      { path: '/etc/passwd', size: 4, sha256: sha('aaaa'), url: A_URL },
    ];
    await expect(download({ manifest: absoluta })).rejects.toBeInstanceOf(VoiceModelManifestError);

    const duplicado: readonly VoiceModelFile[] = [SMALL_MANIFEST[0]!, SMALL_MANIFEST[0]!];
    await expect(download({ manifest: duplicado })).rejects.toBeInstanceOf(VoiceModelManifestError);
    // También al mirar el estado: se valida antes de tocar el disco.
    await expect(voiceModelStatus({ dir, manifest: duplicado })).rejects.toBeInstanceOf(
      VoiceModelManifestError,
    );
  });

  it('una redirección dentro de Hugging Face se sigue, con `redirect: manual`', async () => {
    const final = 'https://hf.co/istupakov/test/a.bin';
    const seen: Array<string | undefined> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.redirect);
      const url = typeof input === 'string' ? input : input.toString();
      if (url === A_URL) return new Response(null, { status: 302, headers: { location: final } });
      if (url === final) return new Response(CONTENT_A);
      return new Response(CONTENT_B);
    }) as unknown as typeof fetch;

    await download({ fetch: fetchImpl });
    expect((await status()).state).toBe('ready');
    expect(seen.every((value) => value === 'manual')).toBe(true);
  });

  it('una redirección a otro host no se sigue', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === A_URL) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/a.bin' },
        });
      }
      return new Response(CONTENT_B);
    }) as unknown as typeof fetch;

    await expect(download({ fetch: fetchImpl })).rejects.toBeInstanceOf(VoiceModelDownloadError);
    expect(existsSync(dir)).toBe(false);
  });

  it('una redirección a http: no se sigue', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === A_URL) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://huggingface.co/istupakov/test/a.bin' },
        });
      }
      return new Response(CONTENT_B);
    }) as unknown as typeof fetch;

    await expect(download({ fetch: fetchImpl })).rejects.toThrow(/https/);
  });
});

describe('el cerrojo del modelo', () => {
  const lock = (): string => `${dir}.lock`;
  const owner = (pid: number, token = 'ab'.repeat(16)) =>
    JSON.stringify({ pid, token, createdAt: Date.now() });
  /** Un cerrojo como lo deja otro proceso: el directorio y su `owner.json`. */
  function putLock(content?: string, ageMs = 0): void {
    mkdirSync(lock());
    if (content !== undefined) writeFileSync(join(lock(), 'owner.json'), content);
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      utimesSync(lock(), old, old);
    }
  }
  const STALE = VOICE_MODEL_LOCK_STALE_MS + 60_000;

  it('con el cerrojo de un proceso vivo, otra descarga no empieza', async () => {
    putLock(owner(process.pid));
    await expect(download()).rejects.toBeInstanceOf(VoiceModelBusyError);
    expect(existsSync(dir)).toBe(false);
    // El cerrojo del otro sigue ahí: no lo quita quien no es su dueño.
    expect(readFileSync(join(lock(), 'owner.json'), 'utf-8')).toContain(String(process.pid));
  });

  it('el cerrojo propio es un directorio con su dueño entero (pid, token y fecha)', async () => {
    let seen: unknown;
    await download({
      onProgress: () => {
        seen ??= JSON.parse(readFileSync(join(lock(), 'owner.json'), 'utf-8'));
      },
    });
    expect(seen).toMatchObject({ pid: process.pid });
    expect((seen as { token: string }).token).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof (seen as { createdAt: unknown }).createdAt).toBe('number');
    expect(existsSync(lock())).toBe(false);
  });

  it('un cerrojo de un proceso que ya no vive se quita y la descarga sigue', async () => {
    // pid imposible: nadie lo tiene tomado.
    putLock(owner(999999));
    await download();
    expect((await status()).state).toBe('ready');
    expect(existsSync(lock())).toBe(false);
    expect(existsSync(`${lock()}.recover`)).toBe(false);
  });

  it('un pid vivo sin latido en 5 min es un cerrojo muerto (pid reciclado)', async () => {
    putLock(owner(process.pid), STALE);
    await download();
    expect((await status()).state).toBe('ready');
  });

  it('un cerrojo sin dueño legible es un resto y se recupera (se publica siempre con dueño)', async () => {
    putLock('basura que no es JSON');
    await download();
    expect((await status()).state).toBe('ready');
    expect(existsSync(lock())).toBe(false);
  });

  it('un `.recover` abandonado (dueño muerto) se aparta y el siguiente intento recupera', async () => {
    putLock(owner(999999));
    mkdirSync(`${lock()}.recover`);
    writeFileSync(join(`${lock()}.recover`, 'owner.json'), owner(999999, 'ef'.repeat(16)));
    // Este intento lo encuentra ocupado y aparta el abandonado...
    await expect(download()).rejects.toBeInstanceOf(VoiceModelBusyError);
    expect(existsSync(`${lock()}.recover`)).toBe(false);
    // ...y el siguiente ya puede recuperar el cerrojo muerto.
    await download();
    expect((await status()).state).toBe('ready');
  });

  it('un fichero donde va el cerrojo (formato anterior) solo se aparta cuando es viejo', async () => {
    writeFileSync(lock(), String(process.pid));
    await expect(download()).rejects.toBeInstanceOf(VoiceModelBusyError);
    const old = new Date(Date.now() - STALE);
    utimesSync(lock(), old, old);
    await download();
    expect((await status()).state).toBe('ready');
  });

  it('con otro proceso recuperando (`.recover` reciente), no se toca nada', async () => {
    putLock(owner(999999));
    mkdirSync(`${lock()}.recover`);
    writeFileSync(join(`${lock()}.recover`, 'owner.json'), owner(process.pid, 'ef'.repeat(16)));
    await expect(download()).rejects.toBeInstanceOf(VoiceModelBusyError);
    expect(existsSync(lock())).toBe(true);
    // El `.recover` vivo del otro no se toca.
    expect(existsSync(`${lock()}.recover`)).toBe(true);
  });

  it('un `.recover` con dueño vivo y reciente no se aparta aunque su directorio sea viejo', async () => {
    // Lo que cuenta es su dueño (inmutable), no el `mtime` del directorio: un
    // `.recover` recién publicado puede ocupar el sitio de uno viejo.
    putLock(owner(999999));
    const guard = `${lock()}.recover`;
    mkdirSync(guard);
    writeFileSync(join(guard, 'owner.json'), owner(process.pid, 'ef'.repeat(16)));
    const old = new Date(Date.now() - STALE);
    utimesSync(guard, old, old);
    await expect(download()).rejects.toBeInstanceOf(VoiceModelBusyError);
    expect(JSON.parse(readFileSync(join(guard, 'owner.json'), 'utf-8')).token).toBe(
      'ef'.repeat(16),
    );
  });

  it('las preparaciones `.new` abandonadas se limpian; las recientes de otro, no', async () => {
    const stale = `${lock()}.${'11'.repeat(16)}.new`;
    mkdirSync(stale);
    writeFileSync(
      join(stale, 'owner.json'),
      JSON.stringify({ pid: 999999, token: '11'.repeat(16), createdAt: Date.now() - STALE }),
    );
    const fresh = `${lock()}.${'22'.repeat(16)}.new`;
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'owner.json'), owner(process.pid, '22'.repeat(16)));
    await download();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('si el cerrojo deja de ser suyo a mitad, no publica nada ni borra el ajeno', async () => {
    const ajeno = owner(process.pid, 'cd'.repeat(16));
    await expect(
      download({
        onProgress: () => {
          // Alguien ha puesto el suyo mientras la descarga estaba en marcha.
          writeFileSync(join(lock(), 'owner.json'), ajeno);
        },
      }),
    ).rejects.toBeInstanceOf(VoiceModelBusyError);
    expect(existsSync(dir)).toBe(false);
    expect(JSON.parse(readFileSync(join(lock(), 'owner.json'), 'utf-8')).token).toBe(
      'cd'.repeat(16),
    );
  });

  it('dos procesos a la vez: uno descarga y el otro recibe VoiceModelBusyError', async () => {
    const fixture = fileURLToPath(new URL('./__fixtures__/download-lock.ts', import.meta.url));
    const tsxLoader = pathToFileURL(
      join(
        dirname(createRequire(import.meta.url).resolve('tsx/package.json')),
        'dist',
        'loader.mjs',
      ),
    ).href;
    const gate = join(root, 'go');
    const runs = [0, 1].map((index) =>
      execa(
        process.execPath,
        ['--import', tsxLoader, fixture, root, gate, join(root, `ready-${index}`)],
        { reject: false, timeout: 60_000 },
      ),
    );
    // Los dos hijos ya tienen el módulo cargado cuando aparece el `go`: la
    // carrera es de verdad, no de quién arranca antes.
    await until(() => existsSync(join(root, 'ready-0')) && existsSync(join(root, 'ready-1')));
    writeFileSync(gate, 'go');

    const results = await Promise.all(runs);
    const lines = results.map((result) => result.stdout.trim());
    expect(lines.filter((line) => line === 'ok')).toHaveLength(1);
    expect(lines.filter((line) => line === 'VoiceModelBusyError')).toHaveLength(1);
    // La que descargó dejó el modelo bueno y el cerrojo suelto.
    expect((await status()).state).toBe('ready');
    expect(existsSync(`${dir}.lock`)).toBe(false);
  }, 90_000);
});

describe('estado del modelo de voz', () => {
  it('sin directorio: missing, y los ficheros esperados se listan igual', async () => {
    const state = await status();
    expect(state.state).toBe('missing');
    expect(state.files).toEqual([
      { path: 'a.bin', expectedSize: CONTENT_A.length },
      { path: 'b.bin', expectedSize: CONTENT_B.length },
    ]);
  });

  it('sin la marca: incomplete', async () => {
    await download();
    rmSync(join(dir, VOICE_MODEL_MARKER));
    expect((await status()).state).toBe('incomplete');
  });

  it('si falta un fichero: incomplete', async () => {
    await download();
    rmSync(join(dir, 'b.bin'));
    const state = await status();
    expect(state.state).toBe('incomplete');
    expect(state.files[1]).toEqual({ path: 'b.bin', expectedSize: CONTENT_B.length });
  });

  it('una marca de otro manifiesto: outdated', async () => {
    await download();
    const marker = JSON.parse(readFileSync(join(dir, VOICE_MODEL_MARKER), 'utf-8'));
    marker.files[0].sha256 = sha('otra versión');
    writeFileSync(join(dir, VOICE_MODEL_MARKER), JSON.stringify(marker));
    expect((await status()).state).toBe('outdated');
    // Y una marca ilegible también: no se interpreta a medias.
    writeFileSync(join(dir, VOICE_MODEL_MARKER), '{ roto');
    expect((await status()).state).toBe('outdated');
  });

  it('una marca sin `ino` (de antes de la fase 2) es corrupt', async () => {
    await download();
    const marker = JSON.parse(readFileSync(join(dir, VOICE_MODEL_MARKER), 'utf-8'));
    for (const file of marker.files) delete file.ino;
    writeFileSync(join(dir, VOICE_MODEL_MARKER), JSON.stringify(marker));
    // El tamaño, el `mtime` y la suma cuadran, pero no se sabe si el fichero es
    // el mismo: se dice dañado y `stratum voice reseal` lo arregla.
    expect((await status()).state).toBe('corrupt');
  });

  it('una marca que no es un fichero normal es corrupt', async () => {
    await download();
    const markerPath = join(dir, VOICE_MODEL_MARKER);
    rmSync(markerPath);
    mkdirSync(markerPath);
    expect((await status()).state).toBe('corrupt');
  });

  it('un tamaño distinto al del manifiesto: corrupt', async () => {
    await download();
    truncateSync(join(dir, 'a.bin'), 2);
    const state = await status();
    expect(state.state).toBe('corrupt');
    expect(state.files[0]!.size).toBe(2);
  });

  it('un mtime distinto al de la marca: corrupt', async () => {
    await download();
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'a.bin'), old, old);
    expect((await status()).state).toBe('corrupt');
  });

  it('un inodo distinto al de la marca: corrupt', async () => {
    await download();
    // El mismo contenido, otro fichero: es un cambio que la marca tiene que ver.
    renameSync(join(dir, 'a.bin'), join(dir, 'a.viejo'));
    writeFileSync(join(dir, 'a.bin'), CONTENT_A);
    const marker = JSON.parse(readFileSync(join(dir, VOICE_MODEL_MARKER), 'utf-8'));
    marker.files[0].mtimeMs = statSync(join(dir, 'a.bin')).mtimeMs;
    writeFileSync(join(dir, VOICE_MODEL_MARKER), JSON.stringify(marker));
    expect((await status()).state).toBe('corrupt');
  });

  it('con verify, un contenido cambiado del mismo tamaño sale corrupt', async () => {
    await download();
    writeFileSync(join(dir, 'a.bin'), 'zzzz'); // mismos 4 bytes, otra suma
    // Se pone el mtime nuevo en la marca para que la única diferencia sea el contenido.
    const markerPath = join(dir, VOICE_MODEL_MARKER);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    marker.files[0].mtimeMs = statSync(join(dir, 'a.bin')).mtimeMs;
    writeFileSync(markerPath, JSON.stringify(marker));

    const withoutVerify = await status();
    expect(withoutVerify.state).toBe('ready');
    expect(withoutVerify.files[0]!.sha256Ok).toBeUndefined();

    const verified = await status(true);
    expect(verified.state).toBe('corrupt');
    expect(verified.files[0]!.sha256Ok).toBe(false);
    expect(verified.files[1]!.sha256Ok).toBe(true);
  });

  it('un enlace no es un fichero normal: corrupt', async () => {
    await download();
    const real = join(dir, 'a.bin');
    const moved = join(dir, 'a.real');
    renameSync(real, moved);
    try {
      symlinkSync(moved, real);
    } catch {
      // En Windows sin permisos de desarrollador no se puede crear un enlace:
      // el caso queda cubierto por el `lstat` del código.
      return;
    }
    expect((await status()).state).toBe('corrupt');
  });

  it('un enlace en un ancestro de la ruta: corrupt', async () => {
    const real = join(root, 'real');
    const realDir = join(real, 'canary-1b-v2');
    await downloadVoiceModel({
      dir: realDir,
      manifest: SMALL_MANIFEST,
      fetch: fakeFetch(),
      statfs: freeSpace,
    });
    const link = join(root, 'enlace');
    try {
      symlinkSync(real, link, 'junction');
    } catch {
      return;
    }
    const throughLink = await voiceModelStatus({
      dir: join(link, 'canary-1b-v2'),
      manifest: SMALL_MANIFEST,
    });
    expect(throughLink.state).toBe('corrupt');
    // Por la ruta real, el mismo modelo está perfecto.
    const direct = await voiceModelStatus({ dir: realDir, manifest: SMALL_MANIFEST });
    expect(direct.state).toBe('ready');
  });

  it('corrupt gana a incomplete, e incomplete a outdated', async () => {
    await download();
    // Falta un fichero (incomplete) y el otro está dañado (corrupt).
    rmSync(join(dir, 'b.bin'));
    truncateSync(join(dir, 'a.bin'), 1);
    expect((await status()).state).toBe('corrupt');

    // Sin el daño, manda incomplete aunque la marca sea de otro manifiesto.
    await download();
    rmSync(join(dir, 'b.bin'));
    const markerPath = join(dir, VOICE_MODEL_MARKER);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    marker.files[0].sha256 = sha('otra versión');
    writeFileSync(markerPath, JSON.stringify(marker));
    expect((await status()).state).toBe('incomplete');
  });

  it('assertVoiceModelLoadable falla cerrado si el modelo no está listo', async () => {
    // Con el manifiesto de verdad, cualquier cosa que no sea `ready` (aquí: no hay
    // directorio) no se carga: el worker no adivina.
    await expect(assertVoiceModelLoadable(dir)).rejects.toBeInstanceOf(VoiceModelNotReadyError);
    expect((await status()).state).toBe('missing');
    await download();
    // El modelo pequeño de los tests no es el de verdad: sigue sin ser cargable.
    await expect(assertVoiceModelLoadable(dir)).rejects.toThrow(/no está listo/);
  });
});

describe('reseal (rehacer la marca sin volver a descargar)', () => {
  it('con las sumas buenas, reescribe la marca y el modelo pasa a ready', async () => {
    await download();
    // Una marca de antes de la fase 2: sin `ino`.
    const markerPath = join(dir, VOICE_MODEL_MARKER);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    for (const file of marker.files) delete file.ino;
    writeFileSync(markerPath, JSON.stringify(marker));
    expect((await status()).state).toBe('corrupt');

    const resealed = await resealVoiceModel({ dir, manifest: SMALL_MANIFEST });
    expect(resealed.files.map((file) => file.path)).toEqual(['a.bin', 'b.bin']);
    expect(resealed.files.every((file) => (file.ino ?? '').length > 0)).toBe(true);
    expect((await status()).state).toBe('ready');

    const onDisk = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.files[0].ino).toBe(String(lstatSync(join(dir, 'a.bin'), { bigint: true }).ino));
    expect(onDisk.files[0].mtimeMs).toBe(lstatSync(join(dir, 'a.bin')).mtimeMs);
  });

  it('si una suma no cuadra, no escribe nada', async () => {
    await download();
    const markerPath = join(dir, VOICE_MODEL_MARKER);
    const before = readFileSync(markerPath, 'utf-8');
    writeFileSync(join(dir, 'a.bin'), 'zzzz');
    await expect(resealVoiceModel({ dir, manifest: SMALL_MANIFEST })).rejects.toBeInstanceOf(
      VoiceModelIntegrityError,
    );
    expect(readFileSync(markerPath, 'utf-8')).toBe(before);
  });

  it('con el cerrojo de otro tomado, no sella', async () => {
    await download();
    const markerPath = join(dir, VOICE_MODEL_MARKER);
    const before = readFileSync(markerPath, 'utf-8');
    mkdirSync(`${dir}.lock`);
    writeFileSync(
      join(`${dir}.lock`, 'owner.json'),
      JSON.stringify({ pid: process.pid, token: 'ab'.repeat(16), createdAt: Date.now() }),
    );
    await expect(resealVoiceModel({ dir, manifest: SMALL_MANIFEST })).rejects.toBeInstanceOf(
      VoiceModelBusyError,
    );
    expect(readFileSync(markerPath, 'utf-8')).toBe(before);
  });

  it('un directorio con otro nombre no se sella', async () => {
    await expect(
      resealVoiceModel({ dir: join(root, 'otro'), manifest: SMALL_MANIFEST }),
    ).rejects.toBeInstanceOf(VoiceModelPathError);
  });

  it('sin modelo no hay nada que rehacer', async () => {
    await expect(resealVoiceModel({ dir, manifest: SMALL_MANIFEST })).rejects.toBeInstanceOf(
      VoiceModelNotReadyError,
    );
    expect(existsSync(dir)).toBe(false);
  });
});

describe('borrado del modelo de voz', () => {
  it('borra el directorio y no queda nada al lado', async () => {
    await download();
    await expect(removeVoiceModel({ dir })).resolves.toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    // Sin modelo, no hay nada que borrar (y no es un error).
    await expect(removeVoiceModel({ dir })).resolves.toBe(false);
  });

  it('también retira las copias `.old`: lo borrado no vuelve con la siguiente descarga', async () => {
    await download();
    const old = join(root, '.canary-1b-v2.old-abc123');
    renameSync(dir, old);
    await download();
    await expect(removeVoiceModel({ dir })).resolves.toBe(true);
    expect(readdirSync(root)).toEqual([]);
    // Una descarga que no llega a bajar nada no puede resucitar nada.
    const noSpace = async (): Promise<{ bavail: number; bsize: number }> => ({
      bavail: 0,
      bsize: 0,
    });
    await expect(download({ statfs: noSpace })).rejects.toBeInstanceOf(VoiceModelSpaceError);
    expect(existsSync(dir)).toBe(false);
  });

  it('con solo una copia `.old` (sin modelo), también la borra', async () => {
    await download();
    const old = join(root, '.canary-1b-v2.old-abc123');
    renameSync(dir, old);
    await expect(removeVoiceModel({ dir })).resolves.toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('con el cerrojo tomado no borra', async () => {
    await download();
    mkdirSync(`${dir}.lock`);
    writeFileSync(
      join(`${dir}.lock`, 'owner.json'),
      JSON.stringify({ pid: process.pid, token: 'ab'.repeat(16), createdAt: Date.now() }),
    );
    await expect(removeVoiceModel({ dir })).rejects.toBeInstanceOf(VoiceModelBusyError);
    expect(existsSync(dir)).toBe(true);
  });

  it('con un enlace en el padre no borra nada', async () => {
    const real = join(root, 'real');
    const realDir = join(real, 'canary-1b-v2');
    await downloadVoiceModel({
      dir: realDir,
      manifest: SMALL_MANIFEST,
      fetch: fakeFetch(),
      statfs: freeSpace,
    });
    const link = join(root, 'enlace');
    try {
      symlinkSync(real, link, 'junction');
    } catch {
      return;
    }
    await expect(removeVoiceModel({ dir: join(link, 'canary-1b-v2') })).rejects.toBeInstanceOf(
      VoiceModelPathError,
    );
    expect(existsSync(realDir)).toBe(true);
  });
});

describe('formatBytes', () => {
  it('da tamaños legibles', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3_966_054_682)).toBe('3.7 GB');
  });
});
