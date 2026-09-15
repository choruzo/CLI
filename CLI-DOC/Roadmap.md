---
date: 2026-08-27
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
| [[#Hito 6]] | Multi-provider Polishing | ~3 días | ✅ Completado |
| [[#Hito 7]] | Plan & Execute Mode | ~7 días | ✅ Completado |
| [[#Hito 8]] | Multi-agent Foundation | ~10 días | ✅ Completado |
| [[#Hito 9]] | SSH Nativo | ~7 días | ✅ Completado |

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

## Hito 6 — Multi-provider Polishing ✅

- [x] Backends Ollama / vLLM / llama.cpp / LiteLLM vía el cliente OpenAI-compatible único
- [x] Detección de capacidades (`detectCapabilities` / `classifyBackendByUrl` en `providers/utils.ts`)
- [x] Fallback automático por orden en `ProviderRouter`, con notificación inline `provider_fallback`
- [x] Health check con polling en background (~30 s) que pinta el `●` del status bar
- [x] `/provider <name>` y `/model` con descubrimiento de modelos en vivo
- [x] `stratum providers` como alias de `stratum provider`

**Entregable:** cambiar de backend o de modelo sin reiniciar ni tocar `.stratumrc.json`. Ver [[Módulos/providers]].

---

## Hito 7 — Plan & Execute Mode ✅

> El diseño original (`Planner` con una llamada estructurada + checkpoints por paso)
> **se descartó**. Igual que con `/init` en el Hito 2.5, la calidad emerge del loop
> completo: el modo plan es el propio ReAct con el toolset restringido a read-only
> más un tool de cierre. Ver §12.15.

- [x] Tres fases en un mismo turno: exploración read-only → gate de aprobación → ejecución
- [x] Tools de control `present_plan` / `update_plan`, interceptadas por el loop (no despachadas)
- [x] Allowlist read-only en fase 1; toda tool mutante devuelve `tool_error` recuperable
- [x] Aprobar-una-vez, sin checkpoints por paso (el control fino sigue siendo la confirmación destructiva)
- [x] Persistencia incremental en `.stratum/plans/` — el plan es la fuente de verdad del progreso
- [x] Reanudación: el paso que quedó `in_progress` se marca ambiguo y el agente lo verifica antes de darlo por hecho
- [x] UI `<PlanView>` / `<PlanApproval>` y flag `--plan` en `stratum run`

**Entregable:** planificar antes de tocar nada, con un plan que sobrevive a un cuelgue duro. Ver [[Módulos/agent]].

---

## Hito 8 — Multi-agent Foundation ✅

> También aquí se descartó el diseño original: no hay clase `Orchestrator` ni clases
> `CodeAgent`/`ShellAgent`/`ResearchAgent`. Los perfiles son **ficheros markdown con
> frontmatter**, y la delegación es una tool de control más. Ver §12.16.

**8A — Delegación mínima**
- [x] Tool `delegate_task` interceptada por el loop; contexto **aislado** (el hijo no hereda el historial)
- [x] `ProviderRouter` propio por hijo: un fallback del hijo no muta al padre
- [x] Perfiles en `~/.stratum/agents/` y `<proyecto>/.stratum/agents/` (proyecto gana)
- [x] Profundidad = 1: `delegate_task` está oculta a los subagentes

**8B — Robustez**
- [x] Presupuestos `maxIterations`/`timeoutMs` duros y `maxTokens` best-effort
- [x] Persistencia en `.stratum/subagents/`; un hijo a medias queda `interrupted`
- [x] Reanudación: el padre **verifica** antes de reintentar — un subagente no es idempotente

**8C — UX y especialización**
- [x] Ejecución paralela acotada por semáforo (`agents.maxConcurrency`) + mutex para TTY y memoria
- [x] Evento `subagent_event` y árbol vivo `<AgentTree>` con tool calls anidados
- [x] Inspector read-only `/subagents`
- [x] Detección best-effort de conflictos de fichero entre subagentes

**Entregable:** tareas complejas repartidas entre subagentes por perfil, con resultados agregados.

---

## Hito 9 — SSH Nativo ✅

- [x] `SSHConnectionPool`: conexiones persistentes por alias, apertura lazy, `inflight` como mutex de establecimiento
- [x] Tool `ssh_exec` con `pty`, `stdin`, `cwd`, límite de salida y timeout que matan el proceso remoto
- [x] Tools `ssh_upload` / `ssh_download` vía SFTP
- [x] Inventario `ssh.hosts` en `.stratumrc.json` + validación Zod temprana (auth, `strict`, cadena de `jumpHost`)
- [x] Autenticación: clave privada (con passphrase), ssh-agent del sistema, password, jump hosts
- [x] Verificación de host key: TOFU / `strict` / `insecure`, con `~/.stratum/known_hosts.json`
- [x] Reconexión con backoff 2s → 4s → 8s para conexiones establecidas que se caen
- [x] `stratum ssh list` (conectividad en vivo) y `stratum ssh trust`
- [x] Limpieza de conexiones en el ciclo de SIGINT (§12.12)
- [x] Log de auditoría JSONL con rotación a 10 MB

**Entregable:** administrar infraestructura remota desde el loop ReAct, sin el binario `ssh` del sistema. Ver [[Módulos/tools]] y [[Diario/Hito-9]].

---

## Hito 16 — Ejecución unificada, auditoría universal y redacción ✅

Primer bloque de [[Orientacion-Infraestructura]] (cerrado 2026-09-15).

- [x] `ExecutionTarget` (`local` / `ssh:<alias>`; `container`/`pod`/`winrm` reservados)
- [x] Tool `exec` sobre `IExecBackend` con capacidades declaradas; `bash` y `ssh_exec` retirados sin alias
- [x] Descripción de tool generada con los targets de la config
- [x] Backend local: `maxBytes` que descarta sin matar, exit code real en Windows, cancelación estructurada
- [x] Contrato de fallo: `tool_error` recuperable con `countsAsFailure:false`; contador de reintentos consecutivo
- [x] Auditoría universal en `exec-audit.jsonl` (+ alias `ssh.auditLog` migrado por capa)
- [x] Redacción de salidas de tool con núcleo no desactivable y extras literales
- [x] Write-log de subagentes con clave canónica por target
- [x] Avisos de perfiles con tools retiradas en `/agents` y `stratum agents list`

**Entregable:** una sola superficie de ejecución con guardas, auditoría y redacción en un punto, base de los hitos de infraestructura 17–20.
