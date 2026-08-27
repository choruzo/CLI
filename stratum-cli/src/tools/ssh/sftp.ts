import { z } from 'zod';
import { existsSync, statSync } from 'fs';
import { mkdir, stat } from 'fs/promises';
import { dirname, resolve as resolvePath } from 'path';
import type { Client, SFTPWrapper } from 'ssh2';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { getSshPool, confirmFnFrom } from './runtime.js';
import { HostKeyError } from './known-hosts.js';
import { getLogger } from '../../logging/index.js';

const log = getLogger('ssh');

const uploadSchema = z.object({
  host: z.string().describe('Alias del host'),
  localPath: z.string().describe('Ruta local del archivo a subir'),
  remotePath: z.string().describe('Ruta de destino en el host remoto'),
});

const downloadSchema = z.object({
  host: z.string().describe('Alias del host'),
  remotePath: z.string().describe('Ruta remota del archivo a descargar'),
  localPath: z.string().describe('Ruta local de destino'),
});

/** `client.sftp()` promisificado. */
function openSftp(client: Client, alias: string): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`No se pudo abrir la sesión SFTP con "${alias}": ${err.message}`));
        return;
      }
      resolve(sftp);
    });
  });
}

function transfer(
  sftp: SFTPWrapper,
  direction: 'put' | 'get',
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Transferencia SFTP cancelada'));
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (err: Error | null | undefined): void => {
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    if (direction === 'put') sftp.fastPut(from, to, done);
    else sftp.fastGet(from, to, done);
  });
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Traduce fallos de conexión/verificación al `ToolResult` correspondiente. */
function toError(err: unknown): ToolResult {
  const recoverable = err instanceof HostKeyError ? err.recoverable : true;
  return { ok: false, error: (err as Error).message, recoverable };
}

export const sshUploadTool: ToolDefinition = {
  name: 'ssh_upload',
  description:
    'Sube un archivo local a un host remoto vía SFTP. ' +
    'El directorio remoto de destino debe existir: créalo antes con ssh_exec si hace falta.',
  schema: uploadSchema,
  destructive: false,
  serialized: false,
  timeout: 600000,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = uploadSchema.parse(params);
    const localPath = resolvePath(ctx.cwd, input.localPath);

    // Comprobar el fichero antes de abrir SFTP: el error es mucho más claro.
    if (!existsSync(localPath)) {
      return {
        ok: false,
        error: `El fichero local ${localPath} no existe.`,
        recoverable: true,
      };
    }
    if (statSync(localPath).isDirectory()) {
      return {
        ok: false,
        error: `${localPath} es un directorio; ssh_upload transfiere ficheros sueltos.`,
        recoverable: true,
      };
    }

    const started = Date.now();
    try {
      const pool = getSshPool(ctx.config);
      const client = await pool.getConnection(input.host, confirmFnFrom(ctx));
      const sftp = await openSftp(client, input.host);
      await transfer(sftp, 'put', localPath, input.remotePath, ctx.signal);
      const size = (await stat(localPath)).size;
      const durationMs = Date.now() - started;
      log.info('sftp upload', { alias: input.host, size, durationMs });
      return {
        ok: true,
        output:
          `Subido ${localPath} → ${input.host}:${input.remotePath} ` +
          `(${humanBytes(size)} en ${durationMs}ms)`,
      };
    } catch (err) {
      return toError(err);
    }
  },
};

export const sshDownloadTool: ToolDefinition = {
  name: 'ssh_download',
  description: 'Descarga un archivo de un host remoto vía SFTP.',
  schema: downloadSchema,
  destructive: false,
  serialized: false,
  timeout: 600000,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = downloadSchema.parse(params);
    const localPath = resolvePath(ctx.cwd, input.localPath);
    const started = Date.now();

    try {
      await mkdir(dirname(localPath), { recursive: true });
      const pool = getSshPool(ctx.config);
      const client = await pool.getConnection(input.host, confirmFnFrom(ctx));
      const sftp = await openSftp(client, input.host);
      await transfer(sftp, 'get', input.remotePath, localPath, ctx.signal);
      const size = (await stat(localPath)).size;
      const durationMs = Date.now() - started;
      log.info('sftp download', { alias: input.host, size, durationMs });
      return {
        ok: true,
        output:
          `Descargado ${input.host}:${input.remotePath} → ${localPath} ` +
          `(${humanBytes(size)} en ${durationMs}ms)`,
      };
    } catch (err) {
      return toError(err);
    }
  },
};
