---
date: 2026-05-28
tags: [módulo, tools, registry, stratum-cli]
status: implementado
hito: 1
---

# Módulo tools — Registro y Dispatch

Implementado en Hito 1. Ver [[Arquitectura]] y [[Módulos/agent]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/tools/registry.ts` | `ToolRegistry` + `ToolDispatcher` |
| `src/tools/index.ts` | `registerBuiltinTools(registry, config)` |
| `src/tools/fs/read.ts` | Tool `read_file` |
| `src/tools/fs/write.ts` | Tool `write_file` |
| `src/tools/shell/bash.ts` | Tool `bash` |

---

## ToolDefinition

```typescript
interface ToolDefinition {
  name: string
  description: string
  schema: ZodSchema         // validación de parámetros
  destructive?: boolean     // pide confirmación al usuario (Hito 3)
  serialized?: boolean      // nunca se ejecuta en paralelo (bash lo lleva)
  timeout?: number          // ms; default: config.tools.bashTimeout
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
  toToolSchemas(): ToolSchema[]   // convierte Zod → JSON Schema para el LLM
}
```

`toToolSchemas()` usa `zod-to-json-schema` para producir el formato `{ type: 'function', function: { name, description, parameters } }` que espera la API OpenAI.

---

## ToolDispatcher (§12.9)

```typescript
class ToolDispatcher {
  async dispatch(calls: ToolCallReady[], ctx: ToolContext): Promise<DispatchResult[]>
}
```

### Algoritmo de dispatch

1 call → ejecuta directamente.

N calls:
- Si **alguna** tiene `serialized: true` → todas se ejecutan **secuencialmente** en orden de emisión.
- Si ninguna es serialized → `Promise.allSettled` en **paralelo**.

Antes de ejecutar cada tool:
- Tool no encontrada → `{ ok: false, error: '... not found', recoverable: true }`
- `schema.parse(input)` falla (Zod) → `{ ok: false, error: 'Invalid params...', recoverable: true }`
- Timeout vía `Promise.race` con el timer configurado
- Respeta `ctx.signal` (AbortSignal)

El orden del array resultado corresponde al orden de emisión del LLM.

---

## Tools built-in

### read_file

```
Parámetros: path (string), offset? (number), limit? (number)
```

Lee el archivo completo o un rango de líneas (`offset` es 1-indexed, `limit` es cantidad). Devuelve el contenido como texto. `destructive: false`.

### write_file

```
Parámetros: path (string), content (string)
```

Crea o sobrescribe el archivo. Crea los directorios padre con `mkdirSync({ recursive: true })` automáticamente. `destructive: false` en Hito 1 (la confirmación interactiva es Hito 3).

### bash

```
Parámetros: command (string), timeout? (number, ms)
```

Ejecuta el comando con `execa` (`shell: true`). Captura stdout + stderr combinados. Termina el proceso con SIGTERM y fuerza SIGKILL tras 500ms (`forceKillAfterDelay: 500`) para compatibilidad Windows.

- `serialized: true` — nunca se ejecuta en paralelo con otras tools
- Sin guard de patrones destructivos (diferido a [[Roadmap#Hito 3]])
- Timeout por defecto: `config.tools.bashTimeout` (30s)

---

## Tests

`src/tools/registry.test.ts`:
- Register/get/list + toToolSchemas
- Dispatch unitario, paralelo, serializado forzado, tool no encontrada, error Zod

`src/tools/fs.test.ts`:
- `read_file`: lectura completa, con offset/limit, archivo inexistente
- `write_file`: crear nuevo, sobrescribir, crear directorios recursivos

`src/tools/bash.test.ts`:
- Comando simple (echo), comando fallido (exit 1), captura stderr
- Timeout — skipped en Windows (`it.skipIf(process.platform === 'win32')`)
