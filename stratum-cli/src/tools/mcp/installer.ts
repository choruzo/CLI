/**
 * Carpeta gestionada de MCP servers (§12.8, opción 2).
 *
 * En lugar de lanzar cada server con `npx -y <pkg>` —que revalida el paquete
 * contra el registro npm en CADA arranque y añade latencia— Stratum instala el
 * paquete una sola vez en `~/.stratum/mcp/<server>/` y resuelve su binario para
 * lanzarlo con `node` directamente. Arranques posteriores son instantáneos y no
 * tocan la red.
 *
 * El patrón replica el del modelo ONNX de la capa de memoria (§12.10), que ya
 * cachea en `~/.stratum/models/`.
 */

import { execa } from 'execa';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { expandHome } from '../../config/paths.js';
import { sanitizeSegment } from './bridge.js';
import type { McpServer } from '../../config/schema.js';

/** Opciones de runtime que el manager pasa a cada cliente. */
export interface McpRuntimeOptions {
  installDir: string; // ya expandido a ruta absoluta
  autoInstall: boolean;
}

/** Comando ejecutable resuelto para `StdioClientTransport`. */
export interface ResolvedCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Resuelve la carpeta gestionada a ruta absoluta y la crea si no existe. */
export function ensureInstallDir(installDir: string): string {
  const abs = expandHome(installDir);
  mkdirSync(abs, { recursive: true });
  return abs;
}

/** Directorio aislado de un server concreto dentro de la carpeta gestionada. */
export function serverInstallPath(installDir: string, serverName: string): string {
  return join(expandHome(installDir), sanitizeSegment(serverName));
}

/**
 * Deriva el nombre del paquete (sin versión) a partir de un spec npm.
 * `@scope/name@1.2.3` → `@scope/name`; `name@1.2.3` → `name`; `name` → `name`.
 */
export function packageNameFromSpec(spec: string): string {
  if (spec.startsWith('@')) {
    // @scope/name[@version]: el primer '@' es del scope, buscar el segundo
    const at = spec.indexOf('@', 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf('@');
  return at === -1 ? spec : spec.slice(0, at);
}

/** ¿Está el paquete del server ya instalado en su carpeta gestionada? */
export function isServerInstalled(serverCfg: McpServer, installDir: string): boolean {
  if (!serverCfg.package) return false;
  const pkgName = packageNameFromSpec(serverCfg.package);
  const pkgJson = join(serverInstallPath(installDir, serverCfg.name), 'node_modules', pkgName, 'package.json');
  return existsSync(pkgJson);
}

/**
 * Instala el paquete del server en su carpeta gestionada con `npm install`.
 * Idempotente: crea la carpeta y un package.json mínimo para aislar la
 * instalación y evitar que npm escale a directorios padre.
 */
export async function installServer(
  serverCfg: McpServer,
  installDir: string,
  onLog?: (line: string) => void,
): Promise<void> {
  if (!serverCfg.package) {
    throw new Error(`MCP server '${serverCfg.name}' no tiene campo 'package'.`);
  }
  const dir = serverInstallPath(installDir, serverCfg.name);
  mkdirSync(dir, { recursive: true });

  // package.json mínimo para aislar la instalación (npm no escala al padre).
  const localPkgJson = join(dir, 'package.json');
  if (!existsSync(localPkgJson)) {
    writeFileSync(
      localPkgJson,
      JSON.stringify({ name: `stratum-mcp-${sanitizeSegment(serverCfg.name)}`, private: true }, null, 2),
    );
  }

  onLog?.(`Instalando '${serverCfg.package}' en ${dir} ...`);
  await execa(
    'npm',
    ['install', serverCfg.package, '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: dir },
  );
  onLog?.(`Server '${serverCfg.name}' instalado.`);
}

/**
 * Resuelve la ruta del entry-point ejecutable de un paquete instalado leyendo
 * su campo `bin` en package.json. Lanza si no se encuentra.
 */
function resolveBinEntry(serverCfg: McpServer, installDir: string): string {
  const pkgName = packageNameFromSpec(serverCfg.package!);
  const pkgDir = join(serverInstallPath(installDir, serverCfg.name), 'node_modules', pkgName);
  const pkgJsonPath = join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
    main?: string;
  };

  let binRel: string | undefined;
  if (typeof pkg.bin === 'string') {
    binRel = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    // Preferir el bin que coincide con el nombre del paquete; si no, el primero.
    const short = pkgName.includes('/') ? pkgName.split('/')[1]! : pkgName;
    binRel = pkg.bin[short] ?? pkg.bin[pkgName] ?? Object.values(pkg.bin)[0];
  }
  binRel = binRel ?? pkg.main;
  if (!binRel) {
    throw new Error(`El paquete '${pkgName}' no declara 'bin' ni 'main' (server '${serverCfg.name}').`);
  }
  return isAbsolute(binRel) ? binRel : join(pkgDir, binRel);
}

/**
 * Resuelve el comando ejecutable de un server.
 *
 * - Sin `package`: devuelve `command`/`args`/`env` tal cual (comportamiento
 *   actual, sin cambios).
 * - Con `package`: garantiza la instalación (auto-install si procede) y
 *   devuelve `node <entry> [args...]`, evitando `npx` por completo.
 */
export async function resolveServerCommand(
  serverCfg: McpServer,
  options: McpRuntimeOptions,
  onLog?: (line: string) => void,
): Promise<ResolvedCommand> {
  if (!serverCfg.package) {
    // El schema garantiza que command está definido cuando package está ausente.
    return { command: serverCfg.command!, args: serverCfg.args, env: serverCfg.env };
  }

  ensureInstallDir(options.installDir);

  if (!isServerInstalled(serverCfg, options.installDir)) {
    if (!options.autoInstall) {
      throw new Error(
        `MCP server '${serverCfg.name}' no está instalado y autoInstall=false. ` +
          `Ejecuta: stratum mcp install ${serverCfg.name}`,
      );
    }
    await installServer(serverCfg, options.installDir, onLog);
  }

  const entry = resolveBinEntry(serverCfg, options.installDir);
  return { command: 'node', args: [entry, ...serverCfg.args], env: serverCfg.env };
}
