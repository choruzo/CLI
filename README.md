# Stratum CLI

Stratum CLI es un agente de linea de comandos extensible basado en un loop ReAct (Reason -> Act -> Observe). El proyecto esta pensado para ser **provider-agnostic** mediante APIs OpenAI-compatible y para combinar ejecucion de herramientas, memoria de proyecto y sesiones persistentes.

> **Estado actual:** este repositorio contiene la especificacion completa del producto y una implementacion funcional en `stratum-cli/`. Hoy ya funciona con providers OpenAI-compatible, sesiones persistidas, `STRATUM.md` como memoria de proyecto y tres tools integradas (`read_file`, `write_file`, `bash`). Varias capacidades del roadmap siguen en progreso.

## Que incluye hoy

- **CLI operativa** con comandos `chat`, `run`, `init`, `config`, `sessions` y `memory show`
- **Provider router** para configuraciones OpenAI-compatible
- **Loop ReAct** con streaming, tool calls y compresion de contexto
- **Memoria de proyecto** cargada desde `STRATUM.md`
- **Sesiones persistentes** para listar, reanudar y limpiar conversaciones
- **UI de terminal** basada en Ink para el modo interactivo

## Estado de implementacion

| Area | Disponible hoy | Notas |
|---|---|---|
| Providers | `openai-compatible` | Compatible con Ollama, llama.cpp, vLLM, LiteLLM, OpenAI y proxies equivalentes |
| Tools built-in | `read_file`, `write_file`, `glob`, `list_directory`, `grep`, `bash` | Registradas por defecto; salida truncada a ~30k chars |
| Memoria | `STRATUM.md` (proyecto + global), `memory show` | `memory list/search/forget` aun no estan implementados (Hito 5) |
| Sesiones | `list`, `resume`, `delete`, `prune` | Persistencia local de conversaciones |
| MCP / SSH / web tools | En roadmap | La especificacion y el schema ya contemplan estas areas, pero no forman parte del runtime actual |

## Estructura del repositorio

| Ruta | Contenido |
|---|---|
| `stratum-cli/` | Implementacion actual del CLI |
| `STRATUM_PROJECT_DEFINITION.md` | Definicion del producto, arquitectura e invariantes |
| `STRATUM_UI_SPECIFICATION.md` | Especificacion de la UI de terminal |
| `CLI-DOC/` | Documentacion complementaria del proyecto |

## Inicio rapido para desarrollo

Requiere **Node.js 22+**.

```bash
cd stratum-cli
npm install
npm run build
node dist/index.js --help
```

Ejemplos:

```bash
# Inicializa .stratumrc.json y genera/actualiza STRATUM.md
node dist/index.js init

# Abre el modo interactivo
node dist/index.js chat

# Ejecuta una tarea one-shot
node dist/index.js run "Analiza ./src y resume la arquitectura"
```

Si prefieres usar el binario `stratum` durante el desarrollo:

```bash
cd stratum-cli
npm link
stratum --help
```

## Configuracion

`stratum init` crea una configuracion minima, pero tambien puedes escribir `.stratumrc.json` manualmente:

```json
{
  "provider": {
    "default": "local-ollama",
    "providers": {
      "local-ollama": {
        "type": "openai-compatible",
        "baseUrl": "http://localhost:11434/v1",
        "model": "qwen2.5-coder:32b",
        "apiKey": "ollama",
        "contextWindow": 32768
      }
    }
  }
}
```

Notas utiles:

- Las variables `${VAR_NAME}` se expanden desde el entorno al cargar la configuracion.
- El ejemplo completo esta en `stratum-cli/.stratumrc.json.example`.
- El schema actual tambien contempla bloques `memory`, `tools`, `mcp` y `agent`.
- `contextWindow` debe reflejar el contexto **real** que sirve tu servidor (llama.cpp `--ctx-size`, Ollama `num_ctx`, etc.). Esto es especialmente importante para `stratum init`: su calidad depende del contexto acumulado durante la exploracion, y un `contextWindow` menor al real dispara la compresion antes de tiempo y degrada el `STRATUM.md` resultante. Si tu servidor sirve 64k+, configuralo aqui en vez de dejar el default 32768. Durante `init` el agente ya usa un modo de compresion conservador (umbral ≥92%), pero no sustituye a un `contextWindow` bien configurado.

## Comandos disponibles

### Implementados

| Comando | Descripcion |
|---|---|
| `stratum chat` | Abre una sesion interactiva |
| `stratum chat --resume <session-id>` | Reanuda una sesion guardada |
| `stratum run "<tarea>"` | Ejecuta una tarea en modo one-shot |
| `stratum run --allow-destructive "<tarea>"` | Ejecuta la tarea activando la politica de aprobacion para tools destructivas |
| `stratum run --deny-destructive "<tarea>"` | Ejecuta la tarea con politica restrictiva para tools destructivas |
| `stratum init [--force] [--dry-run]` | Inicializa el proyecto y genera/actualiza `STRATUM.md` |
| `stratum config get <clave>` | Lee una clave de configuracion |
| `stratum config set <clave> <valor>` | Actualiza una clave de configuracion |
| `stratum sessions list [--last <n>]` | Lista sesiones guardadas |
| `stratum sessions resume <id>` | Reanuda una sesion |
| `stratum sessions delete <id>` | Elimina una sesion |
| `stratum sessions prune [--older <duracion>]` | Borra sesiones antiguas |
| `stratum memory show` | Muestra el `STRATUM.md` activo |

### Previstos pero no implementados aun

| Comando | Estado actual |
|---|---|
| `stratum memory list` | Placeholder; devuelve mensaje de "Coming in Hito 5" |
| `stratum memory search "<query>"` | Placeholder; devuelve mensaje de "Coming in Hito 5" |
| `stratum memory forget <id>` | Placeholder; devuelve mensaje de "Coming in Hito 5" |

## Tools built-in actuales

| Tool | Descripcion |
|---|---|
| `read_file` | Lee un archivo con lineas numeradas (`N: contenido`), tope de 2000 lineas por llamada y paginacion via `offset` |
| `write_file` | Crea o sobreescribe archivos |
| `glob` | Busca archivos por patron (`**/*.ts`, `src/*.json`); excluye node_modules, dist, .git, etc. |
| `list_directory` | Lista archivos y directorios con profundidad configurable |
| `grep` | Busca contenido por regex (usa ripgrep si esta disponible, con fallback en Node) |
| `bash` | Ejecuta comandos shell con timeout y salida combinada |

Toda salida de tool se trunca a ~30k caracteres (cabeza + cola con marcador) antes de entrar al historial, para proteger el contexto de modelos locales.

> Nota: las flags `--allow-destructive` y `--deny-destructive` ya existen en la CLI, pero las tools built-in actuales no se registran como destructivas.

## Arquitectura actual

```text
StratumAgent
  |- ReactLoop / ContextManager
  |- ProviderRouter
  |- ToolRegistry / ToolDispatcher
  |- MemoryManager
  `- SessionStore
```

Directorios clave dentro de `stratum-cli/src/`:

- `agent/` - loop ReAct, eventos, contexto y prompts
- `providers/` - contrato `IProvider`, router y provider OpenAI-compatible
- `tools/` - definiciones y registro de tools
- `memory/` - carga de `STRATUM.md` y utilidades relacionadas
- `session/` - persistencia y gestion de sesiones
- `cli/` - comandos Commander.js e interfaz Ink

## Desarrollo

```bash
cd stratum-cli

# Desarrollo con hot-reload
npm run dev

# Build
npm run build

# Tests
npm test
npm run test:run

# Lint y formato
npm run lint
npm run format
```

## Documentacion principal

- `STRATUM_PROJECT_DEFINITION.md` - vision del producto, roadmap y especificaciones vinculantes
- `STRATUM_UI_SPECIFICATION.md` - comportamiento esperado de la UI
- `CLAUDE.md` - guia operativa del repositorio y convenciones de implementacion

## Licencia

MIT
