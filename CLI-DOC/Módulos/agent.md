---
date: 2026-06-16
tags: [módulo, agente, react-loop, stratum-cli]
status: implementado
hito: 1-5
---

# Módulo agent — Core Agent Loop

Implementado en Hitos 1–5. Ver [[Arquitectura]] y [[Roadmap]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/agent/types.ts` | Tipos centrales: `AgentEvent`, `Message`, `ToolDefinition`, `ToolResult` |
| `src/agent/core.ts` | `StratumAgent` — estado de sesión, punto de entrada público |
| `src/agent/harness.ts` | `ReactLoop`, `ContextManager`, `streamWithRetry` |
| `src/agent/system-prompt.ts` | `buildSystemPrompt(config, memory?)` — default.txt + bloque `<env>` + memoria |
| `src/agent/initialize-prompt.ts` | `INITIALIZE_PROMPT` — comando-plantilla de init estilo opencode (§12.13) |

---

## AgentEvent (§12.1)

Unión discriminada exhaustiva. Todos los consumidores (UI Ink, `stratum run`) manejan eventos de este tipo.

```typescript
type AgentEvent =
  | { type: 'text_delta';          delta: string }
  | { type: 'tool_call_start';     id: string; name: string; input_so_far: string }
  | { type: 'tool_call_ready';     id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result';         id: string; name: string; result: string; durationMs: number }
  | { type: 'tool_error';          id: string; name: string; error: string; recoverable: boolean }
  | { type: 'memory_retrieved';    decisions: DecisionEntry[] }          // Hito 5
  | { type: 'thinking';            text: string }
  | { type: 'warning';             message: string }                     // Hito 2
  | { type: 'context_compressed';  tokensBefore: number; tokensAfter: number; roundsCompressed: number } // Hito 2
  | { type: 'error';               message: string; fatal: boolean }
  | { type: 'done';                stopReason: 'stop' | 'max_iterations' | 'cancelled' }
```

---

## StratumAgent (`core.ts`)

```typescript
class StratumAgent {
  constructor(config, providerRouter, toolRegistry, options?: { initialMessages?: Message[] })

  async *run(input: string, opts?: RunOptions): AsyncGenerator<AgentEvent>
  reloadMemory(): void                  // reconstruye el system prompt con STRATUM.md actualizado
  getContextUsage(): { used: number; max: number; pct: number; estimated: boolean }
  getMessages(): Message[]              // copia del historial (para SessionStore)
  getProvider(): IProvider              // acceso al provider activo
  getConfig(): StratumConfig            // acceso a la config (para /memory show en chat)

  get toolCallCount(): number
  get providerName(): string
  get model(): string
}
```

Mantiene `messages[]` (historial OpenAI format). El system prompt se construye con `buildSystemPrompt(config, memory?)` incluyendo el STRATUM.md del proyecto si existe. `initialMessages` permite reanudar sesiones persistidas.

---

## ReactLoop (`harness.ts`)

Algoritmo de iteración (hasta `agent.maxIterations`):

1. Si `signal.aborted` → `yield done('cancelled')`
2. `await contextManager.maybeCompress(messages)` — comprime si >80% (§12.4)
3. Llama a `streamWithRetry(provider, request)` — si falla tras 3 intentos → `yield error{fatal:true}` + `yield done('stop')`
4. Por cada chunk: registrar `usage.prompt_tokens` si presente; `StreamBuffer.feed()` → re-yield de eventos
5. Push del turno assistant al historial (formato OpenAI reconstruido)
6. Sin tool calls → `yield done('stop')`
7. Con tool calls → `dispatcher.dispatch(calls, ctx)` → inject resultados como `role:'tool'` → continuar loop
8. Tope alcanzado → `yield done('max_iterations')`

### Política inject & recover (§12.3)

Los errores de tool se inyectan en el historial como XML para que el LLM pueda reaccionar:

```xml
<tool_error>
  <tool>nombre_tool</tool>
  <error>mensaje de error</error>
  <suggestion>Review the error above and adjust...</suggestion>
</tool_error>
```

### streamWithRetry

```
intento 1 → espera 1s → intento 2 → espera 2s → intento 3 → espera 4s → intento 4 → error fatal
```

Priming: llama a `gen.next()` antes de hacer yield para detectar errores de conexión antes del streaming.

---

## ContextManager (`harness.ts`) — §12.4

```typescript
class ContextManager {
  // Estimación de tokens — cascada
  recordUsage(promptTokens: number): void   // guarda el dato real del provider
  usage(messages): { used; max; pct; estimated }
  //   estimated=false → valor real de usage.prompt_tokens
  //   estimated=true  → proxy chars/3.5 (se muestra con ~ en status bar)

  // Compresión
  async maybeCompress(messages: Message[]): Promise<CompressionResult>
}

type CompressionResult =
  | { kind: 'skipped' }
  | { kind: 'compressed'; tokensBefore; tokensAfter; roundsCompressed }
  | { kind: 'truncated';  tokensBefore; tokensAfter; roundsRemoved }
  | { kind: 'pressure' }   // zona protegida sola supera el umbral
```

### Algoritmo de compresión

```
1. usage().pct ≤ 80% → skipped

2. Identificar zona protegida:
   - messages[0] (system prompt)
   - últimas compressionKeepRounds rondas (user + assistant + sus tool results)

3. oldMessages = mensajes fuera de la zona protegida
   Si vacío → pressure

4. Intentar compresión LLM:
   - prompt: "Resume esta conversación en máximo 500 palabras..."
   - reemplazar oldMessages por [{ role:'assistant', content:'<summary>...</summary>' }]
   - si tras comprimir aún > 80% → Caso B

5. Caso A (LLM falla): no reintentar → Caso B directamente

6. Caso B (truncado duro):
   - Eliminar mensajes no protegidos en bloques de 2 rondas (más antiguos primero)
   - Si al agotar el historial antiguo sigue > 80% → emitir warning 'context_window_pressure'
```

**Zona protegida nunca se toca.**

---

## Init estilo opencode (`initialize-prompt.ts`) — §12.13

Desde el Hito 2.5 **no hay agente especializado de init**. El init es un **comando-plantilla**: el `INITIALIZE_PROMPT` se inyecta como mensaje de usuario del **agente general**, que usa sus tools normales (`glob`, `list_directory`, `grep`, `read_file`, `write_file`) para escanear el proyecto y escribir `STRATUM.md`.

- Los placeholders del prompt (`${path}` aparece varias veces) se sustituyen **siempre con `replaceAll`**
- El agente genera las 5 secciones fijas: `Proyecto`, `Stack Tecnológico`, `Estructura`, `Convenciones`, `Comandos Clave`; preserva las secciones extra del usuario
- Compresión conservadora durante el init: `RunOptions.compressionMode: 'conservative'` sube el umbral a ≥0.92 y duplica las rondas protegidas
- Auto-retry de escritura del `STRATUM.md`

| Contexto | Invocación |
|----------|-----------|
| CLI | `stratum init [--force] [--dry-run]` (plain-text) |
| Chat | `/init` — progreso en la conversación; `agent.reloadMemory()` al terminar |

---

## RunOptions

```typescript
interface RunOptions {
  signal?: AbortSignal
  destructivePolicy?: 'ask' | 'allow' | 'deny'   // política de tools destructivas
  onConfirmDestructive?: (call) => Promise<Decision>
  compressionMode?: 'normal' | 'conservative'    // 'conservative' usado por /init
}
```

---

## System Prompt (`system-prompt.ts`)

```typescript
buildSystemPrompt(config: StratumConfig, memory?: string): string
```

System prompt estilo opencode (`default.txt`) + un bloque `<env>` dinámico generado en cada arranque (cwd, worktree, git, plataforma, fecha, model id). Si `memory` no está vacío, inyecta el STRATUM.md del proyecto al final bajo `## Project Memory`.

---

## Tests

`src/agent/harness.test.ts` (11 tests):
- `estimateTokens` / `usage()` con proxy y con `recordUsage` real
- `maybeCompress`: skipped, truncado duro, zona protegida intacta
- Respuesta texto → `done('stop')`, tool call → dispatch → resultado → `done`
- `maxIterations` → `done('max_iterations')`
- Inject & recover (error de tool y error de parse JSON)
- `AbortSignal` → `done('cancelled')`

`src/agent/initialize-prompt.test.ts`:
- Sustitución de placeholders con `replaceAll` (`${path}` en múltiples posiciones)
- El prompt contiene las 5 secciones fijas esperadas
