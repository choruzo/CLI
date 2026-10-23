import type { StratumConfig } from '../config/schema.js';
import { MemoryManager } from './manager.js';
import type { MemoryScope } from './project.js';

/**
 * Genera el texto de salida para el comando `stratum memory show` y `/memory show`.
 * Compartido entre la CLI y la UI de chat para garantizar salida idéntica.
 */
export function renderMemoryShow(
  config: StratumConfig,
  cwd: string,
  scope: MemoryScope = 'project',
): string {
  const mgr = new MemoryManager(config, cwd, scope);
  const { projectContent, globalContent, projectPath, globalPath } = mgr.getProjectMemory();

  if (!projectContent && !globalContent) {
    return [
      '  No se encontró ningún STRATUM.md activo.',
      '',
      `  Ruta buscada: ${scope === 'global' ? globalPath : projectPath}`,
      ...(scope === 'project'
        ? ['', '  Ejecuta `stratum init` para generar el archivo de memoria del proyecto.']
        : []),
    ].join('\n');
  }

  const lines: string[] = [];

  if (globalContent) {
    lines.push(`── Global (${globalPath}) ──`);
    lines.push('');
    lines.push(globalContent);
  }

  if (projectContent) {
    if (lines.length > 0) lines.push('', '─'.repeat(60), '');
    lines.push(`── Proyecto (${projectPath}) ──`);
    lines.push('');
    lines.push(projectContent);
  }

  return lines.join('\n');
}
