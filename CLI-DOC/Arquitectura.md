---
date: 2026-05-28
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
            ├── ReactLoop + ContextManager (harness.ts)
            │       ├── IProvider → OpenAICompatible (streaming SSE)
            │       ├── StreamBuffer (parsing tool calls fragmentados)
            │       └── ToolDispatcher → ToolRegistry
            ├── MemoryManager
            │       ├── STRATUM.md (system prompt)
            │       ├── decisions.json (decision store)
            │       └── vectors.db (sqlite-vec + ONNX embeddings)
            └── MCP Bridge (mcp/bridge.ts)
                    └── ToolDefinitions registradas en ToolRegistry
```

---

## Módulos implementados

### [[Módulos/cli]] — CLI & UI

- Entry point: `cli/index.ts` (Commander.js)
- UI terminal: Ink v5 (React 18) — `App.tsx` → Banner / `ConversationView.tsx`
- Comandos implementados: `chat`, `run`, `config`, `init` (stubs: `memory`, `sessions`)

### [[Módulos/config]] — Configuración

- Schema: `config/schema.ts` (Zod)
- Archivo: `.stratumrc.json` — providers, rutas de memoria, tools, MCP servers
- Variables de entorno `${VAR}` expandidas automáticamente

### [[Módulos/agent]] — Agent Core (Hito 1)

- `StratumAgent` (`core.ts`) — estado de sesión, orquesta subsistemas
- `ReactLoop` + `ContextManager` (`harness.ts`) — bucle ReAct, estimación de tokens
- `AgentEvent` union type — fuente única de verdad para todos los eventos del agente

### [[Módulos/providers]] — Providers (Hito 1)

- `OpenAICompatible` — cliente SSE con `eventsource-parser`
- `StreamBuffer` — acumula chunks fragmentados de tool calls (§12.2)
- `ProviderRouter` — selección de provider activo desde config

### [[Módulos/tools]] — Tools (Hito 1)

- `ToolRegistry` + `ToolDispatcher` — registro central y dispatch paralelo/serializado
- Built-ins: `read_file`, `write_file`, `bash`

---

## Módulos pendientes de implementar

| Módulo | Archivo principal | Hito |
|--------|------------------|------|
| MemoryManager | `memory/manager.ts` | 2–5 |
| Compresión de contexto | `agent/harness.ts` | 2 |
| `edit_file`, `glob`, `grep` | `tools/fs/` | 3 |
| Guard destructivo en `bash` | `tools/shell/bash.ts` | 3 |
| MCP Bridge | `mcp/bridge.ts` | 4 |
| Decision Store + embeddings ONNX | `memory/` | 5 |

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
- **12.4** — Compresión de contexto: umbral 80%, zona protegida
- **12.8** — Ciclo de vida MCP servers: inicio eager, reconexión con backoff
- **12.10** — Carga lazy ONNX con warm-up opcional
- **12.12** — Señales del proceso y cleanup por etapa
