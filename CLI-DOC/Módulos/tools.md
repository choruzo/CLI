---
date: 2026-06-16
tags: [módulo, tools, registry, mcp, stratum-cli]
status: implementado
hito: 1-5
---

# Módulo tools — Registro y Dispatch

Implementado en Hitos 1, 2.5, 3, 4, 4.1 y 5. Ver [[Arquitectura]] y [[Módulos/agent]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/tools/registry.ts` | `ToolRegistry` + `ToolDispatcher` |
| `src/tools/index.ts` | `registerBuiltinTools(registry, config)` |
| `src/tools/truncate.ts` | Truncado de tool outputs (~30k, cabeza 80% + cola 20%) |
| `src/tools/fs/read.ts` | `read_file` (líneas numeradas, paginación) |
| `src/tools/fs/write.ts` | `write_file` |
| `src/tools/fs/edit.ts` | `edit_file` (reemplazo exacto + unified diff) |
| `src/tools/fs/diff.ts` | Generador de unified diff (LCS propio, sin deps) |
| `src/tools/fs/glob.ts` | `glob` |
| `src/tools/fs/list.ts` | `list_directory` |
| `src/tools/fs/grep.ts` | `grep` |
| `src/tools/shell/bash.ts` | `bash` (guard destructivo, serialized) |
| `src/tools/web/search.ts` | `web_search` (metabúsqueda DDG + Tavily, RRF) |
| `src/tools/web/fetch.ts` | `web_fetch` (descarga + HTML→markdown) |
| `src/tools/web/html-to-text.ts` | Conversor HTML→markdown propio |
| `src/tools/memory/store-decision.ts` | `store_decision` (serialized) |
| `src/tools/memory/recall-decisions.ts` | `recall_decisions` |
| `src/tools/mcp/client.ts` | `McpServerClient` — conexión stdio |
| `src/tools/mcp/bridge.ts` | `buildMcpTool` — MCP tool → `ToolDefinition` |
| `src/tools/mcp/manager.ts` | `McpManager` — arranque, heartbeat, backoff |
| `src/tools/mcp/installer.ts` | Carpeta gestionada `~/.stratum/mcp/` |

---

## ToolDefinition

```typescript
interface ToolDefinition {
  name: string
  description: string
  schema?: ZodSchema                   // validación de parámetros
  rawParameters?: object               // JSON Schema nativo (tools MCP)
  destructive?: boolean                // pide confirmación al usuario
  isDestructive?(params, ctx): boolean // predicado dinámico por llamada (bash)
  serialized?: boolean                 // nunca se ejecuta en paralelo (bash, store_decision)
  timeout?: number                     // ms antes de abortar
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>
}

type ToolResult =
  | { ok: true;  output: string }
  | { ok: false; error: string; recoverable: boolean }
```

---

## ToolRegistry

```typescript
class ToolRegistry {
  register(tool: ToolDefinition): void
  get(name: string): ToolDefinition | undefined
  list(): ToolDefinition[]
  toToolSchemas(): ToolSchema[]   // Zod (o rawParameters) → JSON Schema para el LLM
}
```

`toToolSchemas()` produce el formato `{ type: 'function', function: { name, description, parameters } }` que espera la API OpenAI. Las tools MCP aportan su JSON Schema nativo vía `rawParameters` en lugar de Zod.

---

## ToolDispatcher (§12.9)

```typescript
class ToolDispatcher {
  async dispatch(calls: ToolCallReady[], ctx: ToolContext): Promise<DispatchResult[]>
}
```

### Fases

1. **Confirmación destructiva** (antes de ejecutar, secuencial, nunca dos prompts a la vez):
   - Una tool es destructiva si `destructive: true` o si `isDestructive?(params, ctx)` devuelve `true`
   - Política inyectada por `RunOptions.destructivePolicy` (`ask`/`allow`/`deny`) + callback `onConfirmDestructive`
   - Decisiones: `approve` / `deny` / `allow-all` (`!` suprime confirmaciones el resto de la sesión)
   - El chat lo resuelve con `<DestructiveConfirm>`, `stratum run` con readline, CI sin TTY → deny
2. **Ejecución**:
   - 1 call → directo
   - N calls con alguna `serialized: true` → todas **secuenciales** en orden de emisión
   - N calls sin serialized → `Promise.allSettled` en **paralelo**
   - Timeout via `AbortSignal` combinado (cancelación de usuario + timeout, `AbortSignal.any`)
3. **Truncado**: toda salida pasa por `truncate.ts` (~30k chars, cabeza 80% + cola 20%)

Errores: tool no encontrada o `schema.parse` fallido → `{ ok:false, recoverable:true }`. Se inyectan como XML `<tool_error>` (inject & recover, §12.3).

---

## Tools built-in — filesystem

### read_file
`path`, `offset?`, `limit?`. Devuelve líneas numeradas `N: contenido`, tope 2000 líneas, paginación via `offset`.

### write_file
`path`, `content`. Crea/sobrescribe; crea directorios padre recursivamente.

### edit_file
`path`, `old_string`, `new_string`, `replace_all?`. Reemplazo exacto de única ocurrencia (o todas con `replace_all`). Devuelve un **unified diff** generado por `fs/diff.ts` (algoritmo LCS propio, sin dependencias).

### glob
Búsqueda por patrón glob de archivos.

### list_directory
Listado de un directorio.

### grep
Búsqueda de contenido por patrón.

---

## Tool built-in — shell

### bash
`command`, `timeout?`. Ejecuta con `execa` (`shell: true`), captura stdout + stderr combinados.

- `serialized: true` — nunca en paralelo con otras tools
- `isDestructive?()` — detecta patrones de `tools.destructivePatterns` con **límites de palabra**; si coincide, dispara confirmación
- Timeout por defecto: `config.tools.bashTimeout` (30 s)

---

## Tools built-in — web

### web_search
Metabúsqueda: DuckDuckGo (scraping HTML, sin key) + Tavily (si hay `tools.webSearch.tavilyApiKey` o `TAVILY_API_KEY`). Merge + dedupe por URL normalizada + re-rank **RRF**, top 10 al agente. Backend forzable con `tools.webSearch.backend` (`meta`/`duckduckgo`/`tavily`).

### web_fetch
Descarga la URL (`Accept: text/markdown` preferente, límite 5 MB) y extrae texto limpio con el conversor HTML→markdown propio (`html-to-text.ts`).

---

## Tools built-in — memoria (Hito 5)

### store_decision
`serialized: true`. Persiste una decisión estructurada vía `DecisionMemory` (dedup semántico al guardar). Ver [[Módulos/memory]].

### recall_decisions
Recupera decisiones relevantes por KNN semántico; emite el evento `memory_retrieved`.

---

## Tools MCP (Hitos 4 y 4.1)

Cada tool de un MCP server se registra automáticamente con nombre **`mcp__<server>__<tool>`** (naming OpenAI-compatible).

- `McpServerClient` (`client.ts`) — gestiona la conexión stdio a un server
- `buildMcpTool` (`bridge.ts`) — convierte cada MCP tool en `ToolDefinition` con `rawParameters` (JSON Schema nativo)
- `McpManager` (`manager.ts`) — orquesta arranque, **heartbeat 30 s** y **backoff 2→4→8 s**

### Carpeta gestionada (§12.8.1)

Un server puede declarar `package` (npm) en vez de `command`/`args`: se instala **una sola vez** en `~/.stratum/mcp/<server>/` (auto-creada) y se lanza con `node <entry>` directo, evitando el coste de `npx` en cada arranque (`installer.ts`).

### Arranque configurable (`mcp.startup`)

| Valor | Comportamiento |
|-------|---------------|
| `'lazy'` (default) | Conexión en background en `chat` (`startBackground`), no bloquea la UI |
| `'eager'` | Espera a `connectAll` antes de continuar |

`startupTimeout` por server (15 s) aborta servers que cuelgan. Comando `stratum mcp install [server]`.

---

## Tests

`src/tools/registry.test.ts` — register/get/list, toToolSchemas, dispatch unitario/paralelo/serializado, tool no encontrada, error Zod, fase destructiva.

`src/tools/fs.test.ts` — `read_file` (numeradas, offset/limit), `write_file`, `edit_file` (única ocurrencia, `replace_all`, diff), `glob`/`list`/`grep`.

`src/tools/bash.test.ts` — comando simple, fallido, captura stderr, guard destructivo, timeout (skip en Windows).

`src/tools/web` + `src/tools/mcp` + `src/tools/memory` — cubren metabúsqueda/RRF, HTML→markdown, bridge MCP y las tools de decisión.
