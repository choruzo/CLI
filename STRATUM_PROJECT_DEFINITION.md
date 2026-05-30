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
| SSH | ssh2 | Cliente SSH puro Node.js — exec, SFTP, agent forwarding, jump hosts. Sin dependencia del binario `ssh` del sistema. |
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
  "execa": "Shell execution con mejor API que child_process",
  "ssh2": "Cliente SSH puro Node.js: exec remoto, SFTP, agent forwarding, jump hosts",
  "keytar": "Acceso al keychain del SO para passwords SSH (opcional)"
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
  healthCheck(): Promise<boolean>;  // cableado en Hito 6; ver nota de status bar abajo
}
```

Providers soportados desde v1: `OpenAICompatible` (cubre Ollama, llama.cpp, vLLM, LiteLLM proxy, OpenAI, Anthropic vía proxy).

> **Indicador `●` de provider (Hitos 1-5):** `healthCheck()` no está activo hasta el Hito 6. En los hitos anteriores, el indicador de la status bar se basa en el resultado de la **última llamada al LLM**: verde si completó sin error, rojo si la última request falló. No hay polling activo. Cuando `healthCheck()` se cablee en el Hito 6, reemplaza esta lógica y el indicador pasa a reflejar el estado real del provider.

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
  "id": "dec_20260527_k3xP9q",
  "timestamp": "2026-05-27T10:30:00Z",
  "session_id": "sess_abc123",
  "type": "architectural",
  "title": "Usar sqlite-vec en lugar de Chroma",
  "content": "Se decidió sqlite-vec por ser embebido y sin dependencias de servidor. Chroma requería Docker.",
  "tags": ["database", "vectors", "infraestructura"],
  "importance": "high",
  "embedding_ref": "vec_dec_20260527_k3xP9q",
  "project": "stratum-cli"
}
```

**Generación de IDs:** `decisionStore.save()` genera el `id` con el formato `dec_YYYYMMDD_<nanoid6>` antes de escribir en disco (sin leer el JSON previo, sin riesgo de colisión entre sesiones concurrentes). El `embedding_ref` se deriva del `id` como `vec_${id}` y se asigna en el mismo paso; la capa vectorial usa ese string como clave al hacer el INSERT en sqlite-vec.

**Generación de IDs:** `decisionStore.save()` genera el `id` con el formato `dec_YYYYMMDD_<nanoid6>` antes de escribir en disco (sin leer el JSON previo, sin riesgo de colisión entre sesiones concurrentes). El `embedding_ref` se deriva del `id` como `vec_${id}` y se asigna en el mismo paso; la capa vectorial usa ese string como clave al hacer el INSERT en sqlite-vec.

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

**Pipeline de escritura** (trigger: agente invoca `store_decision`):
```
Agente invoca store_decision (serialized: true)
        │
        ▼
decisionStore.save():
  1. Generar id = dec_YYYYMMDD_<nanoid6>
  2. Derivar embedding_ref = vec_${id}
  3. Append entrada completa a decisions.json
        │
        ▼
Generar embedding del content (ONNX local)
        │
        ▼
INSERT en sqlite-vec usando embedding_ref como clave
```

---

## 6. Configuración (`.stratumrc.json`)

**Expansión de variables de entorno:** los valores con formato `${VAR_NAME}` se expanden al cargar la config. Si la variable no está definida en el entorno, el proceso **aborta con error fatal** antes de arrancar, indicando qué variable falta:
```
Error: Variable de entorno requerida no definida: LITELLM_API_KEY
       Referenciada en: provider.providers.litellm-proxy.apiKey
```

**Seguridad de secretos:** los valores de `apiKey` **nunca se persisten** en los archivos de sesión (`~/.stratum/sessions/*.json`). En modo `--debug`, los headers `Authorization` se enmascaran como `Bearer sk-***...` en todos los logs. Ver §12.6 para el schema de sesión.

**Expansión de variables de entorno:** los valores con formato `${VAR_NAME}` se expanden al cargar la config. Si la variable no está definida en el entorno, el proceso **aborta con error fatal** antes de arrancar, indicando qué variable falta:
```
Error: Variable de entorno requerida no definida: LITELLM_API_KEY
       Referenciada en: provider.providers.litellm-proxy.apiKey
```

**Seguridad de secretos:** los valores de `apiKey` **nunca se persisten** en los archivos de sesión (`~/.stratum/sessions/*.json`). En modo `--debug`, los headers `Authorization` se enmascaran como `Bearer sk-***...` en todos los logs. Ver §12.6 para el schema de sesión.

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
  },
  "ssh": {
    "hosts": {
      "bastion": {
        "host": "bastion.example.com",
        "port": 22,
        "user": "javi",
        "privateKey": "~/.ssh/id_ed25519"
      },
      "prod-web": {
        "host": "192.168.1.10",
        "port": 22,
        "user": "javi",
        "privateKey": "~/.ssh/id_ed25519",
        "jumpHost": "bastion",
        "confirmAll": true
      },
      "dev-server": {
        "host": "10.0.0.5",
        "port": 22,
        "user": "javi",
        "agentForwarding": true
      }
    }
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
│   │   ├── mcp/
│   │   │   ├── client.ts      # MCP client wrapper
│   │   │   └── bridge.ts      # MCP tools → ToolRegistry bridge
│   │   └── ssh/
│   │       ├── pool.ts        # SSHConnectionPool — conexiones persistentes por alias
│   │       ├── exec.ts        # ssh_exec tool
│   │       ├── sftp.ts        # ssh_upload / ssh_download tools
│   │       └── inventory.ts   # Carga y validación del inventario de hosts
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

# Inicialización y onboarding de proyecto
stratum init                           # Escanea el proyecto y genera/actualiza STRATUM.md
stratum init --force                   # Sobreescribe STRATUM.md sin preguntar por secciones manuales
stratum init --dry-run                 # Muestra el STRATUM.md que generaría sin escribirlo

# Diagnóstico del entorno
stratum doctor                         # Valida config, prueba conexión a providers y MCP servers, verifica modelo ONNX

# Gestión de sesiones
stratum sessions list                  # Lista sesiones guardadas con fecha y resumen
stratum sessions list --last 5         # Últimas 5
stratum sessions resume <id>           # Equivalente a stratum chat --resume <id>
stratum sessions delete <id>           # Elimina una sesión
stratum sessions prune --older 30d     # Limpia sesiones de más de 30 días
stratum sessions export <id>           # Exporta una sesión a un archivo JSON portable
stratum sessions export <id> --output ./backup.json
stratum sessions import <file>         # Importa una sesión desde un archivo exportado

# Actualizaciones
stratum update                         # Actualiza Stratum a la última versión publicada en npm
stratum update --check                 # Solo comprueba si hay versión nueva sin instalar
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
- [x] `STRATUM.md` loader (proyecto + global)
- [x] Inyección en system prompt
- [x] `SessionContext`: historial de conversación
- [x] Compresión de contexto básica (truncation con resumen)
- [x] Comando `stratum memory show`
- [x] `stratum init` y `/init` — scan de proyecto y generación/actualización de `STRATUM.md` (ver §12.13)

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

### Hito 9 — SSH Nativo *(~7 días)*

El diferenciador operacional de Stratum: capacidad SSH integrada en el loop ReAct sin depender del binario `ssh` del sistema. El agente puede administrar infraestructura remota con la misma naturalidad con que maneja archivos locales.

- [ ] `SSHConnectionPool`: pool de conexiones persistentes por alias de host
- [ ] Tool `ssh_exec`: ejecución remota con detección de patrones destructivos
- [ ] Tools `ssh_upload` / `ssh_download`: transferencia de ficheros vía SFTP
- [ ] Inventario de hosts en `.stratumrc.json` + Zod schema de validación
- [ ] Autenticación: clave privada, SSH agent forwarding, password (keychain SO), jump hosts
- [ ] Reconexión automática con backoff si la conexión cae durante la sesión
- [ ] Comando `stratum ssh list` — lista hosts con estado de conectividad en tiempo real
- [ ] Limpieza de conexiones en el ciclo de SIGINT (integrado en §12.12)

> **UI:** Adaptar el `ToolCallBlock` para mostrar el host remoto como contexto en las tools SSH (icono de servidor + alias). Mostrar un indicador de latencia en el resultado de `ssh_exec` cuando `durationMs > 1000`. El comando `stratum ssh list` funciona sin UI Ink (plain text), igual que `stratum init`.

**Entregable:** El agente puede ejecutar comandos y transferir ficheros en hosts remotos del inventario, sin binarios del sistema. Administración de infraestructura VMware/Linux desde el loop ReAct.

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
| SSH client | ssh2 | binario `ssh` del sistema, node-forge | Puro Node.js, sin dependencias del SO; soporta SFTP, agent forwarding y jump hosts en Windows/Linux/macOS sin configuración extra |

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
  | { type: 'done';             stopReason: 'stop' | 'max_iterations' | 'cancelled' | 'error' }
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

**Comportamiento al agotar `maxToolRetries`:**

El contador de reintentos por tool lo lleva el `ToolDispatcher` (mapa `toolRetries: Map<toolName, number>` por sesión, no por llamada). Cuando una tool alcanza el límite:

1. `ToolDispatcher` elimina la tool del schema que se envía al LLM en las iteraciones siguientes (`ToolRegistry.disableForSession(toolName)`).
2. Se inyecta un `tool_result` final con `recoverable: false` para que el agente conozca el motivo:
```xml
<tool_error>
  <tool>bash</tool>
  <error>Tool 'bash' has been disabled for this session after 3 consecutive failures.</error>
  <suggestion>This tool is no longer available. Consider an alternative approach.</suggestion>
</tool_error>
```
3. El loop **no aborta**: el agente puede seguir usando otras tools o responder al usuario directamente.

**Errores no recuperables** (fallos del propio sistema, no de la tool):
- Error de red al llamar al LLM → reintento con backoff exponencial (3 intentos, 1s/2s/4s), luego `{ type: 'error', fatal: true }`.
- JSON inválido en argumentos de tool → `tool_error` con `recoverable: false`, el loop sigue pero el agente recibe el error.

---

### 12.4 — Compresión de contexto

**Decisión: umbral al 80% del `context_window` del modelo activo, compresión via LLM call.**

El `ContextManager` (parte de `src/agent/harness.ts`) evalúa el tamaño del historial antes de cada iteración.

**Estimación de tokens:** el `ContextManager` usa la siguiente estrategia en cascada:
1. Si la respuesta del provider incluye `usage.prompt_tokens` (la mayoría de APIs OpenAI-compat lo devuelven), ese valor se usa como referencia para la iteración siguiente.
2. Si `usage` no está disponible (primera iteración o provider que no lo reporta), se usa `chars / 3.5` como proxy conservador (español/inglés mezclado).

La status bar muestra el conteo con prefijo `~` mientras se usa el proxy (`~4.2k / 32k`) y sin prefijo cuando hay dato real del provider (`4.2k / 32k`). El `context_window` del modelo se toma de la config del provider.

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

**Política de fallback cuando la compresión falla o no reduce suficiente:**

```
Caso A — El LLM call de resumen falla (timeout, error de red):
  → No reintentar. Ejecutar el fallback del Caso B directamente.

Caso B — El resumen generado no reduce el contexto por debajo del 80%
         (p.ej. zona protegida + system prompt ya superan el umbral):
  → Truncar duro: eliminar los mensajes más antiguos fuera de la zona protegida
    en bloques de 2 rondas (user+assistant) hasta bajar del 80%, o hasta que
    no quede historial antiguo que eliminar.
  → Si tras truncar todo el historial antiguo el contexto sigue sobre el 80%,
    emitir evento { type: 'warning', message: 'context_window_pressure' } y
    continuar — la zona protegida nunca se toca.
  → Registrar el evento en --debug mode indicando cuántas rondas se eliminaron.
```

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
> **Nota de seguridad:** el campo `provider` guarda solo el nombre del provider (`"local-ollama"`), nunca el `apiKey` ni la `baseUrl`. Los secretos de configuración no se persisten en disco bajo ningún formato.

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
  serialized: true,   // escribe en decisions.json + sqlite-vec; nunca en paralelo consigo misma
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
# Producción — canal estable
npm install -g stratum-cli

# Producción — canal beta (pre-releases)
npm install -g stratum-cli@beta

# Desarrollo local (link simbólico)
npm run build && npm link

# Prueba sin instalar
npx stratum-cli@latest chat
npx stratum-cli@beta chat
```

**Inicialización en nuevo proyecto:**
```bash
stratum init        # Crea .stratumrc.json + STRATUM.md con plantillas en el directorio actual
```

---

**Estrategia de versionado (semver + canal beta):**

Stratum sigue semver estricto con dos canales npm:

| Canal npm | Patrón de versión | Cuándo se publica |
|---|---|---|
| `latest` | `X.Y.Z` | Release estable desde rama `main` |
| `beta` | `X.Y.Z-beta.N` | Pre-release desde rama `beta` o commit candidato |

Reglas:
- `MAJOR` — cambios breaking en API de tools, schema de config o formato de eventos `AgentEvent`
- `MINOR` — nuevas features compatibles hacia atrás (nuevas tools, nuevos comandos, nuevo provider)
- `PATCH` — bugfixes y mejoras de rendimiento sin cambios de API

El campo `"version"` en `package.json` es la fuente de verdad. Nunca editar la versión a mano: se gestiona mediante tags Git (ver pipeline más abajo).

---

**Pipeline de release (GitHub Actions):**

El workflow `.github/workflows/release.yml` se dispara únicamente cuando se hace push de un tag con el patrón `v*.*.*` o `v*.*.*-beta.*`:

```
Push tag vX.Y.Z  ──►  CI: build + test + lint
                           │
                           ▼ (solo si pasan todos)
                       npm publish --tag latest
                       gh release create vX.Y.Z (con changelog)

Push tag vX.Y.Z-beta.N  ──►  CI: build + test + lint
                                  │
                                  ▼
                              npm publish --tag beta
```

Pasos del job de release:
1. `npm ci` — instala dependencias exactas del lockfile
2. `npm run build` — compila con tsup (ESM + CJS)
3. `npm test -- --run` — ejecuta todos los tests sin modo watch
4. `npm run lint` — verifica formato
5. `npm publish --access public [--tag beta]` — publica en npm con el tag correcto
6. `gh release create` — crea GitHub Release con tag y CHANGELOG generado desde commits convencionales

**Protecciones:**
- El job de publish requiere el secret `NPM_TOKEN` configurado en el repositorio.
- Los tags solo los crea el maintainer localmente y los pushea; no hay auto-tagging desde CI.
- `npm publish` falla si la versión del `package.json` no coincide con el tag del push (validación explícita al inicio del job).

**Flujo de trabajo del maintainer para publicar:**
```bash
# Release estable
npm version minor -m "chore: release v%s"   # actualiza package.json + crea commit + tag
git push && git push --tags                  # dispara el workflow

# Pre-release beta
npm version prerelease --preid=beta -m "chore: release v%s"
git push && git push --tags
```

---

**Notificación de updates al usuario:**

Al arrancar cualquier comando (`chat`, `run`, `memory`, etc.), Stratum comprueba silenciosamente en background si existe una versión más reciente en el registro npm. La comprobación:
- Se ejecuta con un timeout de **2 segundos**; si no responde, se ignora silenciosamente.
- El resultado se **cachea en `~/.stratum/update-check.json`** con un TTL de **24 horas** para no spamear el registro npm en cada invocación.
- La notificación se muestra **al final** de la sesión (nunca al inicio, para no bloquear el arranque).

**Formato de la notificación** (solo se muestra si hay versión más nueva):
```
╭─────────────────────────────────────────────────╮
│  Nueva versión disponible: 1.2.0 → 1.3.0        │
│  Ejecuta: npm install -g stratum-cli             │
╰─────────────────────────────────────────────────╯
```

Si la versión instalada es una beta y hay una nueva beta, también se notifica indicando el canal:
```
│  Nueva versión beta disponible: 1.3.0-beta.1 → 1.3.0-beta.2  │
│  Ejecuta: npm install -g stratum-cli@beta                      │
```

**Implementación** (`src/utils/update-check.ts`):
```typescript
interface UpdateCache {
  checkedAt: string;      // ISO timestamp
  latestVersion: string;  // versión en npm
  latestBeta: string;     // versión beta en npm
}

// Se llama desde cli/index.ts justo después de parsear el comando,
// sin await — fire-and-forget con AbortSignal(timeout: 2000)
export async function checkForUpdate(): Promise<string | null>
// Devuelve el mensaje de notificación a mostrar al final, o null si no hay update o falló.
```

**La comprobación se puede deshabilitar** con la variable de entorno `STRATUM_NO_UPDATE_CHECK=1` o el campo `"updateCheck": false` en `.stratumrc.json`.

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

---

### 12.13 — Comando `/init` y `stratum init`

**Decisión: inspección de superficie inteligente del proyecto + generación/actualización de `STRATUM.md` con secciones fijas.**

Este comando es el equivalente Stratum del `CLAUDE.md` auto-generado de Claude Code: permite que el agente conozca el proyecto desde el primer mensaje, sin que el usuario tenga que escribir nada manualmente.

---

#### Puntos de entrada

El comportamiento es idéntico en ambos contextos:

| Contexto | Invocación | Descripción |
|---|---|---|
| CLI (onboarding inicial) | `stratum init` | Se ejecuta antes de entrar al chat. Genera `STRATUM.md` y termina el proceso. Sin UI Ink. Salida plain text al stdout. |
| Chat en curso | `/init` | Se ejecuta dentro de una sesión activa. El agente muestra el progreso en el área de conversación. Al terminar, el `STRATUM.md` generado se carga en el system prompt de la iteración siguiente. |

---

#### Algoritmo de scan (superficie inteligente)

El agente inspecciona el directorio de trabajo en este orden. El proceso completo tarda ~5s en proyectos de tamaño medio; respeta `.gitignore`.

```
1. Estructura de directorios
   - Árbol de carpetas, max depth 3
   - Excluir: node_modules/, .git/, dist/, __pycache__/, .venv/, target/

2. Archivos de manifiesto (stack tecnológico)
   - package.json / package-lock.json
   - pyproject.toml / setup.py / requirements.txt
   - Cargo.toml
   - go.mod
   - pom.xml / build.gradle
   - composer.json
   - Gemfile

3. Archivos de configuración conocidos (convenciones y tooling)
   - tsconfig.json, .eslintrc*, .prettierrc*
   - .editorconfig, .nvmrc, .python-version
   - Dockerfile, docker-compose.yml
   - .github/workflows/*.yml (CI/CD)
   - Makefile

4. Documentación existente
   - README.md (o README.rst / README.txt)
   - CONTRIBUTING.md
   - CHANGELOG.md (solo las primeras 50 líneas)

5. Entry points del código (solo si el manifiesto los referencia explícitamente)
   - El campo "main" / "bin" de package.json
   - El campo [tool.poetry.scripts] de pyproject.toml
   - src/main.rs, cmd/main.go, etc.
```

---

#### Lógica update/merge (cuando `STRATUM.md` ya existe)

`/init` nunca destruye trabajo manual. El proceso de merge es:

```
1. Leer STRATUM.md existente
2. Parsear secciones por encabezado H2 (## Sección)
3. Para cada sección del template fijo:
   a. Si la sección existe en el archivo actual Y tiene contenido no vacío:
      → Marcarla como "manual" — el agente la muestra al usuario y pregunta
        si quiere actualizarla o preservarla.
   b. Si la sección existe pero está vacía o tiene solo el placeholder:
      → Rellenarla automáticamente con lo encontrado en el scan.
   c. Si la sección no existe:
      → Añadirla al final del bloque de secciones fijas.
4. Secciones extra (no parte del template) que el usuario haya añadido:
   → Siempre preservadas, sin tocarlas.
```

Para secciones con contenido manual, el agente muestra en el chat:

```
  ⚠  La sección "## Convenciones" tiene contenido escrito a mano.
     ¿Actualizar con la información del scan? (s/N)
```

Si el usuario responde N, esa sección se deja intacta. Si responde S, el agente fusiona el contenido existente con los nuevos hallazgos (no reemplaza — añade lo que falta).

---

#### Estructura fija del `STRATUM.md` generado

Las cinco secciones son siempre las mismas, en este orden:

```markdown
# Stratum Memory

## Proyecto
<!-- Nombre del proyecto, descripción breve, propósito principal -->

## Stack Tecnológico
<!-- Lenguajes, frameworks, librerías principales, versiones clave -->

## Estructura
<!-- Árbol de directorios relevante con descripción de cada carpeta -->

## Convenciones
<!-- Estilo de código, naming, reglas de commits, patrones detectados -->

## Comandos Clave
<!-- Scripts de build, test, dev, lint — exactamente como aparecen en el manifiesto -->
```

**Ejemplo de output real** para un proyecto TypeScript:

```markdown
# Stratum Memory

## Proyecto
Nombre: stratum-cli
Descripción: Agente CLI extensible construido sobre un loop ReAct.
Repositorio: /home/javi/proyectos/CLI

## Stack Tecnológico
- Runtime: Node.js >=22.0.0
- Lenguaje: TypeScript 5.x
- Build: tsup (ESM + CJS)
- Test: Vitest
- UI terminal: Ink 4 + React 18
- LLM client: implementación propia OpenAI-compatible

## Estructura
src/
  agent/     — Loop ReAct: StratumAgent, ReactLoop, ContextManager
  providers/ — ProviderRouter + OpenAICompatible
  tools/     — ToolRegistry, ToolDispatcher, tools built-in
  memory/    — MemoryManager (STRATUM.md + decisions.json + sqlite-vec)
  cli/       — Entry point Commander.js, comandos, UI Ink

## Convenciones
- Imports ESM con extensión explícita (.js)
- Zod para validación de schemas en runtime
- snake_case para archivos, PascalCase para clases
- Commits en inglés, imperativo

## Comandos Clave
- npm run dev      → desarrollo con hot-reload
- npm run build    → compilar a dist/ (ESM + CJS)
- npm test         → Vitest en modo watch
- npm run lint     → ESLint
- npm run format   → Prettier
```

---

#### Heurísticas de detección de stack

El agente usa estas reglas para inferir el stack a partir de los archivos de manifiesto:

| Señal detectada | Inferencia |
|---|---|
| `package.json` con `"typescript"` en devDependencies | TypeScript |
| `package.json` con `"react"` + `"ink"` | UI terminal con Ink |
| `package.json` con `"vitest"` o `"jest"` | Framework de test |
| `pyproject.toml` con `[tool.poetry]` | Python + Poetry |
| `Cargo.toml` con `[package]` | Rust |
| `go.mod` con `module` | Go |
| `Dockerfile` presente | Containerizado |
| `.github/workflows/` con archivos `.yml` | CI/CD en GitHub Actions |
| `docker-compose.yml` | Orquestación multi-servicio |

Si no se detecta ningún manifiesto conocido, la sección **Stack Tecnológico** se genera con la lista de extensiones de archivo más frecuentes en `src/` o la raíz.

---

#### Implementación

```
src/cli/commands/init.ts     ← comando `stratum init` (Commander.js)
src/agent/init-agent.ts      ← lógica de scan + generación del STRATUM.md
```

`InitAgent` es un agente especializado (no el `StratumAgent` principal) que tiene acceso a un subconjunto reducido de tools: `read_file`, `list_directory`, `bash` (solo lectura). No usa tools destructivas, no persiste sesión, no guarda decisiones.

```typescript
class InitAgent {
  async run(cwd: string, options: InitOptions): AsyncGenerator<InitEvent> {
    // 1. Scan del proyecto
    // 2. Síntesis via LLM call
    // 3. Merge con STRATUM.md existente (si aplica)
    // 4. Escritura del archivo
  }
}

type InitEvent =
  | { type: 'scan_progress'; file: string }
  | { type: 'section_ready'; section: string; content: string }
  | { type: 'merge_conflict'; section: string }   // espera respuesta del usuario
  | { type: 'done'; path: string }
  | { type: 'error'; message: string }
```

---

#### Comportamiento en `stratum init` (CLI sin Ink)

```
$ stratum init

  Stratum — Inicializando proyecto

  ⟳ Escaneando estructura...        ✓ 47 archivos inspeccionados
  ⟳ Detectando stack...             ✓ TypeScript · Node.js · Vitest
  ⟳ Generando STRATUM.md...         ✓

  ✓ STRATUM.md creado en /home/javi/proyectos/CLI/STRATUM.md

  Tip: edita STRATUM.md para añadir convenciones o instrucciones
  permanentes al agente. Se carga automáticamente en cada sesión.
```

Si `STRATUM.md` ya existe y hay secciones con contenido manual, se muestra el prompt de confirmación por sección en el terminal (stdin interactivo), exactamente igual que las confirmaciones destructivas.


### 12.14 — SSH Nativo

**Decisión: `ssh2` como cliente SSH puro Node.js. Pool de conexiones persistentes. Tools registradas en `ToolRegistry` como cualquier otra.**

Stratum no invoca el binario `ssh` del sistema. Todo el protocolo SSH corre dentro del proceso Node.js, garantizando portabilidad (Windows, Linux, macOS) y control total sobre el ciclo de vida de las conexiones.

---

#### Tools disponibles

```typescript
// ssh_exec — ejecución remota
{
  name: 'ssh_exec',
  description: `Ejecuta un comando en un host remoto del inventario SSH.
Usa el alias definido en .stratumrc.json → ssh.hosts.<alias>.
AVISO: la detección de patrones destructivos es orientativa, no un control de seguridad real.
Para hosts de producción, usa confirmAll: true en la config del host.`,
  schema: z.object({
    host:     z.string().describe('Alias del host en el inventario SSH'),
    command:  z.string().describe('Comando a ejecutar en el host remoto'),
    cwd:      z.string().optional().describe('Directorio de trabajo remoto'),
    pty:      z.boolean().optional().describe(
      'Allocate pseudo-terminal. Necesario para sudo con password, apt/dnf interactivo, ' +
      'cualquier comando que requiera TTY. Default: false. ' +
      'Con PTY activo, stdout y stderr se mezclan y el exit code puede no ser fiable.'
    ),
    stdin:    z.string().optional().describe(
      'Texto a enviar al stdin del comando (sin PTY). Útil para "sudo -S", ' +
      'respuestas a prompts predecibles. No usar para interacción real — usar pty: true.'
    ),
    timeout:  z.number().optional().describe('Timeout del comando en ms (default: 30000). Al expirar, el proceso remoto recibe SIGKILL.'),
    maxBytes: z.number().optional().describe('Límite de stdout+stderr en bytes (default: 262144 = 256 KB). El output se trunca si supera este límite.'),
  }),
  destructive: true,   // pide confirmación si detecta patrones peligrosos (red de seguridad blanda — ver nota)
  serialized: false,   // ejecución paralela permitida en hosts distintos
  execute: async (params, ctx) => sshPool.exec(params),
}

// ssh_upload — subir fichero
{
  name: 'ssh_upload',
  description: 'Sube un archivo local a un host remoto vía SFTP.',
  schema: z.object({
    host:       z.string().describe('Alias del host'),
    localPath:  z.string().describe('Ruta local del archivo a subir'),
    remotePath: z.string().describe('Ruta de destino en el host remoto'),
  }),
  destructive: false,
  serialized: false,
  execute: async (params) => sshPool.sftp.upload(params),
}

// ssh_download — descargar fichero
{
  name: 'ssh_download',
  description: 'Descarga un archivo de un host remoto vía SFTP.',
  schema: z.object({
    host:       z.string().describe('Alias del host'),
    remotePath: z.string().describe('Ruta remota del archivo a descargar'),
    localPath:  z.string().describe('Ruta local de destino'),
  }),
  destructive: false,
  serialized: false,
  execute: async (params) => sshPool.sftp.download(params),
}
```

---

#### Schema de inventario SSH (`.stratumrc.json`)

```typescript
// src/config/schema.ts (extensión del schema Zod existente)

const SSHHostSchema = z.object({
  host:           z.string(),
  port:           z.number().default(22),
  user:           z.string(),

  // Auth — al menos uno requerido
  privateKey:     z.string().optional(),    // ruta expandida con ~ al archivo de clave
  passphrase:     z.string().optional(),    // passphrase de la clave privada;
                                            // prefijo "keychain:<alias>" para leer del SO
  useAgent:       z.boolean().optional(),   // usar ssh-agent del sistema para autenticar
                                            // (distinto de agentForwarding, ver §Auth)
  password:       z.string().optional(),    // prefijo "keychain:<alias>" o "env:<VAR>"

  // Topología
  jumpHost:       z.string().optional(),    // alias de otro host como bastión

  // Verificación de host key — ver §Host Key
  hostKeyPolicy:  z.enum(['tofu', 'strict', 'insecure']).default('tofu'),
  hostKeyHash:    z.string().optional(),    // SHA-256 hex pinneado (solo con 'strict')

  // Seguridad operacional
  confirmAll:     z.boolean().default(false), // requerir confirmación en TODOS los comandos

  // Timeouts
  connectTimeout: z.number().default(10000),  // ms para establecer la conexión SSH
  commandTimeout: z.number().default(30000),  // ms por defecto para comandos (override por call)

  // Salida
  maxBytes:       z.number().default(262144), // bytes por defecto para outputs (override por call)
});

const SSHConfigSchema = z.object({
  hosts:    z.record(z.string(), SSHHostSchema).default({}),
  auditLog: z.union([z.boolean(), z.string()]).default(true),
           // true → ~/.stratum/logs/ssh-audit.jsonl
           // string → ruta personalizada
           // false → deshabilitado
});
```

Si no hay sección `ssh` en la config, las tools SSH no se registran en el `ToolRegistry` y el LLM no las ve.

---

#### `SSHConnectionPool` (`src/tools/ssh/pool.ts`)

```typescript
class SSHConnectionPool {
  // Conexiones activas ya establecidas
  private connections:  Map<string, ssh2.Client> = new Map();
  // Promesas en vuelo: evita la carrera en getConnection() con serialized: false
  private inflight:     Map<string, Promise<ssh2.Client>> = new Map();

  // Obtiene una conexión activa, reutiliza la inflight si existe, o crea una nueva (lazy)
  async getConnection(hostAlias: string): Promise<ssh2.Client> {
    if (this.connections.has(hostAlias)) return this.connections.get(hostAlias)!;
    if (this.inflight.has(hostAlias))   return this.inflight.get(hostAlias)!;

    const promise = this._openConnection(hostAlias)
      .then(client => {
        this.connections.set(hostAlias, client);
        this.inflight.delete(hostAlias);
        return client;
      })
      .catch(err => {
        this.inflight.delete(hostAlias);
        throw err;
      });

    this.inflight.set(hostAlias, promise);
    return promise;
  }

  // Tool calls
  async exec(params: SSHExecParams): Promise<SSHExecResult>
  async upload(params: SSHUploadParams): Promise<void>
  async download(params: SSHDownloadParams): Promise<void>

  // Cleanup graceful — ver §Ciclo de vida y teardown
  async closeAll(): Promise<void>
}
```

**El `Map<string, Promise>` en `inflight` es el mutex de establecimiento:** dos tool calls paralelas al mismo alias comparten la misma promesa de conexión en lugar de abrir dos sockets.

---

#### Estrategias de autenticación

| Método | Campo en config | Comportamiento |
|---|---|---|
| Clave privada (sin passphrase) | `privateKey: "~/.ssh/id_ed25519"` | Ruta expandida con `~`. El archivo se lee al abrir la conexión. |
| Clave privada (con passphrase) | `privateKey: "~/.ssh/id_ed25519"` + `passphrase: "keychain:mi-clave"` | La passphrase se resuelve según el prefijo (ver §Resolución de secretos). |
| SSH agent | `useAgent: true` | **Usa el agente para autenticarse** — `ssh2` se conecta al socket del agente (`SSH_AUTH_SOCK` en Linux/macOS, named pipe en Windows). No confundir con agent forwarding (reenviar el agente al host remoto), que es una feature distinta y no está soportada en v1. |
| Password | `password: "keychain:prod"` | Se resuelve según §Resolución de secretos. El password nunca se guarda en texto plano. |
| Jump host | `jumpHost: "bastion"` | TCP forwarding dentro de la conexión al bastión (ver §Jump hosts). |

**Resolución de secretos** (para `password` y `passphrase`):

```
"keychain:<alias>"  → keytar.getPassword('stratum-ssh', alias)
                      Fallback si keytar falla o no hay sesión de escritorio:
                        1. Variable de entorno STRATUM_SSH_<ALIAS_UPPER>_SECRET
                        2. Prompt interactivo (solo si stdin es TTY)
                        3. Error fatal descriptivo
"env:<VAR>"         → process.env[VAR]
                      Si no definida → error fatal descriptivo
"<valor literal>"   → el valor tal cual (no recomendado; queda en disco en la config)
```

**Windows y SSH agent:**

```typescript
// src/tools/ssh/inventory.ts
function resolveAgentSocket(): string {
  if (process.platform === 'win32') {
    // Intentar primero el named pipe de OpenSSH for Windows
    const opensshPipe = '\\\\.\\pipe\\openssh-ssh-agent';
    // Si no existe, intentar Pageant (PuTTY agent)
    return fs.existsSync(opensshPipe) ? opensshPipe : 'pageant';
  }
  const sock = process.env.SSH_AUTH_SOCK;
  if (!sock) throw new Error(
    'useAgent: true requiere SSH_AUTH_SOCK definido en el entorno. ' +
    'Ejecuta eval $(ssh-agent) o conecta un agente SSH.'
  );
  return sock;
}
```

---

#### Verificación de host key (TOFU y `known_hosts`)

> **Por qué es crítico:** `ssh2` sin `hostVerifier` no verifica la clave del servidor. Eso expone cada conexión a ataques MITM. Para una herramienta de administración de infraestructura, esto no es aceptable por defecto.

**Política por defecto: TOFU (Trust On First Use)**

```
Primera conexión a un host:
  1. ssh2 presenta la clave pública del servidor
  2. Stratum busca el alias en ~/.stratum/known_hosts (formato propio — ver abajo)
  3. Si no existe entrada:
     a. Mostrar fingerprint SHA-256 al usuario:
        ⚠  Host nuevo: prod-web (192.168.1.10)
           Fingerprint: SHA256:xK3m... (ED25519)
           ¿Confiar y añadir a known_hosts? (s/N)
     b. Si el usuario acepta: guardar la clave y continuar
     c. Si rechaza o no es TTY: abortar con tool_error
  4. Si existe entrada y la clave coincide: continuar (silencioso)
  5. Si existe entrada pero la clave NO coincide:
     → Abortar SIEMPRE (no hay override interactivo)
     → Emitir tool_error con recoverable: false:
```

```xml
<tool_error>
  <tool>ssh_exec</tool>
  <error>HOST KEY MISMATCH for 'prod-web' (192.168.1.10).
  Stored:   SHA256:xK3m... (ED25519)
  Received: SHA256:9pQr... (ED25519)
  This may indicate a MITM attack or the host was reinstalled.
  To update the key: stratum ssh trust prod-web --force</error>
</tool_error>
```

**Políticas disponibles:**

| `hostKeyPolicy` | Comportamiento |
|---|---|
| `"tofu"` (default) | TOFU: primera vez pregunta, después verifica. |
| `"strict"` | Requiere `hostKeyHash` (SHA-256 hex) en la config. Rechaza si no coincide exactamente. Para hosts críticos de producción. |
| `"insecure"` | Sin verificación. Solo para entornos de lab/desarrollo controlados. Emite warning al conectar. |

**Almacenamiento de `known_hosts`:** `~/.stratum/known_hosts.json` (no el formato OpenSSH, para evitar conflictos):

```json
{
  "prod-web": {
    "fingerprint": "SHA256:xK3m...",
    "algorithm":   "ssh-ed25519",
    "addedAt":     "2026-05-29T10:30:00Z",
    "host":        "192.168.1.10"
  }
}
```

**Comando para gestionar host keys:**
```bash
stratum ssh trust <alias>          # muestra el fingerprint actual y pregunta si confiar
stratum ssh trust <alias> --force  # actualiza la entrada (tras reinstalación del host)
stratum ssh trust <alias> --remove # elimina la entrada
```

---

#### Seguridad operacional: detección destructiva y `confirmAll`

**La detección de patrones destructivos en `ssh_exec` es una red de seguridad blanda, no un control real.**

Motivo: el campo `command` es un string que pasa a un shell remoto. Es trivialmente evasible — variable expansion, `base64 -d | sh`, here-docs, scripts que ya residen en el host. El escáner ve la cadena, no lo que se ejecuta.

Lo que sí hace: atrapar errores del LLM (comandos destructivos literales generados por descuido), igual que `bash` local.

**La defensa real en hosts remotos es `confirmAll: true`.**

```
Recomendación en el system prompt y en la config de ejemplo:
  - Hosts de producción → confirmAll: true siempre
  - Hosts de desarrollo/staging → confirmAll: false aceptable
```

Con `confirmAll: true`, **cualquier** `ssh_exec` sobre ese host requiere confirmación explícita del usuario, independientemente del comando:

```
⚠  El agente quiere ejecutar un comando en prod-web [confirmAll: true]:
   ssh_exec [prod-web]: ls -la /var/www/html

¿Continuar? (s/N) _
```

El `.stratumrc.json.example` incluirá los hosts de producción con `confirmAll: true` preconfigurado.

---

#### PTY y stdin — comandos interactivos

`ssh_exec` por defecto hace `exec` sin TTY. Esto cubre la mayoría de comandos de administración (`systemctl`, `df`, `ls`, scripts no interactivos). Pero **los siguientes casos fallan o se cuelgan** sin PTY:

- `sudo <comando>` cuando sudo pide password (bloquea hasta timeout)
- `apt install`, `dnf install` sin `-y` (pide confirmación en TTY)
- Cualquier herramienta que detecte `isatty()` y cambie comportamiento
- Editores (`vim`, `nano`) — no soportados en ningún modo

**Soluciones según el caso:**

```typescript
// Caso 1: sudo sin password en el host (mejor solución para automatización)
// Configurar NOPASSWD en /etc/sudoers del host — no requiere PTY ni stdin

// Caso 2: sudo con password — usar stdin (sin PTY)
ssh_exec({ host: 'prod-web', command: 'sudo -S systemctl restart nginx', stdin: 'mypassword\n' })
// stdin envía el password al prompt de sudo -S (lee de stdin, no de TTY)

// Caso 3: comando que necesita TTY real — usar pty: true
ssh_exec({ host: 'prod-web', command: 'sudo visudo', pty: true })
// Con PTY: stdout y stderr se mezclan, exit code puede ser 0 aunque el comando falle
// El LLM debe ser informado de esta limitación en la descripción del tool
```

**Comportamiento con `pty: true`:**
- `ssh2` alloca un pseudo-terminal en el servidor
- stdout y stderr se mezclan en un único stream
- El exit code puede no reflejar el resultado real en algunos casos
- El output incluye caracteres de control del terminal (escape sequences); `ssh_exec` los filtra antes de devolver el resultado al LLM

**Documentar en el system prompt:** el LLM debe saber que `sudo` en hosts remotos requiere `NOPASSWD` o `stdin` con la contraseña, y que `pty: true` mezcla stdout/stderr.

---

#### Límite de salida y protección del contexto

Un `journalctl`, `tail -f`, `cat /var/log/syslog` o cualquier comando de larga salida puede volcar megabytes al contexto del LLM, disparando compresión (§12.4) o reventando la ventana.

**Límites aplicados por `ssh_exec`:**

```typescript
const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KB

// Dentro de _handleExec():
let totalBytes = 0;
let truncated  = false;

stream.on('data', (chunk: Buffer) => {
  if (truncated) return;
  totalBytes += chunk.length;
  if (totalBytes > maxBytes) {
    truncated = true;
    stream.signal('KILL');   // SIGKILL al proceso remoto
    return;
  }
  outputBuffer += chunk.toString();
});
```

Cuando se trunca, el resultado incluye un aviso explícito:

```xml
<ssh_result host="prod-web" exitCode="truncated" duration="1204ms" truncated="true" maxBytes="262144">
  <stdout>
    ... primeros 256 KB del output ...
    [OUTPUT TRUNCATED at 262144 bytes. Use head/grep/tail to limit output, or increase maxBytes in the tool call.]
  </stdout>
</ssh_result>
```

**Comandos no-terminantes** (`tail -f`, `watch`): el `timeout` (default 30s) los mata con SIGKILL en el host remoto. El resultado se devuelve truncado igual que arriba. El LLM debe evitar comandos que no terminan; se documenta en la descripción de la tool.

---

#### Jump hosts — algoritmo completo

```
SSHConnectionPool.getConnection("prod-web"):

  1. Leer config: prod-web.jumpHost = "bastion"

  2. getConnection("bastion")
     — si "bastion" tiene otro jumpHost, recursión (máx depth: 2)
     — si "bastion" está en inflight, await de la promesa existente (sin carrera)
     — connectTimeout: bastion.connectTimeout (default 10s); si expira → error fatal

  3. bastion.forwardOut(prod-web.host, prod-web.port, 'localhost', 0) → stream TCP

  4. new ssh2.Client().connect({
       sock:           stream,        // túnel TCP sobre la conexión del bastión
       connectTimeout: prod-web.connectTimeout,
       hostVerifier:   (key) => verifyHostKey('prod-web', key),  // SIEMPRE verificar
       ...prod-web-auth-config
     })

  5. Cachear "prod-web" en el pool
```

**Timeout total de la cadena:** cada hop tiene su propio `connectTimeout`. Un host muerto falla en `connectTimeout` ms, no en el timeout del comando. Ejemplo: bastión con 10s + host final con 10s = hasta 20s antes de fallar, dentro del timeout de comando (default 30s).

---

#### Ciclo de vida de las conexiones y reconexión

**Apertura:** lazy al primer uso — no al arrancar Stratum.

**Reconexión:** se distinguen dos escenarios:

| Escenario | Comportamiento |
|---|---|
| Conexión que se cae **durante la sesión** (ya establecida, error de red posterior) | Reintento en background con backoff: 2s → 4s → 8s (máx 3 intentos). Si hay una tool call esperando, se cola hasta que reconecte o supere el `commandTimeout`. |
| **Primera** apertura de una conexión que falla | No hay backoff. Falla inmediatamente con `tool_error` descriptivo. El agente puede reintentar si lo considera oportuno. |

Para reconexiones con jump host: primero se reconecta el bastión (si está caído), luego el host dependiente. El `inflight` Map previene la carrera.

**Teardown (`closeAll()`) — orden de cierre:**

```
1. Identificar dependencias: qué conexiones usan jump hosts
2. Cerrar primero las conexiones hoja (las que son destino, no bastiones)
3. Después cerrar los bastiones
4. Timeout por cierre: 2s por conexión; SIGKILL al proceso ssh2 si no responde
```

Cerrar el bastión antes que las conexiones que dependen de él causa errores en los streams dependientes. El orden inverso al de apertura es siempre seguro.

---

#### Log de auditoría

Todos los comandos remotos ejecutados se registran en `~/.stratum/logs/ssh-audit.jsonl`:

```json
{"timestamp":"2026-05-29T10:30:00Z","sessionId":"sess_abc","host":"prod-web","command":"systemctl restart nginx","exitCode":0,"durationMs":342,"truncated":false}
{"timestamp":"2026-05-29T10:31:00Z","sessionId":"sess_abc","host":"prod-web","command":"rm -rf /tmp/cache","exitCode":0,"durationMs":89,"truncated":false}
```

- Rotación por tamaño: 10 MB → `ssh-audit.jsonl.1` (se guardan los 3 últimos archivos)
- El `password` / `passphrase` nunca se loguea
- Configurable con `ssh.auditLog: false` para deshabilitar o `ssh.auditLog: "/ruta/custom.jsonl"` para ruta alternativa
- `sftp_upload` y `sftp_download` también se loguean (con campos `localPath`/`remotePath` en lugar de `command`)

---

#### `stratum ssh list` — conectividad sin autenticación

El comando **no establece conexiones SSH completas** para listar hosts. Solo hace TCP connect al puerto para comprobar alcanzabilidad:

```
$ stratum ssh list

  Hosts SSH configurados (3):

  ⚡ bastion      bastion.example.com:22   auth: key              [alcanzable  ~12ms]
  ○  prod-web     192.168.1.10:22          auth: key   via bastion [no alcanzable] ⚠ confirmAll
  ?  dev-server   10.0.0.5:22              auth: agent            [tiempo de espera]
```

- `⚡` — TCP connect exitoso (no implica auth válida)
- `○` — no alcanzable (TCP refused o timeout de 3s)
- `?` — timeout sin respuesta
- `⚠ confirmAll` — indicador visible para hosts marcados con `confirmAll: true`

Si el host ya tiene una conexión SSH activa en el pool (sesión en curso), se muestra `[conectado]` en lugar de hacer TCP check.

Los hosts con `hostKeyPolicy: "insecure"` muestran `⚠ insecure` como aviso.

---

#### Formato del resultado para el LLM

```xml
<ssh_result host="prod-web" exitCode="0" duration="342ms">
  <stdout>
    total 48
    drwxr-xr-x 5 javi javi 4096 May 29 10:30 app
  </stdout>
</ssh_result>
```

Si `exitCode !== 0`:
```xml
<tool_error>
  <tool>ssh_exec</tool>
  <error>Command failed on prod-web (exit code 1): bash: cmd_inexistente: command not found</error>
  <suggestion>Verify the command exists on the remote host. Use ssh_exec with 'which <command>' to check.</suggestion>
</tool_error>
```

Si el alias no existe en el inventario:
```xml
<tool_error>
  <tool>ssh_exec</tool>
  <error>SSH host 'unknown-host' not found in inventory. Available hosts: bastion, prod-web, dev-server</error>
  <suggestion>Check .stratumrc.json → ssh.hosts for the correct alias.</suggestion>
</tool_error>
```

---

#### Implementación

```
src/tools/ssh/
  pool.ts        ← SSHConnectionPool (inflight map, reconnect, closeAll con orden de teardown)
  exec.ts        ← tool ssh_exec (PTY, stdin, maxBytes, audit log)
  sftp.ts        ← tools ssh_upload / ssh_download (audit log)
  hostkeys.ts    ← TOFU / strict / insecure — lectura y escritura de ~/.stratum/known_hosts.json
  auth.ts        ← resolución de secretos (keychain, env, passphrase), agent socket por plataforma
  inventory.ts   ← carga del inventario desde config, validación Zod
src/cli/commands/
  ssh.ts         ← subcomandos: stratum ssh list, stratum ssh trust <alias> [--force|--remove]
```

Las tools se registran en el `ToolRegistry` desde `StratumAgent.init()`, solo si `config.ssh.hosts` tiene al menos una entrada. Mismo patrón que las tools de filesystem y web.

**Items del Hito 9 revisados** (sustituyen a los del roadmap §9):
- Pool con in-flight mutex y reconexión diferenciada (drop vs. first-connect)
- `ssh_exec` con PTY opcional, stdin, maxBytes y truncado explícito
- Verificación de host key: TOFU por defecto, strict con hash pinnado, insecure explícito
- `known_hosts.json` + comandos `stratum ssh trust`
- Resolución de secretos: keychain → env var → prompt → error
- Soporte de SSH agent multiplataforma (Linux/macOS `SSH_AUTH_SOCK`, Windows Pageant/named pipe)
- `passphrase` en claves privadas cifradas
- Reencuadre de la detección destructiva como soft net; `confirmAll: true` en el ejemplo de config de hosts de producción
- Log de auditoría `ssh-audit.jsonl` con rotación
- `stratum ssh list` con TCP-only check (no autenticación al listar)
- Orden de teardown en `closeAll()`: hojas antes que bastiones

---

## 13. Documentos Relacionados

| Documento | Descripción |
|---|---|
| [STRATUM_UI_SPECIFICATION.md](./STRATUM_UI_SPECIFICATION.md) | Especificación completa de la interfaz de terminal (Ink): layout, componentes, colores, animaciones, atajos de teclado y mapeo de componentes React |

---

*Documento generado: 2026-05-27 | Versión: 0.1.0-draft*

---

