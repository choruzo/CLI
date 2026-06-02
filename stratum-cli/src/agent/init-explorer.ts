/**
 * InitReActExplorer — Fase 2 del Hito 2.5 (§555-607 de STRATUM_PROJECT_DEFINITION.md).
 *
 * Mini-agente read-only acotado a 8 iteraciones que explora el proyecto libremente
 * y aporta hallazgos a la síntesis LLM de InitAgent.
 * Criterio de señal (opencode): "¿lo perdería un agente sin esta información?"
 */

import { ReactLoop } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { readFileTool } from '../tools/fs/read.js';
import { globTool } from '../tools/fs/glob.js';
import { listDirectoryTool } from '../tools/fs/list.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import type { IProvider } from '../providers/base.js';
import type { Message } from './types.js';
// Tipos de init-agent.ts — import type evita dependencia circular en runtime
import type { InitEvent, ScanData } from './init-agent.js';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface ExplorerFindings {
  /** Rutas de archivos leídos vía read_file durante la exploración. */
  filesRead: string[];
  /** Resumen en prosa del agente: hallazgos clave o "Sin hallazgos adicionales." */
  findings: string;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const EXPLORER_MAX_ITERATIONS = 8;

const ACTION_LABELS: Record<string, string> = {
  read_file: 'leer',
  glob: 'buscar',
  list_directory: 'listar',
};

// ---------------------------------------------------------------------------
// System prompt del explorer
// ---------------------------------------------------------------------------

function buildExplorerPrompt(scanData: ScanData): string {
  const manifestsFound = Object.keys(scanData.manifests).join(', ') || 'ninguno';
  const packagesInfo =
    scanData.isMonorepo && scanData.packages.length > 0
      ? `Paquetes detectados: ${scanData.packages.join(', ')}`
      : 'No es monorepo (o no se detectaron paquetes)';

  return `Eres un investigador técnico de proyectos de software. Tu misión es explorar este proyecto para capturar contexto que un agente de IA necesitaría pero NO encontraría en el scan automático.

HERRAMIENTAS DISPONIBLES (SOLO LECTURA — no modificas nada):
- read_file: leer el contenido de un archivo
- glob: buscar archivos por patrón (e.g. "**/*.md", "src/*.ts")
- list_directory: listar contenido de un directorio

PRESUPUESTO: máximo ${EXPLORER_MAX_ITERATIONS} pasos. Úsalos con criterio.

CRITERIO DE SEÑAL: Solo reporta información si responde "¿lo perdería el agente sin esta información?". No documentes lo obvio (lo que ya aparece en package.json, README o el árbol de directorios).

PRIORIDAD DE EXPLORACIÓN (en orden):
1. Archivos de instrucciones existentes: CLAUDE.md, .cursorrules, .github/copilot-instructions.md, opencode.json, AGENTS.md — léelos si existen, preserva su contenido relevante
2. Entrypoints no estándar o convenciones de arquitectura en archivos fuente clave
3. Archivos de arquitectura: ARCHITECTURE.md, docs/ARCHITECTURE.md, ADR/
4. Paquetes de monorepo en subdirectorios no declarados como workspaces
5. Convenciones de código observables en archivos fuente representativos

PROCESO SUGERIDO:
1. Explora el directorio raíz para orientarte (list_directory o glob "*.md")
2. Lee los archivos de instrucciones si los hay (CLAUDE.md, .cursorrules, AGENTS.md)
3. Explora lo que el árbol sugiera que es interesante
4. Cierra con un RESUMEN DE HALLAZGOS en texto plano

CIERRE OBLIGATORIO: Al terminar tu exploración, escribe directamente (sin llamar más tools) un resumen en prosa de los hallazgos clave. Si no encontraste nada relevante, escribe solo: "Sin hallazgos adicionales."

---
CONTEXTO DEL SCAN AUTOMÁTICO:
Directorio raíz: ${scanData.projectRoot}
${packagesInfo}
Manifiestos detectados: ${manifestsFound}

Árbol de directorios (profundidad 3):
${scanData.dirTree || '(no disponible)'}`;
}

// ---------------------------------------------------------------------------
// InitReActExplorer
// ---------------------------------------------------------------------------

export class InitReActExplorer {
  private readonly config: StratumConfig;

  constructor(
    private readonly provider: IProvider,
    private readonly model: string,
    config: StratumConfig | undefined,
    private readonly contextWindow: number,
  ) {
    // Usar la config pasada como base, o una config mínima por defecto
    const base = config ?? StratumConfigSchema.parse({});
    this.config = {
      ...base,
      agent: {
        ...base.agent,
        maxIterations: EXPLORER_MAX_ITERATIONS,
      },
    };
  }

  /**
   * Ejecuta la fase de exploración libre y devuelve los hallazgos.
   * Yield-ea InitEvent de tipo 'explorer_step' durante la exploración.
   * Al finalizar (return), devuelve ExplorerFindings.
   *
   * Nunca lanza — si el budget se agota o el modelo no llama tools, termina limpiamente.
   */
  async *explore(
    scanData: ScanData,
    _cwd: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<InitEvent, ExplorerFindings, unknown> {
    // Registry restringido: solo tools de lectura
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(globTool);
    registry.register(listDirectoryTool);

    const systemPrompt = buildExplorerPrompt(scanData);
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          'Explora el proyecto y reporta tus hallazgos. Recuerda cerrar con un resumen en prosa.',
      },
    ];

    const loop = new ReactLoop(
      this.provider,
      registry,
      messages,
      this.config,
      this.model,
      this.contextWindow,
    );

    let iteration = 0;
    const filesRead: string[] = [];

    for await (const ev of loop.run({
      signal: opts?.signal,
      allowDestructive: false,
    })) {
      if (ev.type === 'tool_call_ready') {
        iteration++;
        const action = ACTION_LABELS[ev.name] ?? ev.name;
        const file =
          typeof ev.input['path'] === 'string'
            ? ev.input['path']
            : typeof ev.input['pattern'] === 'string'
              ? ev.input['pattern']
              : undefined;

        if (ev.name === 'read_file' && typeof ev.input['path'] === 'string') {
          filesRead.push(ev.input['path']);
        }

        yield { type: 'explorer_step', iteration, action, file };
      }
      // tool_result, text_delta, done, etc. se consumen silenciosamente
    }

    // Extraer hallazgos del último mensaje assistant (su texto libre = resumen)
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const findings = (lastAssistant?.content ?? '').trim() || 'Sin hallazgos adicionales.';

    return { filesRead, findings };
  }
}
