# Implementación: mejoras del comando `init`

> Especificación de implementación derivada del análisis `Analisis-init-STRATUM.md`.
> Todos los cambios apuntan a `stratum-cli/src/agent/init-agent.ts` salvo que se indique otra ruta.
> Orden: **hacer primero lo que desbloquea al resto** → robustez de scan → calidad de contenido → mejoras incrementales.

---

## Bloque 0 — Reconciliar plantillas (prerequisito de todo)

**Problema (2.5):** Existen tres "verdades" sobre las secciones de un `STRATUM.md`. El template versionado tiene solo 2 secciones; la spec y `InitAgent.FIXED_SECTIONS` tienen 5; y ninguno incluye `## Instrucciones para el agente`, que es la sección más valiosa según `system-prompt.ts:54`.

**Cambios:**

### `init-agent.ts` — añadir la 6ª sección fija

```ts
// Líneas 77-83 — antes
const FIXED_SECTIONS = [
  'Proyecto',
  'Stack Tecnológico',
  'Estructura',
  'Convenciones',
  'Comandos Clave',
];

// Después
const FIXED_SECTIONS = [
  'Proyecto',
  'Stack Tecnológico',
  'Estructura',
  'Convenciones',
  'Comandos Clave',
  'Instrucciones para el agente',
];
```

```ts
// Líneas 85-92 — añadir placeholder para la nueva sección
const SECTION_PLACEHOLDERS: Record<string, string> = {
  // ... existentes ...
  'Instrucciones para el agente': `<!-- Escribe aquí las instrucciones permanentes que el agente debe respetar en cada sesión.
Ejemplos:
- Confirmar siempre antes de ejecutar comandos destructivos
- Responder en español
- Al tocar archivos de configuración de VMware, mostrar un diff antes de aplicar
- Preferir editar archivos existentes antes de crear nuevos
-->`,
};
```

### `stratum-cli/STRATUM.md` — alinear al conjunto canónico

El template versionado tiene solo `## Proyecto` e `## Instrucciones para el agente`. Añadir las cuatro secciones faltantes con sus placeholders para que coincida con lo que genera `InitAgent`.

### `init-agent.ts:632` — corregir `isPlaceholder()`

El texto hardcodeado `'<!-- Describe tu proyecto, stack y convenciones aquí -->'` ya no existe. Simplificar:

```ts
private isPlaceholder(content: string): boolean {
  return !content.trim() || content.trim().startsWith('<!--');
}
```

---

## Bloque 1 — Robustez del scan

### 1.1 Detección de proyecto anidado y monorepos

**Problema (1.1):** `scan()` solo busca manifiestos en `cwd`. En este mismo repo, `CLI/` no tiene `package.json`; el proyecto real está en `CLI/stratum-cli/`. El `init` ejecutado en la raíz produce Stack y Comandos vacíos.

**Nueva función `detectProjectRoot()`** — añadir antes de `scan()`:

```ts
/**
 * Si cwd no tiene manifiesto conocido, busca en subdirectorios directos (depth 1).
 * Devuelve { root, isMonorepo, packages[] }.
 *
 * Reglas:
 *  - Si la raíz tiene manifiesto → root = cwd, isMonorepo según 'workspaces'/turbo/nx
 *  - Si la raíz NO tiene manifiesto y hay exactamente 1 hijo directo con manifiesto → root = ese hijo
 *  - Si hay N>1 hijos con manifiestos → isMonorepo = true, root = cwd, packages = hijos
 */
private detectProjectRoot(cwd: string, gitignorePatterns: string[]): ProjectLayout {
  const hasRootManifest = MANIFEST_FILES.some(f => existsSync(join(cwd, f)));

  if (hasRootManifest) {
    // ¿Es monorepo?
    const pkgPath = join(cwd, 'package.json');
    let isMonorepo = false;
    const packages: string[] = [];
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
        if (Array.isArray(pkg['workspaces'])) isMonorepo = true;
      } catch { /* ignorar */ }
    }
    if (!isMonorepo) {
      isMonorepo = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json']
        .some(f => existsSync(join(cwd, f)));
    }
    if (isMonorepo) {
      // Listar paquetes directos (depth 1, solo dirs con manifiesto)
      for (const dir of this.listDirs(cwd, gitignorePatterns)) {
        if (MANIFEST_FILES.some(f => existsSync(join(cwd, dir, f)))) {
          packages.push(dir);
        }
      }
    }
    return { root: cwd, isMonorepo, packages };
  }

  // Sin manifiesto en raíz → buscar en hijos directos
  const childrenWithManifest = this.listDirs(cwd, gitignorePatterns)
    .filter(dir => MANIFEST_FILES.some(f => existsSync(join(cwd, dir, f))));

  if (childrenWithManifest.length === 1) {
    return { root: join(cwd, childrenWithManifest[0]!), isMonorepo: false, packages: [] };
  }
  if (childrenWithManifest.length > 1) {
    return { root: cwd, isMonorepo: true, packages: childrenWithManifest };
  }
  return { root: cwd, isMonorepo: false, packages: [] };
}

private listDirs(dir: string, gitignorePatterns: string[]): string[] {
  try {
    return readdirSync(dir)
      .filter(e => !EXCLUDED_DIRS.has(e) && !this.isGitignored(e, gitignorePatterns))
      .filter(e => { try { return statSync(join(dir, e)).isDirectory(); } catch { return false; } });
  } catch { return []; }
}
```

Tipo de apoyo:
```ts
interface ProjectLayout {
  root: string;       // directorio real del proyecto (puede diferir de cwd)
  isMonorepo: boolean;
  packages: string[]; // nombres de subdirectorios con manifiestos (solo si isMonorepo)
}
```

**En `run()`:** llamar `detectProjectRoot()` antes de `scan()` y pasar `layout.root` como directorio de trabajo. Si `isMonorepo`, incluir un resumen de paquetes en el contexto de síntesis.

**En `ScanData`:** añadir `projectRoot: string` y `isMonorepo: boolean`.

### 1.2 Incluir archivos en el árbol de directorios

**Problema (1.2):** `buildDirTree()` omite todos los archivos (`init-agent.ts:363` — solo entra si `stat.isDirectory()`). El LLM infiere convenciones de naming sin haber visto un solo nombre de archivo.

**Cambio en `buildDirTree()`:**

```ts
// Añadir después del bloque if (stat.isDirectory()) { ... }
else {
  // Incluir archivos en raíz y src/; limitar a MAX_FILES_PER_DIR por carpeta
  if (depth <= 2) {
    lines.push(`${indent}${entry}`);
  }
}
```

Añadir constante de control al inicio del archivo:
```ts
const MAX_FILES_PER_DIR = 20; // máximo de archivos mostrados por directorio
```

Implementación completa del bloque de archivos dentro del loop de `buildDirTree()`:

```ts
} else if (depth <= 2) {
  fileEntries.push(`${indent}${entry}`);
}
```

Acumular `fileEntries` separado del array `lines`; al final del directorio, añadir los primeros `MAX_FILES_PER_DIR` y si hay más, `${indent}  … +N más`:

```ts
const fileSlice = fileEntries.slice(0, MAX_FILES_PER_DIR);
const overflow = fileEntries.length - fileSlice.length;
lines.push(...fileSlice);
if (overflow > 0) lines.push(`${indent}  … +${overflow} más`);
```

### 1.3 Fallback por extensiones cuando no hay manifiesto

**Problema (1.3):** Spec §12.13 exige fallback a conteo de extensiones si no se detecta ningún manifiesto. No está implementado.

**Nueva función `collectExtensionStats()`:**

```ts
/**
 * Cuenta extensiones de archivo en src/ (o raíz si no existe src/).
 * Retorna las 8 más frecuentes, ej. { '.ts': 42, '.json': 12, ... }
 */
private collectExtensionStats(root: string): Record<string, number> {
  const srcDir = existsSync(join(root, 'src')) ? join(root, 'src') : root;
  const counts: Record<string, number> = {};
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (EXCLUDED_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        try {
          const s = statSync(full);
          if (s.isDirectory()) walk(full, depth + 1);
          else {
            const ext = entry.includes('.') ? `.${entry.split('.').pop()}` : '(sin extensión)';
            counts[ext] = (counts[ext] ?? 0) + 1;
          }
        } catch { /* ignorar */ }
      }
    } catch { /* ignorar */ }
  };
  walk(srcDir, 0);
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
  );
}
```

**En `synthesize()`:** si `Object.keys(data.manifests).length === 0`, añadir al contexto:
```
## Extensiones de archivo detectadas (sin manifiesto conocido)
.ts: 42, .json: 12, .md: 5, ...
```

**Ampliar `MANIFEST_FILES`** con los candidatos que faltan:
```ts
const MANIFEST_FILES = [
  // existentes ...
  'mix.exs',          // Elixir
  'pubspec.yaml',     // Flutter/Dart
  'Package.swift',    // Swift
  'deno.json',        // Deno
  'deno.jsonc',
  // *.csproj y *.sln requieren glob — ver nota abajo
];
```

> **Nota:** `.csproj` y `.sln` no tienen nombre fijo. Añadir una pasada extra en `scan()` que busque `readdirSync(root).find(f => f.endsWith('.csproj') || f.endsWith('.sln'))` antes de aplicar el fallback de extensiones.

### 1.4 Detección del gestor de paquetes por lockfile

**Problema (1.4):** `MANIFEST_FILES` incluye `package-lock.json` pero no `pnpm-lock.yaml`, `yarn.lock` ni `bun.lockb`. Además, los lockfiles no deben volcarse al prompt (ruido puro).

**Cambios:**

1. Eliminar `'package-lock.json'` de `MANIFEST_FILES`.

2. Añadir detección explícita del gestor en `scan()` tras leer manifiestos:

```ts
// Detectar gestor de paquetes por lockfile (solo presencia, no contenido)
const LOCKFILES: Record<string, string> = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml':    'pnpm',
  'yarn.lock':         'yarn',
  'bun.lockb':         'bun',
};
let packageManager: string | undefined;
for (const [lockfile, manager] of Object.entries(LOCKFILES)) {
  if (existsSync(join(root, lockfile))) {
    packageManager = manager;
    scannedFiles.push(lockfile);
    break; // el primero encontrado gana (orden de precedencia arriba)
  }
}
```

3. Añadir `packageManager?: string` a `ScanData`.

4. En `synthesize()`, inyectar `packageManager` en las heurísticas del prompt:
```
Gestor de paquetes detectado: pnpm
```

5. En la sección **Comandos Clave** generada de forma determinista (ver Bloque 2.2), prefijar scripts con el runner correcto:
```
pnpm run dev   # en lugar de npm run dev
```

### 1.5 Metadatos de Git con saneo de credenciales

**Problema (1.5):** El scan no consulta Git. Además, el remote de este repo contiene un PAT en la URL que **no debe aparecer** en `STRATUM.md`.

**Nueva función `readGitMetadata()`:**

```ts
import { execSync } from 'child_process'; // o usar execa si ya está disponible

private readGitMetadata(root: string): GitMetadata | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf-8' }).trim();

    // Leer remote y SANEAR credenciales antes de cualquier uso
    let remote: string | undefined;
    try {
      const rawRemote = execSync('git remote get-url origin', { cwd: root, encoding: 'utf-8' }).trim();
      // Eliminar user:token@ de URLs https://user:token@host/...
      remote = rawRemote.replace(/https?:\/\/[^@]+@/, 'https://');
    } catch { /* sin remote */ }

    // Últimos 5 asuntos de commit para inferir convención
    const logLines = execSync(
      'git log --oneline -5 --pretty=format:"%s"',
      { cwd: root, encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);

    return { branch, remote, recentCommits: logLines };
  } catch {
    return undefined; // no es un repo git o git no disponible
  }
}
```

Tipo de apoyo:
```ts
interface GitMetadata {
  branch: string;
  remote?: string;  // ya saneado
  recentCommits: string[];
}
```

**En `ScanData`:** añadir `git?: GitMetadata`.

**En `synthesize()`:** si hay metadatos Git, añadirlos al contexto antes de las heurísticas de convenciones:
```
## Git
Rama por defecto: main
Remote: https://github.com/user/repo.git
Commits recientes (inferir convención de mensajes):
  - feat: add streaming support
  - fix(provider): handle timeout
  - chore: bump dependencies
```

> ⚠️ **Recordatorio de seguridad:** el saneo `replace(/https?:\/\/[^@]+@/, 'https://')` debe aplicarse **antes** de escribir cualquier cadena en `STRATUM.md` o en el prompt del LLM.

### 1.7 Presupuesto de tokens del contexto

**Problema (1.7):** `synthesize()` concatena todo sin límite. En repos grandes puede acercarse al `contextWindow`.

**Añadir constante y lógica de recorte en `synthesize()`:**

```ts
const CONTEXT_BUDGET_CHARS = 12_000; // ~3000 tokens a 4 chars/token; ajustar si contextWindow > 32768
```

Prioridad de inclusión (mayor a menor):
1. Manifiesto principal (`package.json`, `Cargo.toml`, etc.) — íntegro hasta 4000 chars
2. Scripts / comandos extraídos del manifiesto — siempre íntegros (deterministas)
3. Intro del README — primeras 150 líneas (ya tiene límite de 3000 chars)
4. Configs (`tsconfig.json`, etc.) — 500 chars c/u (ya tiene límite)
5. Workflows CI — 1000 chars c/u
6. Entry points — 1000 chars c/u

Si la suma supera `CONTEXT_BUDGET_CHARS`, truncar de menor a mayor prioridad (5 → 4 → 3), nunca truncar 1 ni 2.

---

## Bloque 2 — Calidad del contenido generado

### 2.2 Patrón deterministic-first: inyectar árbol y scripts directamente

**Problema (2.2):** El prompt pide al LLM que regenere el árbol de directorios y los scripts, que ya se conocen con certeza. Esto invita a alucinaciones y desperdicia tokens.

**Cambio arquitectónico en `synthesize()` y `buildStratumMd()`:**

Separar lo que se genera de forma determinista de lo que necesita síntesis LLM:

```
Secciones deterministas (no van al prompt, se inyectan directas):
  - Estructura   → árbol real de buildDirTree()
  - Comandos Clave → scripts de package.json / Makefile / etc.

Secciones que requieren síntesis LLM:
  - Proyecto      → descripción, propósito
  - Stack Tecnológico → inferido de manifiestos + heurísticas
  - Convenciones  → inferido de nombres de archivos, commits, configs
```

**Nueva función `buildDeterministicSections()`:**

```ts
private buildDeterministicSections(data: ScanData): Record<string, string> {
  const sections: Record<string, string> = {};

  // Estructura — árbol real
  sections['Estructura'] = data.dirTree
    ? `\`\`\`\n${data.dirTree}\n\`\`\``
    : SECTION_PLACEHOLDERS['Estructura']!;

  // Comandos Clave — extraídos del manifiesto
  const runner = data.packageManager ?? 'npm';
  const cmds: string[] = [];
  if (data.manifests['package.json']) {
    try {
      const pkg = JSON.parse(data.manifests['package.json']) as Record<string, unknown>;
      const scripts = pkg['scripts'] as Record<string, string> | undefined;
      if (scripts) {
        for (const [name, cmd] of Object.entries(scripts)) {
          cmds.push(`${runner} run ${name}   # ${cmd}`);
        }
      }
    } catch { /* ignorar */ }
  }
  if (data.manifests['Makefile']) {
    // Extraer targets de Makefile: líneas que empiecen con `nombre:`
    const targets = data.manifests['Makefile']
      .split('\n')
      .filter(l => /^[a-zA-Z][a-zA-Z0-9_-]*:/.test(l))
      .map(l => `make ${l.split(':')[0]}`);
    cmds.push(...targets);
  }
  sections['Comandos Clave'] = cmds.length
    ? cmds.join('\n')
    : SECTION_PLACEHOLDERS['Comandos Clave']!;

  return sections;
}
```

**Ajustar el prompt de síntesis** para pedir solo 3 secciones (ya no 5):

```
Genera EXACTAMENTE estas 3 secciones en orden, con delimitadores explícitos:

<<<PROYECTO>>>
[nombre del proyecto, descripción breve, propósito principal]
<<<END>>>

<<<STACK>>>
[lenguajes, frameworks, librerías principales, versiones clave]
<<<END>>>

<<<CONVENCIONES>>>
[estilo de código, naming, reglas de commits inferidas de los commits reales]
<<<END>>>

Estructura y Comandos Clave se generan de forma determinista; NO los incluyas.
```

### 2.3 Parsing robusto con delimitadores explícitos y reintento

**Problema (2.3):** `parseGeneratedSections()` trocea por `^## (.+)$` y hace match por nombre exacto. Un modelo local que traduzca el encabezado o añada preámbulo rompe el parse en silencio.

**Reemplazar el prompt libre por salida delimitada** (ya detallado en 2.2). El nuevo parser:

```ts
private parseDelimitedSections(raw: string): Record<string, string> | null {
  // Mapeo de clave-delimitador a nombre canónico de sección
  const KEY_MAP: Record<string, string> = {
    'PROYECTO':     'Proyecto',
    'STACK':        'Stack Tecnológico',
    'CONVENCIONES': 'Convenciones',
  };
  const result: Record<string, string> = {};

  for (const [key, sectionName] of Object.entries(KEY_MAP)) {
    const match = raw.match(
      new RegExp(`<<<${key}>>>([\\s\\S]*?)<<<END>>>`, 'i') // case-insensitive por si el modelo cambia capitalización
    );
    if (match?.[1]) {
      result[sectionName] = match[1].trim();
    }
  }

  // Validar que las 3 secciones esperadas están presentes
  const missing = Object.values(KEY_MAP).filter(s => !result[s]);
  return missing.length === 0 ? result : null;
}
```

**Lógica de reintento en `synthesize()`:**

```ts
let parsed = this.parseDelimitedSections(rawResponse);
if (!parsed) {
  // Reintentar una vez con el mismo prompt + aviso explícito
  const retryPrompt = prompt +
    '\n\nATENCIÓN: Tu respuesta anterior no incluyó los delimitadores <<<CLAVE>>> requeridos. ' +
    'Responde SOLO con los tres bloques delimitados, sin texto adicional fuera de ellos.';
  // ... nueva llamada al provider ...
  parsed = this.parseDelimitedSections(retryResponse);
}
// Si tras el reintento sigue fallando, caer a placeholders (comportamiento actual)
```

### 2.4 Prompt enriquecido con heurísticas, few-shot y temperatura fija

**Problema (2.4):** El prompt actual es mínimo: no incluye heurísticas de stack, no pide anclar en evidencia, no controla idioma ni temperatura.

**Nuevo prompt de síntesis** (sustituye el de `synthesize()`, líneas 510-522):

```
Eres un asistente técnico que documenta proyectos de software.
Genera SOLO las secciones pedidas. Usa ÚNICAMENTE la evidencia proporcionada.
Si no hay evidencia suficiente para una afirmación, OMÍTELA — nunca inventes convenciones ni versiones.
Responde en español.

HEURÍSTICAS DE STACK (aplica las que correspondan):
  package.json + "typescript" en devDependencies → TypeScript
  "react" + "ink" en dependencies → UI terminal con Ink
  "vitest" o "jest" → framework de test
  gestor detectado por lockfile: pnpm-lock.yaml → pnpm, yarn.lock → yarn, bun.lockb → bun
  Cargo.toml → Rust; go.mod → Go; pyproject.toml → Python; Gemfile → Ruby
  tsup o esbuild en devDependencies → bundler TypeScript
  "execa" → shell commands vía execa (no child_process directo)

EJEMPLO DE SALIDA CORRECTA:
<<<PROYECTO>>>
Stratum CLI — agente de línea de comandos extensible construido sobre un loop ReAct.
Provider-agnostic: compatible con cualquier API OpenAI-compatible (Ollama, llama.cpp, OpenAI).
<<<END>>>

<<<STACK>>>
- TypeScript 5.x (ESM + CJS via tsup)
- Node.js 20+
- Commander.js (CLI), Ink (UI terminal)
- Vitest (tests), ESLint + Prettier (lint/formato)
- sqlite-vec (vector DB), @xenova/transformers (embeddings ONNX)
<<<END>>>

<<<CONVENCIONES>>>
- Archivos: kebab-case; clases: PascalCase (inferido de src/)
- Commits: Conventional Commits (feat:, fix:, chore: — inferido de git log)
- Tests: co-ubicados con el módulo (*.test.ts)
<<<END>>>

EVIDENCIA DEL PROYECTO:
{contextStr}

Genera las 3 secciones siguiendo exactamente el formato del ejemplo:
```

**Temperatura fija** — añadir al objeto de la llamada al provider:

```ts
for await (const chunk of this.provider.complete({
  messages,
  stream: true,
  model: this.model,
  temperature: 0.2,   // ← añadir; baja para reproducibilidad
  signal: AbortSignal.timeout(300000),
})) { ... }
```

> Verificar que `IProvider.complete()` acepta `temperature` en su tipo de request (probablemente ya lo admite como passthrough a la API).

### 2.6 Merge asistido: diff visible en lugar de concatenación ciega

**Problema (2.6):** `mergeContent()` hace unión a nivel de línea, produciendo duplicados semánticos y orden roto.

**Reemplazar `mergeContent()` por una presentación del diff al usuario:**

En lugar de fusionar automáticamente, cuando `resolveConflict` devuelve `true` (el usuario quiere actualizar), usar la versión propuesta completa en vez de concatenar:

```ts
result[fixed] = update ? proposedContent : existingContent;
// Eliminar la llamada a mergeContent() — el LLM ya sintetizó; no mezclar mecánicamente
```

Si en el futuro se necesita una fusión más sofisticada (p. ej. en `--force`), la alternativa es pasar ambas versiones al LLM con un mini-prompt de fusión:

```ts
private async llmMerge(existing: string, proposed: string, section: string): Promise<string> {
  const prompt = `Fusiona estas dos versiones de la sección "${section}" en una sola.
Elimina duplicados, mantén el orden lógico, preserva información no contradictoria de ambas.
Devuelve SOLO el contenido fusionado, sin encabezado de sección ni preámbulo.

=== VERSIÓN EXISTENTE ===
${existing}

=== VERSIÓN PROPUESTA ===
${proposed}`;
  // ... llamada al provider, temperatura 0.1 ...
}
```

---

## Bloque 3 — Mejoras incrementales

### 3.1 Delegar `.gitignore` a la librería `ignore`

**Problema (1.6):** `isGitignored()` reimplementa semántica de `.gitignore` parcialmente. Faltan `.gitignore` anidados, `build/` como directorio-only, etc.

**Instalar:**
```bash
npm install ignore
```

**Reemplazar** `isGitignored()`, `hasNegatedDescendants()`, `matchesRootAnchoredPattern()`, `matchesPathOrAncestor()`, `matchGlob()`, `normalizeGitignorePath()` y `listPathCandidates()` por:

```ts
import ignore, { type Ignore } from 'ignore';

// En scan(), después de leer .gitignore:
const ig: Ignore = ignore();
if (existsSync(gitignorePath)) {
  ig.add(readFileSync(gitignorePath, 'utf-8'));
}
// Opcionalmente: leer .git/info/exclude si existe

// Sustituir this.isGitignored(relPath, gitignorePatterns) por:
ig.ignores(relPath)
```

Eliminar los métodos de matching artesanal (≈80 líneas menos de código a mantener).

---

## Resumen de cambios por archivo

| Archivo | Cambios |
|---|---|
| `src/agent/init-agent.ts` | `FIXED_SECTIONS` +1 sección; `SECTION_PLACEHOLDERS` +1 entrada; `isPlaceholder()` simplificado; `ScanData` +4 campos; nuevas funciones: `detectProjectRoot`, `listDirs`, `readGitMetadata`, `buildDeterministicSections`, `collectExtensionStats`, `parseDelimitedSections`, `llmMerge`; prompt reemplazado; `parseGeneratedSections` reemplazado; `mergeContent` simplificado; `buildDirTree` incluye archivos |
| `src/agent/init-agent.ts` (opcional) | Reemplazar ~80 líneas de matching manual por librería `ignore` |
| `src/cli/commands/init.ts` | Sin cambios estructurales; ajustar mensajes de spinner si se añade fase "detectando raíz del proyecto" |
| `stratum-cli/STRATUM.md` | Añadir las 4 secciones faltantes con placeholders para alinear al conjunto canónico |
| `package.json` | Añadir dependencia `ignore` (si se implementa 3.1) |

---

## Orden de implementación recomendado

```
1. Bloque 0  — Reconciliar plantillas       (prerequisito; 30 min)
2. §1.4      — Detección gestor de paquetes (prerequisito de 2.2; 20 min)
3. §2.2      — Deterministic-first          (alto impacto; 1h)
4. §2.3/2.4  — Parsing robusto + prompt     (alto impacto; 1h)
5. §1.1      — Proyectos anidados/monorepos (alto impacto; 1h)
6. §1.2      — Archivos en el árbol         (medio; 30 min)
7. §1.3      — Fallback por extensiones     (medio; 30 min)
8. §1.5      — Metadatos Git + saneo        (medio; 45 min)
9. §2.6      — Merge simplificado           (medio; 20 min)
10. §1.7     — Presupuesto de tokens        (bajo; 30 min)
11. §3.1     — Librería ignore              (bajo; 45 min)
```

Pasos 1–4 son los que tienen más ROI y los que corrigen los fallos silenciosos actuales. A partir del paso 5 el `/init` es correcto en el caso de este repo.