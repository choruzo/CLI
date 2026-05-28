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
- UI terminal: Ink (React para CLIs) — `App.tsx` → `ChatView.tsx` + `ToolCall.tsx`
- Comandos: `chat`, `run`, `memory`, `sessions`, `config`, `init`

### [[Módulos/config]] — Configuración

- Schema: `config/schema.ts` (Zod)
- Archivo: `.stratumrc.json` — providers, rutas de memoria, tools, MCP servers
- Variables de entorno `${VAR}` expandidas automáticamente

---

## Módulos pendientes de implementar

| Módulo | Archivo principal | Hito |
|--------|------------------|------|
| StratumAgent | `agent/core.ts` | 1 |
| ReactLoop | `agent/harness.ts` | 1 |
| ContextManager | `agent/harness.ts` | 1 |
| StreamBuffer | `agent/harness.ts` | 1 |
| ProviderRouter | `providers/router.ts` | 1 |
| OpenAICompatible | `providers/openai.ts` | 1 |
| ToolRegistry | `tools/registry.ts` | 1 |
| ToolDispatcher | `tools/dispatcher.ts` | 1 |
| MemoryManager | `memory/manager.ts` | 2–5 |
| MCP Bridge | `mcp/bridge.ts` | 4 |

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
