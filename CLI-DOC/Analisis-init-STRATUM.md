# Análisis: mejora del comando `/init` y la generación de `STRATUM.md`

> Diagnóstico y recomendaciones priorizadas. Foco acordado: **robustez del scan** y **calidad del contenido generado**. No incluye cambios de código (entregable de análisis).
>
> Referencias de código verificadas contra `stratum-cli/src/agent/init-agent.ts`, `stratum-cli/src/cli/commands/init.ts`, `stratum-cli/src/agent/system-prompt.ts`, `stratum-cli/src/memory/project.ts`, la spec §12.13 y §3 (Capa 1) de `STRATUM_PROJECT_DEFINITION.md`.

## Resumen ejecutivo

El `/init` actual funciona para el caso feliz (un proyecto Node con manifiesto en la raíz), pero tiene dos debilidades estructurales:

1. **El scan asume manifiesto en la raíz y solo lista directorios.** En cuanto el proyecto está anidado (subcarpeta), es un monorepo, o no usa un manifiesto conocido, el scan se queda ciego y el LLM rellena con suposiciones. Esto afecta a *este mismo repositorio*: la raíz `CLI/` no tiene `package.json` — el proyecto vive en `stratum-cli/` — así que `stratum init` aquí generaría las secciones Stack y Comandos vacías.

2. **El contenido se delega entero a una sola llamada LLM con un prompt mínimo y un parsing frágil.** Datos que ya se conocen con certeza (árbol, scripts, versiones) se le piden al modelo en vez de inyectarse de forma determinista, lo que invita a alucinaciones, y la sección más valiosa para dirigir al agente —instrucciones permanentes— no se genera.

Hay además una **incoherencia de plantillas** entre la spec, el `STRATUM.md` versionado en el repo y lo que produce `InitAgent`, que conviene reconciliar antes de pulir nada más.

---

## Parte 1 — Robustez del scan

### 1.1 Punto ciego con proyectos anidados y monorepos (alto impacto)

`scan()` solo busca manifiestos en `cwd` (`init-agent.ts:194-209`), y `buildDirTree()` desciende pero **nunca detecta manifiestos en subdirectorios**. Consecuencias:

- **Proyecto en subcarpeta.** Es exactamente el caso de este repo: `CLI/` (raíz) no tiene `package.json`; está en `CLI/stratum-cli/`. Un `init` en la raíz produce Stack y Comandos vacíos pese a tener toda la información un nivel más abajo.
- **Monorepos** (`packages/*`, `apps/*` de pnpm/yarn/npm workspaces, Turborepo, Nx). No se detecta el manifiesto raíz como workspace ni los paquetes hijos.

Recomendación: tras leer el manifiesto raíz, hacer una pasada acotada (depth ≤ 2–3, respetando `EXCLUDED_DIRS`) buscando manifiestos adicionales. Si el `package.json` raíz declara `workspaces` (o existe `pnpm-workspace.yaml` / `turbo.json` / `nx.json`), tratarlo como monorepo y resumir los sub-paquetes. Si la raíz no tiene manifiesto pero hay exactamente uno en un hijo directo, considerar ese hijo como el proyecto real (o avisar al usuario).

### 1.2 El árbol de directorios omite los archivos (medio-alto)

`buildDirTree()` solo emite entradas de tipo directorio — `if (stat.isDirectory())` en `init-agent.ts:363`; las ramas de archivo no se añaden nunca. El LLM recibe carpetas pero **cero nombres de archivo**. Esto debilita justo la sección *Convenciones*: el modelo afirma "snake_case para archivos, PascalCase para clases" sin haber visto un solo nombre de archivo — es una suposición, no una observación.

Recomendación: incluir archivos en el árbol (al menos en `src/` y la raíz), con un límite por carpeta (p. ej. primeros 15–20, "+N más"). Los nombres reales son la mejor señal barata para inferir convenciones de naming.

### 1.3 Falta el fallback "sin manifiesto conocido" que exige la spec (medio)

La spec §12.13 dice explícitamente: *"Si no se detecta ningún manifiesto conocido, la sección Stack Tecnológico se genera con la lista de extensiones de archivo más frecuentes en `src/` o la raíz."* Esto **no está implementado**. Hoy, un proyecto sin manifiesto conocido (C/C++, .NET/`*.csproj`, Zig, Elixir/`mix.exs`, scripts sueltos) produce un STRATUM.md prácticamente vacío.

Recomendación: implementar el conteo de extensiones como fallback, y de paso ampliar `MANIFEST_FILES` con candidatos frecuentes que hoy faltan (`*.csproj`/`*.sln`, `mix.exs`, `pubspec.yaml`, `Package.swift`, `deno.json`, `bun.lockb`).

### 1.4 No se detecta el gestor de paquetes (medio)

`MANIFEST_FILES` incluye `package-lock.json` pero ignora `pnpm-lock.yaml`, `yarn.lock` y `bun.lockb` (`init-agent.ts:43-55`). Sin el lockfile correcto no se puede inferir si los comandos son `npm`, `pnpm`, `yarn` o `bun` — y la sección *Comandos Clave* puede salir con el runner equivocado.

Además, meter `package-lock.json` como "manifiesto" y truncarlo a 4000 chars (`init-agent.ts:201-204`) **gasta tokens en ruido**: un lockfile no aporta nada semántico al LLM. Mejor usar su mera presencia como señal del gestor y **no** volcar su contenido al prompt.

### 1.5 Sin metadatos de Git (medio, con nota de seguridad)

El scan no consulta Git. El remote, la rama por defecto y los últimos asuntos de commit son señales baratas y fiables para la identidad del proyecto (*Proyecto*) y para inferir convención de commits (*Convenciones*) en vez de adivinarla.

⚠️ **Nota de seguridad importante para tu caso:** el remote de este repo trae credenciales embebidas en la URL (un PAT de GitHub en `origin`). Si `init` llega a leer `git remote`, **debe sanear** la URL (quitar `user:token@`) antes de escribirla en `STRATUM.md`, que es un archivo que normalmente se versiona. De lo contrario filtrarías un token al repo.

### 1.6 Parser de `.gitignore` propio y parcial (bajo-medio)

`isGitignored()` reimplementa la semántica de `.gitignore` a mano (`init-agent.ts:381-462`). Cubre lo básico y los tests validan negaciones, pero le faltan casos reales: solo lee el `.gitignore` de la raíz (ignora `.gitignore` anidados y `.git/info/exclude`), no distingue patrones "solo-directorio" (`build/`) de archivos homónimos, y el glob casero no cubre todos los matices de `**`. Riesgo: incluir en el contexto archivos que el usuario considera ruido, o excluir de más.

Recomendación: o bien acotar el alcance documentando las limitaciones, o bien delegar en una librería probada (p. ej. `ignore`, ya estándar en el ecosistema Node) para no mantener semántica de `.gitignore` artesanal.

### 1.7 Presupuesto de tokens sin control (bajo-medio)

El prompt concatena manifiestos (4000 chars c/u), README (3000), todas las configs y todos los workflows (`synthesize()`, `init-agent.ts:468-508`). En un repo grande con `contextWindow` de 32768 (el default de `.stratumrc.json`), esto puede acercarse al límite o desplazar lo importante. No hay priorización ni recorte por presupuesto.

Recomendación: fijar un presupuesto de caracteres para el bloque de contexto y priorizar (manifiesto > scripts > README intro > configs > workflows), recortando lo de menor valor primero.

---

## Parte 2 — Calidad del contenido generado

### 2.1 Falta la sección de instrucciones al agente — la más valiosa (alto impacto)

Las cinco secciones fijas (`FIXED_SECTIONS`, `init-agent.ts:77-83`) son **puramente descriptivas**: Proyecto, Stack, Estructura, Convenciones, Comandos. Pero `system-prompt.ts:54` inyecta el STRATUM.md bajo el encabezado *"Honor these instructions and conventions"*, y la spec (Capa 1, §3, líneas 222-224) dice que el contenido típico incluye *"Instrucciones permanentes al agente"* y *"Restricciones y comportamientos preferidos"*. Esa sección —la que de verdad **dirige** al agente— no existe en la salida generada.

Es revelador que el `STRATUM.md` versionado en el repo **sí** tiene `## Instrucciones para el agente`, pero `InitAgent` genera un conjunto de secciones distinto (ver 2.5). El usuario que confíe en `/init` se queda sin el mecanismo principal de personalización.

Recomendación: añadir una sexta sección fija, p. ej. `## Instrucciones para el agente`, que `init` deja con un placeholder útil (ejemplos comentados) para que el usuario la rellene. Dado tu perfil (administración VMware + proyectos IA), aquí encajarían cosas como "confirmar siempre antes de comandos destructivos en hosts remotos" o "responder en español".

### 2.2 Se le pide al LLM lo que ya sabemos con certeza (alto impacto)

El prompt pide al modelo regenerar la *Estructura* ("árbol de directorios", `init-agent.ts:518`) y los *Comandos Clave* "exactamente como aparecen en el manifiesto" (`init-agent.ts:520`). Pero el árbol exacto **ya lo tenemos** del scan, y los scripts **ya están** en `package.json`. Pedírselos al LLM:

- Invita a deriva/alucinación (árboles inventados, scripts parafraseados).
- Desperdicia la certeza que ya teníamos.

Recomendación (patrón "deterministic-first"): inyectar el árbol real y los scripts extraídos del manifiesto **directamente** en el STRATUM.md, y reservar el LLM para lo que sí requiere síntesis (descripción del proyecto, anotar para qué sirve cada carpeta, inferir convenciones). Esto mejora fiabilidad y reduce tokens a la vez.

### 2.3 Parsing frágil: si el modelo se desvía, la sección queda vacía (alto)

`parseGeneratedSections()` (`init-agent.ts:540-562`) trocea por `^## (.+)$` y mapea por **nombre exacto** de sección. Si el modelo local (un coder de 32B vía Ollama) añade un preámbulo, traduce el encabezado ("Tech Stack" en vez de "Stack Tecnológico"), o usa `###`, el `match` falla en silencio y `FIXED_SECTIONS` rellena con cadena vacía → placeholder. No hay validación ni reintento.

Recomendaciones: (a) hacer el match tolerante (normalizar acentos/idioma, aceptar variantes), o mejor (b) pedir salida estructurada (un bloque por sección con delimitadores explícitos, o JSON con claves fijas) y **validar**: si faltan secciones esperadas, reintentar una vez antes de caer al placeholder.

### 2.4 Prompt de síntesis pobre y no determinista (medio-alto)

El prompt (`init-agent.ts:510-522`) es correcto pero mínimo: no incluye few-shot, ni la tabla de heurísticas de detección de stack de la spec (§12.13, "Heurísticas de detección"), ni instrucción de **anclar afirmaciones en evidencia** (no inventar convenciones), ni control de idioma del *contenido* (las etiquetas son español pero el cuerpo queda al azar del modelo), ni temperatura fija. La spec incluye un ejemplo de salida excelente que no se está aprovechando como guía.

Recomendaciones: enriquecer el prompt con un ejemplo de salida (el de la spec), las heurísticas de stack, una instrucción explícita de "si no hay evidencia para una afirmación, omítela", y fijar `temperature` baja para reproducibilidad.

### 2.5 Incoherencia de plantillas — reconciliar (medio, pero hacer primero)

Hay tres "verdades" distintas sobre qué secciones tiene un STRATUM.md:

| Fuente | Secciones |
|---|---|
| Spec §12.13 (estructura fija) | Proyecto, Stack Tecnológico, Estructura, Convenciones, Comandos Clave |
| `InitAgent.FIXED_SECTIONS` (`init-agent.ts:77-83`) | Igual que la spec (5) |
| `STRATUM.md` versionado en `stratum-cli/` | Proyecto, **Instrucciones para el agente** (solo 2) |

El template versionado no coincide con lo que genera el código ni con la spec. Conviene decidir el conjunto canónico (recomendado: las 5 de la spec **+** "Instrucciones para el agente" del punto 2.1) y alinear los tres sitios, incluido el `isPlaceholder()` que aún busca un texto antiguo (`init-agent.ts:632`).

### 2.6 El merge línea-a-línea puede ensuciar el contenido (medio)

`mergeContent()` (`init-agent.ts:614-625`) hace una unión a nivel de línea: añade al final las líneas nuevas que no existían textualmente. Esto produce duplicados semánticos (dos viñetas que dicen lo mismo con distintas palabras), rompe el orden lógico y puede dejar afirmaciones contradictorias conviviendo. Para texto en prosa o viñetas reordenadas es poco fiable.

Recomendación: para secciones en conflicto, en lugar de unión textual, pasar ambas versiones al LLM para que produzca una fusión coherente (de-duplicada y ordenada), o como mínimo presentar el diff al usuario en vez de concatenar a ciegas.

---

## Recomendaciones priorizadas

**Hacer primero (desbloquea el resto):**

1. **Reconciliar plantillas** (2.5) y **añadir la sección de instrucciones al agente** (2.1). Es barato y define el contrato de salida sobre el que se construye todo lo demás.

**Alto impacto en robustez:**

2. **Detección de proyecto anidado / monorepo** (1.1) — sin esto, `/init` falla en tu propio repo.
3. **Incluir archivos en el árbol** (1.2) y **fallback por extensiones** (1.3).

**Alto impacto en calidad:**

4. **Deterministic-first**: inyectar árbol y scripts reales en vez de pedírselos al LLM (2.2).
5. **Parsing robusto con validación/reintento** (2.3) y **prompt enriquecido + temperatura fija** (2.4).

**Mejoras incrementales:**

6. Detección de gestor de paquetes por lockfile y dejar de volcar lockfiles al prompt (1.4).
7. Metadatos de Git **con saneo de credenciales** (1.5) — relevante por el PAT en tu remote.
8. Presupuesto de tokens (1.7), merge asistido por LLM (2.6), y delegar `.gitignore` a `ignore` (1.6).

---

## Apéndice — Esbozo de prompt mejorado (referencia)

Idea, no implementación. Combina inyección determinista + síntesis acotada + salida validable:

```
Eres un asistente que documenta proyectos. Vas a generar secciones de un
STRATUM.md a partir de EVIDENCIA verificada del repo.

REGLAS:
- Usa solo la evidencia proporcionada. Si no hay evidencia para una
  afirmación, OMÍTELA. No inventes convenciones ni comandos.
- Responde en español.
- Devuelve EXACTAMENTE estas claves, una por bloque, entre delimitadores:
  <<<PROYECTO>>> ... <<<END>>>
  <<<STACK>>> ... <<<END>>>
  <<<CONVENCIONES>>> ... <<<END>>>
  (Estructura y Comandos se rellenan de forma determinista, no los generes.)

HEURÍSTICAS DE STACK (aplica si procede):
  package.json + typescript(devDeps) -> TypeScript
  react + ink -> UI terminal con Ink
  vitest|jest -> framework de test
  pnpm-lock.yaml -> gestor pnpm ; yarn.lock -> yarn ; bun.lockb -> bun
  ...

EVIDENCIA:
  [manifiesto(s) detectado(s), scripts extraídos, lockfile presente,
   árbol con archivos, metadatos git saneados, intro del README]

EJEMPLO DE SALIDA BIEN HECHA:
  [el ejemplo de la spec §12.13]
```
