---
date: 2026-05-29
tags: [diario, hito-2, memoria, sesiones, stratum-cli]
hito: 2
commit: 4d4eb03
---

# Diario — Hito 2: Memory Layer 1

## Resumen

El agente ya conoce el proyecto desde el primer mensaje. Hito completado en una sesión de trabajo. 73 tests pasando, lint y build limpios.

---

## Qué se implementó

### Memoria del proyecto (Capa 1)

El sistema de 3 capas de memoria solo activa la capa 1 por ahora. El arranque de `stratum chat` ahora:

1. Carga `./STRATUM.md` (proyecto) y `~/.stratum/STRATUM.md` (global)
2. Inyecta el contenido en el system prompt bajo `## Project Memory`
3. El agente responde con conocimiento del stack, convenciones y comandos del proyecto desde el primer mensaje

Si no existe ningún STRATUM.md, el agente arranca sin memoria (no rompe).

### `stratum init` / `/init` — scan inteligente

El comando anterior solo creaba una plantilla estática. El nuevo `InitAgent`:

- Escanea el proyecto (depth 3, respeta `.gitignore`, manifiestos, configs, docs)
- Hace un LLM call para sintetizar las **5 secciones fijas** del STRATUM.md
- Si ya existe un STRATUM.md, hace un **merge interactivo** por sección: preserva el contenido manual, rellena los huecos, conserva las secciones extra del usuario

Dentro del chat, `/init` conduce el mismo agente mostrando progreso en la conversación. Los conflictos de merge desbloquean el input para que el usuario responda `s`/`N`.

### Compresión de contexto (§12.4)

El `ContextManager` era un stub. Ahora implementa el algoritmo completo:

- Cascada de estimación: `usage.prompt_tokens` real del provider (prefijo `~` en status bar cuando no está disponible)
- Al superar el 80%: LLM call resumidor → fallback truncado duro (bloques de 2 rondas) → presión irresolvible (warning)
- Zona protegida: system prompt + últimas 6 rondas + sus tool results

El provider ahora solicita `stream_options: { include_usage: true }` para obtener los tokens reales.

### Persistencia de sesiones (§12.6)

Las sesiones se guardan automáticamente en `~/.stratum/sessions/` al cerrar el chat. El schema nunca incluye `apiKey` ni `baseUrl`. Con más de 5 rondas se genera un resumen automático via LLM (≤ 100 chars) para el listado.

`stratum chat --resume <id>` restaura el historial exacto. `stratum sessions list/delete/prune` son operativos.

---

## Decisiones técnicas tomadas

### `performMerge()` como AsyncGenerator con valor de retorno

El merge necesitaba emitir eventos (`merge_conflict`) y también devolver el resultado final (secciones). La solución: `AsyncGenerator<InitEvent, Record<string,string>>`. El caller itera con `.next()` manual para capturar el `done.value` como resultado. Evita el anti-patrón de dos pasadas (una para eventos, otra para el resultado) que existía en el diseño inicial.

### `/init` en chat: Promise para merge interactivo

El callback `resolveConflict` devuelve una `Promise<boolean>`. Cuando `InitAgent` la invoca, el componente React crea la Promise y guarda el `resolve` en un `useRef`. Cuando el usuario escribe `s`/`N`, el input se redirige a ese resolver en lugar de al agente. Después el generador continúa.

### `SessionStore.list()` ordena por `updatedAt` del JSON

Ordenar por nombre de archivo era frágil cuando dos sesiones se crean en el mismo segundo (el sufijo aleatorio del ID podía invertir el orden). La solución: parsear el JSON y ordenar por el campo `updatedAt` ISO 8601, que es milisegundo-preciso.

### `getProvider()` y `getConfig()` en `StratumAgent`

`App.tsx` necesitaba acceso al provider para instanciar `InitAgent` desde `/init`. En lugar de pasar el router como prop adicional, se añadieron dos getters al agente. Mantiene la interfaz compacta sin exponer el router completo.

---

## Issues encontrados en validación (spec-validator)

Tras la implementación inicial, el spec-validator identificó 3 desviaciones:

| Issue | Causa | Fix |
|-------|-------|-----|
| `/init` enviaba `[STRATUM_INTERNAL:INIT]` al LLM | Placeholder de App.tsx nunca completado | Implementación completa con `InitAgent` en `runInit()` |
| `.gitignore` leído pero no aplicado | `buildDirTree` se llamaba antes de leer `.gitignore` | Reordenar el scan y pasar los patrones recursivamente |
| Merge de dos pasadas | `merge()` + `mergeToSections()` separados | Unificar en `performMerge()` AsyncGenerator |

---

## Próximo paso

**Hito 3 — Tools Day 1:** `edit_file`, `list_directory`, `glob`, `grep`, `web_search`, safety check en bash, confirmación interactiva de tools destructivas, ToolCall UI completo (spinner, toggle de expansión), y markdown rendering de respuestas.
