---
date: 2026-05-29
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
| [[#Hito 3]] | Tools Day 1 | ~4 días | ⏳ Pendiente |
| [[#Hito 4]] | MCP Client | ~4 días | ⏳ Pendiente |
| [[#Hito 5]] | Memory Layers 2 y 3 | ~6 días | ⏳ Pendiente |
| [[#Hito 6]] | Multi-provider Polishing | ~3 días | ⏳ Pendiente |
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
- [x] Ink UI: Banner con typewriter, ConversationView con streaming cursor
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

## Hito 3 — Tools completos Day 1 ⏳

- [ ] `edit_file` con diff patches
- [ ] `list_directory`, `glob`, `grep`
- [ ] `web_search` + `web_fetch`
- [ ] Safety check en `bash` (patrones destructivos)
- [ ] Confirmación interactiva en tools destructivas
- [ ] Timeout y cancelación de tools
- [ ] ToolCall UI (Ink): estados pending/running/completed/error, spinner, toggle
- [ ] Markdown rendering de respuestas (`<MarkdownText>` con `marked`)

**Entregable:** Agente con toolset completo del día 1. Puede realizar tareas de código completas.

---

## Hito 4 — MCP Client ⏳

- [ ] Integración `@modelcontextprotocol/sdk`
- [ ] Conexión a MCP servers desde `.stratumrc.json`
- [ ] Auto-registro de MCP tools en `ToolRegistry`
- [ ] Comando `stratum mcp list`

**Entregable:** Cualquier MCP server se puede conectar y sus tools son utilizables.

---

## Hito 5 — Memory Layers 2 y 3 ⏳

- [ ] `DecisionStore`: schema JSON + CRUD + tool `store_decision`
- [ ] Detección automática de decisiones (LLM-based, sin clasificador externo)
- [ ] Pipeline de embedding con `@xenova/transformers` (ONNX local)
- [ ] `sqlite-vec` setup e integración
- [ ] Búsqueda semántica KNN — inyección de decisiones relevantes en contexto
- [ ] Comandos `stratum memory list/search/forget`

**Entregable:** El agente recuerda decisiones entre sesiones y puede recuperarlas semánticamente.

---

## Hito 6 — Multi-provider Polishing ⏳

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
