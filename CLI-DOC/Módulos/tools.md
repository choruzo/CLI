---
date: 2026-08-27
tags: [módulo, tools, registry, mcp, ssh, stratum-cli]
status: implementado
hito: 1-9
---

# Módulo tools — Registro y Dispatch

Implementado en Hitos 1, 2.5, 3, 4, 4.1, 5, 7, 8 y 9. Ver [[Arquitectura]] y [[Módulos/agent]].

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
| `src/tools/exec/exec.ts` | `exec` — tool única de ejecución (Hito 16), descripción generada con los targets |
| `src/tools/exec/target.ts` | `ExecutionTarget`: `parseTarget` / `resolveTarget` / `formatTarget` |
| `src/tools/exec/backend.ts` · `router.ts` | `IExecBackend`, estados, errores y router por kind |
| `src/tools/exec/backends/local.ts` | Backend `local` (execa `buffer:false`, `ByteBudget`, pwsh con exit code real) |
| `src/tools/exec/backends/ssh.ts` | Backend `ssh:<alias>` (antes `ssh_exec`) |
| `src/tools/exec/audit.ts` · `runtime.ts` | `exec-audit.jsonl` universal + `closeExecRuntime()` |
| `src/security/secrets.ts` · `redact-output.ts` | Núcleo de redacción de secretos y `[redacted: motivo]` |
| `src/tools/web/search.ts` | `web_search` (metabúsqueda DDG + Tavily, RRF) |
| `src/tools/web/fetch.ts` | `web_fetch` (descarga + HTML→markdown) |
| `src/tools/web/html-to-text.ts` | Conversor HTML→markdown propio |
| `src/tools/memory/store-decision.ts` | `store_decision` (serialized) |
| `src/tools/memory/recall-decisions.ts` | `recall_decisions` |
| `src/tools/mcp/client.ts` | `McpServerClient` — conexión stdio |
| `src/tools/mcp/bridge.ts` | `buildMcpTool` — MCP tool → `ToolDefinition` |
| `src/tools/mcp/manager.ts` | `McpManager` — arranque, heartbeat, backoff |
| `src/tools/mcp/installer.ts` | Carpeta gestionada `~/.stratum/mcp/` |
| `src/tools/plan/present-plan.ts` | `present_plan` — tool de control, interceptada por el loop |
| `src/tools/plan/update-plan.ts` | `update_plan` — tool de control, interceptada por el loop |
| `src/tools/agent/delegate.ts` | `delegate_task` — tool de control, interceptada por el loop |
| `src/tools/ssh/pool.ts` | `SSHConnectionPool` — conexiones persistentes, jump hosts, reconexión |
| `src/tools/ssh/known-hosts.ts` | Verificación de host key (TOFU / strict / insecure) |
| `src/tools/ssh/inventory.ts` | Alias → `ConnectConfig`, resolución de secretos, socket del agente |
| `src/tools/ssh/sftp.ts` | `ssh_upload` / `ssh_download` |
| `src/tools/ssh/runtime.ts` | Singleton del pool + `closeSshPool()` (lo llama `closeExecRuntime()`) |
| `src/tools/ssh/test-server.ts` | `ssh2.Server` en proceso para los tests |

---

## ToolDefinition

```typescript
interface ToolDefinition {
  name: string
  description: string
  schema?: ZodSchema                   // validación de parámetros
  rawParameters?: object               // JSON Schema nativo (tools MCP)
  destructive?: boolean                // pide confirmación al usuario
  isDestructive?(params, ctx): boolean // predicado dinámico por llamada (exec)
  serialized?: boolean                 // nunca se ejecuta en paralelo (store_decision)
  isSerialized?(params, ctx): boolean  // serialización por llamada (exec: local sí, ssh no) — Hito 16
  structuredCancellation?: boolean     // la tool resuelve su propio `cancelled` — Hito 16
  timeout?: number                     // ms antes de abortar
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>
}

type ToolResult =
  | { ok: true;  output: string }
  | { ok: false; error: string; recoverable: boolean;
      countsAsFailure?: boolean  // false: se ejecutó y falló (no consume reintento) — Hito 16
      executed?: boolean }       // la operación llegó a ejecutarse — Hito 16
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

## Tool built-in — ejecución (Hito 16)

### exec
`target?` (`local` por defecto o `ssh:<alias>`), `command`, `cwd?`, `pty?`, `stdin?`, `timeout?`, `maxBytes?`. Sustituye a `bash` y a `ssh_exec` sin alias (§12.17).

| | `local` | `ssh:<alias>` |
|---|---|---|
| PTY | no (rechazo recuperable) | sí |
| Pasado `maxBytes` | descarta y deja terminar (default `tools.execMaxBytes`, 1 MiB) | mata el proceso remoto (default `host.maxBytes`, 256 KB) |
| Timeout default | `tools.bashTimeout` (30 s) | `host.commandTimeout` (30 s) |
| Serialización | sí | no |
| Directorio en el resultado | efectivo (`cwd`) | solicitado (`requestedCwd`) |

- `preflight` — target → capacidades (`pty+stdin` también se rechaza) → `commandVeto` de `guards.ts`, en ese orden
- `isDestructive?()` — `confirmAll` del host, capa 2 en `confirm`, rutas sensibles `confirm` y `tools.destructivePatterns` con **límites de palabra**
- Resultado `<exec_result target status exitCode duration cwd|requestedCwd maxBytes>`. Exit 0 → `ok:true`; cualquier otro estado → `tool_error` recuperable con `countsAsFailure:false` y `executed:true`
- Cancelación estructurada: Ctrl+C mata el proceso y devuelve `status="cancelled"`
- En Windows usa `pwsh.exe -NoProfile -NonInteractive` con propagación de `$LASTEXITCODE`

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

## Tools built-in — SSH (Hito 9, §12.14)

Cliente SSH propio sobre `ssh2`: **el binario `ssh` del sistema nunca se invoca**. Todo el
protocolo corre dentro del proceso Node, lo que da portabilidad Windows/Linux/macOS y control
total del ciclo de vida de las conexiones.

> **Registro condicional.** `registerSshTools` no registra nada si `.stratumrc.json` no trae
> sección `ssh` con al menos un host. Sin inventario, el modelo ni siquiera ve estas tools.

### ssh_exec (retirado en el Hito 16)
Hoy es `exec` con `target: "ssh:<alias>"`; lo de abajo describe el backend `tools/exec/backends/ssh.ts`.

- `serialized: false` — dos hosts distintos no se estorban; dos calls al mismo alias comparten socket
- `isDestructive?()` — confirma si el host lleva `confirmAll`, o si el comando encaja con
  `tools.destructivePatterns` (`commandIsDestructive`, hoy en `guards.ts`)
- Corta la salida en `maxBytes` (256 KB) y el comando en `commandTimeout` (30 s), en ambos casos
  con `stream.signal('KILL')` al proceso remoto — así un `tail -f` o un `journalctl` no revientan
  el contexto del modelo
- Devuelve XML `<exec_result target="ssh:…" status=… exitCode=… duration=… requestedCwd=… maxBytes=…>`
- Con `pty: true`, filtra las secuencias de escape ANSI antes de devolver el resultado

### ssh_upload / ssh_download
`host` + rutas local y remota. `fastPut` / `fastGet` sobre SFTP. `ssh_download` crea el directorio
local de destino; `ssh_upload` valida el fichero local antes de abrir la sesión SFTP.

---

## SSHConnectionPool

| Aspecto | Comportamiento |
|---------|---------------|
| Apertura | **Lazy** — nada se conecta al arrancar Stratum, solo al primer uso |
| Concurrencia | `inflight: Map<alias, Promise<Client>>` es el mutex de establecimiento: dos calls paralelas al mismo alias comparten una promesa, no abren dos sockets |
| Jump hosts | `forwardOut` sobre la conexión al bastión; profundidad máxima 2, validada en el schema |
| Reconexión | Solo para conexiones **ya establecidas** que se caen: 2s → 4s → 8s. El **primer** fallo de apertura rechaza de inmediato, sin backoff |
| Teardown | `closeAll()` cierra las hojas **antes** que los bastiones — el orden inverso al de apertura es el único seguro |

El `hostVerifier` se monta en el pool, nunca en `inventory.ts`, para que ninguna ruta de conexión
pueda saltarse la verificación. `ssh2` emite `error` de forma asíncrona incluso después de que la
promesa se resuelva, así que el listener es **permanente**: sin él, un error tardío sin manejador
tumba el proceso entero.

---

## Verificación de host key

| Política | Comportamiento |
|----------|---------------|
| `tofu` (default) | Primera conexión: muestra el fingerprint y pregunta. Después verifica en silencio contra `~/.stratum/known_hosts.json` |
| `strict` | Compara contra el `hostKeyHash` pinneado en la config. Requerido por el schema |
| `insecure` | Sin verificación; emite warning al conectar. Solo para lab |

Un **mismatch aborta siempre**, con `recoverable: false` y sin override interactivo — el mensaje
apunta a `stratum ssh trust <alias> --force`. El gate TOFU reutiliza
`ToolContext.confirmDestructive`, así que hereda gratis el comportamiento correcto en cada contexto:
`<DestructiveConfirm>` en el chat, readline en `stratum run`, y deny automático sin TTY.
`allow-all` (`!`) aprueba **ese** host, nunca los siguientes.

---

## Secretos y autenticación

| Método | Campo |
|--------|-------|
| Clave privada | `privateKey` (+ `passphrase`) |
| ssh-agent del sistema | `useAgent: true` — `SSH_AUTH_SOCK` en POSIX, named pipe de OpenSSH o Pageant en Windows |
| Password | `password` |

`passphrase` y `password` se resuelven con `env:<VAR>`, valor literal, o el fallback
`STRATUM_SSH_<ALIAS>_SECRET`. **`keychain:` no está implementado** (desviación consciente de §12.14:
`keytar` es una dependencia nativa sin mantenimiento activo); un `keychain:` en la config devuelve un
error que explica la alternativa en vez de fallar en silencio.

---

## Auditoría

Hito 16: un registro JSON por **cada intento real de ejecución, local o remoto**, en
`~/.stratum/logs/exec-audit.jsonl` (o la ruta de `tools.auditLog`; `ssh.auditLog` es alias obsoleto que
el loader migra por capa), con rotación por tamaño a 10 MB. El comando se guarda redactado y `stdin` nunca:

```json
{"timestamp":"…","sessionId":"sess_…","target":"ssh:lab","host":"lab","command":"systemctl restart nginx","requestedCwd":"/etc","status":"exited","exitCode":0,"durationMs":342,"truncated":false}
```

`status` ∈ `exited | truncated | timeout | cancelled | spawn_error | connect_error`. Los vetos y las
denegaciones no llegan a ejecutarse y no se auditan aquí (los registra el logger del dispatcher).

El `sessionId` viaja por `RunOptions` → `ToolContext`: `chat` lo genera al arrancar (no al guardar),
`run` usa uno efímero por invocación, y los subagentes heredan el del padre.

---

## Tests

`src/tools/registry.test.ts` — register/get/list, toToolSchemas, dispatch unitario/paralelo/serializado, tool no encontrada, error Zod, fase destructiva.

`src/tools/fs.test.ts` — `read_file` (numeradas, offset/limit), `write_file`, `edit_file` (única ocurrencia, `replace_all`, diff), `glob`/`list`/`grep`.

`src/tools/exec/*.test.ts` (Hito 16) — target, backend local (exit codes, stdin/EOF, `cwd`, `maxBytes` que drena, timeout, cancelación, entorno git), tool `exec` (descripción, preflight, serialización), backend SSH contra el servidor en proceso (PTY, EOF, kill por `maxBytes`, host key) y auditoría.

`src/tools/web` + `src/tools/mcp` + `src/tools/memory` — cubren metabúsqueda/RRF, HTML→markdown, bridge MCP y las tools de decisión.

`src/tools/ssh/*.test.ts` (77 tests) — corren contra un **`ssh2.Server` real en proceso**
(`test-server.ts`), no contra mocks del protocolo: exec con exit codes y stdin, truncado por
`maxBytes` matando el proceso remoto, timeout de comandos que no terminan, roundtrip SFTP,
TOFU/strict/insecure y mismatch, reutilización de socket entre calls concurrentes, reconexión con
backoff, orden de cierre hojas→bastiones y jump hosts a través de un túnel `forwardOut` de verdad.
