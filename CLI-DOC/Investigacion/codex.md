# Investigación — `codex` (OpenAI)

**Fuente:** https://github.com/openai/codex · commit `58ae3ba` (2026-10-03) · Apache-2.0
**Fecha:** 2026-10-03 · Clonado y analizado leyendo código y plantillas de prompt; no se ejecutó nada. Revalidado dos veces el mismo día: una pasada propia contra el clon (*[rev]*) y una revisión de Codex contra el clon y contra `stratum-cli/src` (*[rev2]*). Este documento es el entregable.

---

## 1. Qué es y por qué nos importa

Codex CLI es el agente de terminal de OpenAI. El código vive en `codex-rs/`: un workspace de Rust con más de cien crates. A diferencia de `gentle-pi` (una capa de disciplina sobre un agente ajeno), Codex es **un motor completo, como Stratum**, así que la comparación es de igual a igual: dónde resolvieron ellos algo que nosotros aún no tenemos.

La mayor parte del repo no nos sirve: es infraestructura de producto (sandbox nativo por plataforma, proxy de red, app-server, tareas en la nube, voz) o está atada a la Responses API. Lo aprovechable se concentra en pocos crates, y casi todo son **contratos y políticas**, no código que portar (es Rust; aquí todo se reescribe).

| Crate / carpeta | Contenido | Utilidad para nosotros |
|---|---|---|
| `core/src/unified_exec/` | Procesos interactivos y en segundo plano | **Muy alta** |
| `execpolicy/` | Reglas de aprobación por prefijo de comando | **Muy alta** |
| `exec/` | Modo no interactivo (`--json`, `--output-schema`) | Alta |
| `hooks/` | Hooks de ciclo de vida como comandos externos | Alta (contrasta con `Plugins-Implementacion.md`) |
| `prompts/templates/review/` | Rúbrica de code review con salida estructurada | Alta |
| `memories/` | Extracción y consolidación de memoria en dos fases | Media (dos ideas sueltas) |
| `core/src/agents_md.rs` | `AGENTS.md` jerárquico + confianza de proyecto | Media |
| `apply-patch/` | Formato de parche propio | Baja (una función) |
| `linux-sandbox`, `windows-sandbox-rs`, `bwrap`, `network-proxy` | Sandbox de SO y proxy MITM | Ninguna (ver §4) |
| `core/src/guardian/`, `code-mode*`, `app-server*`, `cloud-*`, `realtime-*` | Producto OpenAI | Ninguna (ver §4) |

---

## 2. Recomendaciones priorizadas

### P1 — Procesos vivos en `exec` (`yield` + sesión)

**Lo que hacen** (`core/src/unified_exec/`, `core/src/tools/handlers/unified_exec.rs`, `shell_spec.rs`):

Dos tools. `exec_command` lanza el comando y espera como mucho `yield_time_ms` (10 s por defecto, rango efectivo 250 ms–30 s; en Windows el suelo es 10 s). Si el proceso terminó, devuelve salida y `exit_code`. **Si sigue vivo, devuelve la salida hasta ese momento y un `session_id`**, y el proceso continúa. `write_stdin(session_id, chars)` le escribe y devuelve la salida nueva; con `chars` vacío es un simple sondeo (espera mínima 5 s, para que el modelo no sondee en bucle).

Decisiones que merecen copiarse:

1. **Una sola forma de respuesta** para «terminó» y «sigue»: `{ output, wall_time_seconds, exit_code?, session_id?, original_token_count? }`. El modelo distingue por la presencia de `exit_code` o `session_id`.
2. **Buffer cabeza + cola** (`head_tail_buffer.rs`): 1 MiB por proceso, mitad para el principio y mitad para el final, descartando el medio con un marcador de bytes omitidos. El proceso nunca se mata por hablar demasiado.
3. **Tope de procesos vivos** (64). *[rev2]* Es un límite blando: al alcanzarlo no se rechaza el proceso nuevo, se **poda uno existente y se le mata**, protegiendo los ocho más recientes. Para Stratum prefiero rechazar el nuevo con un error instructivo; matar un proceso que el usuario dejó corriendo es peor sorpresa. *[rev]* `background_terminal_max_timeout` (5 min por defecto) **no** es un tope de vida del proceso: es el máximo que puede esperar un sondeo vacío de `write_stdin`. Un proceso en segundo plano vive hasta que termina, se le mata o acaba la sesión.
4. **`max_output_tokens` por llamada** (10 000 por defecto): el modelo pide más o menos salida según lo que busca.

**Para Stratum:** hoy `exec` es de un solo disparo con timeout. Un `npm run dev`, un `tail -f`, un `kubectl logs -f`, un `docker compose up` o un instalador que pregunta algo no tienen salida buena: o se cuelgan hasta el timeout o hay que envolverlos a mano. Para la orientación de infraestructura esto pesa más que para código.

- Encaja como capacidad nueva de `IExecBackend` (`capabilities.background`), declarada por backend igual que `pty`. El backend `ssh` ya tiene el canal abierto; el `local` ya corre con `buffer: false` y `ByteBudget`.
- Esquema: `exec` gana `yieldMs`; tool nueva `exec_input { session, chars? }` (sondea si `chars` falta) y `exec_kill { session }`. Mejor tres tools pequeñas que un `exec` con modos.
- El resultado `<exec_result>` gana `status="running"` y `session`. Un `running` no es fallo: `ok: true`.
- Lo que hay que decidir antes de implementar, porque toca invariantes nuestras:
  - **Guardas** *[rev2]*: lo que se escribe por stdin a un shell vivo es un comando que no pasó por `commandVeto` ni por `callEffects`. Heredar los efectos de la sesión y pasar por `environmentGate` **no basta**: ese gate no aplica el hard-deny, ni `guardedCommands`, ni las rutas sensibles, así que sería un bypass de las tres capas. Codex vuelve a comprobar permisos e identidad del proceso en cada escritura (`stdin_approval.rs`, `process_manager.rs`). El diseño tiene que:
    - separar **sondear** (sin `chars`, siempre permitido) de **escribir**;
    - ligar cada sesión a su dueño (agente o subagente), target y permisos con los que se abrió;
    - pasar el texto escrito por `commandVeto`, `requirePlan` y read-only como si fuera un comando nuevo;
    - **negar stdin a shells e intérpretes generales** (`pwsh`, `bash`, `python`, `node`, `ssh`…), donde el input no se puede interpretar con seguridad. Queda para responder a prompts de programas concretos, no para teclear comandos.
  - **Read-only**: en una sesión read-only no se escribe stdin a ningún proceso, lo abriese quien lo abriese.
  - **Cierre**: `closeExecRuntime()` mata todos los procesos vivos (§12.12); en Windows con el mismo `taskkill /T /F`.
  - **Auditoría**: una entrada al abrir y otra al cerrar, con el `session`.
  - **Subagentes**: los procesos de un hijo mueren con él.
- UI: un segmento `⟳ N` en `StatusBar` y `/ps` para listarlos y matarlos.

---

### P1 — Aprobaciones persistentes por prefijo de comando

**Lo que hacen** (`execpolicy/`, `core/src/exec_policy.rs`, `core/src/command_canonicalization.rs`):

Un fichero de reglas (`default.rules`, sintaxis Starlark) con entradas:

```starlark
prefix_rule(
    pattern = ["git", ["status", "diff", "log"]],   # tokens en orden; una lista = alternativas
    decision = "allow",                              # allow | prompt | forbidden
    justification = "read-only git",
    match = ["git status", "git log --oneline"],     # ejemplos que DEBEN casar
    not_match = ["git push"],                        # ejemplos que NO deben casar
)
```

Cuatro ideas, de más a menos valiosa:

1. **`match` / `not_match` se validan al cargar.** Son tests unitarios de la propia política: una regla cuyo ejemplo no casa es un error de carga, no una sorpresa en producción.
2. **«Aprobar y no volver a preguntar».** El modelo propone un `prefix_rule` en la propia llamada a `exec_command`; la UI lo ofrece como tercera opción del prompt, y al aceptarla `amend.rs` añade la línea a `~/.codex/rules/default.rules` (con lock de fichero). *[rev]* En Codex el parámetro solo vale junto a una petición de salir del sandbox (`sandbox_permissions: "require_escalated"`): la aprobación por prefijo es la contrapartida de su sandbox, que nosotros no tenemos, así que aquí iría ligada a la confirmación. Hay una lista de prefijos que **nunca** se ofrecen (`BANNED_PREFIX_SUGGESTIONS`: shells con y sin `-c`, `cmd /c`, `env`, `node`, `bun`, `deno`, `perl`, `Rscript`… y también **`git` a secas y `npm run`**) y se descarta la sugerencia si ya casa alguna regla. *[rev2]* Además solo se ofrece si, añadida la regla, **todos** los comandos de esa llamada quedarían en `allow` (`prefix_rule_would_approve_all_commands`): una regla que deja un segmento sin cubrir no se sugiere.
3. **La decisión más estricta gana** cuando casan varias reglas (`forbidden > prompt > allow`), y `justification` viaja al mensaje de rechazo: *«Use `jj` instead of `git`»*. Es nuestro «fallo instructivo» aplicado a políticas.
4. **Canonicalización para la caché de aprobaciones**: `bash -lc "git status"` y `git status` son la misma decisión; un script complejo se cachea por su texto exacto.

**Para Stratum:** hoy la confirmación ofrece `approve` / `deny` / `allow-all` (`!`, toda la sesión). Falta el punto medio, que es el que el usuario quiere el 90 % de las veces: «no me preguntes más por `npm test`». Sin él, la salida natural es `!`, que es mucho más de lo que se quería conceder.

- Config, no Starlark: `tools.approvedCommands: [{ prefix: ["npm","test"], match?: [...], notMatch?: [...] }]` validado con Zod; los ejemplos se comprueban en `validateConfigLayer`.
- *[rev2]* **No reutilizar el troceador de `tools/guards.ts`** para esto. Está hecho para *detectar* peligro: salta envoltorios (`sudo`, `env`, `VAR=…`) y normaliza a propósito, y eso que acierta al vetar se equivoca al autorizar, porque amplía lo que una aprobación significa. Además el comando lo evalúa un shell (`pwsh -Command`, `shell: true`), que puede expandir una sustitución antes de lanzar `npm`. La aprobación por prefijo solo aplica a **invocaciones simples**: un único comando, sin tuberías, encadenados, redirecciones, sustituciones, scriptblocks ni asignaciones, con el ejecutable tal como se escribió. Todo lo demás se pregunta. Es la misma idea de «allowlist y rechazar lo ambiguo sin analizar» de `readOnlyCommandVerdict`.
- Decisión nueva `approve-prefix` en `DestructiveDecision`, escrita en la capa **global**. *[rev2]* `setConfigValue` no sirve tal cual: escribe en el `.stratumrc.json` de proyecto más cercano. Hace falta una operación explícita sobre el fichero global, con relectura antes de escribir para no pisar otra terminal. Una capa de proyecto no puede aportar aprobaciones sin confianza (ver P2 «confianza de proyecto»); Codex hace lo mismo: las `.codex/rules/` de un proyecto no confiable no se cargan.
- **Jerarquía, que no se negocia**: hard-deny > `guardedCommands: block` > rutas `blocked` > `environmentGate` (`confirm-always` y confirmación con nombre) > aprobación por prefijo > preguntar. Una aprobación por prefijo solo sustituye a la confirmación **simple**, y solo en entornos con `policy: ask`. *[rev2]* Tampoco levanta nunca: `destructivePolicy: deny` (`--deny-destructive`), la ausencia de callback o de TTY (CI sigue denegando), el `confirmAll` de un host ni la confirmación tecleada. Un test por cada combinación.
- Por target: la regla lleva `target` opcional (glob como `environments.match`); sin él, solo `local`.
- Lista de prefijos no aprobables: `pwsh`, `powershell`, `cmd`, `bash`, `sh`, `python`, `node`, `env`, `sudo`, `ssh`, y cualquier prefijo de un solo token cuyo comando admita subcomandos mutantes (`git`, `docker`, `kubectl`, `npm`).

---

### P1 — `stratum run` para scripts y CI

**Lo que hacen** (`exec/src/cli.rs`):

- `--json`: eventos del agente en JSONL por stdout.
- `--output-schema <fichero>`: JSON Schema que la respuesta final debe cumplir.
- `--output-last-message <fichero>`: el mensaje final a un fichero, separado del ruido.
- `--ephemeral`: no persiste la sesión.
- `resume <id>` / `resume --last` también en no interactivo.
- `--ignore-user-config`, `--ignore-rules`: ejecución reproducible.

**Para Stratum:** `run` solo emite texto. Integrarlo en un pipeline exige parsear prosa.

- `--json` es casi gratis: `AgentEvent` ya es serializable y sin imports (`events.ts`, lo consume Desktop). Una línea por evento, con `text_delta` agregables. Los prefijos `[sub perfil#n]` de stderr pasan a ser el campo `subagent`.
- `--output-last-message`: trivial. `--ephemeral` *[rev2]* necesita alcance definido: `run` no guarda la conversación, pero sí persiste planes (`.stratum/plans/`) y registros de subagentes; hay que decidir por separado planes, subagentes, memoria, auditoría y logs.
- `--output-schema` *[rev2]*: más caro de lo que escribí. El loop no sabe de antemano cuál es la última petición (lo descubre al recibir una respuesta sin tool calls) y `CompletionRequest` no transporta `response_format`. Hace falta una **fase de finalización explícita**: terminado el trabajo, una petición más, sin tools, con `response_format: { type: "json_schema" }`. Y el contrato para CI tiene que ser duro: se valida siempre en cliente, un reintento, y si la salida no cumple el schema, **exit ≠ 0**; un `warning` con un resultado inválido no le sirve a un pipeline. El soporte de `response_format` en cada backend está sin verificar.
- `run --resume <id>`: continuar una sesión desde un script.

---

### P2 — Confianza de proyecto más allá de los plugins

**Lo que hacen** (`config/src/loader/mod.rs`, `config/src/project_trust.rs`, `core/src/agents_md.rs`): la confianza es una entrada `projects.<ruta>.trust_level` en la config del usuario. Sin ella, las capas de config del proyecto se leen pero quedan **desactivadas**, con un mensaje que nombra lo que se pierde: *«project-local config, hooks, and exec policies»*. Como los servers MCP viven en esa config, caen con ella. Con el proyecto marcado `untrusted`, tampoco se carga su `AGENTS.md`.

*[rev]* Dos matices: la confianza de proyecto de Codex va **por ruta, sin huella de contenido** (como Pi; un `git pull` no la caduca), pero los **hooks** llevan además confianza individual por hash (`HookTrustStatus`: `untrusted` / `trusted` / `modified` / `managed`) y uno modificado no corre hasta volver a aprobarlo. *[rev2]* Ese hash es de la **configuración normalizada** del hook (evento, matcher, comando), no del contenido del script que ejecuta: cambiar el script sin tocar la config no lo invalida. No es una prueba de integridad.

**Para Stratum:** `Plugins-Implementacion.md` §5 ya diseña `~/.stratum/trust.json` con fingerprint, y D7 ya decide que el gate cubra `mcp.servers` de proyecto «como cambio aparte». Codex confirma esa decisión y va más lejos: la frontera es **toda la capa de proyecto**, no una lista de secciones:

| Aporta el proyecto | Riesgo | ¿Bajo confianza? |
|---|---|---|
| `.stratum/plugins/` | Ejecución de código | Sí (ya diseñado) |
| `mcp.servers` de proyecto | Ejecución de comandos | **Sí** |
| `tools.testCommand`, `tools.sensitivePathAllowlist`, `environments`, `tools.guardedCommands: allow` | Relaja guardas | **Sí** |
| `.stratum/agents/` con `destructivePolicy: allow` | Relaja política | Sí |
| `STRATUM.md`, skills | Inyección de prompt | Discutible: Codex lo incluye; yo avisaría sin bloquear |

Recomendación: que D7 no se quede en `mcp.servers`. Ampliar el `fingerprint` de §5 a la capa de proyecto de `.stratumrc.json` entera y a `.stratum/agents/`, y planificarlo junto a PL4. Sin confianza, la capa de proyecto se lee pero no se aplica, y se dice qué se ha dejado fuera.

---

### P2 — Hooks: lo que Codex añade al diseño de plugins

**Lo que hacen** (`hooks/`): hooks **fuera de proceso** — comandos externos con JSON por stdin y JSON por stdout o, *[rev2]*, una tool de un server MCP (`ConfiguredHandlerKind::McpTool`) —, en formato compatible con los de Claude Code (el motor se llama literalmente `ClaudeHooksEngine`). Eventos: `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Interrupt`.

`Plugins-Implementacion.md` §3.2 ya cubre `tool.before`/`tool.after`/`event`/`session.*`/`compaction.context` en proceso, y rechaza con motivo dos cosas que Codex sí permite (mutar argumentos en `PreToolUse` con `updatedInput`, y que un hook de `PermissionRequest` devuelva `allow`). **Esas dos decisiones siguen siendo correctas**, y el código de Codex da argumentos a favor *[rev]*:

- Sus hooks corren **en paralelo**, y si dos reescriben el input gana **el que termina último** (`latest_updated_input`, por orden de finalización). Es no determinista por diseño.
- `PreToolUse` **falla abierto**: un hook que da error, vence el timeout o sale con un código distinto de 0 y 2 queda como `Failed` y la tool se ejecuta. Solo bloquea un `exit 2` con motivo en stderr o un JSON de bloqueo. El timeout por defecto es de 600 s.
- Nuestro diseño (secuencial, sin mutación, falla cerrado, 5 s) es más estricto en los tres puntos. No hay nada que copiar ahí.

Lo que Codex aporta de nuevo:

1. **`Stop` que bloquea.** Un hook de `Stop` puede devolver `{ decision: "block", reason }`; el turno no termina y `reason` se inyecta como prompt de continuación. Caso de uso: «no acabes mientras `npm test` falle» o «no acabes con tareas `todo` abiertas». Es una guarda de *terminación*, que en nuestro diseño no existe. *[rev]* Codex no pone tope: le pasa al hook `stop_hook_active: true` cuando el turno ya es una continuación forzada y confía en que el hook ceda. Nosotros sí pondríamos un tope duro (p. ej. 3 bloqueos seguidos por turno), o un hook roto encierra al agente en un bucle.
2. **`UserPromptSubmit`**: aportar contexto o vetar un mensaje antes de que entre en el historial.
3. **`SubagentStart` / `SubagentStop`**: hoy §3.2 solo los ve por `event`.
4. **Desbordamiento a fichero** (`output_spill.rs`): el contexto que añade un hook tiene tope (2 500 tokens); lo que excede se escribe a un fichero temporal y al modelo le llega el recorte más la ruta. Aplicable a `compaction.context` y, en general, mejor que nuestro truncado a secas para salidas de tool muy largas. *[rev2]* Con condiciones: el fichero es otra copia persistente de la salida, así que se **redacta antes de escribir**, con tope de disco, permisos restrictivos y limpieza al cerrar la sesión; y leerlo con `read_file` no puede saltarse el límite original. (En Codex el límite es configurable y `0` lo desactiva.)
5. **Hooks de comando como alternativa a los plugins en proceso.** Un hook que es `{ event, matcher, command }` en la config no carga código en nuestro proceso, sirve en cualquier lenguaje, y reutiliza hooks ya escritos para Claude Code. Podría ser PL1 con mucho menos riesgo que cargar JS, o un PL5. Sigue necesitando confianza de proyecto: es ejecución de comandos.

---

### P2 — `/review` con rúbrica y salida estructurada

**Lo que hacen** (`prompts/templates/review/rubric.md`, `core/src/tasks/review.rs`, `exec review`):

Una tarea aislada (hilo propio, sin historial del padre) con una rúbrica muy afinada. Los criterios para marcar algo:

- El bug **lo introdujo el cambio**; lo preexistente no se marca.
- Es discreto y accionable, y el autor lo arreglaría si lo supiera.
- No exige más rigor que el del resto del repo.
- **No vale especular** que algo «podría romper otra parte»: hay que identificar la parte afectada.
- Si no hay nada que el autor querría arreglar, **cero hallazgos es la respuesta correcta**.

Salida JSON: `findings[] { title (≤80, imperativo, con [P0]…[P3]), body (un párrafo), confidence_score, priority? (0–3), code_location { absolute_file_path, line_range } }` + `overall_correctness` + `overall_explanation` + `overall_confidence_score`. Objetivos: `--uncommitted`, `--base <rama>`, `--commit <sha>`. El resultado vuelve al hilo principal envuelto en `<user_action>` para que el usuario elija qué hallazgos resolver.

**Para Stratum:** tenemos las piezas y no el comando. `risk.ts` ya da tier, lentes 4R y `correctionBudget`; `git/changes.ts` ya recoge el diff.

- Perfil embebido `review` (`read_file`, `grep`, `glob`, `exec`) con la rúbrica reescrita y las lentes de `classifyRisk` inyectadas. *[rev2]* El perfil **no impone** solo lectura: los perfiles no tienen `readOnly` y un `allowedTools` con `exec` admite comandos mutantes. Las dos entradas de review tienen que lanzar el hijo con `readOnly: true`, sea cual sea el perfil.
- `/review [--base <rama> | --commit <sha>]` y `stratum run --review`, sobre `runDelegate`.
- La salida estructurada depende de `--output-schema` (P1); sin él, se pide el JSON en un bloque y se valida con Zod, con un reintento.
- `<ReviewFindings>` en el chat: lista con prioridad, `Space` expande, `Enter` manda los seleccionados como tarea, con el `correctionBudget` en el prompt.

---

### P2 — `AGENTS.md` jerárquico

**Lo que hacen** (`core/src/agents_md.rs`): raíz del proyecto = primer ancestro con un marcador (`.git` por defecto, configurable). Se **concatenan todos los `AGENTS.md` desde la raíz hasta el cwd**, en ese orden, sin subir más allá de la raíz. `AGENTS.override.md` tiene preferencia local, hay nombres alternativos configurables y un tope de bytes total (`project_doc_max_bytes`).

**Para Stratum:** `STRATUM.md` tiene dos niveles (global y proyecto). `AGENTS.md` solo aparece en el prompt de `/init` como fichero a leer.

- Leer `AGENTS.md` como alternativa cuando no hay `STRATUM.md`: compatibilidad inmediata con cualquier repo que ya lo traiga. Config `memory.instructionFiles: ["STRATUM.md", "AGENTS.md"]`.
- Jerarquía raíz → cwd: útil en monorepos (este repo es un ejemplo: `stratum-cli/` y `stratum-desktop/` tienen reglas distintas). Con tope de bytes y aviso al recortar.
- `STRATUM.local.md` sin versionar, para preferencias personales.

---

### P3 — Higiene de memoria

**Lo que hacen** (`memories/`): pipeline en dos fases, asíncrono, al arrancar una sesión raíz (*[rev2]* solo con la feature activa, sesión no efímera, base de estado disponible y cuota). Fase 1 extrae un recuerdo por sesión pasada; fase 2 lanza un subagente que consolida en ficheros. Es demasiado para modelos locales, pero dos ideas se pueden separar:

1. **La puerta de señal mínima** (`stage_one_system.md`): *«¿Actuará mejor un agente futuro por lo que escribo aquí? Si no, devuelve todo vacío.»* Con la lista explícita de lo que **no** se guarda: consultas sueltas, estado temporal, conocimiento obvio, actualizaciones de estado sin conclusión. «No-op is allowed and preferred.» *[rev2]* `memory/extractor.ts` ya tiene la abstención (exige decisiones duraderas, excluye lo rutinario y admite `[]`); lo que falta es el resto de la lista: hechos temporales, conocimiento obvio y el criterio de utilidad futura.
2. **Olvido por uso**: cada recuerdo lleva `usage_count` y `last_usage`; se priorizan los usados y se dejan fuera los que superan `max_unused_days`. `decisions.json` no registra uso. Añadirlo es un contador en `recall_decisions` y permite un `stratum memory prune --unused 90d`.

---

### P3 — Detalles sueltos

- **Reintento tolerante en `edit_file`** (`apply-patch/src/seek_sequence.rs`): cuando el bloque no casa exacto, se reintenta ignorando espacios finales y luego espacios a ambos lados (por líneas). `edit_file` ya reintenta con CRLF; añadir el paso de espacios finales cubre el fallo más común de modelos pequeños. Solo si la coincidencia tolerante es **única**, y avisando en el resultado.
- **Tools de contexto para el modelo**: `get_context_remaining` (tokens libres o `null`) y `new_context` (*«start a new context window»*, sin tocar el estado del entorno; no he seguido qué conserva del historial). Barato; dudo que un modelo pequeño las use bien.
- **Prefijo del resumen de compactación** (`compact/summary_prefix.md`): el resumen se presenta como *«otro modelo empezó esta tarea y dejó este resumen; úsalo y no repitas trabajo»*, no como hechos sueltos. Comparar con nuestro prompt de §12.4.
- **`!comando` en el chat** (`core/src/tasks/user_shell.rs`): el usuario ejecuta un comando y la salida entra en el historial. No lo tenemos.

---

## 3. Plan de adopción sugerido

| # | Qué | Dónde | Esfuerzo | Valor |
|---|---|---|---|---|
| 1 | `run --json`, `--output-last-message`, `--ephemeral` | `cli/commands/run.ts` | S | Alto |
| 2 | Aprobación por prefijo (`approve-prefix`) | `tools/guards.ts`, `tools/dispatcher`, `config/`, `DestructiveConfirm` | M | Muy alto |
| 3 | Confianza de proyecto ampliada a config, MCP y perfiles | fase PL4 de plugins | S sobre PL4 | Muy alto |
| 4 | Procesos vivos: `yieldMs`, `exec_input`, `exec_kill` | `tools/exec/` | L | Muy alto |
| 5 | `/review` con rúbrica | perfil + `cli/ui/` | M | Alto |
| 6 | `--output-schema` con fase de finalización y fallo duro | `providers/`, `agent/harness.ts`, `run.ts` | M-L | Medio |
| 7 | `AGENTS.md` como alternativa + jerarquía | `memory/` | S | Medio |
| 8 | Puerta de señal en el extractor | `memory/extractor.ts` | XS | Medio |
| 9 | Hook `Stop` que bloquea + `UserPromptSubmit` | diseño de plugins §3.2 | S sobre PL1 | Medio |
| 10 | Reintento tolerante en `edit_file` | `tools/fs/edit.ts` | S | Medio |
| 11 | Olvido por uso | `memory/decisions.ts` | S | Bajo |
| 12 | `!comando` en el chat | `cli/ui/` | S | Bajo |

**Mi recomendación:** 1 y 2 primero. El 1 es pequeño y abre el uso en CI. El 2 ataca la fatiga de confirmaciones, que hoy solo tiene `!` como salida; tras la revisión de Codex queda acotado a invocaciones simples, que es menos cobertura pero no abre nada. El 4 es el de más valor para infraestructura pero el más caro: merece hito propio y plan revisado, porque toca guardas, read-only, auditoría y teardown a la vez.

---

## 4. Lo que no traería

- **Sandbox de SO** (`linux-sandbox`, `bwrap`, `windows-sandbox-rs`, `windows-sandbox-service`, `process-hardening`): Landlock/seccomp, Seatbelt y tokens restringidos de Windows con un servicio aparte. Decenas de miles de líneas nativas por plataforma. Es la respuesta correcta a «el modelo ejecuta lo que quiera sin preguntar», pero Stratum responde a otra pregunta («qué se pregunta y qué se veta») y es Node puro. No hay término medio barato.
- **Proxy de red** (`network-proxy`): MITM con certificados propios para aprobar dominios. Mismo motivo.
- **`apply_patch`**: formato de parche propio (`*** Begin Patch`), afinado para los modelos de OpenAI, que están entrenados con él. Un modelo local pequeño falla más con un formato de diff que con `old_string → new_string`. Solo la función de casado tolerante (P3).
- **Guardian** (`core/src/guardian/`, `prompts/templates/guardian/`): un segundo modelo que aprueba o deniega acciones en lugar del usuario, con una taxonomía de riesgo (exfiltración, sondeo de credenciales, debilitamiento persistente, destrucción). La taxonomía es buena lectura para `tools/guards.ts`, pero el mecanismo exige un modelo fuerte y fiable, y choca con que nuestras confirmaciones de entorno son inapelables.
- **`code-mode`** (V8 embebido para que el modelo escriba JS que llama a tools), **`app-server`**, **`cloud-tasks`**, **`realtime-*`**, **`voice-host`**: producto OpenAI.
- **Shell snapshot** (`shell_snapshot*.rs`): captura el entorno del shell de login para reusarlo. Nosotros lanzamos `pwsh -NoProfile` a propósito.
- **Rollouts JSONL + `state` en SQLite**: su persistencia de sesiones. La nuestra (JSON atómico + Zod + concurrencia optimista) ya cubre lo que necesitamos.

---

## 5. Licencia

Apache-2.0. Lo que adoptamos son ideas y contratos reescritos en TypeScript, así que no hay obligación de aviso. Si se copia casi literal alguna plantilla de prompt (la rúbrica de review o la puerta de señal de memoria son las candidatas), corresponde acreditar la fuente en el propio fichero y conservar el aviso de licencia.
