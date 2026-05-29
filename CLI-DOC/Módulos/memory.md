---
date: 2026-05-29
tags: [módulo, memoria, stratum-cli]
status: implementado-parcial
hito: 2
---

# Módulo memory — Sistema de Memoria

Implementado en Hito 2 (Capa 1). Capas 2 y 3 en [[Roadmap#Hito 5]]. Ver [[Arquitectura]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/memory/project.ts` | `loadProjectMemory()` — carga STRATUM.md del proyecto y global |
| `src/memory/manager.ts` | `MemoryManager` — orquesta las 3 capas |
| `src/memory/show.ts` | `renderMemoryShow()` — salida compartida entre CLI y chat |

---

## Arquitectura en 3 capas

```
MemoryManager
    ├── Capa 1 — STRATUM.md (activa desde Hito 2)
    │       ├── ./STRATUM.md           ← memoria del proyecto (cwd)
    │       └── ~/.stratum/STRATUM.md  ← memoria global del usuario
    ├── Capa 2 — decisions.json        ← Hito 5
    │       └── ~/.stratum/memory/decisions.json
    └── Capa 3 — sqlite-vec            ← Hito 5
            └── ~/.stratum/memory/vectors.db
```

---

## Capa 1 — STRATUM.md (`project.ts`)

```typescript
interface ProjectMemory {
  projectContent: string  // contenido del ./STRATUM.md (vacío si no existe)
  globalContent:  string  // contenido del ~/.stratum/STRATUM.md (vacío si no existe)
  projectPath:    string  // ruta absoluta resuelta
  globalPath:     string  // ruta absoluta resuelta
}

function loadProjectMemory(config: StratumConfig): ProjectMemory
```

- Nunca lanza error por ausencia de archivos — devuelve strings vacíos
- `projectFile` se resuelve desde `process.cwd()` (relativo al proyecto)
- `globalFile` expande `~` via `config/paths.ts`

---

## MemoryManager (`manager.ts`)

```typescript
class MemoryManager {
  constructor(config: StratumConfig)

  reload(): void                       // recarga desde disco (tras /init)
  getProjectMemory(): ProjectMemory    // datos brutos
  getInjectableMemory(): string        // bloque listo para system prompt
  hasMemory(): boolean

  // Hito 5 (stubs que lanzan error)
  async storeDecision(params: unknown): Promise<void>
  async searchDecisions(query: string): Promise<unknown[]>
}
```

`getInjectableMemory()` concatena global (primero) + proyecto (último, mayor prioridad) separados por `---`. El resultado se pasa a `buildSystemPrompt(config, memory)`.

---

## Integración con el agente

```
Arranque de sesión:
  MemoryManager.getInjectableMemory()
    → buildSystemPrompt(config, memory)
      → messages[0] = { role: 'system', content: prompt }

Tras /init:
  InitAgent.run() → emite done
    → App.tsx llama agent.reloadMemory()
      → MemoryManager.reload()
        → messages[0] se reconstruye con el nuevo STRATUM.md
```

---

## `stratum init` / `/init` — §12.13

Ver [[Módulos/agent#InitAgent]] para la implementación completa.

### Estructura fija del STRATUM.md generado

```markdown
# Stratum Memory

## Proyecto
<!-- nombre, descripción, propósito -->

## Stack Tecnológico
<!-- lenguajes, frameworks, versiones clave -->

## Estructura
<!-- árbol de directorios relevante con descripción -->

## Convenciones
<!-- estilo, naming, commits, patrones -->

## Comandos Clave
<!-- scripts exactamente como en el manifiesto -->
```

Las secciones extra que el usuario añada se preservan siempre.

### Flags de `stratum init`

| Flag | Comportamiento |
|------|---------------|
| _(ninguno)_ | Scan + síntesis + merge interactivo si STRATUM.md existe |
| `--force` | Sobrescribe sin preguntar por secciones manuales |
| `--dry-run` | Muestra qué generaría sin escribir |

---

## `stratum memory show` / `/memory show`

`renderMemoryShow(config): string` — función compartida entre CLI y chat.

- Si no hay ningún STRATUM.md → aviso con rutas buscadas + sugerencia `stratum init`
- Si hay global y/o proyecto → muestra ruta + contenido de cada uno

---

## Rutas de memoria (`config/paths.ts`)

```typescript
function expandHome(p: string): string
// "~/.stratum/..." → "/home/user/.stratum/..."

function resolveMemoryPaths(config: StratumConfig): MemoryPaths
// { projectFile, globalFile, decisionsFile, vectorDb, sessionsDir }
```

El loader de config solo expande `${ENV}`, no `~`. Este módulo completa esa responsabilidad.

---

## Tests

`src/memory/project.test.ts` (4 tests):
- Devuelve strings vacíos cuando no existe STRATUM.md
- Carga y hace trim del contenido cuando existe
- Devuelve la ruta correcta aunque el archivo no exista
