import { z } from 'zod';

const ProviderConfigSchema = z.object({
  type: z.literal('openai-compatible'),
  baseUrl: z.string().url(),
  model: z.string(),
  apiKey: z.string().default(''),
  contextWindow: z.number().int().positive().default(32768),
});

const McpServerSchema = z
  .object({
    name: z.string(),
    /** Requerido cuando no se define `package`; ignorado como ejecutable cuando `package` sí se define. */
    command: z.string().optional(),
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
  })
  .refine((s) => s.package !== undefined || (s.command !== undefined && s.command.length > 0), {
    message: "Se requiere 'command' cuando no se define 'package'",
    path: ['command'],
  });

/**
 * Host del inventario SSH (Hito 9, §12.14). Un alias del `ssh.hosts` de
 * `.stratumrc.json` es todo lo que el LLM ve: nunca manipula credenciales.
 */
const SSHHostSchema = z.object({
  host: z.string(),
  port: z.number().int().positive().default(22),
  user: z.string(),

  // --- Auth: al menos uno requerido (validado en el superRefine de abajo) ---
  /** Ruta al fichero de clave privada. `~` se expande al home del usuario. */
  privateKey: z.string().optional(),
  /** Passphrase de la clave privada. Prefijo `env:<VAR>` o valor literal. */
  passphrase: z.string().optional(),
  /**
   * Autenticar contra el ssh-agent del sistema (`SSH_AUTH_SOCK` en POSIX,
   * named pipe de OpenSSH o Pageant en Windows). No confundir con agent
   * forwarding (reenviar el agente al host remoto), no soportado en v1.
   */
  useAgent: z.boolean().optional(),
  /** Password. Prefijo `env:<VAR>` o valor literal (no recomendado). */
  password: z.string().optional(),

  // --- Topología ---
  /** Alias de otro host del inventario usado como bastión. Profundidad máx. 2. */
  jumpHost: z.string().optional(),

  // --- Verificación de host key ---
  /**
   * `tofu` (default): la primera conexión pregunta y persiste en
   * `~/.stratum/known_hosts.json`; después verifica en silencio.
   * `strict`: exige `hostKeyHash` y rechaza cualquier discrepancia.
   * `insecure`: sin verificación (solo lab); emite warning al conectar.
   */
  hostKeyPolicy: z.enum(['tofu', 'strict', 'insecure']).default('tofu'),
  /** Fingerprint pinneado (`SHA256:<base64>`). Requerido con `strict`. */
  hostKeyHash: z.string().optional(),

  // --- Seguridad operacional ---
  /**
   * Requerir confirmación del usuario en TODOS los `ssh_exec` de este host,
   * sea cual sea el comando. Es la defensa real en producción: la detección
   * de patrones destructivos es una red blanda y trivialmente evasible.
   */
  confirmAll: z.boolean().default(false),

  // --- Timeouts y salida ---
  /** ms para establecer la conexión SSH. */
  connectTimeout: z.number().int().positive().default(10000),
  /** ms por defecto para cada comando (override por tool call). */
  commandTimeout: z.number().int().positive().default(30000),
  /** Tope de stdout+stderr en bytes (override por tool call). */
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(256 * 1024),
});

const SSHConfigSchema = z
  .object({
    hosts: z.record(z.string(), SSHHostSchema).default({}),
    /**
     * `true` → `~/.stratum/logs/ssh-audit.jsonl`; string → ruta personalizada;
     * `false` → deshabilitado.
     */
    auditLog: z.union([z.boolean(), z.string()]).default(true),
  })
  .superRefine((cfg, ctx) => {
    for (const [alias, host] of Object.entries(cfg.hosts)) {
      if (!host.privateKey && !host.useAgent && !host.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hosts', alias],
          message: `El host "${alias}" no declara ningún método de autenticación. Define privateKey, useAgent o password.`,
        });
      }
      if (host.hostKeyPolicy === 'strict' && !host.hostKeyHash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hosts', alias, 'hostKeyHash'],
          message: `El host "${alias}" usa hostKeyPolicy "strict" pero no define hostKeyHash.`,
        });
      }

      // Cadena de jump hosts: alias existente, sin ciclos y profundidad máx. 2
      // (§12.14). Se valida aquí para que un ciclo no cuelgue el pool en runtime.
      const seen = new Set<string>([alias]);
      let current = host.jumpHost;
      let depth = 0;
      while (current !== undefined) {
        if (seen.has(current)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['hosts', alias, 'jumpHost'],
            message: `Ciclo de jumpHost detectado en "${alias}" → "${current}".`,
          });
          break;
        }
        const next = cfg.hosts[current];
        if (!next) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['hosts', alias, 'jumpHost'],
            message: `El host "${alias}" declara jumpHost "${current}", que no existe en ssh.hosts.`,
          });
          break;
        }
        if (++depth > 2) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['hosts', alias, 'jumpHost'],
            message: `La cadena de jumpHost de "${alias}" excede la profundidad máxima de 2.`,
          });
          break;
        }
        seen.add(current);
        current = next.jumpHost;
      }
    }
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

  logging: z
    .object({
      /**
       * Nivel base de log: trace|debug|info|warn|error|silent.
       * Sobrescribible con `--log-level`, `STRATUM_LOG_LEVEL` o `--debug`.
       */
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
      /** Salida legible y coloreada a stderr (en `chat` se eleva a warn+ para no romper Ink). */
      stderr: z.boolean().default(true),
      /** Redacta secretos (apiKey, Authorization, tokens…) antes de escribir cualquier log. */
      redact: z.boolean().default(true),
      file: z
        .object({
          /** Persistir logs en JSON Lines. Default off; `--debug`/`STRATUM_LOG_FILE=1` lo activan. */
          enabled: z.boolean().default(false),
          /** Carpeta del fichero `stratum.jsonl`. */
          dir: z.string().default('~/.stratum/logs'),
          /** Tamaño máximo antes de rotar (bytes). */
          maxBytes: z
            .number()
            .int()
            .positive()
            .default(5 * 1024 * 1024),
          /** Ficheros rotados a conservar (`.1`…`.N`). */
          maxFiles: z.number().int().positive().default(5),
        })
        .default({}),
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

  /**
   * Multi-agente (Hito 8, §12.16). Solo ajustes globales del subsistema: los
   * perfiles en sí son ficheros sueltos en `~/.stratum/agents/<name>.md` o
   * `<projectRoot>/.stratum/agents/<name>.md`, no van aquí.
   */
  agents: z
    .object({
      /** Perfil usado cuando `delegate_task` no especifica uno. */
      defaultProfile: z.string().default('general'),
      /** Subagentes concurrentes máximos. 8A=1 (secuencial); 8C permite >1. */
      maxConcurrency: z.number().int().positive().default(1),
    })
    .default({}),

  /**
   * Inventario SSH (Hito 9, §12.14). Deliberadamente **opcional** y sin
   * `.default({})`: si no hay sección `ssh`, las tools SSH no se registran en
   * el `ToolRegistry` y el LLM no las ve.
   */
  ssh: SSHConfigSchema.optional(),
});

export type StratumConfig = z.infer<typeof StratumConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;
export type SSHHostConfig = z.infer<typeof SSHHostSchema>;
export type SSHConfig = z.infer<typeof SSHConfigSchema>;
