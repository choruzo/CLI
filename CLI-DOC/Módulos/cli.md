---
date: 2026-05-29
tags: [módulo, cli, ui, ink, stratum-cli]
status: implementado
hito: 1-2
---

# Módulo cli — Comandos y UI

Implementado en Hitos 1 y 2. Ver [[Arquitectura]] y [[Roadmap]].

---

## Archivos

```
src/cli/
├── index.ts                    Entry point Commander.js
├── commands/
│   ├── chat.ts                 REPL interactivo (Ink) con --resume
│   ├── run.ts                  One-shot plain-text
│   ├── init.ts                 Scan + síntesis LLM + STRATUM.md (§12.13)
│   ├── memory.ts               memory show (list/search/forget → Hito 5)
│   ├── sessions.ts             list / resume / delete / prune
│   └── config.ts               get / set de .stratumrc.json
└── ui/
    ├── App.tsx                 Root: reducer + slash commands + /init + /memory
    ├── Banner.tsx              Pantalla de bienvenida con typewriter
    ├── ConversationView.tsx    StatusBar + MessageList + InputArea
    ├── MessageList.tsx         <Static> + currentItem (scroll pattern)
    ├── StatusBar.tsx           ● provider │ model [gap] ctx ~N/Nk │ % (~ si estimado)
    ├── InputArea.tsx           ink-text-input con ❯❯ prompt
    ├── AgentMessage.tsx        Label "Stratum" + ToolCallBlock[] + StreamingText
    ├── UserMessage.tsx         Label "You" + texto
    ├── StreamingText.tsx       Texto + cursor █ parpadeante (500ms)
    ├── ToolCallBlock.tsx       running / completed / error states
    ├── useAgentStream.ts       Hook: itera agent.run(), dispatcha eventos (con estimated)
    ├── theme.ts                Paleta de colores (chalk hex)
    └── ascii-art.ts            Arte ASCII responsive para el banner
```

---

## Comando `stratum chat`

```
stratum chat [--provider <name>] [--resume <session-id>]
```

```typescript
loadConfig()
  → new ProviderRouter(config, opts.provider)
  → new ToolRegistry() → registerBuiltinTools(registry, config)
  → SessionStore.load(opts.resume)  // si --resume
  → new StratumAgent(config, router, registry, { initialMessages? })
  → render(<App agent={...} version={...} />)
  → await waitUntilExit()
  → SessionStore.save({ messages, toolCallCount, ... })  // guarda al salir
```

**Gestión de Ctrl+C:**
- Durante un run activo: cancela (`AbortController.abort()`)
- Durante init conflicto pendiente: se ignora (el input está redirigido al resolver)
- En idle: 1er Ctrl+C no hace nada, 2do Ctrl+C en < 1s → `exit()`

---

## Comando `stratum run`

Modo one-shot sin Ink. Separa stdout/stderr:

| Evento | Destino |
|--------|---------|
| `text_delta` | **stdout** (respuesta final) |
| `tool_call_start` | stderr: `[tool] name: ...` |
| `tool_result` | stderr: `[tool] name: result (Xs)` |
| `tool_error` | stderr: `[error] name: msg` |
| `warning` | stderr: `[error] [warning] msg` |
| `context_compressed` | stderr: `[ctx] Contexto comprimido: N → M tokens` |
| `error{fatal:true}` | stderr: `[fatal] msg` + `process.exit(1)` |
| SIGINT (código 130) | `process.exit(130)` |

Chalk se autodesactiva si stdout no es TTY.

---

## Comando `stratum init`

```
stratum init [--force] [--dry-run]
```

Conduce `InitAgent` con salida plain-text (sin Ink):

```
  Stratum — Inicializando proyecto

  ✓ .stratumrc.json creado
  ⟳ Escaneando proyecto... (12 archivos)
  ⟳ Generando secciones... (Comandos Clave listo)

  ✓ STRATUM.md creado en /ruta/al/proyecto/STRATUM.md

  Tip: edita STRATUM.md para añadir convenciones...
```

Si STRATUM.md ya existe y hay secciones manuales, readline pregunta por sección:

```
  ⚠  La sección "## Convenciones" tiene contenido escrito a mano.
     ¿Actualizar con la información del scan? (s/N)
```

---

## Comando `stratum memory show`

Lee el STRATUM.md activo (proyecto + global) y lo imprime con rutas. Si no hay ninguno, sugiere `stratum init`.

---

## Comandos `stratum sessions`

| Subcomando | Descripción |
|-----------|-------------|
| `list [--last N]` | Lista sesiones con fecha, provider/model y resumen |
| `resume <id>` | Equivalente a `stratum chat --resume <id>` |
| `delete <id>` | Elimina la sesión |
| `prune [--older 30d]` | Limpia sesiones antiguas |

Ver [[Módulos/sessions]] para la especificación completa.

---

## App.tsx — Estado global

```typescript
interface AppState {
  phase: 'banner' | 'conversation'
  completedItems: ConvItem[]
  currentItem: ConvItem | null
  inputValue: string
  thinking: boolean                    // true durante run del agente o init
  contextUsed: number
  contextMax: number
  contextEstimated: boolean            // true → mostrar ~ en StatusBar
  mergeConflictSection: string | null  // sección esperando s/N del usuario
}

type AppAction =
  | AGENT_START | AGENT_EVENT | CONTEXT_UPDATE | INPUT_CHANGE
  | SYSTEM_MESSAGE        // item de sistema sin round LLM (/memory show)
  | INIT_START | INIT_PROGRESS | INIT_CONFLICT | INIT_CONFLICT_DONE | INIT_DONE
```

### Slash commands en el input

| Comando | Comportamiento |
|---------|---------------|
| `/quit`, `/exit` | Cierra la app |
| `/memory show` | Muestra STRATUM.md activo sin round LLM (SYSTEM_MESSAGE) |
| `/init` | Lanza `InitAgent`, muestra progreso en conversación; manejo interactivo de conflictos de merge |

Durante `/init`:
- `thinking: true` → input deshabilitado
- Al llegar `merge_conflict` → `thinking: false`, `mergeConflictSection = nombre`
- El usuario escribe `s` o `N` → se resuelve la Promise del `resolveConflict` callback
- `merge_conflict_resolved` → `thinking: true` de nuevo, `mergeConflictSection = null`
- Al terminar → `agent.reloadMemory()` para que el STRATUM.md entre en el siguiente turno

---

## StatusBar.tsx

```
● provider │ model                    ctx ~2.1k / 32k │ 6%
                                          ↑
                                          ~ solo cuando estimated=true
```

**`~` prefijo:** se muestra mientras no hay dato real de `usage.prompt_tokens` del provider (primera iteración o provider que no reporta usage). Desaparece tras el primer LLM call que devuelva tokens reales.

**Colores del % de contexto:**
- < 60% → verde (`#22C55E`)
- 60–85% → ámbar (`#F59E0B`)
- > 85% → rojo (`#EF4444`)

---

## useAgentStream.ts

```typescript
function useAgentStream(agent: StratumAgent, dispatch: Dispatch<AppAction>) {
  // itera agent.run(input, { signal })
  // dispatcha AGENT_START, AGENT_EVENT por cada evento
  // tras cada iteración: getContextUsage() → CONTEXT_UPDATE { used, max, estimated }
  return { send, cancel }
}
```

`cancel()` llama `AbortController.abort()`, que propaga la señal al provider y al `ReactLoop`.

---

## Tests

`src/cli/ui/useAgentStream.test.ts`:
- `CONTEXT_UPDATE` incluye `estimated: true/false`
- `done(cancelled)` se dispatcha tras `cancel()`

`src/cli/commands/run.test.ts` (2 tests):
- Espera `done(cancelled)` antes de salir con código 130 tras SIGINT
