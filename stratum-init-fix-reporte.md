# Stratum CLI — Diagnóstico y plan de implementación para `/init`

> **Audiencia:** Claude Code (Sonnet 4.6) actuando como implementador sobre `github.com/choruzo/CLI` (directorio `stratum-cli/`).
> **Síntoma:** Con el mismo LLM (Gemma vía llama.cpp/LiteLLM), `stratum init` produce un `STRATUM.md` de calidad muy inferior al `AGENTS.md` que genera el `/init` de OpenCode.
> **Diagnóstico resumido:** Un bug crítico de sustitución de placeholders + tools de exploración no registradas + ausencia de límites de contexto en `read_file`/`bash` (que dispara la compresión destructiva a mitad del init) + system prompt sin bloque de entorno. Referencia de arquitectura objetivo: documento `opencode-init-implementacion.md` (assets verbatim de OpenCode).

Orden de implementación: los fixes están ordenados por impacto. El F1 es un bug puro; F2–F4 son los que explican la mayor parte de la diferencia de calidad.

---

## F1 (CRÍTICO) — `replace` solo sustituye la primera ocurrencia de `${path}`

**Archivos:** `src/cli/commands/init.ts:77-79` y `src/cli/ui/App.tsx:304-306`
**Causa:** `INITIALIZE_PROMPT` (en `src/agent/initialize-prompt.ts`) contiene el placeholder literal `${path}` **3 veces** (cabecera, "already exists at `${path}`", "write_file tool at path `${path}/STRATUM.md`"). `String.prototype.replace(string, string)` sustituye **solo la primera**. El modelo recibe el placeholder sin resolver justo en la instrucción de escritura final, e improvisa la ruta o el comportamiento.

**Fix (ambos puntos de entrada):**

```ts
const prompt = INITIALIZE_PROMPT
  .replaceAll('${path}', cwd)
  .replaceAll('$ARGUMENTS', focus?.trim() || '(none)');
```

**Test de regresión:** añadir un test que renderice el prompt y verifique `expect(prompt).not.toContain('${path}')` y `expect(prompt).not.toContain('$ARGUMENTS')`.

---

## F2 — Registrar las tools de exploración (existen pero no se registran) y añadir `grep`

**Archivo:** `src/tools/index.ts`
**Causa:** `registerBuiltinTools` solo registra `read_file`, `write_file` y `bash`. Sin embargo `src/tools/fs/glob.ts` y `src/tools/fs/list.ts` ya están implementadas y **nunca se registran**. No existe tool de búsqueda por contenido (`grep`). El prompt de init pide una estrategia de investigación estructurada; sin glob/grep, Gemma explora con comandos bash improvisados, que falla con frecuencia y consume iteraciones.

**Fix:**

```ts
import { globTool } from './fs/glob.js';
import { listTool } from './fs/list.js';
import { grepTool } from './fs/grep.js'; // nueva

export function registerBuiltinTools(registry: ToolRegistry, _config: StratumConfig): void {
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(globTool);
  registry.register(listTool);
  registry.register(grepTool);
  registry.register(bashTool);
}
```

**Nueva tool `grep`** (`src/tools/fs/grep.ts`): búsqueda regex por contenido. Implementación recomendada: ejecutar `rg --line-number --no-heading <pattern>` si ripgrep está disponible, con fallback a recorrido en Node con `RegExp` reutilizando `EXCLUDED_DIRS` de `glob.ts`. Salida: `ruta:línea: contenido`, cap a 200 matches. Descripción (adaptada de OpenCode, mantener en inglés):

```
- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions (eg. "log.*Error", "function\s+\w+")
- Filter files by pattern with the include parameter (eg. "*.ts", "*.{ts,tsx}")
- Returns file paths and line numbers with matching lines
- Use this tool when you need to find files containing specific patterns
```

Revisar también las descripciones de `glob` y `list` para alinearlas con las de `opencode-init-implementacion.md` §5 (incluida la instrucción de lanzar búsquedas especulativas en paralelo — el `ToolDispatcher` ya soporta llamadas paralelas vía `Promise.allSettled`).

---

## F3 — `read_file`: cap por defecto, números de línea y truncado de líneas largas

**Archivo:** `src/tools/fs/read.ts`
**Causa:** sin `offset/limit`, devuelve el archivo **entero y sin formato**. El propio repo del usuario contiene markdowns de 96KB y 54KB: una sola lectura consume ~24k tokens de los 32768 del `contextWindow` configurado, dispara `ContextManager.maybeCompress` a mitad del init y **la compresión destruye el contexto ya investigado** — causa directa del `STRATUM.md` superficial. Además, sin números de línea el modelo no puede paginar con `offset` de forma fiable.

**Fix — comportamiento objetivo (mismo contrato que OpenCode):**

- Tope por defecto: **2000 líneas** desde el inicio (o desde `offset`).
- Cada línea prefijada con su número: `N: contenido` (1-indexado).
- Líneas individuales truncadas a 2000 caracteres.
- Si se truncó, terminar la salida con una línea informativa: `(File has more lines. Use 'offset' to read beyond line N)`.
- Actualizar `description` de la tool para documentar el formato `N: contenido`, el tope de 2000 líneas, el uso de `offset`, y la recomendación de leer ventanas grandes y llamar a la tool en paralelo para varios ficheros (texto en §5.1 del documento de referencia).

```ts
const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;

const lines = content.split('\n');
const start = (offset ?? 1) - 1;
const cap = limit !== undefined ? Math.min(limit, MAX_LINES) : MAX_LINES;
const end = Math.min(start + cap, lines.length);
const body = lines
  .slice(start, end)
  .map((l, i) => `${start + i + 1}: ${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…' : l}`)
  .join('\n');
const suffix = end < lines.length
  ? `\n(File has more lines. Use 'offset' to read beyond line ${end})`
  : '';
return { ok: true, output: body + suffix };
```

---

## F4 — Truncado de salida en `bash` (y en cualquier tool result)

**Archivo:** `src/tools/shell/bash.ts` (y/o un truncador genérico en `ToolDispatcher`)
**Causa:** la salida de bash se devuelve íntegra. Un `find`, `cat` o `git log` grande inunda el contexto igual que F3. OpenCode trunca toda salida de tool (`tool/truncate.ts`).

**Fix:** truncar a ~30.000 caracteres conservando cabeza y cola, con marcador explícito:

```ts
const MAX_OUTPUT = 30_000;
if (text.length > MAX_OUTPUT) {
  const head = text.slice(0, MAX_OUTPUT * 0.8);
  const tail = text.slice(-MAX_OUTPUT * 0.2);
  text = `${head}\n\n[... output truncated (${text.length} chars total) ...]\n\n${tail}`;
}
```

Aplicarlo de forma genérica en `ToolDispatcher.dispatchOne` (sobre `result.output`) protege también a futuras tools.

---

## F5 — System prompt: bloque `<env>` + andamiaje conductual de `default.txt`

**Archivo:** `src/agent/system-prompt.ts`
**Causa:** el system prompt actual no incluye **working directory, si es repo git, fecha ni model id** — el modelo no sabe dónde está y debe descubrirlo gastando iteraciones (o lo asume mal). Además carece del andamiaje que OpenCode da a modelos genéricos (`default.txt`): ejemplos few-shot de verbosidad, política de tool calls paralelas, convenciones de código, sección "Doing tasks".

**Fix en dos partes:**

1. Añadir el bloque de entorno (formato exacto de OpenCode), generado dinámicamente en `buildSystemPrompt`:

```
You are powered by the model named ${modelId}. The exact model ID is ${provider}/${modelId}
Here is some useful information about the environment you are running in:
<env>
  Working directory: ${cwd}
  Workspace root folder: ${worktree}
  Is directory a git repo: yes|no
  Platform: ${process.platform}
  Today's date: ${new Date().toDateString()}
</env>
```

(Detectar git con `existsSync(join(worktree, '.git'))` o `git rev-parse` cacheado; `worktree` = raíz del repo si se detecta, si no `cwd`. Pasar `modelId` desde el `ProviderRouter` a `buildSystemPrompt` — actualmente no se recibe.)

2. Incorporar las secciones de `default.txt` (documento de referencia §4.2) adaptando nombre de producto y URLs a Stratum: *Tone and style* con sus ejemplos few-shot, *Following conventions*, *Doing tasks*, *Tool usage policy* (incluida la instrucción de batch/paralelo). Conservar la sección `## Project Memory` existente y la regla de idioma actual.

---

## F6 — Proteger el init de la compresión de contexto

**Archivos:** `src/agent/harness.ts` (ContextManager) + `src/config/schema.ts`
**Causa:** `/init` es la operación más sensible a la compresión: su valor está en el contexto acumulado durante la exploración. Con `contextWindow: 32768` y lecturas grandes, la compresión se activa antes de escribir el fichero. F3/F4 reducen drásticamente el riesgo, pero conviene además:

- Permitir pasar un flag a `ReactLoop`/`ContextManager` (p. ej. `compressionMode: 'conservative'`) que durante `/init` suba el `compressionThreshold` y conserve más rondas (`compressionKeepRounds`), o que como mínimo emita un `warning` visible.
- Documentar en el README que para `/init` con Gemma en la L4 conviene configurar el `contextWindow` real del servidor llama.cpp (si sirve 64k+ con el KV disponible, reflejarlo en `.stratumrc.json` en vez del default 32768).

---

## F7 (opcional, tras F1–F6) — Tool `question`

El prompt de init de OpenCode contempla una tanda única de preguntas al usuario cuando el repo no responde algo importante. Implementación mínima: tool `question` que recibe `questions: [{question, options[]}]`, pausa el loop, muestra las opciones en la TUI (Ink) o por stdin en modo comando, y devuelve las respuestas como tool result. Mientras no exista, eliminar cualquier referencia a preguntar al usuario en `INITIALIZE_PROMPT` para que Gemma no intente usar una tool inexistente.

---

## Verificación

1. **Unit:** test de regresión de F1 (placeholders resueltos); tests de formato de `read_file` (números de línea, cap 2000, sufijo de truncado); test de truncado de bash.
2. **Integración:** ejecutar `stratum init` sobre este mismo repo (`stratum-cli/`) y comprobar en la traza: (a) usa `glob`/`grep`/`read_file` antes de `write_file`; (b) ninguna tool result supera ~30k chars; (c) no se emite `context_compressed` antes de la escritura; (d) `STRATUM.md` se escribe en la raíz correcta.
3. **Calidad (A/B):** generar `AGENTS.md` con OpenCode y `STRATUM.md` con Stratum sobre el mismo repo y el mismo modelo Gemma, y comparar: comandos exactos verificables, notas de arquitectura no obvias, ausencia de relleno genérico, mejora in-place si el fichero ya existe.

## Mapa de archivos afectados

| Fix | Archivos |
|---|---|
| F1 | `src/cli/commands/init.ts`, `src/cli/ui/App.tsx` |
| F2 | `src/tools/index.ts`, `src/tools/fs/grep.ts` (nuevo), descripciones en `fs/glob.ts`, `fs/list.ts` |
| F3 | `src/tools/fs/read.ts` |
| F4 | `src/tools/shell/bash.ts` y/o `src/tools/registry.ts` (ToolDispatcher) |
| F5 | `src/agent/system-prompt.ts`, `src/agent/core.ts` (pasar modelId/cwd), `src/providers/router.ts` |
| F6 | `src/agent/harness.ts`, `src/config/schema.ts` |
| F7 | `src/tools/question.ts` (nuevo), `src/cli/ui/App.tsx`, `src/agent/initialize-prompt.ts` |
