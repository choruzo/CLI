---
date: 2026-06-16
tags: [arquitectura, stratum-cli, diseño]
status: vivo
---

# Arquitectura — Stratum CLI

Agente de línea de comandos extensible construido sobre un loop ReAct (Reason → Act → Observe). Provider-agnostic: compatible con cualquier API OpenAI-compatible.

Ver [[Roadmap]] para el estado de implementación. Hitos 0–5 completados; Hito 6 en curso.

---

## Diagrama de subsistemas

```
CLI (Commander.js)
    └── StratumAgent (core.ts)
            ├── MemoryManager (memory/manager.ts)               ← Hito 2 + 5
            │       ├── STRATUM.md loader (capa 1)
            │       └── DecisionMemory (decision-memory.ts)     ← Hito 5
            │               ├── DecisionStore (decisions.json)
            │               ├── VectorStore (sqlite-vec / fallback JS)
            │               └── EmbeddingService (ONNX local / HTTP)
            ├── ReactLoop + ContextManager (harness.ts)
            │       ├── IProvider → OpenAICompatible (streaming SSE + usage tokens)
            │       ├── StreamBuffer (parsing tool calls fragmentados)
            │       ├── ContextManager (compresión §12.4: LLM call + truncado duro)
            │       └── ToolDispatcher → ToolRegistry
            │               ├── fs: read/write/edit/glob/list/grep
            │               ├── shell: bash (guard destructivo)
            │               ├── web: search / fetch
            │               ├── memory: store_decision / recall_decisions  ← Hito 5
            │               └── mcp__<server>__<tool>  (auto-registradas)  ← Hito 4
            ├── SessionStore (session/store.ts)                 ← Hito 2
            │       └── ~/.stratum/sessions/*.json
            └── McpManager (mcp/manager.ts)                     ← Hito 4 + 4.1
                    ├── McpServerClient (stdio, heartbeat, backoff)
                    ├── installer.ts (carpeta gestionada ~/.stratum/mcp/)
                    └── buildMcpTool → ToolDefinitions en ToolRegistry
```

---

## Módulos implementados

### [[Módulos/cli]] — CLI & UI (Hitos 0–5)

- Entry point: `cli/index.ts` (Commander.js)
- UI terminal: Ink v5 (React 18) — `App.tsx` → Banner / `ConversationView.tsx`
- Comandos operativos: `chat` (con `--resume`), `run`, `config`, `init`, `provider`, `memory list/search/forget/show`, `sessions list/resume/delete/prune`, `mcp list/install`
- Slash commands en chat: `/init`, `/memory list|search|forget|show`, `/model`, `/config_provider`, `/tools`, `/quit`

### [[Módulos/config]] — Configuración (Hito 0, ampliado en Hitos 2 y 5)

- Schema: `config/schema.ts` (Zod) — incluye `agent.compressionThreshold`, `agent.compressorModel`, `tools.destructivePatterns`, `tools.webSearch`, `mcp.{startup,startupTimeout,servers}`, `memory.{embeddingDimension,embeddingEndpoint,autoExtract,extractionModel,similarityThreshold,embeddingWarmup}`
- Rutas: `config/paths.ts` — `expandHome()`, `resolveMemoryPaths()`
- Loader (`loader.ts`) expande `${ENV}`; writer (`writer.ts`) persiste cambios en caliente
- Archivo: `.stratumrc.json` — providers, rutas de memoria, tools, MCP servers

### [[Módulos/agent]] — Agent Core (Hitos 1–5)

- `StratumAgent` (`core.ts`) — estado de sesión, orquesta subsistemas; expone `getProvider()`, `reloadMemory()`
- `ReactLoop` + `ContextManager` (`harness.ts`) — bucle ReAct, compresión §12.4 completa, `compressionMode: 'conservative'` para init, evento `memory_retrieved` vía `takeLastRecall`
- Init: `initialize-prompt.ts` (`INITIALIZE_PROMPT`), inyectado como mensaje de usuario del agente general — **no hay agente especializado de init** (§12.13)
- System prompt (`system-prompt.ts`): default.txt estilo opencode + bloque `<env>` dinámico + inyección de memoria
- `AgentEvent` union type — incluye `warning`, `context_compressed`, `memory_retrieved`

### [[Módulos/providers]] — Providers (Hito 1, ampliado en Hitos 2 y 3.5)

- `OpenAICompatible` — cliente SSE con `eventsource-parser`; solicita `stream_options.include_usage`
- `StreamBuffer` — acumula chunks fragmentados de tool calls (§12.2)
- `ProviderRouter` — selección de provider activo desde config + fallback; expone `getActive()`
- Wizard `stratum provider add`, `/model`, `/config_provider`

### [[Módulos/tools]] — Tools (Hitos 1, 2.5, 3, 4, 5)

- `ToolRegistry` + `ToolDispatcher` — registro central y dispatch paralelo/serializado, fase de confirmación destructiva, truncado ~30k (`truncate.ts`)
- fs: `read_file`, `write_file`, `edit_file` (unified diff), `glob`, `list_directory`, `grep`
- shell: `bash` (guard destructivo configurable, serialized)
- web: `web_search` (DDG + Tavily, RRF), `web_fetch` (HTML→markdown)
- memory: `store_decision`, `recall_decisions`
- MCP: tools auto-registradas `mcp__<server>__<tool>` (`mcp/`)

### [[Módulos/memory]] — Memory Layers 1, 2 y 3 (Hitos 2 y 5)

- `MemoryManager` — orquesta las 3 capas; carga STRATUM.md proyecto + global
- Capa 2 `DecisionStore` (`decisions.json`) + Capa 3 `VectorStore` (`vectors.db`) orquestadas por `DecisionMemory`
- `EmbeddingService` ONNX local lazy + extracción automática en background (`extractor.ts`)
- `stratum init` / `/init`, `stratum memory list/search/forget/show`

### [[Módulos/sessions]] — Session Persistence (Hito 2)

- `SessionStore` — save/load/list/delete/prune en `~/.stratum/sessions/`
- Auto-resumen LLM (≤ 100 chars) al guardar sesiones con ≥ 5 rondas
- Nunca persiste `apiKey` ni `baseUrl`

---

## Módulos pendientes de implementar

| Módulo | Archivo principal | Hito |
|--------|------------------|------|
| Pulido multi-provider (health check, listado de modelos) | `providers/router.ts` | 6 |
| Planner + Plan & Execute | `agent/planner.ts` | 7 |
| Orchestrator multi-agente | `agent/orchestrator.ts` | 8 |

---

## Decisiones técnicas fijas

| Área | Decisión |
|------|----------|
| LLM client | Implementación propia OpenAI-compatible (no `ai-sdk` ni `openai` npm) |
| Vector DB | `sqlite-vec` embebido + fallback brute-force JS (no Chroma/Qdrant) |
| Embeddings | ONNX local con `@xenova/transformers` (no OpenAI API) |
| Shell | `execa` (no `child_process` directo) |
| Build | `tsup` → ESM + CJS en `dist/` |

---

## Specs vinculantes (sección 12)

Antes de implementar módulos de `agent/` o `providers/`, revisar:

- **12.1** — Schema completo de `AgentEvent`
- **12.2** — Algoritmo `StreamBuffer` (parsing SSE fragmentado)
- **12.3** — Política de errores: inject & recover, formatos XML ✅ implementado
- **12.4** — Compresión de contexto: umbral 80%, zona protegida, LLM call ✅ implementado
- **12.6** — Persistencia de sesiones ✅ implementado
- **12.7** — Tools de memoria (`store_decision` / `recall_decisions`) ✅ implementado
- **12.8** — Ciclo de vida MCP servers: arranque, reconexión con backoff ✅ implementado
- **12.8.1** — Carpeta gestionada de MCP servers ✅ implementado
- **12.10** — Carga lazy ONNX con warm-up opcional ✅ implementado
- **12.12** — Señales del proceso y cleanup por etapa
- **12.13** — `stratum init` / `/init`: comando-plantilla `INITIALIZE_PROMPT` ✅ implementado
