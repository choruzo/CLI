import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { getDecisionMemory } from '../../memory/decision-memory.js';
import {
  CODE_DECISION_TYPES,
  MEMORY_SECTIONS,
  type MemoryTaxonomy,
} from '../../memory/decisions.js';

const common = {
  title: z.string().max(100).describe('Título breve de la decisión'),
  content: z
    .string()
    .describe('Explicación detallada: contexto, alternativas consideradas, razón de la elección'),
  tags: z.array(z.string()).max(5).describe('Tags para búsqueda semántica'),
  importance: z.enum(['low', 'medium', 'high']),
};

const codeSchema = z.object({ ...common, type: z.enum(CODE_DECISION_TYPES) });

/**
 * M19 — memorias con secciones (`assistant`, `companion`). Ante la duda, `topic`
 * (B2): un tipo omitido o dudoso no hace fallar la llamada y el usuario lo
 * reclasifica desde el inspector. `summary` es opcional: sin él se muestra el
 * principio del contenido.
 */
const sectionsSchema = z.object({
  ...common,
  type: z
    .enum(MEMORY_SECTIONS)
    .default('topic')
    .describe(
      'Sección: profile (el propio usuario: preferencias, rasgos, cómo quiere las cosas), person (alguien de su entorno), project (algo en lo que trabaja), area (un ámbito estable de su vida o trabajo) o topic (cualquier otra cosa). Si dudas, topic.',
    ),
  summary: z
    .string()
    .max(140)
    .optional()
    .describe('El recuerdo en una línea (máx. 140 caracteres), para listarlo.'),
});

const DESCRIPTIONS: Record<MemoryTaxonomy, string> = {
  code:
    'Persiste una decisión importante tomada durante esta sesión en la memoria a largo plazo.\n' +
    'Úsala cuando: (1) elijas entre alternativas técnicas significativas, (2) definas convenciones del proyecto, ' +
    '(3) resuelvas un bug no trivial, (4) el usuario te dé una preferencia explícita que debas recordar.\n' +
    'NO la uses para acciones rutinarias o pasos intermedios.',
  sections:
    'Guarda un recuerdo en tu memoria a largo plazo, clasificado en una sección (profile, person, project, area o topic).\n' +
    'Úsala cuando el usuario te cuente algo estable sobre sí mismo o su entorno, fije una preferencia, te corrija o te pida recordar algo.\n' +
    'NO la uses para detalles pasajeros de la conversación.',
};

function createStoreTool(taxonomy: MemoryTaxonomy): ToolDefinition {
  const schema = taxonomy === 'code' ? codeSchema : sectionsSchema;
  return {
    name: 'store_decision',
    description: DESCRIPTIONS[taxonomy],
    schema,
    destructive: false,
    // Escribe en decisions.json + índice vectorial; nunca en paralelo consigo misma.
    serialized: true,

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = schema.parse(params);
      try {
        const memory = getDecisionMemory(ctx.config);
        // Procedencia (M17): en qué conversación se guardó, como la extracción automática.
        const result = await memory.save(
          { ...input, source: 'agent', ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}) },
          { source: 'tool', ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) },
        );
        if (result.deduped) {
          return {
            ok: true,
            output: `Decisión ya registrada (near-duplicado de ${result.duplicateOf}). No se creó una entrada nueva.`,
          };
        }
        if (!result.indexed) {
          // La decisión se persistió en decisions.json pero NO se indexó: el
          // servicio de embeddings no está disponible (sin @xenova/transformers
          // instalado y sin memory.embeddingEndpoint accesible). Avisar para que
          // no se asuma que será recuperable con recall_decisions.
          return {
            ok: true,
            output:
              `Decisión almacenada: ${result.record.id} — "${result.record.title}". ` +
              'AVISO: no se pudo generar el embedding (servicio de embeddings no disponible), ' +
              'así que NO será recuperable por búsqueda semántica hasta que haya un embedder activo ' +
              '(instala @xenova/transformers o configura memory.embeddingEndpoint).',
          };
        }
        return {
          ok: true,
          output: `Decisión almacenada: ${result.record.id} — "${result.record.title}"`,
        };
      } catch (err) {
        return {
          ok: false,
          error: `No se pudo almacenar la decisión: ${(err as Error).message}`,
          recoverable: true,
        };
      }
    },
  };
}

/** `store_decision` del agente de código: los 6 tipos de siempre. */
export const storeDecisionTool: ToolDefinition = createStoreTool('code');

/** `store_decision` de `assistant` y `companion` (M19): secciones. Mismo nombre de tool. */
export const storeMemoryTool: ToolDefinition = createStoreTool('sections');
