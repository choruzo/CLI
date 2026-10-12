/**
 * Descubrimiento del servidor del Stratum Protocol: dónde escucha y con qué
 * token. Aquí solo se **lee** y se interpreta; publicar el endpoint es cosa de
 * quien sirve el protocolo.
 */
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { STRATUM_PROTOCOL_VERSION } from '../protocol/index.js';

/** Dónde y cómo conectar. El `token` es un secreto: no se registra ni se muestra. */
export interface Endpoint {
  /** Versión del protocolo que habla el servidor. */
  protocol: number;
  pid: number;
  /** ISO 8601. */
  startedAt: string;
  /** Versión de Stratum que lo sirve. */
  version: string;
  /** Named pipe (`\\.\pipe\…`) o ruta de un unix socket. */
  ipcPath: string;
  token: string;
}

export const ENDPOINT_FILE = 'endpoint.json';

/** Carpeta del endpoint: `~/.stratum/daemon/`. */
export function defaultEndpointDir(home: string = homedir()): string {
  return join(home, '.stratum', 'daemon');
}

const endpointSchema = z.object({
  protocol: z.number().int().positive(),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  version: z.string().min(1),
  ipcPath: z.string().min(1),
  token: z.string().min(32),
});

export type DiscoveryResult =
  | { status: 'found'; endpoint: Endpoint }
  /** No hay endpoint publicado: ningún servidor en marcha. */
  | { status: 'absent' }
  /** Hay endpoint, pero el proceso que lo publicó ya no existe. */
  | { status: 'stale'; pid: number }
  /** El fichero no se puede leer o no tiene la forma esperada. */
  | { status: 'invalid'; reason: string }
  /** El servidor habla otra versión del protocolo: no merece la pena ni conectar. */
  | { status: 'incompatible'; protocol: number; version: string };

/** Cómo se localiza el servidor. Se consulta en cada (re)conexión: puede haber cambiado. */
export interface Discovery {
  locate(): Promise<DiscoveryResult>;
}

/** Interpreta el contenido de un `endpoint.json`. Puro: no toca disco ni procesos. */
export function parseEndpoint(text: string): DiscoveryResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { status: 'invalid', reason: 'not valid JSON' };
  }
  const parsed = endpointSchema.safeParse(raw);
  if (!parsed.success) {
    // Solo qué campo falla: el fichero lleva el token.
    const field = parsed.error.issues[0]?.path.join('.') || 'document';
    return { status: 'invalid', reason: `bad field: ${field}` };
  }
  if (parsed.data.protocol !== STRATUM_PROTOCOL_VERSION) {
    return {
      status: 'incompatible',
      protocol: parsed.data.protocol,
      version: parsed.data.version,
    };
  }
  return { status: 'found', endpoint: parsed.data };
}

/** ¿Existe un proceso con ese pid? Sin permiso para señalarlo también cuenta como vivo. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface FileDiscoveryOptions {
  /** Carpeta del endpoint. Por defecto, `~/.stratum/daemon/`. */
  dir?: string;
  /** Inyectable para tests. */
  isAlive?: (pid: number) => boolean;
}

/** Descubrimiento por `endpoint.json`. */
export function fileDiscovery(options: FileDiscoveryOptions = {}): Discovery {
  const file = join(options.dir ?? defaultEndpointDir(), ENDPOINT_FILE);
  const isAlive = options.isAlive ?? processAlive;
  return {
    async locate(): Promise<DiscoveryResult> {
      let text: string;
      try {
        text = await readFile(file, 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return code === 'ENOENT'
          ? { status: 'absent' }
          : { status: 'invalid', reason: `cannot read endpoint file (${code ?? 'error'})` };
      }
      const result = parseEndpoint(text);
      if (result.status === 'found' && !isAlive(result.endpoint.pid)) {
        return { status: 'stale', pid: result.endpoint.pid };
      }
      return result;
    },
  };
}

/** Descubrimiento fijo, o calculado en cada intento (tests, endpoint explícito). */
export function staticDiscovery(endpoint: Endpoint | (() => Endpoint | null)): Discovery {
  return {
    locate(): Promise<DiscoveryResult> {
      const current = typeof endpoint === 'function' ? endpoint() : endpoint;
      if (!current) return Promise.resolve({ status: 'absent' });
      return Promise.resolve(
        current.protocol === STRATUM_PROTOCOL_VERSION
          ? { status: 'found', endpoint: current }
          : { status: 'incompatible', protocol: current.protocol, version: current.version },
      );
    },
  };
}
