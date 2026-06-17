/**
 * Log de diagnóstico de MCP (§12.8).
 *
 * Recoge el stderr de los MCP servers (banners, avisos de telemetría, errores
 * de arranque) y los mensajes del instalador, y los persiste en
 * `~/.stratum/logs/mcp.log` en vez de volcarlos a la terminal — donde
 * ensuciarían la UI de Stratum.
 *
 * Diseño: fire-and-forget. `mcpLog` nunca lanza ni bloquea; las escrituras se
 * serializan en una cola interna y los errores de E/S se ignoran (un fallo del
 * logging de diagnóstico jamás debe romper el flujo principal).
 */

import { appendFile, mkdir, stat, rename } from 'fs/promises';
import { dirname } from 'path';
import { expandHome } from '../../config/paths.js';

/** Ruta del log de diagnóstico MCP. */
const LOG_PATH = expandHome('~/.stratum/logs/mcp.log');

/** Tamaño máximo antes de rotar (5 MB). */
const MAX_BYTES = 5 * 1024 * 1024;

let dirEnsured = false;
/** Cola para serializar las escrituras y evitar entrelazado de líneas. */
let writeQueue: Promise<void> = Promise.resolve();

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(dirname(LOG_PATH), { recursive: true });
  dirEnsured = true;
}

/** Rota el log a `mcp.log.1` cuando supera el tamaño máximo. */
async function rotateIfNeeded(): Promise<void> {
  try {
    const { size } = await stat(LOG_PATH);
    if (size > MAX_BYTES) {
      await rename(LOG_PATH, `${LOG_PATH}.1`);
    }
  } catch {
    // El archivo aún no existe → nada que rotar.
  }
}

/**
 * Registra una línea en el log de diagnóstico MCP. Fire-and-forget: no devuelve
 * promesa, nunca lanza y no bloquea al llamador.
 */
export function mcpLog(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  writeQueue = writeQueue
    .then(async () => {
      await ensureDir();
      await rotateIfNeeded();
      await appendFile(LOG_PATH, stamped, 'utf8');
    })
    .catch(() => {
      // El logging de diagnóstico nunca debe romper el flujo principal.
    });
}

/** Ruta absoluta del log de diagnóstico (para mostrarla al usuario). */
export function mcpLogPath(): string {
  return LOG_PATH;
}
