---
date: 2026-05-29
tags: [arquitectura, stratum-cli, diseño]
status: vivo
---

# Arquitectura — Stratum CLI

Agente de línea de comandos extensible construido sobre un loop ReAct (Reason → Act → Observe). Provider-agnostic: compatible con cualquier API OpenAI-compatible.

Ver [[Roadmap]] para el estado de implementación.

---

## Diagrama de subsistemas

```
CLI (Commander.js)
    └── StratumAgent (core.ts)
            ├── MemoryManager (memory/manager.ts)          ← Hito 2
            │       └── STRATUM.md loader (capa 1 activa)
            │           [decisions.json + sqlite-vec]      ← Hito 5
            ├── ReactLoop + ContextManager (harness.ts)
            │       ├── IProvider → OpenAICompatible (streaming SSE + usage tokens)
            │       ├── StreamBuffer (parsing tool calls fragmentados)
            │       ├── ContextManager (compresión §12.4: LLM call + truncado duro)
            │       └── ToolDispatcher → ToolRegistry
            ├── SessionStore (session/store.ts)            ← Hito 2
            │       └── ~/.stratum/sessions/*.json
            └── MCP Bridge (mcp/bridge.ts)                 ← Hito 4
                    └── ToolDefinitions registradas en ToolRegistry
```

---

## Módulos implementados

### [[Módulos/cli]] — CLI & UI (Hitos 0–2)

- Entry point: `cli/index.ts` (Commander.js)
- UI terminal: Ink v5 (React 18) — `App.tsx` → Banner / `ConversationView.tsx`
- Comandos operativos: `chat` (con `--resume`), `run`, `config`, `init`, `memory show`, `sessions list/resume/delete/prune`
- Slash commands en chat: `/memory show`, `/init`, `/quit`

### [[Módulos/config]] — Configuración (Hito 0, ampliado en Hito 2)

- Schema: `config/schema.ts` (Zod) — incluye `agent.compressionThreshold`, `agent.compressorModel`
- Rutas: `config/paths.ts` — `expandHome()`, `resolveMemoryPaths()`
- Archivo: `.stratumrc.json` — providers, rutas de memoria, tools, MCP servers

### [[Módulos/agent]] — Agent Core (Hitos 1–2)

- `StratumAgent` (`core.ts`) — estado de sesión, orquesta subsistemas; expone `getProvider()`, `reloadMemory()`
- `ReactLoop` + `ContextManager` (`harness.ts`) — bucle ReAct, compresión §12.4 completa
- `InitAgent` (`init-agent.ts`) — scan de proyecto + síntesis LLM + merge STRATUM.md (§12.13)
- `AgentEvent` union type — incluye `warning`, `context_compressed`

### [[Módulos/providers]] — Providers (Hito 1, ampliado en Hito 2)

- `OpenAICompatible` — cliente SSE con `eventsource-parser`; solicita `stream_options.include_usage`
- `StreamBuffer` — acumula chunks fragmentados de tool calls (§12.2)
- `ProviderRouter` — selección de provider activo desde config; expone `getActive()`

### [[Módulos/tools]] — Tools (Hito 1)

- `ToolRegistry` + `ToolDispatcher` — registro central y dispatch paralelo/serializado
- Built-ins: `read_file`, `write_file`, `bash`

### [[Módulos/memory]] — Memory Layer 1 (Hito 2)

- `MemoryManager` — orquesta capas; carga STRATUM.md proyecto + global
- Inyección en system prompt al arrancar; recarga tras `/init`
- `stratum init` / `/init` — scan + síntesis LLM + merge interactivo

### [[Módulos/sessions]] — Session Persistence (Hito 2)

- `SessionStore` — save/load/list/delete/prune en `~/.stratum/sessions/`
- Auto-resumen LLM (≤ 100 chars) al guardar sesiones con ≥ 5 rondas
- Nunca persiste `apiKey` ni `baseUrl`

---

## Módulos pendientes de implementar

| Módulo | Archivo principal | Hito |
|--------|------------------|------|
| `edit_file`, `glob`, `grep`, `web_search` | `tools/fs/`, `tools/web/` | 3 |
| Guard destructivo en `bash` | `tools/shell/bash.ts` | 3 |
| MCP Bridge | `mcp/bridge.ts` | 4 |
| Decision Store + embeddings ONNX | `memory/` | 5 |
| Fallback automático de provider | `providers/router.ts` | 6 |
| Planner + Plan & Execute | `agent/planner.ts` | 7 |
| Orchestrator multi-agente | `agent/orchestrator.ts` | 8 |

---

## Decisiones técnicas fijas

| Área | Decisión |
|------|----------|
| LLM client | Implementación propia OpenAI-compatible (no `ai-sdk` ni `openai` npm) |
| Vector DB | `sqlite-vec` embebido (no Chroma/Qdrant) |
| Embeddings | ONNX local con `@xenova/transformers` (no OpenAI API) |
| Shell | `execa` (no `child_process` directo) |
| Build | `tsup` → ESM + CJS en `dist/` |

---

## Specs vinculantes (sección 12)

Antes de implementar módulos de `agent/` o `providers/`, revisar:

- **12.1** — Schema completo de `AgentEvent`
- **12.2** — Algoritmo `StreamBuffer` (parsing SSE fragmentado)
- **12.3** — Política de errores: inject & recover, formatos XML
- **12.4** — Compresión de contexto: umbral 80%, zona protegida, LLM call ✅ implementado
- **12.6** — Persistencia de sesiones ✅ implementado
- **12.8** — Ciclo de vida MCP servers: inicio eager, reconexión con backoff
- **12.10** — Carga lazy ONNX con warm-up opcional
- **12.12** — Señales del proceso y cleanup por etapa
- **12.13** — `stratum init` / `/init`: scan + síntesis + merge ✅ implementado
