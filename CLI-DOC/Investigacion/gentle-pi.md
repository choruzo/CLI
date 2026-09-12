# Investigación — `gentle-pi` (Gentleman Programming)

**Fuente:** https://github.com/Gentleman-Programming/gentle-pi · v2.5.0 · MIT (el nombre/logo son marca registrada)
**Fecha:** 2026-09-11 · Clonado, analizado y borrado. Este documento es el entregable.

---

## 1. Qué es y por qué nos importa

`gentle-pi` **no es un CLI**: es un *paquete de extensiones* para el agente **Pi** (`@earendil-works/pi-coding-agent`). Instala una capa de disciplina operativa encima de un agente que ya existe: persona, enrutado de trabajo, subagentes, SDD/OpenSpec, TDD estricto, guardas de seguridad y review acotado.

Eso lo hace **muy complementario a Stratum**: nosotros tenemos el motor (ReAct, providers, tools, MCP, SSH, memoria, subagentes) y ellos tienen el **harness de disciplina** encima. Casi todo lo aprovechable es *prompt engineering estructurado + políticas*, no código que haya que portar.

**Estructura del repo:**

| Carpeta | Contenido | Utilidad para nosotros |
|---|---|---|
| `extensions/` | 12 extensiones TS (tools + UI) | Alta: `gentle-todo`, `codegraph-tools`, `skill-registry`, `quiet-tools` |
| `lib/` | 77 módulos (review engine, TUI, métricas) | Media: `review-risk`, `runtime-metrics`, `shell-changes` |
| `assets/` | Prompts de orquestador, agentes SDD, chains | **Muy alta**: los prompts son portables tal cual |
| `skills/` | 13 skills markdown (`SKILL.md` + frontmatter) | Alta: formato y concepto |
| `contracts/` | JSON Schemas de telemetría y review | Media |
| `docs/` | Guía de estilo de skills, arquitectura | Alta (`skill-style-guide.md`) |

**Lo que NO deberíamos copiar:** el motor de review (`review-*.ts`, ~10k líneas), la máquina SDD/OpenSpec completa, el binario nativo Go verificado, la telemetría con schemas versionados. Es infraestructura para su ecosistema propietario; la complejidad no se justifica en Stratum.

---

## 2. Recomendaciones priorizadas

### P1 — Tool `todo` con re-inyección en el system prompt

**Lo que hacen** (`extensions/gentle-todo.ts` + `lib/shell-todo.ts`):

Una tool `todo` con acciones `write | add | update | clear | list`. Lo verdaderamente inteligente no es la lista, son tres decisiones:

1. **`write` reemplaza la lista entera**, conservando los `id` de las tareas que ya existían. El modelo no tiene que hacer diffs mentales: reescribe el plan y ya.
2. **Cada turno, el hook `before_agent_start` inyecta el bloque de tareas abiertas en el system prompt.** Una descripción estática de tool no basta para que el modelo mantenga la lista al día; recordárselo en cada turno sí.
3. **Detección de *staleness*:** si pasan ≥2 turnos con tareas abiertas y sin llamar a `todo`, se añade al prompt `(stale: N turns without an update — bring the list up to date now)` y se marca visualmente al humano.

El estado vive en el historial de sesión (cada tool result carga el snapshot completo) → el replay al reanudar es gratis. Una lista terminada se limpia al turno siguiente. Máx. 12 filas visibles: las `done` colapsan a `✓ N done`.

Las *prompt guidelines* de la tool merecen copiarse casi literales:

```
- Use todo for work with three or more steps or when the user hands you a list.
  Skip it for single trivial requests.
- Mark a task in_progress before starting it and done right after finishing it;
  keep exactly one task in_progress.
- Prefer write with the complete list whenever the plan changes; keep ids of
  tasks that already exist.
- Never mark a task done while tests fail or the work is partial; add a task
  for the blocker instead.
```

**Para Stratum:** encaja perfectamente entre `present_plan` (Hito 7, plan formal con gate de aprobación) y nada. El plan es pesado: requiere aprobación, persiste en `.stratum/plans/`, tiene fases. Un `todo` es el escalón ligero para trabajo de 3-8 pasos que no justifica ceremonia.

- Nueva tool `tools/todo.ts`, `serialized: true`, interceptada por el loop como las de plan.
- Estado en `ReactLoop` (o `SessionContext`), snapshot completo en cada tool result para que `chat --resume` lo recupere sin store nuevo.
- `ContextManager`/`composeMessages` inyecta el bloque `## Todo list` + la línea de staleness antes de cada iteración.
- UI: reutilizar `PlanSteps.tsx` — mismos iconos `○◐✓`. Colapsable con `Ctrl+Shift+T`.
- Reglas de estado compartidas con `PlanStepStatus` (`pending`/`in_progress`/`done`) para no duplicar vocabulario.

---

### P1 — Escalera de enrutado de trabajo (Work Routing Ladder)

**Lo que hacen** (`assets/orchestrator.md`, `assets/orchestrator-delegation.md`):

El prompt del padre define **tres niveles** y **umbrales numéricos concretos** para pasar de uno a otro:

1. **Inline Direct** — pequeño, mecánico, con contexto ya en el padre (typo, edición de un fichero, lectura de 1-3 ficheros conocidos, `bash` para leer estado).
2. **Simple Delegation** — un subagente acotado: exploración read-only, implementación acotada, verificación.
3. **SDD / plan formal** — solo por petición explícita o propuesta aceptada. **Tamaño y riesgo por sí solos nunca seleccionan este nivel.**

Y disparadores obligatorios, medibles:

| Regla | Umbral | Acción |
|---|---|---|
| Lectura acotada | 1–3 ficheros | inline |
| **Regla de 4 ficheros** | entender requiere ≥4 ficheros | delegar un mapeador read-only |
| **Regla de escritura múltiple** | ≥2 ficheros no triviales | delegar **un** escritor |
| Regla de contexto | lectura que prepara una escritura, investigación amplia | delegar junto con la escritura |
| Regla de incidente | cwd equivocado, mutación accidental, entorno raro | diagnosticar **aparte** antes de seguir |
| **Regla de sesión larga** | ~20 tool calls / 5 lecturas exploratorias / 2 ediciones no mecánicas sin delegar | pausar y delegar el resto |

Tabla acción→ruta que resuelve la ambigüedad de un vistazo:

| Acción | Inline | Worker delegado |
|---|---|---|
| Leer para decidir/verificar (1–3 ficheros) | sí | — |
| Leer para explorar/entender (4+) | — | sí, un mapeador estrecho |
| Leer como preparación para escribir | — | sí, junto con la escritura |
| Escribir 1 fichero mecánico ya entendido | sí | — |
| Escribir 2+ ficheros no triviales | — | sí, un escritor |
| `bash` para estado (`git`, `gh`) | sí | — |
| Tests, builds, instalaciones | permitido acotado | sí, worker fresco por acción |

La pregunta rectora, repetida en todo el prompt: **«¿esto infla el contexto del padre sin necesidad?»**

**Para Stratum:** hoy `delegate_task` existe (Hito 8A/8B/8C) pero **el system prompt no le dice al modelo cuándo usarlo**. Con modelos locales pequeños eso significa que casi nunca delega, o delega mal. Añadir un bloque `## Work routing` a `system-prompt.ts`, inyectado solo cuando hay perfiles de agente disponibles, con estos umbrales adaptados a nuestros nombres de tools. Es la mejora de mayor ratio impacto/esfuerzo de todo el informe: son ~40 líneas de prompt.

**Variante adicional útil:** *«Escribe los prompts hacia subagentes en inglés por defecto, aunque el usuario hable español.»* Baja tokens y da a los hijos un lenguaje operativo consistente sin cambiar la persona de cara al usuario. Excepciones: citas literales, mensajes de error, nombres de fichero, comandos, y cuando la salida del hijo se va a pegar directamente al usuario.

---

### P1 — Guardas de runtime por capas (allow / confirm / block)

**Lo que hacen** (`extensions/gentle-ai.ts`, líneas ~1180-1700):

Tres capas ordenadas y **no negociables en ese orden**:

1. **Hard-deny** — patrones que se bloquean *siempre*, la config no los puede levantar:
   ```js
   /\brm\s+-rf\s+(?:\/(?:\s|$)|~(?:\/|\s|$)|[$]HOME(?:\/|\s|$)|\.\.?(?:\s|$))/
   /\bgit\s+reset\s+--hard\b/
   /\bgit\s+clean\b(?=[^\n]*(?:-[^\n]*f|--force))(?=[^\n]*(?:-[^\n]*d|--directories))/
   /\bgit(?:\s+--?\S+(?:\s+[^-\s]\S*)?)*\s+push\b(?=[^\n]*\s--force(?:-with-lease)?\b)/
   /\bchmod\s+-R\s+777\b/   ·   /\bchown\s+-R\b/
   ```
   Nótese el detalle: el regex de `git push` tolera flags globales intermedios (`git -C /repo push --force`), que es justo como se escapan los patrones ingenuos.

2. **Comandos guardados con acción configurable** — un mapa `clave → allow|confirm|block`:
   ```
   gitPush: allow   ·   gitRebase: confirm   ·   gitBranchDeleteForce: confirm
   npmPublish: block   ·   piRemove: confirm
   ```
   En modo normal *todo* lo guardado pide confirmación; solo en «modo autónomo» se aplican las acciones configuradas. Es decir: **la autonomía no se activa por descuido, y aun activada `npm publish` sigue bloqueado**.

3. **Rutas sensibles** — `read`/`write`/`edit` se bloquean contra:
   ```js
   /(^|\/)\.ssh(?:\/|$)/   ·   /(^|\/)\.aws\/credentials$/
   /(^|\/)\.config\/gh\/hosts\.ya?ml$/   ·   /(^|\/)secrets(?:\/|$)/
   /(^|\/)\.env(?:$|[./_-])/   ·   /\.(?:pem|key|p12|pfx)$/
   /(^|\/)library\/keychains(?:\/|$)/   ·   /(^|\/)\.credentials(?:\/|$)/
   ```
   La extracción de rutas es **recursiva sobre los parámetros de la tool** (`collectPathInputs`), buscando claves conocidas (`path`, `paths`, `file`, `files`, `filePath`, `filePaths`) a cualquier profundidad — no asume una forma plana de parámetros.

**Para Stratum:** ya tenemos `tools.destructivePatterns` + `isDestructive()`, que cubre la capa 2 a medias. Nos faltan las capas 1 y 3:

- **Hard-deny no configurable** en `shell/bash.ts` y `ssh/exec.ts`: hoy cualquier patrón se puede desactivar vaciando la config. Un `rm -rf /` nunca debería depender de un fichero JSON. Reutiliza `commandIsDestructive` pero añade una lista `HARD_DENY` previa que devuelve `recoverable: false`.
- **Gate de rutas sensibles** en `fs/read.ts`, `fs/write.ts`, `fs/edit.ts`: `.env`, `.ssh/`, `*.pem`, `~/.aws/credentials`. Encaja con nuestro `ToolContext.confirmDestructive`. Es la protección que hoy nos falta y la que más probablemente muerda en la práctica: un agente leyendo `.env` y volcándolo al provider.
- **Mapa `allow|confirm|block` por comando conocido** en `.stratumrc.json` (`tools.guardedCommands`), con `npm publish` y `git push --force` en `confirm` por defecto.

---

### P2 — Registro de skills descubiertas (`.atl/skill-registry.md`)

**Lo que hacen** (`extensions/skill-registry.ts`, 621 líneas):

Escanean ~17 directorios de skills de usuario (`~/.claude/skills`, `~/.config/opencode/skills`, `~/.codex/skills`, `~/.cursor/skills`…) y ~13 de proyecto (`./skills`, `.claude/skills`, `.pi/skills`…), leen el frontmatter de cada `SKILL.md` (`name`, `description`) y **generan una tabla markdown** `.atl/skill-registry.md` con `Nombre | Descripción/Trigger | Path | Scope`.

Detalles de ingeniería que valen:
- **Caché por fingerprint** (`sha1` del contenido + `mtime` + versión de schema) → no regenera si nada cambió.
- **`watch` con debounce de 500 ms** sobre los directorios → el registro se mantiene vivo durante la sesión.
- **Dedup por nombre con precedencia de proyecto** sobre usuario.
- **Escritura atómica** (write a temporal + `rename`).
- Parser de frontmatter propio que soporta bloques `>`/`|` de YAML, sin dependencias.

El protocolo de uso (en `orchestrator-skills.md`) es lo interesante: **el padre resuelve los paths una vez por sesión** y se los pasa a los subagentes bajo una cabecera `## Skills to load before work`. Los hijos no redescubren nada. Y el hijo reporta cómo los resolvió: `paths-injected` (correcto) / `fallback-registry` / `fallback-path` / `none` — si un hijo reporta fallback, es una **brecha de orquestación del padre**, y así queda auditable.

**Para Stratum:** ya tenemos `ProfileLoader` para perfiles de agente (`.stratum/agents/*.md`, markdown + frontmatter, proyecto > global). El salto natural es **el mismo mecanismo pero para «instrucciones de tarea»**: `.stratum/skills/<nombre>/SKILL.md`, descubiertas, indexadas, e inyectadas como una tabla compacta `nombre → descripción` en el system prompt, con el contenido cargado bajo demanda vía `read_file`.

Lo que sí copiaría del diseño: el **fingerprint cacheado** y el patrón «índice barato siempre en contexto, cuerpo caro solo cuando hace falta». Lo que no: escanear 30 directorios de otros agentes. Bastaría `~/.stratum/skills/` + `<proyecto>/.stratum/skills/`, con quizá `.claude/skills` como cortesía.

---

### P2 — Tool `codegraph` como patrón de integración de binario externo

**Lo que hacen** (`extensions/codegraph-tools.ts`):

Una tool que envuelve el binario `codegraph` (índice semántico de código) con tres operaciones: `init`, `query`, `explore`. Lo valioso no es codegraph, es **cómo la envuelven**:

- **La tool nunca acepta una ruta.** Opera siempre sobre `ctx.cwd` resuelto. Elimina de raíz el vector de «usa esta tool para indexar `/etc`».
- **Valida que el cwd sea una raíz de repo Git real**, y rechaza explícitamente `$HOME` y `$TMPDIR`.
- **Comprueba que `.codegraph` no sea un symlink** antes de escribir en él.
- **Degradación explícita, nunca error duro:** si el binario no existe (`ENOENT`) devuelve un resultado *exitoso* cuyo texto dice `"CodeGraph is unavailable… Use read, grep, and find for this exploration."`. El modelo recibe una instrucción de fallback, no una excepción que interrumpa el loop.
- **Workaround de Windows documentado en el propio código:** npm en Windows instala solo shims `.cmd`/`.ps1`, sin `.exe`, así que `execFile` (que usa `CreateProcess` sin shell) siempre da `ENOENT`. Resuelven el `package.json` del paquete global, sacan el `bin` real y lo lanzan con `process.execPath` — **sin shell**, así que los argumentos nunca se reinterpretan.

**Para Stratum:** dos cosas concretas.

1. **El patrón de fallback instructivo** debería ser nuestra norma para toda tool opcional. Hoy si `sqlite-vec` o `@xenova/transformers` faltan, degradamos internamente (bien), pero una tool cuyo binario externo falta debería devolver *texto que le diga al modelo qué hacer en su lugar*, no un `tool_error`.
2. **El truco de Windows** es directamente aplicable si alguna vez envolvemos un binario npm global. Vale la pena tenerlo anotado: es exactamente la clase de bug que cuesta una tarde.

---

### P2 — Clasificación de riesgo del diff y selección de «lentes» de review

**Lo que hacen** (`lib/review-risk.ts`):

A partir de `git diff --numstat` calculan un *tier* (`low`/`medium`/`high`) y de ahí seleccionan qué revisores lanzar. El modelo mental son **4 lentes (4R)**:

| Lente | Qué busca |
|---|---|
| **R1 Risk** | seguridad, límites de privilegio, exposición de datos, dependencias |
| **R2 Readability** | naming, complejidad, intención, mantenibilidad, tamaño del review |
| **R3 Reliability** | cobertura orientada a comportamiento, casos borde, determinismo, contratos |
| **R4 Resilience** | fallbacks, retry/backoff, degradación, observabilidad, rollback, SLO |

La selección de lente dominante es puro pattern-matching sobre rutas:

```js
HIGH_RISK_TOKEN  = /^(?:auth|authentication|authorization|update|updater|security|
                      payments?|permissions?|shell|process|processes|secrets?|
                      credentials?|tokens?)$/i
RESILIENCE_PATH  = /(?:^|\/)(?:update|deploy|infra|ops|migrations?|rollback|recovery)(?:\/|$)/
RELIABILITY_PATH = /(?:^|\/)(?:tests?|specs?|runtime|api)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/
```

Y dos constantes con criterio detrás:
- `LARGE_AUTHORED_CHANGE_LINES = 400` — umbral de «esto ya es un PR demasiado grande para un humano».
- `correctionBudget = min(200, ceil(líneas_originales / 2))` — **el fix de un review no puede ser más grande que la mitad del cambio que revisa.** Si lo es, no es una corrección: es un cambio nuevo disfrazado. Esta métrica es la idea más aguda del módulo.

Excluyen del recuento los binarios, los cambios de solo-modo y los goldens generados (`^testdata/golden/`) — pero deliberadamente **no** los tests normales ni los fixtures, que sí son trabajo autoral.

**Para Stratum:** no necesitamos su motor de review. Sí es directamente aprovechable:
- **Clasificar riesgo para decidir cuántos subagentes lanzar.** Ya tenemos `runDelegations` con semáforo; falta la política de *cuántos* y *de qué perfil*. Un `classifyRisk(diffStats)` en ~60 líneas puras, testeable, alimentaría esa decisión.
- **El «reviewer protection»:** avisar al usuario *antes* de que una tarea se convierta en un diff de 400+ líneas. Encaja como un `warning` emitido desde el loop cuando el write-log acumulado cruza el umbral.

---

### P3 — Modo TDD estricto con evidencia obligatoria

**Lo que hacen** (`assets/support/strict-tdd.md`, ~250 líneas de prompt):

Cuando la config del proyecto declara un comando de tests, las fases de apply/verify **deben registrar evidencia** del ciclo `SAFETY NET → RED → GREEN → TRIANGULATE → REFACTOR`, en una tabla markdown por tarea.

Las partes genuinamente originales, que funcionarían con cualquier modelo:

- **SAFETY NET:** antes de tocar un fichero existente, correr sus tests y capturar el baseline («5 tests passing»). Si alguno ya falla → **parar y reportar como fallo preexistente, NO arreglarlo**. Esa línea base es la prueba de que no rompiste nada.
- **TRIANGULATE obligatorio por defecto:** hay que argumentar para saltárselo. Un solo test permite que el modelo «finja» (hardcodear el retorno). Un segundo caso con entradas distintas fuerza la lógica real. Solo se salta si la tarea es puramente estructural, hay literalmente una salida posible, y se anota `Triangulation skipped: {razón}`.
- **Detección de GREEN falsos** — la lista es excelente y aplica a cualquier agente que escriba tests:
  - pasa porque el componente nunca se renderizó → no es GREEN
  - pasa porque un bucle iteró 0 veces (*ghost loop*: el cuerpo del bucle es código muerto) → no es GREEN
  - pasa porque el setup no dispara el code path → no es GREEN
- **Aserciones prohibidas:** tautologías (`expect(true).toBe(true)`), colecciones vacías sin justificación de por qué están vacías, aserciones solo-de-tipo (`toBeDefined()` a secas), y **nombres de clases CSS** (jamás son una aserción válida).
- **Regla mocks/aserciones:** ≤3 mocks sano · 4-6 revisar · **7+ estás testeando en la capa equivocada**. Corolario, *Extract-Before-Mock*: si lo que quieres probar es una transformación de datos, extráela a función pura y pruébala sin un solo mock.
- Durante el ciclo, correr **solo el fichero de test relevante**, nunca la suite completa. La suite se corre en verify.

**Para Stratum:** esto es un `.stratum/agents/tdd.md` (perfil de subagente) más un bloque opcional de system prompt activado por `tools.testCommand` en la config. Cero código. Yo empezaría por el perfil: nuestro Hito 8 ya soporta perfiles con toolset filtrado, así que un perfil `tdd` con estas reglas es un fin de semana de trabajo y transforma la calidad de los tests que genera un modelo local.

---

### P3 — Panel de cambios del working tree

**Lo que hacen** (`lib/shell-changes.ts`): parsean `git diff --numstat` + `git status --porcelain -z` en un modelo (`path`, `added`, `deleted`, `status ∈ {modified, added, deleted, renamed, untracked}`) y lo pintan como widget persistente sobre el editor, con totales `+N/-M`.

**Para Stratum:** un `/changes` o un segmento en `StatusBar.tsx` con `+N/-M` acumulado de la sesión. Es información que el usuario mira constantemente y que hoy obliga a salir al shell. Barato: el parseo son ~80 líneas puras y ya tenemos el patrón de `<Static>` + widget.

---

### P3 — Métricas de uso y ventanas de rate limit

**Lo que hacen** (`lib/runtime-metrics.ts`, `lib/shell-usage.ts`): contabilidad local de tokens por `agentClass` × modelo × effort, con estados explícitos por medición: `reported` / `unavailable` / `unsupported`. **Nunca infieren un valor que el backend no dio.** Y parsean las cabeceras de rate limit de Anthropic (`anthropic-ratelimit-unified-*`) y Codex para pintar medidores de ventana (5h / 7d) con porcentaje y tiempo de reset.

**Para Stratum:** el rate-limit de proveedores cloud nos da igual (somos local-first), pero **la contabilidad de tokens con estados explícitos sí importa**. Hoy en Hito 8B, si el backend no devuelve `usage`, `SubagentResult.usage.tokens` queda `undefined` y el presupuesto se ignora en silencio. Distinguir `unavailable` (el backend no lo mandó) de `unsupported` (este backend nunca lo manda) permitiría avisar una sola vez al usuario en lugar de degradar mudamente. Es un cambio pequeño de tipos con buen retorno en diagnosticabilidad.

---

## 3. Ideas transversales de prompting

Sueltas, pero de las que más valor tienen por línea:

- **Prompts lazy-loaded por punteros.** `orchestrator.md` (96 líneas, siempre en contexto) contiene solo punteros: *«antes de tocar SDD, lee `sdd-orchestrator-workflow.md`»* (338 líneas, bajo demanda). El system prompt siempre-activo se mantiene corto; el detalle se carga cuando se necesita. Directamente aplicable a nuestro `system-prompt.ts`, que tiende a crecer.
- **Contrato de identidad explícito.** «Cuando te pregunten qué eres, responde X, no "tu asistente".» Evita que el modelo se presente como un chatbot genérico y olvide sus capacidades.
- **Dominio de idioma separado en tres.** (1) conversación con el usuario → idioma del usuario; (2) **artefactos técnicos** (código, comentarios, commits, nombres de fichero, tests, docs de repo) → **inglés por defecto siempre**, salvo que el proyecto ya sea otra cosa; (3) comentarios públicos (PR, issues, Slack) → idioma del hilo destino. Nosotros hoy solo tenemos (1). Para un proyecto en español con código en inglés, la distinción (2) evita commits mezclados.
- **Prompts de elección cerrada.** Su `ask_user_choice` acepta 2-4 opciones ordenadas, `allowCustomResponse` **opt-in explícito**, y devuelve un token opaco (nunca se re-parsea la etiqueta ni el ordinal). Nuestra tool `question` ya es parecida; lo que podríamos adoptar es el token opaco y la validación estricta del dominio de respuesta: aceptar solo coincidencia exacta con **una** opción, rechazar cero coincidencias y rechazar múltiples.
- **«Una pregunta sobre el bloqueo no es una respuesta al bloqueo.»** Si el usuario pregunta *por qué* hace falta su input o qué significa una opción, se le contesta desde el envelope que ya tienes — y luego **se vuelve a presentar la pregunta completa y se sigue esperando**. Sin elegir por él. Regla pequeña, evita un fallo muy real.
- **Registro de worktree por sesión** (`session-worktree-registry.ts`): al resolver rutas con git, **limpian todas las variables `GIT_*` del entorno del hijo** para que el enrutado ambiental (`GIT_DIR`, `GIT_WORK_TREE`) no redirija una ruta a otro repositorio. Nos aplica en `bash` y en subagentes.

---

## 4. Plan de adopción sugerido

| # | Qué | Dónde | Esfuerzo | Valor |
|---|---|---|---|---|
| 1 | Bloque `## Work routing` con umbrales de delegación | `agent/system-prompt.ts` | S | Muy alto |
| 2 | Hard-deny no configurable + gate de rutas sensibles | `tools/shell/bash.ts`, `tools/fs/*`, `tools/ssh/exec.ts` | S | Muy alto |
| 3 | Tool `todo` + inyección por turno + staleness | `tools/todo.ts`, `agent/harness.ts`, UI | M | Alto |
| 4 | Perfil `tdd.md` con ciclo estricto y evidencia | `.stratum/agents/tdd.md` | S | Alto |
| 5 | Fallback instructivo en tools opcionales | `tools/*` | S | Medio |
| 6 | Registro de skills `.stratum/skills/` con fingerprint | nuevo `skills/` | M | Medio |
| 7 | Idioma: artefactos técnicos en inglés | `agent/system-prompt.ts` | XS | Medio |
| 8 | `classifyRisk(diff)` → política de delegación | `agent/risk.ts` | M | Medio |
| 9 | Panel `/changes` con `+N/-M` | `cli/ui/` | S | Medio |
| 10 | Tokens con estado `reported`/`unavailable`/`unsupported` | `agent/types.ts`, `harness.ts` | S | Bajo |
| 11 | Prompts lazy-loaded por punteros | `agent/system-prompt.ts` | M | Medio |

**Mi recomendación:** 1 + 2 primero. Son el mayor cambio de comportamiento por unidad de esfuerzo, no tocan arquitectura, y el 2 cierra un agujero de seguridad real que hoy tenemos abierto (nada impide que el agente lea y transmita un `.env`).

---

## 5. Licencia

MIT para el código. **El nombre y el logo `gentle-pi` son marca de Alan Buscaglia** — la licencia no permite implicar respaldo ni afiliación. Como lo que adoptamos son ideas y patrones de prompt reescritos, no hay problema; si en algún momento copiamos un fichero de prompt casi literal (por ejemplo el módulo de TDD estricto), corresponde acreditar la fuente en el propio fichero.
