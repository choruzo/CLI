---
date: 2026-06-11
tags: [diario, hito-3, hito-3.5, tools, providers, stratum-cli]
hito: 3
---

# Diario — Hito 3: Tools completos Day 1 (+ Hito 2.5 e Hito 3.5)

## Resumen

Tres bloques cerrados el mismo día: el rediseño de init estilo opencode (Hito 2.5), el toolset completo del día 1 (Hito 3) y la UX de providers/modelos (Hito 3.5). El agente ya puede realizar tareas de código completas de principio a fin.

---

## Hito 2.5 — Init estilo opencode

El `InitAgent` especializado se eliminó. Init pasó a ser un **comando-plantilla**: `INITIALIZE_PROMPT` (`agent/initialize-prompt.ts`) se inyecta como mensaje de usuario del agente general, que usa sus tools normales (`glob`, `list_directory`, `grep`, `read_file`, `write_file`) para escanear el proyecto y escribir `STRATUM.md`.

- Placeholders sustituidos siempre con `replaceAll` (`${path}` aparece varias veces)
- System prompt con bloque `<env>` dinámico (cwd, worktree, git, plataforma, fecha, model id)
- `read_file` con líneas numeradas (`N: contenido`, tope 2000, paginación por `offset`)
- Truncado de tool outputs (~30k, cabeza 80% + cola 20%, `tools/truncate.ts`)
- Compresión conservadora (`compressionMode: 'conservative'`, umbral ≥0.92) y auto-retry de escritura

---

## Hito 3 — Tools Day 1

### Filesystem

- `edit_file` — reemplazo exacto `old_string → new_string` (única ocurrencia o `replace_all`), devuelve **unified diff** generado por `fs/diff.ts` (algoritmo LCS propio, sin dependencias)
- `glob`, `list_directory`, `grep`

### Web

- `web_search` — metabúsqueda: DuckDuckGo (scraping HTML, sin key) + Tavily (opcional). Merge + dedupe por URL + re-rank **RRF**, top 10
- `web_fetch` — descarga (límite 5 MB) + conversor HTML→markdown propio (`html-to-text.ts`)

### Seguridad y control

- Guard destructivo en `bash` vía `isDestructive?()` con `tools.destructivePatterns` y límites de palabra
- Confirmación interactiva: chat con `<DestructiveConfirm>`, `stratum run` con readline, CI sin TTY → deny
- Timeout/cancelación con `AbortSignal` combinado (`AbortSignal.any`)

### UI

- `ToolCallBlock` con 4 estados (pending/running/completed/error), foco Tab, expansión Space
- `<MarkdownText>` dual-mode: `marked` + `cli-highlight`

---

## Hito 3.5 — Provider & Model UX

- Wizard `stratum provider add` (`ProviderWizard.tsx` + `wizard-logic.ts`)
- `provider list/use/remove`
- `/model` — cambio de modelo en caliente; `/config_provider` — selección de provider activo

---

## Próximo paso

**Hito 4 — MCP Client:** conexión a MCP servers, auto-registro de tools `mcp__server__tool`, `McpManager` con heartbeat y backoff.
