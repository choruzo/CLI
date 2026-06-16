---
date: 2026-06-16
tags: [diario, hito-4, hito-4.1, mcp, stratum-cli]
hito: 4
commit: 33ade07
---

# Diario — Hito 4: MCP Client (+ Hito 4.1)

## Resumen

Stratum ya habla MCP: cualquier server del ecosistema Model Context Protocol se conecta y sus tools quedan disponibles para el agente con naming OpenAI-compatible. El Hito 4.1 añadió carpeta gestionada y arranque no bloqueante.

---

## Hito 4 — MCP Client (cerrado 2026-06-15)

- `McpServerClient` (`mcp/client.ts`) — conexión stdio a un server
- `buildMcpTool` (`mcp/bridge.ts`) — convierte cada MCP tool en `ToolDefinition` con `rawParameters` (JSON Schema nativo, en lugar de Zod)
- Auto-registro con nombre **`mcp__<server>__<tool>`**
- `McpManager` (`mcp/manager.ts`) — orquesta arranque, **heartbeat 30 s** y **backoff 2→4→8 s**
- `stratum mcp list`; `/tools` en chat; indicador de conectividad MCP en StatusBar

---

## Hito 4.1 — Carpeta gestionada + arranque no bloqueante (cerrado 2026-06-16)

### Carpeta gestionada (§12.8.1)

Un server puede declarar `package` (npm) en vez de `command`/`args`. Se instala **una sola vez** en `~/.stratum/mcp/<server>/` (auto-creada) y se lanza con `node <entry>` directo. Esto evita el coste de arrancar `npx` en cada inicio. Implementado en `installer.ts`; comando `stratum mcp install [server]`.

### Arranque configurable

`mcp.startup`:
- `'lazy'` (default) — conexión en background en `chat` (`startBackground`), no bloquea la UI
- `'eager'` — espera a `connectAll`

`startupTimeout` por server (15 s) aborta servers que cuelgan.

---

## Decisión técnica

**`rawParameters` en vez de Zod para tools MCP.** Las tools nativas ya exponen su JSON Schema; forzarlas por Zod implicaría una conversión bidireccional con pérdida. `ToolDefinition` admite `rawParameters` y `toToolSchemas()` lo pasa directo al LLM.

---

## Próximo paso

**Hito 5 — Memory Layers 2 y 3:** `DecisionStore`, embeddings ONNX, `sqlite-vec` y recuperación semántica.
