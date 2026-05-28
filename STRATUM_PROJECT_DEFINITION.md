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
- [x] Inicializar proyecto TypeScript con tsup
- [x] CLI entry point con Commander.js
- [x] Sistema de configuración (`.stratumrc.json` + Zod schema)
- [x] Estructura de directorios base
- [x] Script de desarrollo con hot-reload
- [x] Vitest configurado

**Entregable:** `stratum --version` funciona. Config se carga correctamente.

---

### Hito 1 — Core Agent Loop *(~5 días)*
- [x] `ProviderRouter` con cliente OpenAI-compatible
- [x] Streaming de responses (SSE parser)
- [x] `ReactLoop` básico (sin tools)
- [x] `ToolRegistry` con dispatch
- [x] Tools básicas: `read_file`, `write_file`, `bash`
- [x] System prompt base
- [x] Ink UI: ChatView con streaming

> **UI:** Implementar el esqueleto completo de la interfaz. Ver [§2 — Layout y Zonas](./STRATUM_UI_SPECIFICATION.md#2-layout-y-zonas), [§3 — Banner de Arranque](./STRATUM_UI_SPECIFICATION.md#3-estado-a--banner-de-arranque) (typewriter + transición), [§4.1 — Status Bar](./STRATUM_UI_SPECIFICATION.md#41-status-bar), [§4.2 — Área de Conversación](./STRATUM_UI_SPECIFICATION.md#42-área-de-conversación) (streaming text + cursor parpadeante), [§5.2 — Input Area](./STRATUM_UI_SPECIFICATION.md#52-input-area--comandos-y-autocompletado) (modo normal únicamente), [§6 — Paleta de Colores](./STRATUM_UI_SPECIFICATION.md#6-paleta-de-colores), [§8 — Animaciones](./STRATUM_UI_SPECIFICATION.md#8-animaciones-y-transiciones), [§10 — Atajos de Teclado](./STRATUM_UI_SPECIFICATION.md#10-atajos-de-teclado), [§11 — Mapeo a Componentes Ink](./STRATUM_UI_SPECIFICATION.md#11-mapeo-a-componentes-ink) (`App`, `Banner`, `ConversationView`, `StatusBar`, `StreamingText`, `InputArea`).

**Entregable:** `stratum chat` funciona. El agente puede leer archivos y ejecutar comandos básicos.

---

### Hito 2 — Memory Layer 1 *(~3 días)*
- [ ] `STRATUM.md` loader (proyecto + global)
- [ ] Inyección en system prompt
- [ ] `SessionContext`: historial de conversación
- [ ] Compresión de contexto básica (truncation con resumen)
- [ ] Comando `stratum memory show`

> **UI:** El porcentaje de contexto en el status bar pasa a ser funcional (cambia de color según el umbral: verde / ámbar / rojo). Activar el comando `/memory show` en el input. Ver [§4.1 — Status Bar](./STRATUM_UI_SPECIFICATION.md#41-status-bar) (indicador de contexto %), [§5.2 — /comandos](./STRATUM_UI_SPECIFICATION.md#52-input-area--comandos-y-autocompletado) (`/memory show`).

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
- [ ] Markdown rendering de respuestas del agente (`<MarkdownText>` con `marked` + Ink components manuales)

> **UI:** El bloque de tool calls y el markdown rendering son las piezas centrales de este hito. Implementar los cuatro estados de tool call (`pending`, `running`, `completed`, `error`), el spinner animado, el timer incremental, el toggle de expansión con output colapsable, y el prompt de confirmación para operaciones destructivas. Implementar también el sistema dual-mode de renderizado de markdown: `<StreamingText>` durante la generación, `<MarkdownText>` (usando `marked` + Ink components) al recibir el evento `done`. Ver [§5.1 — Tool Call Block — Estados](./STRATUM_UI_SPECIFICATION.md#51-tool-call-block--estados) (todos los estados y el bloque expandido), [§5.3 — Renderizado de Markdown](./STRATUM_UI_SPECIFICATION.md#53-renderizado-de-markdown-en-respuestas-del-agente) (dual-mode, estructura de componentes, elementos soportados), [§8 — Animaciones](./STRATUM_UI_SPECIFICATION.md#8-animaciones-y-transiciones) (spinner + timer + transición StreamingText→MarkdownText), [§11 — Mapeo a Componentes Ink](./STRATUM_UI_SPECIFICATION.md#11-mapeo-a-componentes-ink) (`ToolCallBlock`, `MarkdownText`, `CodeBlock`).

**Entregable:** Agente con toolset completo del día 1. Puede realizar tareas de código completas.

---

### Hito 4 — MCP Client *(~4 días)*
- [ ] Integración `@modelcontextprotocol/sdk`
- [ ] Conexión a MCP servers desde `.stratumrc.json`
- [ ] Auto-registro de MCP tools en `ToolRegistry`
- [ ] Listado de tools MCP disponibles
- [ ] Comando `stratum mcp list`

> **UI:** Cubrir el estado de error específico de MCP en el tool call block (`tool_error` con mensaje "MCP server unavailable") y activar `/tools` en el autocompletado del input. El indicador `●` del status bar refleja también la conectividad de MCP servers. Ver [§5.1 — estado `error`](./STRATUM_UI_SPECIFICATION.md#51-tool-call-block--estados), [§4.1 — Status Bar](./STRATUM_UI_SPECIFICATION.md#41-status-bar) (indicador de conexión), [§5.2 — /comandos](./STRATUM_UI_SPECIFICATION.md#52-input-area--comandos-y-autocompletado) (`/tools`).

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

> **UI:** Activar los comandos `/memory list`, `/memory search` y `/memory forget` en el autocompletado. Añadir indicador visual discreto cuando el agente recupera memoria semántica (evento `memory_retrieved` del `AgentEvent` schema). Mostrar la barra de progreso de descarga del modelo ONNX en el primer arranque. Ver [§5.2 — /comandos](./STRATUM_UI_SPECIFICATION.md#52-input-area--comandos-y-autocompletado) (`/memory list/search/forget`), [§11 — Mapeo a Componentes Ink](./STRATUM_UI_SPECIFICATION.md#11-mapeo-a-componentes-ink) (evento `memory_retrieved`), [§15 — Consideraciones Windows vs Linux](./STRATUM_UI_SPECIFICATION.md#15-consideraciones-windows-vs-linux) (carga ONNX).

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

> **UI:** El indicador `●` del status bar refleja el estado del provider en tiempo real (verde / rojo / gris según health check). El `/provider <name>` y `/model <name>` pasan a estar operativos en el autocompletado. En caso de fallback automático, notificar al usuario con un mensaje inline en el área de conversación. Ver [§4.1 — Status Bar](./STRATUM_UI_SPECIFICATION.md#41-status-bar) (indicador de conexión), [§5.2 — /comandos](./STRATUM_UI_SPECIFICATION.md#52-input-area--comandos-y-autocompletado) (`/provider`, `/model`).

**Entregable:** El agente funciona de forma transparente con cualquier backend LLM.

---

### Hito 7 — Plan & Execute Mode *(~7 días)*
- [ ] `Planner`: genera plan estructurado antes de ejecutar
- [ ] Representación de plan (lista de pasos con dependencias)
- [ ] Checkpoints de aprobación del usuario
- [ ] Ejecución paso a paso con posibilidad de editar plan
- [ ] Flag `--plan` en `stratum run`
- [ ] UI de plan en Ink

> **UI:** ⚠️ *La especificación de UI actual no cubre este modo — requiere extensión de `STRATUM_UI_SPECIFICATION.md` antes de comenzar la implementación.* Necesita diseñar: vista de plan (lista numerada de pasos con estado `pending / in_progress / done / skipped`), prompt de aprobación interactivo (aprobar / editar / rechazar), y la transición de la vista de plan a la vista de conversación durante la ejecución. Activar `/plan` en el autocompletado. Ver [§5.2 — /comandos](./STRATUM_UI_SPECIFICATION.md#52-input-area--comandos-y-autocompletado) (`/plan`).

**Entregable:** `stratum run --plan "task"` muestra plan, pide aprobación, ejecuta paso a paso.

---

### Hito 8 — Multi-agent Foundation *(~10 días)*
- [ ] `Orchestrator`: agente principal que delega en subagentes
- [ ] Spawning de subagentes con contexto aislado
- [ ] Protocolo de comunicación entre agentes (mensajes estructurados)
- [ ] Agregación de resultados
- [ ] Agentes especializados: `CodeAgent`, `ShellAgent`, `ResearchAgent`
- [ ] Visualización de árbol de agentes en Ink

> **UI:** ⚠️ *La especificación de UI actual no cubre este modo — requiere extensión de `STRATUM_UI_SPECIFICATION.md` antes de comenzar la implementación.* Necesita diseñar: árbol de agentes activos (orquestador + subagentes con sus tool call blocks anidados), indicador de qué agente está "hablando" en cada momento, vista de resultados agregados, y cómo representar la delegación de tareas en el flujo de conversación.

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

---

## 13. Documentos Relacionados

| Documento | Descripción |
|---|---|
| [STRATUM_UI_SPECIFICATION.md](./STRATUM_UI_SPECIFICATION.md) | Especificación completa de la interfaz de terminal (Ink): layout, componentes, colores, animaciones, atajos de teclado y mapeo de componentes React |

---

*Documento generado: 2026-05-27 | Versión: 0.1.0-draft*

---

## 12. Especificaciones Técnicas Detalladas

Esta sección resuelve los puntos de ambigüedad identificados antes de comenzar el desarrollo. Cada decisión está justificada y es vinculante para la implementación.

---

### 12.1 — Schema de `AgentEvent`

Todos los módulos que consuman el generador `StratumAgent.run()` deben depender de esta definición y solo de esta.

```typescript
// src/agent/types.ts

type AgentEvent =
  | { type: 'text_delta';       delta: string }
  | { type: 'tool_call_start';  id: string; name: string; input_so_far: string }
  | { type: 'tool_call_ready';  id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result';      id: string; name: string; result: string; durationMs: number }
  | { type: 'tool_error';       id: string; name: string; error: string; recoverable: boolean }
  | { type: 'memory_retrieved'; decisions: DecisionEntry[] }
  | { type: 'thinking';         text: string }          // reasoning interno del modelo
  | { type: 'error';            message: string; fatal: boolean }
  | { type: 'done';             stopReason: 'stop' | 'max_iterations' | 'cancelled' }
```

**Invariantes:**
- Todo `tool_call_start` tiene exactamente un `tool_call_ready` posterior (o un `tool_error` si el parsing falla).
- Todo `tool_call_ready` tiene exactamente un `tool_result` o `tool_error` posterior.
- El evento `done` es siempre el último evento del generador. Nunca hay eventos después.
- `fatal: true` en `error` significa que el loop se abortó. `fatal: false` es un error recuperado.

La UI (Ink) y los comandos `chat` / `run` consumen exclusivamente este stream de eventos. Ningún módulo accede al estado interno del agente directamente.

---

### 12.2 — Parsing de tool calls en streaming SSE

El protocolo OpenAI-compatible envía tool calls fragmentadas en chunks SSE. El `ResponseParser` (en `src/providers/openai-compatible.ts`) debe acumularlas y emitir eventos completos.

**Estructura del chunk SSE con tool call:**
```json
{
  "choices": [{
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": "{\"path\": \"/src/"
        }
      }]
    }
  }]
}
```

Los argumentos llegan fragmentados. El parser debe acumularlos en un `StreamBuffer` por `index`:

```typescript
class StreamBuffer {
  private toolBuffers: Map<number, { id: string; name: string; args: string }> = new Map();

  feed(chunk: OpenAIStreamChunk): AgentEvent[] {
    const events: AgentEvent[] = [];
    const delta = chunk.choices[0]?.delta;

    // Texto normal
    if (delta?.content) {
      events.push({ type: 'text_delta', delta: delta.content });
    }

    // Tool call chunks
    for (const tc of delta?.tool_calls ?? []) {
      if (!this.toolBuffers.has(tc.index)) {
        // Primera vez que vemos este índice: emitir start
        this.toolBuffers.set(tc.index, { id: tc.id, name: tc.function.name, args: '' });
        events.push({ type: 'tool_call_start', id: tc.id, name: tc.function.name, input_so_far: '' });
      }
      const buf = this.toolBuffers.get(tc.index)!;
      buf.args += tc.function.arguments ?? '';
      // Actualizar el start event con el input acumulado (para la UI progresiva)
      events.push({ type: 'tool_call_start', id: buf.id, name: buf.name, input_so_far: buf.args });
    }

    // finish_reason: 'tool_calls' → parsear todos los buffers acumulados
    if (chunk.choices[0]?.finish_reason === 'tool_calls') {
      for (const [, buf] of this.toolBuffers) {
        try {
          const input = JSON.parse(buf.args);
          events.push({ type: 'tool_call_ready', id: buf.id, name: buf.name, input });
        } catch {
          events.push({ type: 'tool_error', id: buf.id, name: buf.name,
            error: `Invalid JSON in tool arguments: ${buf.args}`, recoverable: false });
        }
      }
      this.toolBuffers.clear();
    }

    return events;
  }
}
```

**Modelos que envían múltiples tool calls en un turno** (Claude, GPT-4o): el buffer soporta `index` 0..N de forma natural, acumulando en paralelo.

---

### 12.3 — Política de errores en el ReAct loop

**Decisión: Inject & Recover con límite de reintentos por tool.**

Cuando una tool falla, el error se inyecta como `tool_result` con el mensaje de error y el agente decide cómo proceder (reintentar, buscar alternativa, abortar). El loop nunca aborta automáticamente por un error de tool, excepto cuando se supera el máximo de iteraciones global.

```typescript
// Configuración en .stratumrc.json
{
  "agent": {
    "maxIterations": 50,        // iteraciones totales del loop
    "maxToolRetries": 3,        // reintentos por tool por sesión (no por llamada)
    "toolErrorFormat": "xml"    // formato del error inyectado
  }
}
```

**Formato del tool_result de error inyectado al LLM:**
```xml
<tool_error>
  <tool>bash</tool>
  <error>Command failed with exit code 1: permission denied</error>
  <suggestion>Consider using sudo or checking file permissions first.</suggestion>
</tool_error>
```

**Errores no recuperables** (fallos del propio sistema, no de la tool):
- Error de red al llamar al LLM → reintento con backoff exponencial (3 intentos, 1s/2s/4s), luego `{ type: 'error', fatal: true }`.
- JSON inválido en argumentos de tool → `tool_error` con `recoverable: false`, el loop sigue pero el agente recibe el error.

---

### 12.4 — Compresión de contexto

**Decisión: umbral al 80% del `context_window` del modelo activo, compresión via LLM call.**

El `ContextManager` (parte de `src/agent/harness.ts`) evalúa el tamaño del historial antes de cada iteración.

**Estimación de tokens:** sin tokenizador universal, se usa `chars / 3.5` como proxy (conservador para español/inglés mezclado). El `context_window` del modelo se toma de la config del provider.

```typescript
// .stratumrc.json
{
  "providers": {
    "local-ollama": {
      "model": "qwen2.5-coder:32b",
      "contextWindow": 32768        // tokens máximos del modelo
    }
  }
}
```

**Algoritmo de compresión:**
```
1. Estimar tokens actuales: sum(chars) / 3.5
2. Si tokens_estimados > contextWindow * 0.80:
   a. Separar "zona protegida": [system_prompt] + últimas 6 rondas (configurable)
   b. Comprimir el historial antiguo con un LLM call:
      prompt: "Resume esta conversación en máximo 500 palabras preservando decisiones técnicas y contexto clave:"
      model: el mismo provider activo (o un modelo pequeño si se configura compressor_model)
   c. Reemplazar historial antiguo por: [{ role: 'assistant', content: '<summary>...</summary>' }]
3. Emitir evento interno de compresión (visible en --debug mode)
```

**Zona protegida (nunca comprimida):**
- System prompt completo
- Últimas N rondas (default: 6, configurable `agent.compressionKeepRounds`)
- Tool results de la iteración actual

---

### 12.5 — Tools destructivas en modo `stratum run`

**Decisión: Pausar y pedir confirmación interactiva (selector sí/no) incluso en modo non-interactive.**

`stratum run` no es completamente no-interactivo: puede pausarse para confirmar operaciones destructivas. Esto es más seguro que bloquearlo completamente y más explícito que el flag `--allow-destructive` silencioso.

**Flujo:**
```
stratum run "limpia los logs viejos"
  → Agente decide ejecutar: rm -rf /var/log/app/*.log
  → Sistema detecta patrón destructivo

  ⚠  El agente quiere ejecutar una operación destructiva:
     bash: rm -rf /var/log/app/*.log

  ¿Continuar? (s/N) _
```

**Flags disponibles:**
```bash
stratum run "tarea"                   # Pausa y pregunta en destructivas
stratum run --allow-destructive "task" # Aprueba todas las destructivas sin preguntar
stratum run --deny-destructive "task"  # Bloquea todas las destructivas y las inyecta como error
```

**Patrones destructivos detectados (lista configurable en `.stratumrc.json`):**
```
rm, rmdir, dd, mkfs, format, DROP, DELETE, truncate, shred, wipefs, > (overwrite redirect)
```

**En piped/CI mode** (stdin no es TTY): si no se puede mostrar el prompt, se comporta como `--deny-destructive` automáticamente. El agente recibe el error y puede buscar alternativas.

---

### 12.6 — Persistencia y reanudación de sesiones

**Decisión: Sesión arranca limpia por defecto. `--resume session_id` restaura historial exacto.**

**Almacenamiento de sesiones:**
```
~/.stratum/sessions/
  sess_20260527_143022_abc.json   # historial completo
  sess_20260527_091511_xyz.json
```

**Schema de sesión guardada:**
```json
{
  "id": "sess_20260527_143022_abc",
  "createdAt": "2026-05-27T14:30:22Z",
  "updatedAt": "2026-05-27T15:12:08Z",
  "provider": "local-ollama",
  "model": "qwen2.5-coder:32b",
  "project": "/home/javi/proyectos/mi-repo",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "toolCallCount": 12,
  "summary": "Sesión de refactoring del módulo de autenticación"
}
```

**Ciclo de vida:**
- Al iniciar `stratum chat`: crea nueva sesión en memoria.
- Al terminar (Ctrl+C, `exit`, `/quit`): guarda automáticamente en `~/.stratum/sessions/`.
- Con `--resume sess_20260527_143022_abc`: carga el historial completo y continúa.

**Comandos de gestión:**
```bash
stratum sessions list              # Lista sesiones guardadas con fecha y resumen
stratum sessions list --last 5     # Últimas 5
stratum sessions resume <id>       # Equivalente a stratum chat --resume <id>
stratum sessions delete <id>       # Elimina una sesión
stratum sessions prune --older 30d # Limpia sesiones de más de 30 días
```

**Auto-generación del resumen:** al guardar, si la sesión tiene más de 5 rondas, se hace un LLM call para generar el campo `summary` (máx 100 chars). Se usa para el listado de sesiones.

---

### 12.7 — Detección y persistencia de decisiones importantes

**Decisión: `store_decision` como tool interna que el agente invoca él mismo.**

El agente tiene disponible en todo momento la tool `store_decision`. El system prompt le indica cuándo usarla. No hay LLM call extra ni clasificador externo. El costo es cero si el agente decide que no hubo decisión relevante.

**Tool definition:**
```typescript
{
  name: 'store_decision',
  description: `Persiste una decisión importante tomada durante esta sesión en la memoria a largo plazo.
Úsala cuando: (1) elijas entre alternativas técnicas significativas, (2) definas convenciones del proyecto,
(3) resuelvas un bug no trivial, (4) el usuario te dé una preferencia explícita que debas recordar.
NO la uses para acciones rutinarias o pasos intermedios.`,
  schema: z.object({
    title:   z.string().max(100).describe('Título breve de la decisión'),
    content: z.string().describe('Explicación detallada: contexto, alternativas consideradas, razón de la elección'),
    type:    z.enum(['architectural', 'tooling', 'convention', 'bug_fix', 'security', 'user_preference']),
    tags:    z.array(z.string()).max(5).describe('Tags para búsqueda semántica'),
    importance: z.enum(['low', 'medium', 'high']),
  }),
  destructive: false,
  execute: async (params) => decisionStore.save(params)
}
```

**Instrucción en system prompt:**
```
Tienes acceso a la tool store_decision. Úsala proactivamente cuando tomes decisiones técnicas 
significativas o cuando el usuario exprese preferencias que deban persistir entre sesiones. 
Piensa en ello como escribir en tu cuaderno de notas a largo plazo.
```

---

### 12.8 — Ciclo de vida de los MCP servers

**Política: inicio eager al arrancar el proceso, reconexión automática con backoff.**

```
Al iniciar stratum:
  1. Leer lista de MCP servers en .stratumrc.json
  2. Lanzar cada server (spawn proceso hijo o conectar vía HTTP/stdio)
  3. Descubrir tools disponibles (tools/list)
  4. Registrar tools en ToolRegistry con prefijo del server: "filesystem/read_file"
  5. Si un server falla al iniciar: warning en UI, no abortar el arranque

Durante la sesión:
  - Heartbeat cada 30s (configurable, mcp.heartbeatInterval)
  - Si heartbeat falla: marcar tools del server como unavailable
  - Reconexión: backoff exponencial 2s → 4s → 8s (máx 3 intentos)
  - Si no reconecta: las tools quedan disabled, el agente recibe error descriptivo al intentar usarlas

Al terminar stratum:
  - Shutdown graceful: SIGTERM a cada proceso hijo, esperar 2s, SIGKILL si no responde
```

**Comportamiento cuando una tool MCP no está disponible:**
```xml
<tool_error>
  <tool>filesystem/read_file</tool>
  <error>MCP server 'filesystem' is currently unavailable (reconnecting...)</error>
  <suggestion>Try again in a few seconds or use the built-in read_file tool instead.</suggestion>
</tool_error>
```

---

### 12.9 — Paralelismo de tool calls

**Decisión: ejecución paralela con `Promise.allSettled`, habilitada por defecto.**

Cuando el LLM emite múltiples tool calls en un turno (posible en Claude y GPT-4o), el `ToolDispatcher` las ejecuta en paralelo:

```typescript
async function dispatchToolCalls(calls: ToolCallReady[]): Promise<ToolResult[]> {
  if (calls.length === 1) {
    return [await dispatchSingle(calls[0])];
  }

  // Ejecución paralela
  const results = await Promise.allSettled(calls.map(dispatchSingle));

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { id: calls[i].id, name: calls[i].name, error: r.reason.message, recoverable: true }
  );
}
```

**Consideraciones de seguridad en paralelo:**
- Tools marcadas como `serialized: true` en su definición se ejecutan siempre de forma secuencial, incluso si el modelo las emite juntas. Por defecto: `bash` es `serialized: true`, las tools de filesystem son paralelas.
- Las confirmaciones destructivas se resuelven secuencialmente (no se muestran dos prompts a la vez).

**Orden de resultados:** los `tool_result` se envían al LLM en el mismo orden en que el modelo los emitió, independientemente del orden de finalización.

---

### 12.10 — Carga del modelo ONNX (`@xenova/transformers`)

**Decisión: lazy load en primer uso, con warm-up opcional en config.**

El modelo ONNX (`all-MiniLM-L6-v2`, ~23MB) se descarga en `~/.stratum/models/` en el primer uso y se cachea localmente. Las descargas posteriores son instantáneas.

**Estrategia de carga:**
```typescript
class EmbeddingService {
  private pipeline: Pipeline | null = null;
  private loadPromise: Promise<Pipeline> | null = null;

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipeline) {
      // Lazy load: solo cuando se necesita por primera vez
      if (!this.loadPromise) {
        this.loadPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
          cache_dir: path.join(os.homedir(), '.stratum', 'models'),
        });
      }
      this.pipeline = await this.loadPromise;
    }
    return this.pipeline(text, { pooling: 'mean', normalize: true }).then(r => r.data);
  }
}
```

**Warm-up configurable:**
```json
{
  "memory": {
    "embeddingWarmup": true    // precarga ONNX al arrancar el proceso
  }
}
```

Con `embeddingWarmup: true`, el modelo se carga en background durante el splash de arranque. La UI muestra un indicador discreto "Cargando modelos de memoria..." que desaparece cuando termina (3-10s en el primer arranque, <1s desde caché).

**Primera ejecución (descarga del modelo):**
```
stratum chat
  ⟳ Descargando modelo de embeddings (23 MB)... [████████░░] 82%
  ✓ Modelo listo — ~/.stratum/models/all-MiniLM-L6-v2
```

---

### 12.11 — Distribución e instalación

**Decisión: `npm install -g stratum-cli` como canal principal.**

**Resolución de rutas en instalación global:**
- `~/.stratum/` para datos del usuario (sesiones, memoria, modelos ONNX)
- La config del proyecto (`.stratumrc.json`) se busca en el directorio de trabajo actual subiendo hasta la raíz, igual que hace Git con `.git/`

**package.json relevante:**
```json
{
  "name": "stratum-cli",
  "bin": {
    "stratum": "./dist/index.js"
  },
  "files": ["dist/", "STRATUM.md.template"],
  "engines": {
    "node": ">=22.0.0"
  }
}
```

**Canales de distribución:**
```bash
# Producción (canal principal)
npm install -g stratum-cli

# Desarrollo local (link simbólico)
npm run build && npm link

# Prueba sin instalar
npx stratum-cli@latest chat
```

**Inicialización en nuevo proyecto:**
```bash
stratum init        # Crea .stratumrc.json + STRATUM.md con plantillas en el directorio actual
```

---

### 12.12 — Cancelación con Ctrl+C (señales del proceso)

**Decisión: shutdown graceful con cleanup definido por etapa.**

El `ReactLoop` registra un `AbortController` por sesión. El handler de `SIGINT` activa el abort y espera el cleanup.

```typescript
// En cli/commands/chat.ts
const controller = new AbortController();

process.on('SIGINT', async () => {
  console.log('\n⏸  Cancelando...');
  controller.abort();
});

// El ReactLoop recibe el signal
for await (const event of agent.run(input, { signal: controller.signal })) {
  // render events...
}
```

**Comportamiento por etapa al recibir Ctrl+C:**

| Etapa | Comportamiento |
|---|---|
| LLM streaming | Cancela el fetch (AbortSignal). El chunk parcial se descarta. |
| Tool en ejecución | La tool recibe el signal. `bash` hace SIGTERM al proceso hijo (SIGKILL tras 2s). Tools de filesystem terminan la operación actual antes de salir. |
| Confirmación pendiente | Respuesta automática "No" y loop termina. |
| Entre iteraciones | Loop termina limpiamente en el siguiente checkpoint. |

**Cleanup al terminar (Ctrl+C o exit normal):**
1. Cerrar MCP servers (SIGTERM → SIGKILL fallback)
2. Guardar sesión en `~/.stratum/sessions/` (si hay historial)
3. Escribir decisiones pendientes al JSON store
4. Emitir `{ type: 'done', stopReason: 'cancelled' }` al stream

**Segundo Ctrl+C:** si el usuario presiona Ctrl+C por segunda vez durante el cleanup, se hace `process.exit(1)` inmediato sin más espera.
