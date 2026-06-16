---
date: 2026-06-16
tags: [módulo, cli, ui, ink, stratum-cli]
status: implementado
hito: 1-5
---

# Módulo cli — Comandos y UI

Implementado en Hitos 1–5. Ver [[Arquitectura]] y [[Roadmap]].

---

## Archivos

```
src/cli/
├── index.ts                    Entry point Commander.js
├── commands/
│   ├── chat.ts                 REPL interactivo (Ink) con --resume
│   ├── run.ts                  One-shot plain-text
│   ├── init.ts                 Init estilo opencode (INITIALIZE_PROMPT, §12.13)
│   ├── memory.ts               list / search / forget / show
│   ├── sessions.ts             list / resume / delete / prune
│   ├── config.ts               get / set de .stratumrc.json
│   ├── provider.tsx            add / list / use / remove (wizard)
│   └── mcp.ts                  list / install
└── ui/
    ├── App.tsx                 Root: reducer + slash commands + /init + /memory
    ├── Banner.tsx              Bienvenida con typewriter
    ├── ConversationView.tsx    StatusBar + MessageList + InputArea
    ├── MessageList.tsx         <Static> + currentItem (scroll pattern)
    ├── StatusBar.tsx           ● provider │ model │ MCP │ ctx ~N/Nk │ %
    ├── InputArea.tsx           ink-text-input + CommandPalette al escribir /
    ├── CommandPalette.tsx      Panel de /comandos (filtrado + scroll)
    ├── AgentMessage.tsx        Label "Stratum" + ToolCallBlock[] + StreamingText
    ├── UserMessage.tsx         Label "You" + texto
    ├── StreamingText.tsx       Texto + cursor █ parpadeante
    ├── ToolCallBlock.tsx       4 estados + foco Tab + expansión Space
    ├── DestructiveConfirm.tsx  Confirmación approve/deny/allow-all de tools destructivas
    ├── MarkdownText.tsx        Render dual-mode (marked + cli-highlight)
    ├── ProviderWizard.tsx      Wizard de alta de provider
    ├── useAgentStream.ts       Hook: itera agent.run(), dispatcha eventos
    ├── session-commands.ts     Definición + autocompletado de slash commands
    ├── theme.ts                Paleta de colores
    └── ascii-art.ts            Arte ASCII responsive del banner
```

---

## Comandos top-level

| Comando | Subcomandos / flags | Descripción |
|---------|---------------------|-------------|
| `chat` | `--provider <name>`, `--resume <id>` | REPL interactivo (Ink) |
| `run` | `--allow-destructive` / `--deny-destructive` | One-shot plain-text |
| `init` | `--force`, `--dry-run` | Genera/actualiza STRATUM.md (§12.13) |
| `memory` | `list`, `search <q>`, `forget <id>`, `show` | Gestión de memoria |
| `sessions` | `list`, `resume <id>`, `delete <id>`, `prune` | Historial de sesiones |
| `config` | `get <key>`, `set <key> <value>` | Lectura/escritura de `.stratumrc.json` |
| `provider` | `add`, `list`, `use <name>`, `remove <name>` | Gestión de providers (wizard en `add`) |
| `mcp` | `list`, `install [server]` | Gestión de MCP servers |

---

## Comando `stratum chat`

```
stratum chat [--provider <name>] [--resume <session-id>]
```

```typescript
loadConfig()
  → new ProviderRouter(config, opts.provider)
  → new ToolRegistry() → registerBuiltinTools(registry, config)
  → McpManager.startBackground()        // arranque lazy de MCP (Hito 4.1)
  → SessionStore.load(opts.resume)      // si --resume
  → new StratumAgent(config, router, registry, { initialMessages? })
  → render(<App agent={...} version={...} />)
  → await waitUntilExit()
  → SessionStore.save({ messages, toolCallCount, ... })
```

**Gestión de Ctrl+C:** durante un run → cancela (`AbortController.abort()`); durante conflicto de init pendiente → ignorado; en idle → 2do Ctrl+C en < 1s sale.

---

## Comando `stratum run`

Modo one-shot sin Ink. Separa stdout/stderr:

| Evento | Destino |
|--------|---------|
| `text_delta` | **stdout** (respuesta final) |
| `tool_call_start` / `tool_result` / `tool_error` | stderr |
| `warning` | stderr `[warning]` |
| `context_compressed` | stderr `[ctx] N → M tokens` |
| `memory_retrieved` | stderr `[memory] N decisiones` |
| `error{fatal:true}` | stderr `[fatal]` + `process.exit(1)` |
| SIGINT | `process.exit(130)` |

Política destructiva via `--allow-destructive` / `--deny-destructive`; confirmación interactiva con readline; CI sin TTY → deny. Chalk se autodesactiva si stdout no es TTY.

---

## Comando `stratum init`

```
stratum init [--force] [--dry-run]
```

Init opera como **comando-plantilla** estilo opencode: el `INITIALIZE_PROMPT` (`agent/initialize-prompt.ts`) se inyecta como mensaje de usuario del agente general — no hay agente especializado. Compresión conservadora (`compressionMode: 'conservative'`) y auto-retry de escritura. Ver [[Módulos/memory]] y §12.13.

---

## Comandos `stratum memory`

| Subcomando | Descripción |
|-----------|-------------|
| `show` | STRATUM.md activo (proyecto + global) con rutas |
| `list` | Lista decisiones almacenadas (Capa 2) |
| `search <query>` | Búsqueda semántica KNN (Capa 3) |
| `forget <id>` | Elimina una decisión |

---

## Comandos `stratum sessions`

| Subcomando | Descripción |
|-----------|-------------|
| `list` | Lista sesiones con fecha, provider/model y resumen |
| `resume <id>` | Equivalente a `stratum chat --resume <id>` |
| `delete <id>` | Elimina la sesión |
| `prune` | Limpia sesiones antiguas |

Ver [[Módulos/sessions]] para la especificación completa.

---

## Comandos `stratum provider` (Hito 3.5)

| Subcomando | Descripción |
|-----------|-------------|
| `add` | Wizard interactivo de alta de provider (`ProviderWizard.tsx`) |
| `list` | Lista providers configurados |
| `use <name>` | Marca un provider como activo (`provider.default`) |
| `remove <name>` | Elimina un provider de la config |

---

## Comandos `stratum mcp` (Hitos 4 y 4.1)

| Subcomando | Descripción |
|-----------|-------------|
| `list` | Lista MCP servers y su estado de conexión |
| `install [server]` | Instala el `package` npm en la carpeta gestionada `~/.stratum/mcp/` |

---

## App.tsx — Estado global

```typescript
interface AppState {
  phase: 'banner' | 'conversation'
  completedItems: ConvItem[]
  currentItem: ConvItem | null
  inputValue: string
  thinking: boolean
  contextUsed: number
  contextMax: number
  contextEstimated: boolean
  mergeConflictSection: string | null  // sección esperando s/N
}
```

### Slash commands en el input (`session-commands.ts`)

| Comando | Comportamiento |
|---------|---------------|
| `/help` | Lista los comandos disponibles |
| `/init` | Lanza init en la conversación; manejo interactivo de conflictos de merge |
| `/memory show` | Muestra STRATUM.md activo sin round LLM |
| `/memory list` | Lista decisiones almacenadas |
| `/memory search <q>` | Búsqueda semántica de decisiones |
| `/memory forget <id>` | Elimina una decisión |
| `/model` | Cambia el modelo activo en caliente |
| `/config_provider` | Selecciona el provider activo |
| `/tools` | Lista las tools registradas (incluye `mcp__*`) |
| `/quit`, `/exit` | Cierra la app |

---

## StatusBar.tsx

```
● provider │ model │ ◇ MCP            ctx ~2.1k / 32k │ 6%
```

**`~` prefijo:** mientras no hay dato real de `usage.prompt_tokens`. **Indicador MCP:** estado de conectividad de los servers (Hito 4). **Colores del % de contexto:** < 60% verde, 60–85% ámbar, > 85% rojo.

---

## useAgentStream.ts

```typescript
function useAgentStream(agent, dispatch) {
  // itera agent.run(input, { signal })
  // dispatcha AGENT_START, AGENT_EVENT por evento (incl. memory_retrieved)
  // tras cada iteración: getContextUsage() → CONTEXT_UPDATE { used, max, estimated }
  return { send, cancel }
}
```

`cancel()` llama `AbortController.abort()`, que propaga la señal al provider y al `ReactLoop`.

---

## Tests

`src/cli/ui/useAgentStream.test.ts` — `CONTEXT_UPDATE` con `estimated`, `done(cancelled)` tras `cancel()`.

`src/cli/ui/session-commands.test.ts` — definición y filtrado de slash commands.

`src/cli/ui/wizard-logic.test.ts` — lógica del wizard de provider.

`src/cli/commands/run.test.ts` — `done(cancelled)` antes de salir con código 130 tras SIGINT.
