---
date: 2026-05-29
tags: [módulo, providers, llm, streaming, stratum-cli]
status: implementado
hito: 1-2
---

# Módulo providers — LLM Client

Implementado en Hito 1, ampliado en Hito 2. Ver [[Arquitectura]] y [[Módulos/agent]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/providers/base.ts` | `IProvider`, tipos de request/response |
| `src/providers/openai-compatible.ts` | `OpenAICompatible` + `StreamBuffer` |
| `src/providers/router.ts` | `ProviderRouter` — selección del provider activo |
| `src/providers/mock.ts` | `MockProvider` — guion de chunks para tests |

---

## IProvider (`base.ts`)

```typescript
interface IProvider {
  complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk>
  healthCheck(): Promise<boolean>
}

interface CompletionRequest {
  messages: Message[]
  tools?: ToolSchema[]
  stream: true
  model: string
  signal?: AbortSignal
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: { content?: string | null; tool_calls?: ToolCallDelta[] }
    finish_reason: string | null
    index: number
  }>
  // Presente solo en el chunk final cuando se solicita stream_options.include_usage
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
```

**Invariante:** `complete()` es siempre streaming. No hay modo no-streaming.

---

## OpenAICompatible (`openai-compatible.ts`)

Implementación propia del cliente. **No usa `openai` npm ni `ai-sdk`** (decisión técnica fija, ver [[Arquitectura]]).

### Flujo de streaming

```
fetch(baseUrl + '/chat/completions', {
  body: { ..., stream: true, stream_options: { include_usage: true } },
  signal
})
  → ReadableStream<Uint8Array>
  → TextDecoderStream
  → EventSourceParserStream   ← eventsource-parser v3 (WHATWG TransformStream)
  → filtrar '[DONE]'
  → yield chunk si chunk.choices[0] ó chunk.usage
```

**`stream_options.include_usage`** (añadido en Hito 2): solicita al provider que incluya los tokens reales en el último chunk. El `ContextManager` llama a `recordUsage(chunk.usage.prompt_tokens)` al recibir ese chunk, lo que activa la estimación real (`estimated: false`) en lugar del proxy `chars/3.5` (`estimated: true`).

### healthCheck()

`GET baseUrl/models` — devuelve `true` si responde 2xx. El indicador `●` dinámico en StatusBar está diferido a Hito 6.

---

## StreamBuffer (§12.2)

Acumula los argumentos de tool calls que llegan fragmentados en múltiples chunks SSE y reconstruye los eventos completos.

```typescript
class StreamBuffer {
  feed(chunk: OpenAIStreamChunk): AgentEvent[]
  reset(): void
}
```

### Algoritmo

1. Si `delta.content` → emite `text_delta`
2. Si `delta.tool_calls[i]`:
   - Primera vez que aparece `index i` → emite `tool_call_start` con `input_so_far: ""`
   - Acumula `arguments` en `toolBuffers.get(i).args`
   - Emite `tool_call_start` progresivo con `input_so_far` actualizado
3. Cuando `finish_reason === 'tool_calls'`:
   - Por cada buffer acumulado:
     - `JSON.parse(args)` OK → emite `tool_call_ready`
     - `JSON.parse` falla → emite `tool_error { recoverable: false }`
   - Llama `reset()`
4. Chunks con `choices: []` + `usage` → **no generan AgentEvent** (son consumidos por `ReactLoop` para `recordUsage`)

### Casos cubiertos

| Escenario | Comportamiento |
|-----------|---------------|
| Solo texto | `text_delta` por chunk |
| Args fragmentados en N chunks | Un único `tool_call_ready` al final |
| Dos tool calls paralelas (`index` 0 y 1) | Dos `tool_call_ready` independientes |
| JSON inválido en args | `tool_error { recoverable: false }` |
| Chunk de usage (choices vacío) | Sin AgentEvent — consumido por ReactLoop |

---

## ProviderRouter (`router.ts`)

```typescript
class ProviderRouter {
  getActive(): IProvider
  getActiveConfig(): ProviderConfig
  get providerName(): string
  get model(): string
  get contextWindow(): number
  async healthCheck(): Promise<boolean>
}
```

Lee `config.provider.default` (o el override `--provider` del CLI) e instancia el proveedor correspondiente. Actualmente solo soporta `type: 'openai-compatible'`. El fallback automático está diferido al [[Roadmap#Hito 6]].

---

## MockProvider (`mock.ts`)

Usado exclusivamente en tests. Acepta un guion de rondas:

```typescript
const mock = new MockProvider([
  makeTextRound('Hola, ¿en qué puedo ayudarte?'),
  makeToolCallRound('c1', 'read_file', { path: './foo.ts' }),
])
```

Helpers exportados: `makeTextRound(text)`, `makeToolCallRound(id, name, input)`.

---

## Tests

`src/providers/openai-compatible.test.ts` cubre todos los escenarios de `StreamBuffer` (ver tabla arriba).
