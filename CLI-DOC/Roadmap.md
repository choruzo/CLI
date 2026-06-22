---
date: 2026-06-16
tags: [roadmap, hitos, stratum-cli]
status: en-progreso
---

# Roadmap — Stratum CLI

## Estado general

| Hito | Descripción | Duración est. | Estado |
|------|-------------|---------------|--------|
| [[#Hito 0]] | Scaffolding | ~2 días | ✅ Completado |
| [[#Hito 1]] | Core Agent Loop | ~5 días | ✅ Completado |
| [[#Hito 2]] | Memory Layer 1 | ~3 días | ✅ Completado |
| [[#Hito 2.5]] | Init estilo opencode | ~2 días | ✅ Completado |
| [[#Hito 3]] | Tools Day 1 | ~4 días | ✅ Completado |
| [[#Hito 3.5]] | Provider & Model UX | ~2 días | ✅ Completado |
| [[#Hito 4]] | MCP Client | ~4 días | ✅ Completado |
| [[#Hito 4.1]] | MCP carpeta gestionada + arranque no bloqueante | ~2 días | ✅ Completado |
| [[#Hito 5]] | Memory Layers 2 y 3 | ~6 días | ✅ Completado |
| [[#Hito 6]] | Multi-provider Polishing | ~3 días | ⏳ Siguiente |
| [[#Hito 7]] | Plan & Execute Mode | ~7 días | ⏳ Pendiente |
| [[#Hito 8]] | Multi-agent Foundation | ~10 días | ⏳ Pendiente |

---

## Hito 0 — Scaffolding del proyecto ✅

- [x] Inicializar proyecto TypeScript con tsup
- [x] CLI entry point con Commander.js
- [x] Sistema de configuración (`.stratumrc.json` + Zod schema)
- [x] Estructura de directorios base
- [x] Script de desarrollo con hot-reload
- [x] Vitest configurado

**Entregable:** `stratum --version` funciona. Config se carga correctamente.

---

## Hito 1 — Core Agent Loop ✅

- [x] `ProviderRouter` con cliente OpenAI-compatible
- [x] Streaming de responses (SSE parser via `eventsource-parser`)
- [x] `ReactLoop` con retry de red (backoff 1s/2s/4s) y política inject & recover
- [x] `ToolRegistry` con `ToolDispatcher` (paralelo + serializado §12.9)
- [x] Tools básicas: `read_file`, `write_file`, `bash`
- [x] `StreamBuffer` para parsing de tool calls SSE fragmentadas (§12.2)
- [x] System prompt base (identidad Stratum + instrucciones ReAct)
- [x] UI terminal: logo con cortina ANSI aditiva previa a Ink y fallback estático; ConversationView con streaming cursor
- [x] `stratum run` en modo plain-text (stdout/stderr separados)

**Entregable:** `stratum chat` arranca la UI interactiva. El agente puede leer archivos y ejecutar comandos. `stratum run "tarea"` funciona en modo plain-text contra Ollama local. 42 tests pasando.

Ver [[Módulos/agent]], [[Módulos/providers]], [[Módulos/tools]], [[Módulos/cli]].

---

## Hito 2 — Memory Layer 1 ✅

- [x] `STRATUM.md` loader (proyecto + global) — `src/memory/project.ts`
- [x] Inyección en system prompt — `buildSystemPrompt(config, memory?)`
- [x] `MemoryManager` capa 1 — `src/memory/manager.ts`
- [x] Compresión de contexto completa (§12.4): usage real + proxy `~`, LLM call, fallback truncado duro, presión irresolvible
- [x] `stratum memory show` — muestra STRATUM.md activo
- [x] `stratum init` reescrito — scan inteligente + síntesis LLM + merge interactivo (§12.13)
- [x] `/init` en chat — conduce `InitAgent` mostrando progreso en la conversación
- [x] `/memory show` en chat — sin round LLM
- [x] `SessionStore` — persistencia a `~/.stratum/sessions/` (§12.6)
- [x] `stratum chat --resume <id>` — restaura historial completo
- [x] `stratum sessions list/resume/delete/prune` — gestión completa
- [x] StatusBar prefijo `~` cuando el conteo es estimado

**Entregable:** El agente inyecta el contexto del proyecto al arrancar, comprime el historial al 80%, persiste sesiones a disco y las reanuda. 73 tests pasando.

Ver [[Módulos/memory]], [[Módulos/sessions]], [[Módulos/agent]], [[Módulos/cli]].

---

## Hito 2.5 — Init estilo opencode ✅

*(cerrado 2026-06-11)*

- [x] `INITIALIZE_PROMPT` como comando-plantilla (`initialize-prompt.ts`), inyectado como mensaje de usuario del agente general
- [x] Tools `glob`, `list_directory`, `grep`
- [x] `read_file` con líneas numeradas (`N: contenido`, tope 2000, paginación por `offset`)
- [x] Truncado de tool outputs (~30k chars, cabeza 80% + cola 20%, `tools/truncate.ts`)
- [x] System prompt con bloque `<env>` dinámico (cwd, worktree, git, plataforma, fecha, model id)
- [x] Compresión conservadora en init (`compressionMode: 'conservative'`, umbral ≥0.92, rondas protegidas duplicadas)
- [x] Auto-retry de escritura de STRATUM.md

**Entregable:** `stratum init` y `/init` operan como comando-plantilla estilo opencode, sin agente especializado. Ver §12.13.

---

## Hito 3 — Tools completos Day 1 ✅

*(cerrado 2026-06-11)*

- [x] `edit_file` — reemplazo exacto `old_string → new_string` (única ocurrencia o `replace_all`) con unified diff propio (`fs/diff.ts`, LCS sin dependencias)
- [x] `list_directory`, `glob`, `grep`
- [x] `web_search` — metabúsqueda DuckDuckGo (scraping HTML) + Tavily (opcional), merge + dedupe + re-rank RRF, top 10
- [x] `web_fetch` — descarga (límite 5 MB) + conversor HTML→markdown propio
- [x] Safety check en `bash` — `isDestructive?()` con `tools.destructivePatterns` y límites de palabra
- [x] Confirmación interactiva en tools destructivas (chat Ink + `stratum run` readline + deny automático en CI sin TTY)
- [x] Timeout y cancelación de tools con `AbortSignal` combinado (`AbortSignal.any`)
- [x] ToolCall UI (Ink): 4 estados pending/running/completed/error, foco Tab, expansión Space
- [x] Markdown rendering dual-mode (`<MarkdownText>` con `marked` + `cli-highlight`)

**Entregable:** Agente con toolset completo del día 1. Puede realizar tareas de código completas.

---

## Hito 3.5 — Provider & Model UX ✅

*(cerrado 2026-06-11)*

- [x] Wizard `stratum provider add`
- [x] `/model` en chat — cambio de modelo en caliente
- [x] `/config_provider` en chat — selección de provider activo

**Entregable:** Alta y cambio de provider/modelo guiado, sin editar `.stratumrc.json` a mano.

---

## Hito 4 — MCP Client ✅

*(cerrado 2026-06-15)*

- [x] `McpServerClient` (`mcp/client.ts`) — conexión stdio a un server
- [x] Conexión a MCP servers desde `.stratumrc.json`
- [x] Auto-registro de MCP tools como `mcp__<server>__<tool>` (`buildMcpTool`, `bridge.ts`)
- [x] `McpManager` (`manager.ts`) — arranque, heartbeat 30 s, backoff 2→4→8 s
- [x] Comando `stratum mcp list`; `/tools` en chat; indicador de conectividad MCP en StatusBar

**Entregable:** Cualquier MCP server se puede conectar y sus tools son utilizables.

---

## Hito 4.1 — MCP carpeta gestionada + arranque no bloqueante ✅

*(cerrado 2026-06-16)*

- [x] Carpeta gestionada `~/.stratum/mcp/` (campo `package` npm; instala una vez, lanza `node` directo, evita overhead de `npx`; `installer.ts`)
- [x] Comando `stratum mcp install [server]`
- [x] `mcp.startup`: `'lazy'` (default, conexión en background con `startBackground`, no bloquea la UI) / `'eager'`
- [x] `startupTimeout` por server (15 s) aborta servers que cuelgan
- [x] Auto-creación de la carpeta gestionada

**Entregable:** Servers MCP por paquete npm sin coste de `npx` en cada arranque; el chat arranca sin esperar a los servers. Ver §12.8.1.

---

## Hito 5 — Memory Layers 2 y 3 ✅

*(cerrado 2026-06-16)*

- [x] `DecisionStore` (`decisions.ts`) — CRUD JSON atómico, id `dec_YYYYMMDD_<nanoid6>`, `embedding_ref = vec_${id}`
- [x] Tool `store_decision` (serialized) + extracción automática LLM-based en background (`extractor.ts`)
- [x] `EmbeddingService` (`embeddings.ts`) — `@xenova/transformers` ONNX local lazy + endpoint HTTP `/v1/embeddings` opcional (fast-fail + latch), guard de symlinks en Windows
- [x] `VectorStore` (`vectors.ts`) — backend `sqlite-vec` cosine (import dinámico) + fallback brute-force JS persistente (`*.fallback.json`)
- [x] Orquestador `DecisionMemory` (`decision-memory.ts`, singleton por ruta) — dedup semántico al guardar + KNN al recuperar
- [x] Tool `recall_decisions` + evento `memory_retrieved` (vía `takeLastRecall`) con indicador discreto en la UI
- [x] Comandos `stratum memory list/search/forget` (CLI) y `/memory list|search|forget` en chat
- [x] Warm-up ONNX opcional (`memory.embeddingWarmup`); deps opcionales en `optionalDependencies` + `external` en tsup

**Entregable:** El agente recuerda decisiones entre sesiones y las recupera semánticamente. Invariante: `decisions.json` nunca se pierde aunque el índice/embedder fallen. 29 tests nuevos. Ver §5, §9, §12.7 y §12.10.

---

## Hito 6 — Multi-provider Polishing ⏳ (siguiente)

- [ ] Soporte Ollama completo (listado de modelos, pull)
- [ ] Soporte llama.cpp server / vLLM / LiteLLM
- [ ] Fallback automático a provider secundario
- [ ] Provider health check al startup
- [ ] Comando `stratum providers list`

---

## Hito 7 — Plan & Execute Mode ⏳

- [ ] `Planner`: genera plan estructurado antes de ejecutar
- [ ] Checkpoints de aprobación del usuario
- [ ] Ejecución paso a paso con posibilidad de editar plan
- [ ] Flag `--plan` en `stratum run`

---

## Hito 8 — Multi-agent Foundation ⏳

- [ ] `Orchestrator`: agente principal que delega en subagentes
- [ ] Spawning de subagentes con contexto aislado
- [ ] Agentes especializados: `CodeAgent`, `ShellAgent`, `ResearchAgent`
- [ ] Visualización de árbol de agentes en Ink
