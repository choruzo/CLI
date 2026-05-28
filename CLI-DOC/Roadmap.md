---
date: 2026-05-28
tags: [roadmap, hitos, stratum-cli]
status: en-progreso
---

# Roadmap — Stratum CLI

## Estado general

| Hito | Descripción | Duración est. | Estado |
|------|-------------|---------------|--------|
| [[#Hito 0]] | Scaffolding | ~2 días | ✅ Completado |
| [[#Hito 1]] | Core Agent Loop | ~5 días | ✅ Completado |
| [[#Hito 2]] | Memory Layer 1 | ~3 días | ⏳ Pendiente |
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

## Hito 2 — Memory Layer 1 ⏳

- [ ] `STRATUM.md` loader (proyecto + global)
- [ ] Inyección en system prompt
- [ ] `SessionContext`: historial de conversación
- [ ] Compresión de contexto (umbral 80%)
- [ ] Comando `stratum memory show`

**Entregable:** El agente recuerda el contexto del proyecto entre iteraciones dentro de una sesión.

---

## Hito 3 — Tools completos Day 1 ⏳

- [ ] `edit_file` con diff patches
- [ ] `list_directory`, `glob`, `grep`
- [ ] `web_search` + `web_fetch`
- [ ] Safety check en `bash` (patrones destructivos)
- [ ] Confirmación interactiva en tools destructivas
- [ ] Timeout y cancelación de tools
- [ ] ToolCall UI (Ink)

**Entregable:** Agente con toolset completo del día 1.

---

## Hito 4 — MCP Client ⏳

- [ ] Integración `@modelcontextprotocol/sdk`
- [ ] Conexión a MCP servers desde `.stratumrc.json`
- [ ] Auto-registro de MCP tools en `ToolRegistry`
- [ ] Comando `stratum mcp list`

**Entregable:** Cualquier MCP server se puede conectar y sus tools son utilizables.

---

## Hito 5 — Memory Layers 2 y 3 ⏳

- [ ] `DecisionStore`: schema JSON + CRUD
- [ ] Pipeline de embedding con `@xenova/transformers` (ONNX local)
- [ ] `sqlite-vec` setup e integración
- [ ] Búsqueda semántica KNN
- [ ] Comandos `stratum memory list/search/forget`

---

## Hito 6 — Multi-provider Polishing ⏳

- [ ] Soporte Ollama completo
- [ ] Soporte llama.cpp server / vLLM / LiteLLM
- [ ] Fallback automático a provider secundario
- [ ] Comando `stratum providers list`

---

## Hito 7 — Plan & Execute Mode ⏳

- [ ] `Planner`: genera plan estructurado antes de ejecutar
- [ ] Checkpoints de aprobación del usuario
- [ ] Flag `--plan` en `stratum run`

---

## Hito 8 — Multi-agent Foundation ⏳

- [ ] `Orchestrator`: agente principal que delega en subagentes
- [ ] Spawning de subagentes con contexto aislado
- [ ] Agentes especializados: `CodeAgent`, `ShellAgent`, `ResearchAgent`
