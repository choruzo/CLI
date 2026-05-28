---
date: 2026-05-28
tags: [módulo, agente, react-loop, stratum-cli]
status: implementado
hito: 1
---

# Módulo agent — Core Agent Loop

Implementado en Hito 1. Ver [[Arquitectura]] y [[Roadmap]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/agent/types.ts` | Tipos centrales: `AgentEvent`, `Message`, `ToolDefinition`, `ToolResult` |
| `src/agent/core.ts` | `StratumAgent` — estado de sesión, punto de entrada público |
| `src/agent/harness.ts` | `ReactLoop`, `ContextManager`, `streamWithRetry` |
| `src/agent/system-prompt.ts` | `buildSystemPrompt()` — identidad y patrón ReAct |

---

## AgentEvent (§12.1)

Unión discriminada exhaustiva. Todos los consumidores (UI Ink, `stratum run`) manejan eventos de este tipo.

```typescript
type AgentEvent =
  | { type: 'text_delta';       delta: string }
  | { type: 'tool_call_start';  id: string; name: string; input_so_far: string }
  | { type: 'tool_call_ready';  id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result';      id: string; name: string; result: string; durationMs: number }
  | { type: 'tool_error';       id: string; name: string; error: string; recoverable: boolean }
  | { type: 'memory_retrieved'; decisions: DecisionEntry[] }
  | { type: 'thinking';         text: string }
  | { type: 'error';            message: string; fatal: boolean }
  | { type: 'done';             stopReason: 'stop' | 'max_iterations' | 'cancelled' | 'error' }
```

---

## StratumAgent (`core.ts`)

```typescript
class StratumAgent {
  constructor(config, providerRouter, toolRegistry)
  async *run(input: string, opts?: RunOptions): AsyncGenerator<AgentEvent>
  getContextUsage(): { used: number; max: number; pct: number }
  get providerName(): string
  get model(): string
}
```

Mantiene `messages[]` (historial OpenAI format). Cada llamada a `run()` añade el mensaje de usuario y delega en `ReactLoop`.

---

## ReactLoop (`harness.ts`)

Algoritmo de iteración (hasta `agent.maxIterations`):

1. Si `signal.aborted` → `yield done('cancelled')`
2. Llama a `streamWithRetry(provider, request)` — si falla tras 3 intentos → `yield error{fatal:true}` + `yield done('error')`
3. Por cada chunk: `StreamBuffer.feed()` → re-yield de eventos; acumula `assistantText` y `tool_call_ready`
4. Push del turno assistant al historial (formato OpenAI reconstruido)
5. Sin tool calls → `yield done('stop')`
6. Con tool calls → `dispatcher.dispatch(calls, ctx)` → inject resultados como `role:'tool'` → continuar loop
7. Tope alcanzado → `yield done('max_iterations')`

### Política inject & recover (§12.3)

Los errores de tool se inyectan en el historial como XML para que el LLM pueda reaccionar:

```xml
<tool_error>
  <tool>nombre_tool</tool>
  <error>mensaje de error</error>
</tool_error>
```

El loop continúa (no aborta) cuando `recoverable: true`.

### streamWithRetry

Envuelve el generador del provider con reintentos de red:

```
intento 1 → espera 1s → intento 2 → espera 2s → intento 3 → error fatal
```

Priming: llama a `gen.next()` antes de hacer yield para detectar errores de conexión en el primer chunk (no durante el streaming).

---

## ContextManager (`harness.ts`)

```typescript
class ContextManager {
  estimateTokens(messages: Message[]): number  // sum(chars) / 3.5
  usage(messages: Message[]): { used: number; max: number; pct: number }
  maybeCompress(messages: Message[]): void     // stub — Hito 2 implementa compresión real
}
```

La compresión real (umbral 80%, zona protegida, LLM call resumidor) está diferida al [[Roadmap#Hito 2]].

---

## System Prompt (`system-prompt.ts`)

`buildSystemPrompt(config)` genera el prompt base:
- Identidad: "Eres Stratum, un agente de terminal inteligente..."
- Patrón ReAct: razona antes de actuar, usa tools cuando es necesario
- Formato de respuesta: conciso, orientado a la tarea
- Sin inyección de `STRATUM.md` ni `store_decision` (Hito 2 y 5 respectivamente)

---

## Tests

`src/agent/harness.test.ts` cubre:
- `estimateTokens` — proporción chars/3.5
- Respuesta solo-texto → `done('stop')`
- Tool call → dispatch → inject resultado → 2ª iteración → `done`
- `maxIterations` → `done('max_iterations')`
- Error de tool inyectado → loop continúa (inject & recover)
- `AbortSignal` → `done('cancelled')`
