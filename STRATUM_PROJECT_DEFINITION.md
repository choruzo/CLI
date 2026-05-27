# Stratum CLI — Definición de Proyecto

> Agente CLI extensible de propósito general con foco en código, automatización DevOps y administración de infraestructura virtualizada.

---

## 1. Visión General

**Stratum CLI** es un agente de línea de comandos construido sobre un loop ReAct (Reason → Act → Observe) que evoluciona hacia una arquitectura multi-agente con soporte de plan-and-execute. El agente es agnóstico al proveedor de LLM, compatible con cualquier API OpenAI-compatible, y diseñado para crecer por capas — igual que su nombre sugiere.

### Principios de diseño

- **Composable por capas** — cada subsistema (memoria, tools, providers) es independiente y reemplazable.
- **Provider-agnostic** — OpenAI API compatible. Funciona con Claude (vía LiteLLM), Ollama, llama.cpp, vLLM, OpenAI y cualquier proxy compatible.
- **Local-first** — no requiere servicios externos para funcionar. Todo puede correr en local.
- **Extensible vía MCP** — cualquier herramienta externa se integra via Model Context Protocol.
- **Transparente** — el usuario puede auditar cada decisión, herramienta ejecutada y memoria almacenada.

---

## 2. Stack Tecnológico

| Capa | Tecnología | Justificación |
|---|---|---|
| Runtime | Node.js 22 LTS | Estable, ecosistema maduro, streams nativos |
| Lenguaje | TypeScript 5+ | Tipado fuerte, excelente DX, mismo stack que Claude Code |
| CLI Framework | Commander.js | Lightweight, bien mantenido, sin magia innecesaria |
| Terminal UI | Ink (React for CLIs) + Chalk | Componentes re-renderizables, spinners, layout |
| LLM Client | Cliente propio OpenAI-compatible | Máximo control, sin dependencias de SDK de terceros |
| MCP Client | @modelcontextprotocol/sdk | Protocolo oficial, compatibilidad total |
| Vector DB | better-sqlite3 + sqlite-vec | Embebida, sin servidor, embeddings nativos en SQLite |
| Embeddings | @xenova/transformers (ONNX local) | Embeddings locales sin API key |
| Build | tsup (esbuild-based) | Bundle rápido, ESM + CJS, single binary |
| Testing | Vitest | Rápido, TS nativo, compatible con ESM |
| Linting | ESLint + Prettier | Consistencia de código |

### Dependencias de producción clave

```json
{
  "commander": "CLI parsing",
  "ink": "Terminal UI reactiva",
  "chalk": "Colores y estilos terminal",
  "better-sqlite3": "SQLite embebido",
  "sqlite-vec": "Extensión vectorial para SQLite",
  "@modelcontextprotocol/sdk": "Cliente MCP",
  "@xenova/transformers": "Embeddings locales ONNX",
  "zod": "Validación de schemas (config, tools, memoria)",
  "undici": "HTTP client moderno para web fetch",
  "eventsource-parser": "Streaming SSE para LLM responses",
  "diff": "Generación de patches para edit_file",
  "glob": "File globbing para tools",
  "execa": "Shell execution con mejor API que child_process"
}
```

---

## 3. Arquitectura del Agente — El Harness

El harness es el bucle central que convierte entrada del usuario en acciones y observaciones.

### 3.1 Diagrama de flujo principal

```
Usuario (input)
      │
      ▼
┌─────────────────────────────────────┐
│           StratumAgent              │
│                                     │
│  ┌──────────┐    ┌───────────────┐  │
│  │ Memory   │───▶│ SystemPrompt  │  │
│  │ Manager  │    │  Composer     │  │
│  └──────────┘    └───────┬───────┘  │
│                          │          │
│                          ▼          │
│                 ┌────────────────┐  │
│                 │ ProviderRouter │  │
│                 └───────┬────────┘  │
│                         │           │
│                         ▼           │
│              ┌──────────────────┐   │
│              │   LLM (stream)   │   │
│              └────────┬─────────┘   │
│                       │             │
│              ┌────────▼─────────┐   │
│              │  Response Parser │   │
│              └────────┬─────────┘   │
│                       │             │
│           ┌───────────▼──────────┐  │
│           │   Tool Call?         │  │
│           │   ├─ YES ──▶ ToolRegistry │
│           │   └─ NO  ──▶ Output  │  │
│           └──────────────────────┘  │
│                       │             │
│                  (loop / done)       │
└─────────────────────────────────────┘
```

### 3.2 Componentes del harness

#### `StratumAgent` (src/agent/core.ts)
Clase principal. Mantiene el estado de la sesión, orquesta todos los subsistemas y expone la interfaz `run(input: string): AsyncGenerator<AgentEvent>`.

```typescript
interface AgentConfig {
  provider: ProviderConfig;
  tools: ToolDefinition[];
  memory: MemoryConfig;
  maxIterations: number;       // límite de loops ReAct (default: 50)
  confirmDestructive: boolean; // pedir confirmación en ops destructivas
}
```

#### `ReactLoop` (src/agent/harness.ts)
Implementa el loop Reason → Act → Observe:

```
iteration N:
  1. Compose messages: [system] + [memory_context] + [conversation_history]
  2. Call LLM → stream response
  3. Parse: text | tool_call | stop
  4. If tool_call:
       a. Dispatch to ToolRegistry
       b. Append tool_result to messages
       c. Loop (N+1)
  5. If stop → emit final answer
```

#### `ProviderRouter` (src/providers/router.ts)
Abstrae todos los proveedores detrás de una interfaz única:

```typescript
interface CompletionRequest {
  messages: Message[];
  tools?: ToolSchema[];
  stream: boolean;
  model: string;
}

interface IProvider {
  complete(req: CompletionRequest): AsyncGenerator<CompletionChunk>;
  healthCheck(): Promise<boolean>;
}
```

Providers soportados desde v1: `OpenAICompatible` (cubre Ollama, llama.cpp, vLLM, LiteLLM proxy, OpenAI, Anthropic vía proxy).

#### `ToolRegistry` (src/tools/registry.ts)
Registro central de herramientas. Soporta:
- Tools internas (built-in)
- Tools registradas dinámicamente por MCP servers
- Confirmación previa en tools marcadas como `destructive: true`

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  schema: ZodSchema;          // validación de parámetros
  destructive?: boolean;      // requiere confirmación del usuario
  timeout?: number;           // ms, default 30000
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

---

## 4. Tools del Día 1

### 4.1 File System

| Tool | Descripción |
|---|---|
| `read_file` | Lee contenido de un archivo. Soporta offset/limit de líneas. |
| `write_file` | Crea o sobreescribe un archivo. |
| `edit_file` | Edición de precisión con `old_string → new_string`. Genera diff para revisión. |
| `list_directory` | Lista contenido de un directorio con metadatos. |
| `glob` | Encuentra archivos por patrón glob. |
| `grep` | Búsqueda por regex en archivos con contexto de líneas. |

### 4.2 Shell Execution

| Tool | Descripción |
|---|---|
| `bash` | Ejecuta comandos shell. Output streameado. Timeout configurable. Marca como `destructive` si contiene `rm`, `dd`, `mkfs`, etc. |

Política de seguridad: lista de patrones peligrosos → solicitud de confirmación explícita al usuario antes de ejecutar.

### 4.3 Web

| Tool | Descripción |
|---|---|
| `web_search` | Búsqueda web. Backend configurable: SerpAPI, Brave Search, DuckDuckGo scraping, Tavily. |
| `web_fetch` | Fetch de URL con extracción de texto limpio (sin HTML). Soporte de `Accept: text/markdown`. |

### 4.4 MCP Client

| Tool | Descripción |
|---|---|
| `mcp_list_tools` | Lista herramientas disponibles en los MCP servers conectados. |
| `mcp_call` | Invoca cualquier herramienta en un MCP server conectado. |

Los MCP servers se configuran en `.stratumrc.json` y se conectan al iniciar el agente. Sus tools se registran automáticamente en el `ToolRegistry`.

---

## 5. Arquitectura de Memoria

Sistema de memoria en tres capas, diseñado para ser transparente y auditable.

### Capa 1 — Project Memory (`STRATUM.md`)

Archivo markdown en la raíz del proyecto (o `~/.stratum/STRATUM.md` para memoria global). Se carga en el system prompt al iniciar cada sesión.

**Contenido típico:**
- Contexto del proyecto (stack, convenciones)
- Instrucciones permanentes al agente
- Restricciones y comportamientos preferidos

```markdown
# Stratum Memory

## Proyecto
Repositorio: mi-proyecto-devops
Stack: Ansible + VMware vSphere + Python

## Convenciones
- Siempre verificar antes de ejecutar comandos destructivos
- Comentarios en español
- Usar pathlib en lugar de os.path
```

### Capa 2 — Decision Store (`~/.stratum/memory/decisions.json`)

Decisiones importantes almacenadas durante el funcionamiento del agente como JSON estructurado.

```json
{
  "id": "dec_20260527_001",
  "timestamp": "2026-05-27T10:30:00Z",
  "session_id": "sess_abc123",
  "type": "architectural",
  "title": "Usar sqlite-vec en lugar de Chroma",
  "content": "Se decidió sqlite-vec por ser embebido y sin dependencias de servidor. Chroma requería Docker.",
  "tags": ["database", "vectors", "infraestructura"],
  "importance": "high",
  "embedding_ref": "vec_001",
  "project": "stratum-cli"
}
```

**Tipos de decisión**: `architectural`, `tooling`, `convention`, `bug_fix`, `security`, `user_preference`.

### Capa 3 — Vector DB (`~/.stratum/memory/vectors.db`)

SQLite con extensión `sqlite-vec`. Las decisiones del JSON se embeben con un modelo ONNX local y se almacenan aquí.

**Flujo de recuperación:**
```
Query semántica del agente
        │
        ▼
Embedding del query (local ONNX)
        │
        ▼
Búsqueda KNN en sqlite-vec (top-K)
        │
        ▼
IDs de decisiones relevantes
        │
        ▼
Carga de entradas completas desde decisions.json
        │
        ▼
Inyección en contexto del agente
```

**Pipeline de escritura** (trigger: agente detecta decisión importante):
```
Decisión detectada
        │
        ▼
Append a decisions.json
        │
        ▼
Generar embedding (ONNX local)
        │
        ▼
INSERT en sqlite-vec con ID de referencia
```

---

## 6. Configuración (`.stratumrc.json`)

```json
{
  "provider": {
    "default": "local-ollama",
    "providers": {
      "local-ollama": {
        "type": "openai-compatible",
        "baseUrl": "http://localhost:11434/v1",
        "model": "qwen2.5-coder:32b",
        "apiKey": "ollama"
      },
      "litellm-proxy": {
        "type": "openai-compatible",
        "baseUrl": "http://localhost:4000/v1",
        "model": "claude-sonnet-4-5",
        "apiKey": "${LITELLM_API_KEY}"
      }
    }
  },
  "memory": {
    "projectFile": "./STRATUM.md",
    "globalFile": "~/.stratum/STRATUM.md",
    "decisionsFile": "~/.stratum/memory/decisions.json",
    "vectorDb": "~/.stratum/memory/vectors.db",
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "retrievalTopK": 5
  },
  "tools": {
    "confirmDestructive": true,
    "bashTimeout": 30000,
    "webSearch": {
      "backend": "brave",
      "apiKey": "${BRAVE_API_KEY}"
    }
  },
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
      }
    ]
  }
}
```

---

## 7. Estructura de Directorios

```
stratum-cli/
├── src/
│   ├── agent/
│   │   ├── core.ts            # StratumAgent — clase principal
│   │   ├── harness.ts         # ReactLoop — bucle Reason/Act/Observe
│   │   ├── planner.ts         # Plan-and-execute mode (Hito 7)
│   │   ├── orchestrator.ts    # Multi-agent orchestrator (Hito 8)
│   │   └── types.ts           # Tipos compartidos del agente
│   ├── providers/
│   │   ├── base.ts            # IProvider interface
│   │   ├── openai-compatible.ts # Cliente OpenAI-compatible universal
│   │   └── router.ts          # ProviderRouter — selección y fallback
│   ├── tools/
│   │   ├── registry.ts        # ToolRegistry
│   │   ├── fs/
│   │   │   ├── read.ts
│   │   │   ├── write.ts
│   │   │   ├── edit.ts
│   │   │   ├── list.ts
│   │   │   ├── glob.ts
│   │   │   └── grep.ts
│   │   ├── shell/
│   │   │   └── bash.ts
│   │   ├── web/
│   │   │   ├── search.ts
│   │   │   └── fetch.ts
│   │   └── mcp/
│   │       ├── client.ts      # MCP client wrapper
│   │       └── bridge.ts      # MCP tools → ToolRegistry bridge
│   ├── memory/
│   │   ├── manager.ts         # MemoryManager — orquesta las 3 capas
│   │   ├── project.ts         # Capa 1: STRATUM.md loader
│   │   ├── decisions.ts       # Capa 2: JSON decision store
│   │   └── vectors.ts         # Capa 3: sqlite-vec + embeddings
│   ├── cli/
│   │   ├── index.ts           # Entry point (commander.js)
│   │   ├── commands/
│   │   │   ├── chat.ts        # stratum chat — modo interactivo
│   │   │   ├── run.ts         # stratum run "task" — modo one-shot
│   │   │   ├── memory.ts      # stratum memory list/search/forget
│   │   │   └── config.ts      # stratum config get/set
│   │   └── ui/
│   │       ├── App.tsx        # Root Ink component
│   │       ├── ChatView.tsx   # Vista conversacional
│   │       ├── ToolCall.tsx   # Renderizado de tool calls
│   │       └── Spinner.tsx    # Loading states
│   └── config/
│       ├── schema.ts          # Zod schema de .stratumrc.json
│       └── loader.ts          # Carga y merge de config
├── STRATUM.md                 # Template de memoria de proyecto
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
└── .stratumrc.json.example
```

---

## 8. Comandos CLI

```bash
# Modo interactivo (REPL)
stratum chat

# Tarea one-shot (no interactivo)
stratum run "Analiza el código en ./src y encuentra posibles memory leaks"

# Con proveedor específico
stratum chat --provider litellm-proxy

# Gestión de memoria
stratum memory list                    # Lista decisiones almacenadas
stratum memory search "sqlite"         # Búsqueda semántica
stratum memory forget dec_20260527_001 # Elimina una decisión
stratum memory show                    # Muestra STRATUM.md activo

# Configuración
stratum config get provider.default
stratum config set provider.default litellm-proxy
```

---

## 9. Hitos del Proyecto (Roadmap)

### Hito 0 — Scaffolding del proyecto *(~2 días)*
- [ ] Inicializar proyecto TypeScript con tsup
- [ ] CLI entry point con Commander.js
- [ ] Sistema de configuración (`.stratumrc.json` + Zod schema)
- [ ] Estructura de directorios base
- [ ] Script de desarrollo con hot-reload
- [ ] Vitest configurado

**Entregable:** `stratum --version` funciona. Config se carga correctamente.

---

### Hito 1 — Core Agent Loop *(~5 días)*
- [ ] `ProviderRouter` con cliente OpenAI-compatible
- [ ] Streaming de responses (SSE parser)
- [ ] `ReactLoop` básico (sin tools)
- [ ] `ToolRegistry` con dispatch
- [ ] Tools básicas: `read_file`, `write_file`, `bash`
- [ ] System prompt base
- [ ] Ink UI: ChatView con streaming

**Entregable:** `stratum chat` funciona. El agente puede leer archivos y ejecutar comandos básicos.

---

### Hito 2 — Memory Layer 1 *(~3 días)*
- [ ] `STRATUM.md` loader (proyecto + global)
- [ ] Inyección en system prompt
- [ ] `SessionContext`: historial de conversación
- [ ] Compresión de contexto básica (truncation con resumen)
- [ ] Comando `stratum memory show`

**Entregable:** El agente recuerda el contexto del proyecto entre iteraciones dentro de una sesión.

---

### Hito 3 — Tools completos Day 1 *(~4 días)*
- [ ] `edit_file` con diff patches
- [ ] `list_directory`, `glob`, `grep`
- [ ] `web_search` + `web_fetch`
- [ ] Safety check en `bash` (patrones destructivos)
- [ ] Confirmación interactiva en tools destructivas
- [ ] Timeout y cancelación de tools
- [ ] ToolCall UI (renderizado de tool calls en Ink)

**Entregable:** Agente con toolset completo del día 1. Puede realizar tareas de código completas.

---

### Hito 4 — MCP Client *(~4 días)*
- [ ] Integración `@modelcontextprotocol/sdk`
- [ ] Conexión a MCP servers desde `.stratumrc.json`
- [ ] Auto-registro de MCP tools en `ToolRegistry`
- [ ] Listado de tools MCP disponibles
- [ ] Comando `stratum mcp list`

**Entregable:** Cualquier MCP server se puede conectar y sus tools son utilizables por el agente.

---

### Hito 5 — Memory Layers 2 y 3 *(~6 días)*
- [ ] `DecisionStore`: schema JSON + CRUD
- [ ] Detección automática de decisiones importantes (LLM-based)
- [ ] Pipeline de embedding con `@xenova/transformers` (ONNX local)
- [ ] `sqlite-vec` setup e integración
- [ ] Búsqueda semántica KNN
- [ ] Inyección de memoria relevante en context
- [ ] Comandos `stratum memory list/search/forget`

**Entregable:** El agente recuerda decisiones entre sesiones y puede recuperarlas semánticamente.

---

### Hito 6 — Multi-provider Polishing *(~3 días)*
- [ ] Soporte Ollama completo (listado de modelos, pull, etc.)
- [ ] Soporte llama.cpp server
- [ ] Soporte vLLM
- [ ] LiteLLM proxy routing
- [ ] Provider health check al startup
- [ ] Fallback automático a provider secundario
- [ ] Comando `stratum providers list`

**Entregable:** El agente funciona de forma transparente con cualquier backend LLM.

---

### Hito 7 — Plan & Execute Mode *(~7 días)*
- [ ] `Planner`: genera plan estructurado antes de ejecutar
- [ ] Representación de plan (lista de pasos con dependencias)
- [ ] Checkpoints de aprobación del usuario
- [ ] Ejecución paso a paso con posibilidad de editar plan
- [ ] Flag `--plan` en `stratum run`
- [ ] UI de plan en Ink

**Entregable:** `stratum run --plan "task"` muestra plan, pide aprobación, ejecuta paso a paso.

---

### Hito 8 — Multi-agent Foundation *(~10 días)*
- [ ] `Orchestrator`: agente principal que delega en subagentes
- [ ] Spawning de subagentes con contexto aislado
- [ ] Protocolo de comunicación entre agentes (mensajes estructurados)
- [ ] Agregación de resultados
- [ ] Agentes especializados: `CodeAgent`, `ShellAgent`, `ResearchAgent`
- [ ] Visualización de árbol de agentes en Ink

**Entregable:** Tareas complejas se distribuyen entre subagentes especializados con resultados agregados.

---

## 10. Próximos Pasos Inmediatos

1. **Crear repositorio Git** en `D:\Archivos\Javier\Proyectos\CLI\stratum-cli`
2. **Inicializar package.json** con el stack definido
3. **Configurar TypeScript + tsup + Vitest**
4. **Implementar Hito 0**: CLI entry point + config system
5. **Primer commit**: scaffolding funcional

---

## 11. Decisiones Técnicas Clave

| Decisión | Elección | Alternativas descartadas | Razón |
|---|---|---|---|
| LLM client | Propio (OpenAI-compat) | ai-sdk, openai npm | Control total, sin lock-in |
| Terminal UI | Ink | blessed, terminal-kit | React mental model, componentes |
| Vector DB | sqlite-vec | Chroma, Qdrant, PGVector | Embebido, sin servidor, portable |
| Embeddings | ONNX local (@xenova) | OpenAI embeddings API | Sin API key, privado, offline |
| Config | .stratumrc.json + Zod | dotenv, yaml | Tipado, validación en runtime |
| Shell tool | execa | child_process directo | API async limpia, manejo de errores |
| Build | tsup | tsc, webpack, rollup | Rápido, zero-config, ESM+CJS |

---

*Documento generado: 2026-05-27 | Versión: 0.1.0-draft*
