# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Proyecto

**Stratum CLI** — agente de línea de comandos extensible construido sobre un loop ReAct (Reason → Act → Observe), con soporte de plan-and-execute y arquitectura multi-agente. Provider-agnostic: compatible con cualquier API OpenAI-compatible (Ollama, llama.cpp, vLLM, LiteLLM, OpenAI nativo).

La definición completa del proyecto está en `STRATUM_PROJECT_DEFINITION.md`. La especificación de UI está en `STRATUM_UI_SPECIFICATION.md`.

El código vive en `stratum-cli/`. Todos los comandos de desarrollo se ejecutan desde ese directorio.

## Comandos de desarrollo

```bash
cd stratum-cli

# Desarrollo con hot-reload
npm run dev

# Build (tsup produce ESM + CJS en dist/)
npm run build

# Tests (Vitest)
npm test
npm run test:run        # sin modo watch
npm test -- src/agent/  # test de un directorio específico

# Lint y formato
npm run lint
npm run format

# Ejecutar CLI compilado
node dist/index.js chat
node dist/index.js run "tarea"
```

## Arquitectura central

### Loop ReAct (`src/agent/`)

El núcleo es un generador async: `StratumAgent.run(input)` emite `AgentEvent`s. Internamente, `ReactLoop` (en `harness.ts`) ejecuta iteraciones: compone mensajes → llama al LLM en streaming → parsea la respuesta con `StreamBuffer` (acumula chunks SSE fragmentados de tool calls) → despacha al `ToolDispatcher` → repite hasta `stop` o `maxIterations`. El `ContextManager` (también en `harness.ts`) evalúa el tamaño del historial antes de cada iteración y lo comprime via LLM call cuando supera el 80% del `contextWindow` del modelo activo.

- `core.ts` — `StratumAgent`: estado de sesión, orquesta todos los subsistemas
- `harness.ts` — `ReactLoop` + `ContextManager`: bucle ReAct y gestión de contexto. `RunOptions.compressionMode: 'conservative'` (usado por `/init`) sube el umbral de compresión a ≥0.92 y duplica las rondas protegidas
- `types.ts` — schema completo de `AgentEvent` (ver sección 12.1 del documento principal)
- `system-prompt.ts` — system prompt estilo opencode `default.txt` + bloque `<env>` dinámico (cwd, worktree, git, plataforma, fecha, model id) + inyección de memoria
- `initialize-prompt.ts` — `INITIALIZE_PROMPT` para `stratum init` y `/init`: se inyecta como mensaje de usuario del agente general (no hay agente especializado de init). Sustituir placeholders siempre con `replaceAll` — `${path}` aparece varias veces

### Providers (`src/providers/`)

Todos los proveedores implementan `IProvider` (en `base.ts`) con un único método `complete(req): AsyncGenerator<CompletionChunk>`. El `ProviderRouter` selecciona el proveedor activo según `.stratumrc.json` y gestiona el fallback automático. Solo hay un tipo de provider en v1: `OpenAICompatible`. Existe también `mock.ts` para tests.

### Tools (`src/tools/`)

`ToolRegistry` es el registro central. Cada tool implementa `ToolDefinition` con un schema Zod para validar parámetros. Flags y hooks que controlan la ejecución:
- `destructive: true` — pide confirmación al usuario antes de ejecutar (en modo no-interactivo/CI se comporta como `--deny-destructive`)
- `isDestructive?(params, ctx)` — predicado dinámico por llamada; `exec` lo usa para detectar patrones destructivos y el `confirmAll` del host (`tools.destructivePatterns` de config) con límites de palabra
- `serialized: true` — nunca se ejecuta en paralelo aunque el LLM emita múltiples tool calls en un turno (`exec` lo decide por llamada con `isSerialized`: local sí, ssh no)
- `timeout` — ms antes de abortar; el dispatcher pasa a `execute()` un `AbortSignal` combinado (cancelación de usuario + timeout via `AbortSignal.any`)

El `ToolDispatcher` resuelve la fase de confirmación destructiva ANTES de ejecutar (secuencial, nunca dos prompts a la vez; decisiones `approve`/`deny`/`allow-all` — `!` suprime confirmaciones el resto de la sesión), luego ejecuta múltiples tool calls con `Promise.allSettled`, respetando `serialized`, y trunca toda salida a ~30k caracteres (cabeza 80% + cola 20%, ver `tools/truncate.ts`). La política se inyecta por `RunOptions.destructivePolicy` (`ask`/`allow`/`deny`) + `onConfirmDestructive` (callback async; el chat lo resuelve con `<DestructiveConfirm>`, `stratum run` con readline, CI sin TTY → deny).

Tools organizadas en subdirectorios: `fs/` (read.ts, write.ts, edit.ts, glob.ts, list.ts, grep.ts), `exec/` (tool `exec`, targets `local` y `ssh:<alias>`, Hito 16), `web/` (search.ts, fetch.ts, html-to-text.ts) y `mcp/` (client.ts, bridge.ts, manager.ts). `read_file` devuelve líneas numeradas `N: contenido` con tope de 2000 líneas y paginación via `offset`. `edit_file` hace reemplazo exacto `old_string → new_string` (única ocurrencia o `replace_all`) y devuelve unified diff (`fs/diff.ts`, LCS propio sin dependencias). `web_search` es metabúsqueda: DuckDuckGo (scraping HTML, sin key) + Tavily (si hay `tools.webSearch.tavilyApiKey` o `TAVILY_API_KEY`), merge + dedupe por URL normalizada + re-rank RRF, top 10 al agente; backend forzable con `tools.webSearch.backend` (`meta`/`duckduckgo`/`tavily`). `web_fetch` descarga la URL (`Accept: text/markdown` preferente, límite 5 MB) y extrae texto limpio con conversor HTML→markdown propio. Las tools MCP se registran automáticamente con nombre `mcp__<server>__<tool>` (naming OpenAI-compatible): `McpServerClient` (client.ts) gestiona la conexión stdio a un server; `buildMcpTool` (bridge.ts) convierte cada MCP tool en un `ToolDefinition` con `rawParameters` (JSON Schema nativo); `McpManager` (manager.ts) orquesta el arranque, heartbeat 30 s y backoff 2→4→8 s. Carpeta gestionada (`installer.ts`, §12.8.1): un server puede declarar `package` (npm) en vez de `command`/`args`; se instala una sola vez en `~/.stratum/mcp/<server>/` (auto-creada) y se lanza con `node <entry>` directo, evitando el coste de `npx` en cada arranque. Arranque configurable con `mcp.startup`: `'lazy'` (default, conexión en background en `chat` vía `startBackground`, no bloquea la UI) o `'eager'` (espera a `connectAll`); `startupTimeout` por server (15 s) aborta servers que cuelgan. Comando `stratum mcp install [server]`.

### SSH (`src/tools/ssh/`)

Cliente SSH nativo sobre `ssh2` — el binario `ssh` del sistema nunca se invoca (§12.14). Desde el Hito 16 la ejecución remota es `exec` con `target: "ssh:<alias>"`. Las tools `ssh_upload` y `ssh_download` **solo se registran si `.stratumrc.json` trae sección `ssh` con al menos un host**: sin inventario, el LLM no las ve.

- `pool.ts` — `SSHConnectionPool`: conexiones persistentes por alias, apertura lazy. El mapa `inflight` es el mutex de establecimiento (dos `exec` paralelos al mismo alias comparten socket, necesario porque va con `serialized: false`). Jump hosts vía `forwardOut` (profundidad máx. 2, validada en el schema). Reconexión con backoff 2s→4s→8s **solo** para conexiones ya establecidas que se caen; el primer fallo de apertura rechaza de inmediato. `closeAll()` cierra hojas antes que bastiones. Listener de `error` permanente: ssh2 emite errores tardíos que sin manejador tumban el proceso
- `known-hosts.ts` — verificación de host key en `~/.stratum/known_hosts.json` (formato propio, escritura atómica). `tofu` (default) pregunta la primera vez y verifica después; `strict` exige `hostKeyHash`; `insecure` solo para lab. Un **mismatch aborta siempre** con `recoverable: false`, sin override interactivo
- `inventory.ts` — resolución de alias → `ConnectConfig`. Secretos con `env:<VAR>`, literal, y fallback `STRATUM_SSH_<ALIAS>_SECRET`; `keychain:`/keytar **no implementado** (ver desviaciones en §12.14). Nunca monta el `hostVerifier` — lo añade el pool, para que ninguna ruta pueda saltárselo
- (Hito 16) `ssh_exec` se retiró: su lógica es `tools/exec/backends/ssh.ts`, detrás de la tool `exec`
- `sftp.ts` — `ssh_upload` / `ssh_download` con `fastPut`/`fastGet`
- `runtime.ts` — singleton del pool por config (`getSshPool`) + `closeSshPool()`, llamado en el teardown de `chat`/`run`: sin cerrar los sockets el proceso no termina (§12.12)
- (Hito 16) la auditoría es universal: `tools/exec/audit.ts` → `~/.stratum/logs/exec-audit.jsonl` (`tools.auditLog`), rotación a 10 MB. El `sessionId` viaja por `RunOptions`→`ToolContext`: `chat` lo genera **al arrancar** (no al guardar, como antes), `run` usa uno efímero por invocación, y los subagentes heredan el del padre
- `test-server.ts` — servidor `ssh2.Server` en proceso: los tests corren contra el protocolo real (exec, SFTP, jump hosts), sin mocks

El gate TOFU y las confirmaciones reutilizan `ToolContext.confirmDestructive`. Comando `stratum ssh list` / `stratum ssh trust <alias> [--force|--remove]`.

### Memoria (`src/memory/`)

`MemoryManager` orquesta las 3 capas; las tres están activas (Capas 2 y 3 cerradas en Hito 5):

1. **`STRATUM.md`** *(activa)* — cargado en el system prompt al inicio de cada sesión; hay versión global (`~/.stratum/STRATUM.md`) y de proyecto
2. **`decisions.json`** *(activa)* — decision store JSON estructurado (`decisions.ts`, `DecisionStore`), fuente de verdad; escritura atómica, id `dec_YYYYMMDD_<nanoid6>`, `embedding_ref = vec_${id}`. Se escribe vía la tool `store_decision` (el agente, §12.7) y vía extracción automática LLM-based en background (`extractor.ts`)
3. **`vectors.db`** *(activa)* — índice semántico (`vectors.ts`, `VectorStore`): backend `sqlite-vec` (tabla `vec0` con `distance_metric=cosine`, import dinámico de `better-sqlite3`+`sqlite-vec`) con **fallback brute-force JS** persistente (`*.fallback.json`) cuando las deps nativas faltan. Embeddings vía `EmbeddingService` (`embeddings.ts`): `@xenova/transformers` ONNX local (lazy, guard de symlinks Windows) con endpoint HTTP `/v1/embeddings` opcional (fast-fail + latch). El orquestador `DecisionMemory` (`decision-memory.ts`, singleton por ruta) hace dedup semántico al guardar y KNN al recuperar (tool `recall_decisions`). Invariante: `decisions.json` nunca se pierde aunque el índice/embedder fallen. Comandos `stratum memory list/search/forget`

### Sesiones (`src/session/`)

`SessionStore` persiste el historial de conversaciones en disco. `session/types.ts` define los tipos. Los comandos `stratum sessions list/resume/delete/prune` gestionan el historial.

### Logging (`src/logging/`)

Sistema de logs propio (cero dependencias nuevas), orientado a depuración y a empaquetar trazas para bug reports. Un `Logger` ligero produce `LogRecord`s estructurados (`time`, `level`, `ns`, `msg`, `fields`, `err`) y los reparte a uno o más `LogSink`. El núcleo (`LoggerCore` en `logger.ts`) es un singleton mutable: `getLogger('ns')` capturado a nivel de módulo sigue funcionando tras `configureLogging`, y antes de configurarse el umbral global es `silent` (no-op seguro).

- `types.ts` — niveles `trace|debug|info|warn|error|silent` (`LEVEL_ORDER`), `LogRecord`, `LogSink`
- `logger.ts` — `Logger` con `child(ns, fields)` (namespaces anidados + campos heredados), `startTimer()` y serialización de `err`
- `redact.ts` — redacción de secretos (apiKey, Authorization, Bearer/sk-/xox- …) aplicada a los campos antes de cualquier sink; **el apiKey nunca se registra**
- `sinks.ts` — `StderrSink` (legible y coloreado, ANSI propio, respeta `NO_COLOR`/TTY), `FileSink` (JSON Lines con rotación por tamaño `.1`…`.N`, cola de escritura fire-and-forget que nunca lanza ni bloquea), `MemorySink` (tests)
- `index.ts` — `getLogger`, `configureLogging(config, overrides)`, `flushLogging`, `logFilePath`

Precedencia de configuración: flags (`--log-level`, `--debug`) > entorno (`STRATUM_LOG_LEVEL`, `STRATUM_DEBUG`, `STRATUM_LOG_FILE`) > `.stratumrc.json` (`logging.{level,stderr,redact,file{enabled,dir,maxBytes,maxFiles}}`). En `chat` el sink de stderr se eleva a `warn+` por defecto para no entrelazarse con Ink (dueño de stdout); el sink de fichero, si está activo, recibe el nivel completo. Subsistemas instrumentados: `provider` (request/response/errores HTTP, latencias), `agent.loop` (iteraciones, compresión, retries de stream, max-iterations), `tools` (dispatch, params inválidos, confirmaciones destructivas, fallos y deshabilitado por sesión) y `mcp` (connect/reconnect/heartbeat). El log de diagnóstico MCP (`tools/mcp/diagnostics.ts`, `mcp.log`) sigue capturando el stderr crudo de los servers.

### CLI y UI (`src/cli/`)

Entry point en `cli/index.ts` (Commander.js). Los comandos viven en `cli/commands/`:

| Comando | Descripción |
|---|---|
| `chat` | REPL interactivo |
| `run` | One-shot con flags `--allow-destructive` / `--deny-destructive` |
| `memory` | `list`, `search`, `forget`, `show` |
| `sessions` | `list`, `resume`, `delete`, `prune` |
| `config` | `get` / `set` de `.stratumrc.json` |
| `init` | Escanea el proyecto y crea/actualiza `STRATUM.md` |
| `logs` | `path` / `tail [n]` sobre el fichero de logs JSONL (bug reports) |
| `ssh` | `list` (conectividad en vivo) / `trust <alias> [--force\|--remove]` (host keys) |

La UI terminal usa Ink (React para CLIs). Componentes en `cli/ui/`:

| Componente | Rol |
|---|---|
| `App.tsx` | Raíz: coordina Banner → ConversationView |
| `Banner.tsx` | Animación de arranque (typewriter) |
| `ConversationView.tsx` | Área de conversación + scroll |
| `MessageList.tsx` | Lista de mensajes renderizados |
| `AgentMessage.tsx` | Mensaje del agente (streaming + markdown) |
| `UserMessage.tsx` | Mensaje del usuario |
| `ToolCallBlock.tsx` | Bloque de tool call con estados pending/running/completed/error |
| `StatusBar.tsx` | Barra inferior: provider, modelo, contexto % |
| `InputArea.tsx` | Input con soporte de /comandos |
| `StreamingText.tsx` | Texto con cursor parpadeante durante generación |
| `useAgentStream.ts` | Hook que consume el generador de `AgentEvent`s |

`useAgentStream` debe tratar los eventos `tool_call_start` como actualizaciones del mismo tool call (identificado por `id`), no como nuevas entradas.

## Configuración

El archivo `.stratumrc.json` (validado con Zod en `src/config/schema.ts`) define proveedores, rutas de memoria, comportamiento de tools y servidores MCP. Ver `.stratumrc.json.example` para la estructura completa.

Variables de entorno referenciadas con `${VAR_NAME}` en la config son expandidas automáticamente por el loader.

## Decisiones técnicas que no deben revertirse

| Área | Decisión |
|---|---|
| LLM client | Implementación propia OpenAI-compatible; no usar `ai-sdk` ni `openai` npm |
| Vector DB | `sqlite-vec` embebido; no Chroma/Qdrant (requieren servidor) |
| Embeddings | ONNX local con `@xenova/transformers`; no OpenAI embeddings API |
| Shell | `execa`; no `child_process` directo |
| SSH | `ssh2` (puro Node.js); nunca el binario `ssh` del sistema. Va en `external` de tsup |
| Build | `tsup`; genera ESM + CJS |

## Specs de implementación

Antes de implementar cualquier módulo de `src/agent/` o `src/providers/`, leer la **sección 12** de `STRATUM_PROJECT_DEFINITION.md`. Contiene las especificaciones vinculantes de:
- Schema completo de `AgentEvent` con sus invariantes (12.1)
- Algoritmo de `StreamBuffer` para parsing SSE de tool calls fragmentadas (12.2)
- Política de errores en el loop: inject & recover, formatos XML (12.3)
- Algoritmo de compresión de contexto: umbral 80%, zona protegida, LLM call (12.4)
- Ciclo de vida de MCP servers: inicio eager, reconexión con backoff, shutdown (12.8)
- Carga lazy del modelo ONNX con warm-up opcional (12.10)
- Señales del proceso y cleanup por etapa (12.12)
- Init: comando-plantilla estilo opencode con `INITIALIZE_PROMPT`, compresión conservadora y auto-retry de escritura (12.13)
- SSH nativo: pool, host keys, auth, jump hosts, límites de salida y auditoría (12.14)

## Hito actual

**Hito 9 — SSH Nativo** ✅ completado. Hitos 0, 1, 2, 2.5, 3, 3.5, 4, 4.1, 5, 6, 7 y 8 (8A/8B/8C) completados.

- Hito 0 ✅ Scaffolding (package.json, tsconfig, tsup, Vitest, Commander.js)
- Hito 1 ✅ Core Agent Loop (ProviderRouter, streaming SSE, ReactLoop, ToolRegistry, tools básicas, UI Ink)
- Hito 2 ✅ Memory Layer 1 (cerrado 2026-06-11): STRATUM.md loader (proyecto + global con tests), inyección en system prompt, `stratum init`, compresión de contexto, `/memory show`, status bar con umbrales de color
- Hito 2.5 ✅ Init estilo opencode (cerrado 2026-06-11): INITIALIZE_PROMPT como comando-plantilla, tools glob/list/grep, read_file con líneas numeradas, truncado de tool outputs, system prompt con `<env>`, compresión conservadora en init, auto-retry de escritura
- Hito 3 ✅ Tools completos Day 1 (cerrado 2026-06-11): `edit_file` con unified diff, `web_search` (metabúsqueda DDG+Tavily con RRF), `web_fetch` (HTML→markdown), safety check de bash con patrones configurables, confirmación interactiva destructiva (chat Ink + `stratum run` readline + deny automático en CI), timeout/cancelación con `AbortSignal` combinado, ToolCallBlock con 4 estados + foco Tab + expansión Space, `<MarkdownText>` dual-mode (`marked` + `cli-highlight`)
- Hito 3.5 ✅ Provider & Model UX (cerrado 2026-06-11): wizard `stratum provider add`, `/model`, `/config_provider`
- Hito 4 ✅ MCP Client (cerrado 2026-06-15): `McpManager` con arranque eager, heartbeat y backoff; auto-registro `mcp__server__tool`; `stratum mcp list`; `/tools`; status bar con indicador de conectividad MCP
- Hito 4.1 ✅ MCP carpeta gestionada + arranque no bloqueante (cerrado 2026-06-16): carpeta gestionada `~/.stratum/mcp/` (campo `package`, instala una vez y lanza `node` directo, evita el overhead de `npx`; `installer.ts`); `stratum mcp install`; `mcp.startup` `lazy`/`eager` (background en `chat` con `startBackground`); `startupTimeout` por server; auto-creación de la carpeta. Ver §12.8.1
- Hito 5 ✅ Memory Layers 2 y 3 (cerrado 2026-06-16): `DecisionStore` (`decisions.ts`, CRUD JSON atómico, id `dec_YYYYMMDD_<nanoid6>`); `EmbeddingService` (`embeddings.ts`, `@xenova` ONNX local lazy + endpoint HTTP `/v1/embeddings` opcional con fast-fail, guard symlinks Windows); `VectorStore` (`vectors.ts`, backend `sqlite-vec` cosine vía import dinámico + fallback brute-force JS persistente); orquestador `DecisionMemory` (`decision-memory.ts`, singleton, dedup semántico al guardar + KNN al recuperar); tools `store_decision` (serialized) y `recall_decisions` + instrucción en system prompt; extracción automática LLM-based en background (`extractor.ts`); `stratum memory list/search/forget` (CLI) y `/memory list|search|forget` en el chat (autocompletado `session-commands.ts` + handlers en `App.tsx`); evento `memory_retrieved` emitido en `harness.ts` (vía `takeLastRecall`) y manejado en el reducer con indicador discreto; warm-up ONNX cableado en `chat` (`memory.embeddingWarmup`); deps opcionales (`@xenova/transformers`,`better-sqlite3`,`sqlite-vec`) en `optionalDependencies` y `external` en `tsup.config.ts`; config `memory.{embeddingDimension,embeddingEndpoint,autoExtract,extractionModel,similarityThreshold,embeddingWarmup}`. 29 tests nuevos. Ver §5, §9 y §12.7/§12.10. Doc y visualización en `CLI-DOC/`

- Hito 6 ✅ Multi-provider Polishing (cerrado 2026-06-18): backends Ollama/vLLM/llama.cpp/LiteLLM vía cliente OpenAI-compatible único; detección de capacidades (`detectCapabilities`/`classifyBackendByUrl` en `providers/utils.ts`) que clasifica el backend y detecta soporte de `/models`; **fallback automático por orden** en `ProviderRouter` (`advanceProvider`/`resetFallback`/`hasFallback`/`switchProvider`/`providerNames`), cableado en `ReactLoop` (conmuta solo antes de emitir tokens) y `core.run()` (reset por turno), con notificación inline `provider_fallback` (evento `warning`); health check con polling en background (~30 s) que pinta el `●` izquierdo del status bar (`ProviderStatus` en `StatusBar.tsx`, MCP movido a segmento propio `mcp ●`); `/provider <name>` para cambiar provider en sesión + autocompletado (`session-commands.ts`); `/model` descubre modelos en vivo (no depende de la config — un modelo nuevo en LiteLLM aparece sin tocar `.stratumrc.json`) y ofrece entrada manual cuando `/models` no está soportado; `stratum providers` como alias de `stratum provider`. Tests nuevos en `providers/utils.test.ts` y `providers/router.test.ts`.

- Hito 7 ✅ Plan & Execute Mode (cerrado 2026-06-19): modo plan-and-execute en 3 fases dentro de un solo turno del loop ReAct (filosofía `/init`, sin pipeline ni agente especializado). Tipos `Plan`/`PlanStep`/`PlanStepStatus`/`PlanDecision`/`AgentMode` y eventos `plan_proposed`/`plan_step_update` en `agent/types.ts`; helpers en `agent/plan.ts` (`PLAN_ALLOWLIST` read-only, `PLAN_MODE_PROMPT`, `makePlanFromProposal`, `buildExecutionInjection`, `buildResumePreamble`, `serializePlanToMarkdown`/`parsePlanFromMarkdown`, `isPlanComplete`); tools de control `present_plan` y `update_plan` (`tools/plan/`, interceptadas por el loop, no despachadas) registradas en `tools/index.ts`; filtrado de toolset por modo (`isToolVisibleInMode` + `toToolSchemas(mode)` en `registry.ts`). En `harness.ts`: `RunOptions.mode` muta `plan→execute` en el mismo turno; Fase 1 restringe a la allowlist y rechaza tools mutantes con `tool_error` recuperable; `present_plan` emite `plan_proposed` y resuelve el gate vía `RunOptions.onApprovePlan` (sin callback → rechazo); al aprobar inyecta el checklist como tool result y conmuta a execute; `update_plan` aplica el estado, emite `plan_step_update` y persiste. Persistencia incremental en `.stratum/plans/` (`session/plan-store.ts`, escritura atómica) vía `RunOptions.onPlanPersist`; `planRef` en `SessionContext`/`SaveSessionParams` y reanudación de plan `in_progress` en `chat --resume` (`StratumAgentOptions.resumePreamble`/`planRef`, `core.ts`). UI Ink (§5.4): `PlanSteps` (render compartido con iconos `○◐✓⊘`), `PlanView` (compacto pinned en Fase 3, cabecera `Plan · N/total`), `PlanApproval` (gate Fase 2 con edición inline: ↑↓/Enter/d/n/A/R); estado `planMode`/`plan`/`pendingApproval` en el reducer de `App.tsx`; badge `◑ PLAN`/`▸ EXEC` en `StatusBar`; `send` con opts por llamada en `useAgentStream`; `/plan <tarea>` en autocompletado y `executeCommand`. `stratum run --plan` (+ `--yes`/`--approve-plan`): plan a stderr, aprobación por TTY/flags, sin TTY y sin `--yes` el plan es el entregable (exit 0 sin ejecutar). 13 tests nuevos (`plan.test.ts`, `plan-flow.test.ts`). Ver UI §5.4.

- Hito 8A ✅ Delegación mínima (implementado 2026-06-20, §12.16): tool de control `delegate_task` (`tools/agent/delegate.ts`) interceptada por el `ReactLoop` igual que las de plan — no se despacha. Tipos `SubagentTask`/`SubagentBudget`/`SubagentResult`/`SubagentStatus`/`AgentProfile`/`SubagentRouter` y eventos `subagent_started`/`subagent_progress`/`subagent_completed` en `agent/types.ts`. `ProfileLoader` (`agent/profiles.ts`): perfiles como ficheros markdown+frontmatter YAML en `~/.stratum/agents/` y `<projectRoot>/.stratum/agents/` (proyecto > global, parser YAML mínimo sin deps), perfil `general` embebido; perfil inexistente → `tool_error` recuperable. `runSubagent` (`agent/subagent.ts`): contexto **aislado** (no hereda historial del padre; solo system con marca de subagente + task + refs de ficheros), **`ProviderRouter` propio por hijo** (un fallback/switch del hijo no muta al padre), toolset filtrado por perfil + **profundidad = 1** (delegate_task oculto a subagentes vía `isToolVisibleForProfile`/`ToolsetFilter` en `registry.ts`), signal encadenado (cancelación del padre + `timeoutMs` por `AbortSignal.any`), `maxIterations` del presupuesto (override en `RunOptions`), `SubagentResult` truncado a ~30k (`tools/truncate.ts`) e inyectado como tool result XML (inject & recover), write-log best-effort de `filesChanged`. Ejecución **estrictamente secuencial** (concurrencia = 1). `core.ts` instancia el `ProfileLoader` y lo pasa al loop vía `extras`. Config `agents.{defaultProfile,maxConcurrency}` (`config/schema.ts`); perfiles de ejemplo en `.stratum/agents/{research,code}.md`. Tests: `agent/subagent.test.ts`, `agent/delegate-flow.test.ts` (inyección de router mock vía `RunOptions.makeSubagentRouter`/`RunSubagentOptions.makeRouter`). UI: `cli/ui/SubagentBlock.tsx` (bloque colapsable estilo `ToolCallBlock`: running/completed/failed/cancelled/budget_exceeded, expande summary + filesChanged con Space); estado `subagents?` en `AgentConvItem` y eventos `subagent_started`/`subagent_completed` manejados en el reducer de `App.tsx`; `delegate_task` se filtra del render de tool calls crudos (se representa solo como SubagentBlock); `getActiveBlocks` une tool calls + subagentes para navegación Tab/Space; render en `AgentMessage`/`MessageList`. Además, corregido el descubrimiento de perfiles: el `ProfileLoader` acepta varios roots `[worktreeRoot, cwd]` (el cwd, más específico, gana en conflictos; dedup por ruta) para descubrir `<proyecto>/.stratum/agents/` aunque el proyecto npm viva en un subdirectorio del repo git.

- Hito 8B ✅ Robustez (cerrado 2026-08-20, §12.16): **presupuesto de tokens best-effort** — `ReactLoop` acumula `usage` real (`_tokensUsed` + getter `tokensUsed`) y corta entre iteraciones cuando supera `RunOptions.maxTokens` (`stopReason: 'budget_tokens'`); si el backend no devuelve `usage`, se ignora y el control recae en `maxIterations`+`timeoutMs` (`SubagentResult.usage.tokens` queda `undefined`, `debug` en `agent.subagent`). `runSubagent` mapea `budget_tokens`/`max_iterations` → `budget_exceeded` y captura `usage.tokens`. **Persistencia** en `<proyecto>/.stratum/subagents/<id>.json` (`session/subagent-store.ts`, `SubagentStore`, escritura atómica tmp+rename, best-effort): `saveRunning` marca `running` ANTES de ejecutar y `saveResult` sobrescribe con el estado terminal; `loadInterrupted()` devuelve los `running` sin resultado (cuelgue a mitad), `markInterrupted()`/`read()`/`list()`. Cableada vía `RunOptions.onSubagentPersist` (llamada por el loop padre en la interceptación de `delegate_task`: sin `result` → running, con `result` → terminal) en `cli/commands/run.ts` y en `App.tsx` (`getRunOptions`, hereda al path de `/plan`). **Reanudación** (`chat --resume`): `buildInterruptedSubagentsPreamble` (en `agent/subagent.ts`) inyecta un preámbulo que instruye al PADRE a verificar el estado real y decidir — **no reejecuta** el hijo (un subagente no es idempotente: pudo ejecutar `bash`/escribir ficheros); tras inyectar, `markInterrupted` para no re-detectarlos. Cancelación (signal encadenado) y propagación de errores (`failed` como tool result recuperable) ya venían de 8A. Tests nuevos: `agent/subagent-8b.test.ts` (9: presupuesto de tokens, store, preámbulo) + 1 en `delegate-flow.test.ts` (wiring `onSubagentPersist` running→terminal). 8C (paralelismo + árbol Ink `<AgentTree>` + evento `subagent_event` + detección de conflictos) pendiente.

- Hito 8C ✅ UX y especialización (cerrado 2026-08-20, §12.16, UI §5.6/§5.7): **ejecución paralela** acotada por semáforo — `runDelegations` en `harness.ts` orquesta los `delegate_task` de un turno con `Semaphore(agents.maxConcurrency)` (con maxConcurrency=1 degrada a secuencial, idéntico a 8A/8B); primitivas propias sin deps en `agent/concurrency.ts` (`Semaphore` contador + `Mutex` FIFO por cadena de promesas). **Merge de eventos**: cola fan-in que drena en tiempo real los eventos de los hijos; `runSubagent` acepta un callback `onEvent` y el loop re-emite cada `AgentEvent` del hijo envuelto como `subagent_event` (nuevo en `types.ts`). **Mutex compartidos**: confirmaciones destructivas serializadas contra la TTY única del padre (`confirmMutex` envuelve `onConfirmDestructive`), y escrituras de memoria serializadas con un mutex interno en `DecisionMemory.save()` (§12.7). **Detección de conflictos** best-effort: intersección de write-logs por subagente (`filesChanged`) → `warning` `subagent_file_conflict`; write-log de `bash` inferido con `inferBashWrites` (redirecciones, `tee`, `touch`, `rm`, destino de `cp`/`mv`). **Perfil `shell`** afinado (`.stratum/agents/shell.md`, `bash` read-only-first, `ask`) junto a `code`/`research`. **UI**: `<AgentTree>` (`cli/ui/AgentTree.tsx`) monta el árbol vivo cuando hay >1 subagente en el turno (nodos con tool calls anidados vía `subagent_event`, marcador `▶` del que "habla", estados `queued`/`running`/terminales, resumen agregado al terminar); con 1 solo subagente se conserva `<SubagentBlock>`. Inspector `/subagents` (`cli/ui/SubagentView.tsx`): transcripts en memoria (`subagentTranscripts` en el reducer, alimentado por `subagent_event`), desplegable de selección + vista read-only con `focusState='subagent-view'`, input restringido a `/quit`/`Esc`. `stratum run` prefija la salida entrelazada con `[sub perfil#n]` a stderr. Reductor de tool calls compartido en `cli/ui/tool-call-reducer.ts`. Tests nuevos: `agent/subagent-8c.test.ts` (10: semáforo respetado con maxConcurrency=2, secuencial con 1, `subagent_event` envuelto, conflicto de fichero → warning, confirmaciones serializadas por mutex, `inferBashWrites`, primitivas Semaphore/Mutex). 344 tests verdes.

- Hito 9 ✅ SSH Nativo (cerrado 2026-08-27, §12.14, UI §5.8): cliente SSH puro Node sobre `ssh2` (dep normal, en `external` de tsup) — el binario `ssh` del sistema nunca se invoca. Schema Zod `ssh.{hosts,auditLog}` **opcional** (`SSHHostSchema` en `config/schema.ts`) con `superRefine` que valida en carga lo que el pool no puede arreglar en runtime: al menos un método de auth por host, `hostKeyHash` obligatorio con `strict`, y cadena de `jumpHost` existente, sin ciclos y de profundidad ≤2. `SSHConnectionPool` (`pool.ts`): apertura lazy, mapa `inflight` como mutex de establecimiento, jump hosts con `forwardOut`, backoff 2s→4s→8s **solo** para conexiones establecidas que se caen (el primer fallo de apertura rechaza ya), `closeAll()` hojas→bastiones, y listener de `error` permanente porque ssh2 emite errores tardíos que sin manejador tumban el proceso. Verificación de host key (`known-hosts.ts`): TOFU con `~/.stratum/known_hosts.json` (formato propio, escritura atómica), `strict` con fingerprint pinneado, `insecure` con warning; **mismatch aborta siempre** con `recoverable: false`. El gate TOFU reutiliza `ToolContext.confirmDestructive` (Ink / readline / deny sin TTY), y `allow-all` aprueba solo ese host. Tools `ssh_exec` (`exec.ts`: `pty`, `stdin`, `cwd`, corte en `maxBytes` 256 KB y `commandTimeout` 30 s con `stream.signal('KILL')`, salida XML `<ssh_result>`, filtrado ANSI con PTY) y `ssh_upload`/`ssh_download` (`sftp.ts`, `fastPut`/`fastGet`); **solo se registran si hay inventario** (`registerSshTools`). Confirmación de `ssh_exec` vía `isDestructive()` — `confirmAll` del host o patrón destructivo reutilizando `commandIsDestructive` de `shell/bash.ts` — y `describeCall` antepone `[alias]`. Auditoría JSONL en `~/.stratum/logs/ssh-audit.jsonl` con rotación a 10 MB (`audit.ts`); `sessionId` propagado por `RunOptions`→`ToolContext`. `closeSshPool()` en el teardown de `chat`/`run` (§12.12). Bloque de inventario y limitaciones (sudo/NOPASSWD, PTY, comandos no terminantes) inyectado en el system prompt solo si hay hosts. Comando `stratum ssh list|trust`. UI: `⌗ alias` en `<ToolCallBlock>` y duración en `warning` si >1 s. **Desviaciones documentadas en §12.14**: `keychain:`/keytar no implementado (se usa `env:` + fallback `STRATUM_SSH_<ALIAS>_SECRET`) y `destructive: true` traducido a `isDestructive()`. **Dos trampas de `ssh2` que ya están resueltas y no deben re-introducirse**: (1) emite `error` de forma asíncrona incluso después de que la promesa de conexión se resuelva o rechace, y sin listener permanente ese EventEmitter tumba el proceso; (2) es CJS y el detector de exports de Node reconoce `Client` pero **no** `Server`/`utils`, que hay que tomar del default import. 77 tests nuevos contra un `ssh2.Server` **real en proceso** (`test-server.ts`: exec, SFTP y jump hosts sin mocks del protocolo). 422 tests verdes. Verificado de punta a punta contra un host Ubuntu real con modelo local — ver `CLI-DOC/Diario/Hito-9.md`.

Ver sección 9 de `STRATUM_PROJECT_DEFINITION.md` para el roadmap completo.

## Imported Claude Cowork project instructions
