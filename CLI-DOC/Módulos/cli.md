---
date: 2026-05-28
tags: [módulo, cli, ui, ink, stratum-cli]
status: implementado
hito: 1
---

# Módulo cli — Comandos y UI

Implementado en Hito 1. Ver [[Arquitectura]] y [[Roadmap]].

---

## Archivos

```
src/cli/
├── index.ts                    Entry point Commander.js
├── commands/
│   ├── chat.ts                 REPL interactivo (Ink)
│   └── run.ts                  One-shot plain-text
└── ui/
    ├── App.tsx                 Root: reducer + phase routing
    ├── Banner.tsx              Pantalla de bienvenida con typewriter
    ├── ConversationView.tsx    StatusBar + MessageList + InputArea
    ├── MessageList.tsx         <Static> + currentItem (scroll pattern)
    ├── StatusBar.tsx           ● provider │ model [gap] ctx N/Nk │ %
    ├── InputArea.tsx           ink-text-input con ❯❯ prompt
    ├── AgentMessage.tsx        Label "Stratum" + ToolCallBlock[] + StreamingText
    ├── UserMessage.tsx         Label "You" + texto
    ├── StreamingText.tsx       Texto + cursor █ parpadeante (500ms)
    ├── ToolCallBlock.tsx       running / completed / error states
    ├── useAgentStream.ts       Hook: itera agent.run(), dispatcha eventos
    ├── theme.ts                Paleta de colores (chalk hex)
    └── ascii-art.ts            Arte ASCII responsive para el banner
```

---

## Comando `stratum chat`

```typescript
// chat.ts
loadConfig()
  → new ProviderRouter(config)
  → new ToolRegistry() → registerBuiltinTools(registry, config)
  → new StratumAgent(config, providerRouter, toolRegistry)
  → render(<App agent={...} version={...} />)
```

Gestión de SIGINT (Ctrl+C):
- **1er Ctrl+C durante un run:** cancela la llamada en curso (`AbortController.abort()`)
- **2do Ctrl+C en < 1s:** sale del proceso (`process.exit(0)`)
- Ctrl+C en idle: sale directamente

Flags:
- `--provider <name>` — override del provider activo
- `--resume <id>` — stub con aviso (persistencia de sesión es Hito posterior)

---

## Comando `stratum run`

Modo one-shot sin Ink. Separa stdout/stderr:

| Evento | Destino |
|--------|---------|
| `text_delta` | **stdout** (respuesta final) |
| `tool_call_ready` | stderr: `[tool] name: input...` |
| `tool_result` | stderr: `[tool] name: result (Xs)` |
| `tool_error` / `error{fatal:false}` | stderr: `[error] name: msg` |
| `error{fatal:true}` | stderr: `[fatal] msg` + `process.exit(1)` |

Chalk se autodesactiva si stdout no es TTY (útil para pipes y redirects).

---

## App.tsx — Estado global

```typescript
type Phase = 'banner' | 'conversation'

type ConvItem =
  | { kind: 'user';  text: string }
  | { kind: 'agent'; text: string; toolCalls: ToolCallState[]; streaming: boolean }

type AppState = {
  phase: Phase
  completedItems: ConvItem[]
  currentItem: ConvItem | null
  inputValue: string
  contextUsage: { used: number; max: number; pct: number }
}
```

Acciones: `AGENT_START`, `AGENT_EVENT`, `CONTEXT_UPDATE`, `INPUT_CHANGE`.

`useReducer` maneja todas las transiciones. `useRef` para los contadores de Ctrl+C (evita stale closure en el handler).

---

## Banner.tsx

Pantalla inicial hasta que el usuario envía el primer mensaje.

- **Typewriter:** `indexRef = useRef(0)`, `setInterval(16ms)`, avanza 4 chars/tick. El arte ASCII completo tarda ~400ms en aparecer.
- **Color stepping:** fases `typing → appearing → ready`. Tres pasos de 50ms cada uno: `#374151 → #4B5563 → #6B7280`.
- **Arte responsive** (via `getAsciiArt(columns)` de `ascii-art.ts`):
  - ≥ 72 cols → arte ASCII completo "STRATUM"
  - 60–71 cols → arte reducido
  - < 60 cols → solo "Stratum CLI v0.1.0"
- Sin sección MCP startup (Hito 4).

---

## MessageList.tsx — Scroll pattern de Ink

```tsx
<Box flexDirection="column">
  <Static items={completedItems}>
    {(item, i) => <ConvItemView key={i} item={item} />}
  </Static>
  {currentItem && <ConvItemView item={currentItem} />}
</Box>
```

`<Static>` renderiza los ítems completados una sola vez en el buffer de scroll del terminal. El `currentItem` (agente respondiendo) se re-renderiza con cada delta.

---

## StatusBar.tsx

```
● provider │ model                    ctx 2.1k / 32k │ 6%
```

Colores del % de contexto:
- < 60% → verde (`#22C55E`)
- 60–85% → ámbar (`#F59E0B`)
- > 85% → rojo (`#EF4444`)

El indicador `●` es verde estático en Hito 1. El health-check dinámico es Hito 6.

---

## ToolCallBlock.tsx

| Estado | Rendering |
|--------|-----------|
| `running` | `◌◎●◉○` spinner 150ms + timer `0.1s, 0.2s, ...` |
| `completed` | `✓ name │ Xs │ input resumido` |
| `error` | `✗ name │ mensaje de error` |

La expansión con foco y bordes detallados (§5.1 de la spec UI) está diferida al Hito 3.

---

## useAgentStream.ts

```typescript
function useAgentStream(agent: StratumAgent, dispatch: Dispatch<AppAction>) {
  const abortRef = useRef<AbortController | null>(null)
  async function send(input: string): Promise<void> {
    // crea AbortController, itera agent.run(input, { signal }),
    // dispatcha AGENT_START, AGENT_EVENT (por cada AgentEvent), CONTEXT_UPDATE al done
  }
  return { send, abort: () => abortRef.current?.abort() }
}
```
