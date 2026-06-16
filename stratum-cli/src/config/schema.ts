import { z } from 'zod';

const ProviderConfigSchema = z.object({
  type: z.literal('openai-compatible'),
  baseUrl: z.string().url(),
  model: z.string(),
  apiKey: z.string().default(''),
  contextWindow: z.number().int().positive().default(32768),
});

const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  /**
   * Paquete npm a instalar en la carpeta gestionada (`mcp.installDir`).
   * Cuando se define, Stratum instala el paquete una sola vez en
   * `<installDir>/<server>/` y lanza el binario resuelto con `node`
   * directamente, evitando el coste de resolución de `npx` en cada arranque
   * (§12.8). `command`/`args` se ignoran como ejecutable: `args` se conserva
   * y se pasa al binario resuelto. Formato: `nombre`, `nombre@version` o
   * `@scope/nombre@version` (pinear versión es lo recomendado).
   */
  package: z.string().optional(),
  /** Timeout de arranque por server en ms (§12.8, opción 3). */
  startupTimeout: z.number().int().positive().default(15000),
});

export const StratumConfigSchema = z.object({
  provider: z
    .object({
      default: z.string(),
      providers: z.record(ProviderConfigSchema),
    })
    .optional(),

  memory: z
    .object({
      projectFile: z.string().default('./STRATUM.md'),
      globalFile: z.string().default('~/.stratum/STRATUM.md'),
      decisionsFile: z.string().default('~/.stratum/memory/decisions.json'),
      vectorDb: z.string().default('~/.stratum/memory/vectors.db'),
      embeddingModel: z.string().default('Xenova/all-MiniLM-L6-v2'),
      /**
       * Dimensión del vector de embeddings del modelo activo.
       * 384 para all-MiniLM-L6-v2 (default). Ajustar si se cambia de modelo.
       */
      embeddingDimension: z.number().int().positive().default(384),
      retrievalTopK: z.number().int().positive().default(5),
      embeddingWarmup: z.boolean().default(false),
      /**
       * Endpoint HTTP OpenAI-compatible para generar embeddings (Ollama, vLLM,
       * llama.cpp, LiteLLM…). Cuando se define, se intenta primero con
       * fast-fail y se cae a `@xenova` local si el endpoint no responde
       * (patrón provider-agnostic). Si se omite, se usa siempre el ONNX local.
       */
      embeddingEndpoint: z
        .object({
          url: z.string().url(),
          model: z.string().default(''),
          apiKey: z.string().default(''),
        })
        .optional(),
      /**
       * Extracción automática de decisiones en background tras cada respuesta
       * del agente (además de la tool `store_decision`). Usa el LLM activo.
       */
      autoExtract: z.boolean().default(true),
      /** Modelo a usar para la extracción automática. Si se omite, el modelo activo. */
      extractionModel: z.string().optional(),
      /**
       * Umbral de similitud coseno (0–1) para considerar dos decisiones
       * duplicadas al persistir y para filtrar resultados de recuperación.
       */
      similarityThreshold: z.number().min(0).max(1).default(0.9),
    })
    .default({}),

  tools: z
    .object({
      confirmDestructive: z.boolean().default(true),
      bashTimeout: z.number().int().positive().default(30000),
      webSearch: z
        .object({
          /**
           * 'meta' (default): DuckDuckGo siempre + Tavily si hay API key,
           * con merge, dedupe y re-rank (RRF). 'duckduckgo'/'tavily' fuerzan
           * un único motor. 'brave'/'serpapi' reservados (no implementados).
           */
          backend: z.enum(['meta', 'duckduckgo', 'tavily', 'brave', 'serpapi']).default('meta'),
          apiKey: z.string().default(''),
          tavilyApiKey: z.string().default(''),
          maxResults: z.number().int().positive().max(20).default(10),
        })
        .default({}),
      destructivePatterns: z
        .array(z.string())
        .default([
          'rm',
          'rmdir',
          'dd',
          'mkfs',
          'format',
          'DROP',
          'DELETE',
          'truncate',
          'shred',
          'wipefs',
        ]),
    })
    .default({}),

  mcp: z
    .object({
      servers: z.array(McpServerSchema).default([]),
      heartbeatInterval: z.number().int().positive().default(30000),
      /**
       * Política de arranque (§12.8, opción 3):
       *  - 'lazy' (default): en `chat` los servers se conectan en background
       *    sin bloquear el arranque de la UI; las tools se registran a medida
       *    que cada server queda listo.
       *  - 'eager': `chat` espera a que todos los servers conecten antes de
       *    mostrar el prompt (tools garantizadas en el primer turno).
       * `stratum run` (one-shot) siempre espera, acotado por `startupTimeout`.
       */
      startup: z.enum(['eager', 'lazy']).default('lazy'),
      /**
       * Carpeta gestionada donde se instalan los servers con `package`
       * (opción 2). Se crea automáticamente si no existe.
       */
      installDir: z.string().default('~/.stratum/mcp'),
      /**
       * Si un server con `package` no está instalado, instalarlo
       * automáticamente en el primer arranque. Si es `false`, se requiere
       * ejecutar `stratum mcp install` manualmente.
       */
      autoInstall: z.boolean().default(true),
    })
    .default({}),

  agent: z
    .object({
      maxIterations: z.number().int().positive().default(50),
      maxToolRetries: z.number().int().positive().default(3),
      toolErrorFormat: z.enum(['xml', 'json']).default('xml'),
      compressionKeepRounds: z.number().int().positive().default(6),
      compressionThreshold: z.number().min(0.1).max(1).default(0.8),
      compressorModel: z.string().optional(),
    })
    .default({}),
});

export type StratumConfig = z.infer<typeof StratumConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
