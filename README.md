# Stratum CLI

Agente de línea de comandos extensible construido sobre un loop ReAct (Reason → Act → Observe). Provider-agnostic: compatible con cualquier API OpenAI-compatible — Ollama, llama.cpp, vLLM, LiteLLM, OpenAI nativo, y más.

## Características

- **Loop ReAct** — el agente razona, actúa y observa en iteraciones hasta completar la tarea
- **Provider-agnostic** — un cliente OpenAI-compatible universal; sin dependencia de SDKs de terceros
- **Local-first** — no requiere servicios externos; todo puede correr en local
- **Memoria en 3 capas** — contexto de proyecto (Markdown), decision store (JSON), búsqueda semántica (SQLite + embeddings ONNX)
- **Tools extensibles** — filesystem, shell, web, SSH remoto; más cualquier herramienta MCP externa
- **SSH nativo** — cliente puro Node.js con connection pooling, SFTP y soporte de jump hosts
- **UI reactiva** — interfaz terminal con Ink (React para CLIs)

## Instalación

```bash
npm install -g stratum-cli
```

Requiere **Node.js 22+**.

## Inicio rápido

```bash
# Inicializa la config en el directorio actual
stratum init

# Abre el REPL interactivo
stratum chat

# Ejecuta una tarea en modo one-shot
stratum run "Analiza ./src y encuentra posibles memory leaks"
```

## Configuración

Crea `.stratumrc.json` en la raíz del proyecto (o ejecuta `stratum init`):

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
    "vectorDb": "~/.stratum/memory/vectors.db"
  },
  "tools": {
    "confirmDestructive": true,
    "bashTimeout": 30000
  }
}
```

Las variables `${VAR_NAME}` se expanden desde el entorno al cargar la config. Si una variable requerida no está definida, el proceso aborta con un mensaje claro.

Ver `.stratumrc.json.example` para la estructura completa con SSH y MCP.

## Comandos

| Comando | Descripción |
|---|---|
| `stratum chat` | REPL interactivo |
| `stratum run "<tarea>"` | Ejecuta una tarea en modo one-shot |
| `stratum run --allow-destructive "<tarea>"` | One-shot sin confirmación en operaciones destructivas |
| `stratum memory list` | Lista decisiones almacenadas |
| `stratum memory search "<query>"` | Búsqueda semántica en memoria |
| `stratum memory forget <id>` | Elimina una decisión |
| `stratum sessions list` | Lista sesiones guardadas |
| `stratum sessions resume <id>` | Retoma una sesión anterior |
| `stratum sessions prune` | Elimina sesiones antiguas |
| `stratum config get <clave>` | Lee un valor de la config |
| `stratum config set <clave> <valor>` | Actualiza la config |
| `stratum init` | Crea `.stratumrc.json` + `STRATUM.md` en el directorio actual |

## Tools disponibles

### Filesystem
`read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep`

### Shell
`bash` — ejecuta comandos. Los patrones destructivos (`rm`, `dd`, `mkfs`, etc.) requieren confirmación explícita.

### Web
`web_search`, `web_fetch`

### SSH
`ssh_exec`, `ssh_upload`, `ssh_download` — acceso remoto con connection pooling. Los hosts se definen en `.stratumrc.json` bajo la clave `ssh.hosts`.

### MCP
Cualquier herramienta de servidores MCP externos se registra automáticamente al iniciar el agente. Se configuran en `.stratumrc.json` bajo `mcp.servers`.

## Memoria del proyecto (`STRATUM.md`)

El archivo `STRATUM.md` en la raíz del proyecto se carga en el system prompt al inicio de cada sesión. Úsalo para dar contexto permanente al agente:

```markdown
# Stratum Memory

## Proyecto
Stack: Node.js + TypeScript + Ansible
Convenciones: comentarios en español, usar ESM

## Restricciones
- Siempre confirmar antes de ejecutar comandos destructivos
- No modificar archivos fuera de ./src sin preguntar
```

## Desarrollo

```bash
# Instalar dependencias
npm install

# Desarrollo con hot-reload
npm run dev

# Build (ESM + CJS en dist/)
npm run build

# Tests
npm test
npm test -- --run

# Lint y formato
npm run lint
npm run format
```

## Arquitectura

```
StratumAgent (core.ts)
    │
    ├── MemoryManager     — carga STRATUM.md, decisions.json, sqlite-vec
    ├── ProviderRouter    — selección de provider y fallback
    ├── ReactLoop         — iteraciones Reason → Act → Observe
    │       └── StreamBuffer  — parsing SSE de tool calls fragmentadas
    ├── ToolDispatcher    — ejecución paralela respetando flags serialized/destructive
    └── ContextManager    — compresión del historial al superar el 80% del context window
```

Los providers implementan `IProvider` con un único método `complete(req): AsyncGenerator<CompletionChunk>`. El tipo soportado en v1 es `openai-compatible`, que cubre Ollama, llama.cpp, vLLM, LiteLLM, OpenAI y Anthropic vía proxy.

## Decisiones técnicas

| Área | Decisión |
|---|---|
| LLM client | Implementación propia OpenAI-compatible; sin `ai-sdk` ni `openai` npm |
| Vector DB | `sqlite-vec` embebido; sin Chroma/Qdrant |
| Embeddings | ONNX local con `@xenova/transformers`; sin OpenAI Embeddings API |
| Shell | `execa`; sin `child_process` directo |
| Build | `tsup`; genera ESM + CJS |

## Licencia

MIT
