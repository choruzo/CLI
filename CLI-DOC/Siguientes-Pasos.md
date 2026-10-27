# Stratum — siguientes pasos

> Fecha: 2026-10-23. Síntesis de cuatro investigaciones (subagentes opencode-bridge, solo lectura):
> pendientes internos de Stratum, opencode **v2** (rama `v2`, 2.0.26), núcleo de **deepseek-harness** e
> interfaz de **deepseek-harness**. Las afirmaciones sobre Stratum se han contrastado con el código; las de
> los proyectos externos vienen de sus informes y conviene revisar la ruta citada antes de copiar nada.

## 0. Resumen ejecutivo

El código de Stratum está limpio: sin `TODO/FIXME` reales y con `KNOWN_GAPS` de evals vacío. Lo pendiente
está en los documentos y en huecos de producto. Propuesta de orden:

| # | Bloque | Por qué ahora | Tamaño |
|---|---|---|---|
| 1 | **Undo por turno** (snapshots en un git en la sombra) | Es el hueco de producto más grande frente a opencode y Claude Code; lo apoyan `ChangeTracker` y el diff de `edit_file` | M |
| 2 | **Edición tolerante + diagnósticos tras editar (LSP ligero)** | Hoy `edit_file` exige match exacto (solo tolera CRLF) y no hay LSP. opencode v2 *perdió* el LSP: si lo tenemos, es diferencial | M + L |
| 3 | **Telemetría y UI de la TUI** (pills de uso, coste, razonamiento con preview, modos de detalle, Esc Esc) | Barato, visible, se nota en cada sesión | S–M |
| 4 | **Cerrar el contrato v1 del protocolo** (`sessions.open{resume}`, `trace.subscribe`, `session.detached`, `tool.blocked`) y congelarlo | Congelar con métodos declarados y sin atender es peor que implementarlos o retirarlos | M |
| 5 | **Plugins (resolver R1 → PL1)** | Ya está diseñado y aprobado; el diseño cita commits de opencode/Pi que envejecen | M + L |
| 6 | **Hitos 18–19 de infraestructura** (`net_probe`/`sys_inspect`/`log_query`/`service_status` → `diagnosis` + triaje) | Es el diferenciador que se escribió para Stratum | L + L |
| 7 | **Cola no-seguridad de M9** (desfase de versiones, carga, empaquetado y firma) | Bloquea release firmada y, con ella, la congelación del protocolo | L |

> **Actualización 2026-10-23:** los bloques 1–3 están implementados (detalle y pendientes en §5, «Estado»).
> El siguiente según este orden es el 4, cerrar el contrato v1, con `sessions.revert` como candidato a entrar en él.
>
> **Actualización 2026-10-27:** también Contrato-1 (publicado en la 0.9.0/0.10.0). Hoy: cola de UX-3 (uso de
> sesión al reanudar, con el bug de `/sessions resume`; `/verbosity` persistido) y `/btw` de UX-4. Ver §5 y,
> para lo que queda, §7.

Decisiones abiertas que conviene no dejar sin fecha: **default de `chat`** (vivir en `stratumd`, bloqueado
por Q1, el entorno de la terminal) y **convergencia Dot/Desktop** (§15.1.4: ¿Dot es el modo compacto de
Desktop?). Hay que decidir §15.1.4 *antes* de extraer componentes compartidos, para no extraerlos dos veces.

---

## 1. Pendientes internos (inventario)

### 1a. Deuda y huecos del contrato

- **Protocolo v1 sin congelar**: `docs/protocol.md` §17 (15 correcciones sin subir versión). No se congela
  hasta publicar un tag que incluya `stratumd` (el último publicado, 0.8.0, es anterior). **M**
- **`sessions.open { resume }` responde `UNAVAILABLE`**: `stratum-cli/src/daemon/daemon.ts:650`, mientras que
  `sessions.list` sí devuelve las sesiones recuperadas (M11). **S**
- **`trace.subscribe` no lo sirve el daemon** (§13.6). El cliente Node ya sabe suscribirse
  (`src/client/subscriptions.ts`); bloquea el panel de trayectoria de Desktop. **M**
- **`tool.blocked` y `session.detached` sin emisor; `broker` nunca se concede** (§13.6). **S**
- **Q2, identidad del par** (`docs/PRD_STRATUM_DOT.md` §Q2): cualquier proceso del mismo usuario está en el mismo
  dominio de confianza. Es el bloqueo de seguridad declarado. **L**
- **`chat`/`run` siguen con compresión en línea**: solo las sesiones del daemon tienen conversación duradera. **L**
- **Sin Caso B en sesiones duraderas**: si la memoria de sesión falla y ya no cabe, `context_full`
  (`.claude/docs/agent-loop.md`). Es deliberado, pero es una vía de fallo total. **M**
- Tests intermitentes conocidos: `peer.integration.test.ts` (parada forzada del daemon) y el de SIGINT de
  `run.test.ts`. **S**
- Publicación del anfitrión par: `/model` se publica en el turno siguiente, `/sessions resume` en caliente
  no cambia el id publicado e `init` no se publica (`.claude/docs/peer-host.md`). **S**

### 1b. Features planificadas sin hacer

- **Hitos 18, 19 y 20** (`CLI-DOC/Orientacion-Infraestructura.md`): 18 da el sustrato, 19 es «la pieza
  diferencial» y del 20 el documento dice que es «la carrera que se pierde siempre» (no empezar por él).
- **Plugins** (`CLI-DOC/Plugins-Implementacion.md`): aprobado, nada implementado. Tiene 12 hallazgos de
  revisión, uno **bloqueante** (R1, huella de confianza del proyecto).
- **Desktop no aprueba** (necesita broker nativo como Dot). Lo aplazado de Desktop: retención de carpetas,
  editor de ajustes, panel de memoria global y panel de trayectoria.
- **Dot**: paginación de historial y desglose de contexto (`sessions.history` y `sessions.context` ya existen). **S** cada uno.
- Notificaciones de bandeja en Linux (Q4/AC-9), promoción explícita de memoria de sesión → proyecto,
  `run --detach`, perfiles de triaje y medir `prompt.guides: 'pointers'`.

### 1c. Huecos de producto (verificados en el código)

| Hueco | Evidencia | Tamaño |
|---|---|---|
| Sin LSP ni diagnósticos | `grep lsp` en `src/` → 0 | L |
| Sin undo/revert de ficheros | Solo hay checkpoints de *sesión*; `src/git/` solo lee | M |
| `edit_file` solo con match exacto | `tools/fs/edit.ts:22,86`: solo tolera CRLF | S |
| `run` sin salida legible por máquina | `cli/commands/run.ts` sin `--json`/`stream-json` | S/M |
| Sin coste en $ | Hay tokens y caché, sin tabla de precios | S |
| Sin temas | `cli/ui/theme.ts` es constante; sin clave en config | S |
| Sin `@fichero` en el chat | `@` está reservado a perfiles (`App.tsx`) | M |
| Sin exportar sesión | `stratum sessions` = `list/resume/delete/prune` | S |

---

## 2. Qué importar de opencode v2

Contexto: v2 es una reescritura sobre Effect 4 + SQLite/Drizzle. El núcleo es dueño del runtime, hay un
log de eventos duradero con `seq` por agregado y la TUI está hecha con OpenTUI + Solid (ya no es Ink). Pierde
cosas frente a v1: **no tiene runtime de LSP** (`packages/core/src/tool/plugin/edit.ts:107`, un TODO), ni tool
`todo`, ni *share* público.

| Idea | Dónde | Encaje en Stratum | Interés |
|---|---|---|---|
| **Snapshots en un git en la sombra** por mensaje del asistente + `SessionRevert.stage` (restaurar el primer snapshot de cada fichero tocado después del punto) | `packages/core/src/snapshot.ts`, `session/revert.ts:84-114` | Base del **undo por turno**: repo propio en `~/.stratum/snapshots/<hash(worktree)>`, límite por fichero, `gc`. No toca el git del usuario. Vale para `/undo`, `/rewind <turno>` y Desktop/Dot | **Alto** |
| **Edición tolerante en escalera**: exacto → normalización Unicode (comillas y guiones tipográficos, espacios raros) → coincidencia por líneas sin espacios finales; conserva BOM y CRLF | `edit.ts:49-102` | Directo en `tools/fs/edit.ts`. Cada nivel debe seguir exigiendo unicidad y cuál ha casado debe ir a la traza (sin estimar nada) | **Alto** |
| **Permiso con diff de previsualización** adjunto (`metadata.files`) | `edit.ts:180-188`, `core/src/permission.ts` | La confirmación de `edit_file`/`write_file` y la solicitud del centro de aprobaciones llevan el diff: Dot lo muestra antes de aprobar | **Alto** |
| **Rechazo con feedback** que se propaga a todas las llamadas paralelas del lote (`CorrectedError`) | `permission.ts:249-253` | «Rechazar y decir por qué»: el texto llega al modelo como corrección | Medio-alto |
| **Checkpoint de compactación estructurado** (Objetivo / Requisitos / Decisiones / Estado / Siguiente paso / Ficheros relevantes / Contexto) que se *actualiza consolidando* el anterior; reintento 0,7/0,5/0,35 si el backend rechaza por desbordamiento | `session/compaction.ts:95-176` | Plantilla para la memoria de sesión de M11 (`ContextManager.compactSession`); hay que medirla con `stratum eval` antes de adoptarla | Medio-alto |
| **Fan-out de eventos**: frame codificado una sola vez y cola acotada por cliente; el cliente lento se expulsa sin frenar a los demás | `packages/server/src/event-feed.ts`, `specs/v2/event-stream-architecture.md` | Revisar `EventHub` del daemon con esa medida (dicen que pasaron de 554 ms a 12 ms con 50 clientes). Encaja con «colas acotadas» y con la prueba de carga de M9 | Medio |
| **`/btw`**: pregunta lateral con una generación transitoria que no entra en la conversación | `packages/tui/src/feature-plugins/prompt/btw.tsx` | Con daemon y `tracedCompletion` es casi gratis (origen nuevo en `LLM_CALL_ORIGINS`) | **Alto** |
| **Comandos declarativos**: una sola definición sirve a la paleta y al `/` | `packages/tui/src/config/keybind.ts` | Unificar `CommandPalette.tsx` y `session-commands.ts` | Medio |
| **Pasar a segundo plano una tool en curso** sin cancelarla | `protocol/groups/session.ts:766-781` | Encaja con `JobManager`: «este `exec` tarda, pásalo a job» | Medio-alto |
| **Code Mode**: el modelo escribe un JS restringido que llama a las tools, en vez de encadenar llamadas | `packages/codemode` | Interesante para exploración con modelos locales (menos idas y vueltas), pero choca con guardas y aprobaciones por llamada. Solo como experimento | Bajo-medio |
| Catálogo de modelos (models.dev) empaquetado con snapshot y refresco en caché | `core/src/models-dev.ts` | Fuente de **precios y límites** para el coste en $ y para la ventana de contexto | Medio |
| Export/import de sesión saneado (`SessionTransfer`) | `core/src/session/transfer.ts` | `stratum sessions export` (JSON/Markdown) pasando por la redacción de secretos | Medio |
| Subagente = sesión hija continuable por id, profundidad configurable (por defecto 1) | `tool/plugin/subagent.ts:129-240` | Continuar un subagente de `delegate_task` y fijar `maxDepth` | Medio |

**Qué no copiar**: Effect, los 25 paquetes, HTTP con Basic Auth (va contra «sin TCP») y OpenTUI.

## 3. Qué importar del núcleo de deepseek-harness

Contexto: TypeScript ESM sobre **Cordis**: todo es un plugin con *effects* reversibles. Hay dos invariantes:
«lo que ve el modelo ⟺ está en el log» y «una capability = un seam de 3 roles». El `native/` no es un sandbox:
son un lanzador Landlock y un `flock`. `BENCHMARK.md` remite a un SDK de Python externo y los benchmarks del
repo miden rendimiento.

Muchas ideas suyas **ya las tenemos** (tools en orden canónico, caché medida sin estimar, resultado
desconocido → preguntar, steering como bloque anexado, pipeline veto → preflight → confirmación → ejecución
y fallo cerrado). Lo que aporta de verdad:

| Idea | Dónde | Encaje | Interés |
|---|---|---|---|
| **Scheduler de tool calls**: las *exclusive* actúan de barrera, las *parallel-safe* van en un pool acotado y los resultados se confirman **en el orden del modelo** | `packages/core/agent-loop/src/tool-calls.ts:60-102` | Paralelizar lecturas (`read_file`, `grep`, `web_fetch`) en `ToolDispatcher` sin cambiar el orden en el historial ni en la traza; `callEffects` ya distingue lo que muta | **Alto** |
| **Reintento en la frontera del step, durable antes de esperar**: el evento `llm/retry` se escribe antes del backoff y se respeta `Retry-After` | `packages/llm/llm-retry/README.md:50-84` | Comprobar que nuestros reintentos dejan rastro en la traza *antes* de dormir (si se cae a mitad del backoff, que se vea) | Medio |
| **Compactación que reutiliza la caché**: la llamada de resumen reproduce byte a byte system, tools y mensajes; solo la instrucción final queda fuera de caché | `packages/compaction/compaction-basic/README.md:108-233` | La compactación de M11 sale mucho más barata en backends con caché de prefijo (DeepSeek, vLLM, llama.cpp). Se puede medir con lo que ya tenemos | **Alto** |
| **Podar resultados de tools antes de resumir** y spill de textos enormes (localizador + cómo recuperarlo, en vez de truncar a ciegas) | `compaction-basic`, `packages/context/spill` | Mejor que truncar salidas de `exec` | Medio-alto |
| **Guards de aviso** que no vetan: p. ej. «llevas 3 veces la misma tool» como contexto añadido después de ejecutar | `packages/guard/repeat-tool-reminder` | Contra bucles de modelos locales; como dato del runtime con `TraceScope.runtime`, no en el system prompt | Medio-alto |
| **Política de sandbox por llamada** con `enforcement: full \| partial` declarado | `docs/subsystems/sandbox.md` | Que el entorno o el read-only digan cuánto garantizan de verdad (local frente a SSH) | Medio |
| **Eval por replay de sesión grabada** con `workspace.expected/` como oráculo: sin API key y «verifica el mundo, no lo que dice el agente» | `snapshots/AGENTS.md`, `docs/testing.md` | Tipo nuevo de escenario de `stratum eval` que corre en CI sin modelo. Actualizar `stratum-cli/docs/eval.md` | **Alto** |
| Subagentes: rechazo `ACTIVATION_LIMIT_REACHED` en vez de cola y aviso al padre al terminar | `packages/subagent/subagent/README.md` | Límites duros en `delegate_task` | Medio |
| Organizar `packages/` por familia de capacidad | `packages/README.md` | Solo como convención. No adoptar Cordis | Bajo |

## 4. Qué importar de la interfaz de deepseek-harness

No tienen TUI: `apps/web` es React 18 + Vite, `apps/desktop` es Electron y la UI vive en `packages/client/ui-*`.
Se aprovecha el **modelo de información**, no los píxeles.

### Para la TUI (Ink)

1. **Pills de telemetría bajo el prompt** (`ui-chat/.../StatsPills.tsx:237-334`). Dos lecturas, actividad y uso;
   la compacta muestra velocidad y % de caché:
   ```
   ⊙ 3 turnos · 8 pasos · 42 tok/s     ⛁ 12.4K · caché 87% · $0.031
   ```
   Con un atajo se abre el detalle (TTFT, tiempo de LLM frente a tiempo de tools, desglose de tokens). Hoy
   `StatusBar.tsx` tiene contexto y `Σ` de tokens. **Alto, S.** Sin dato del backend se muestra `n/d`, nunca 0.
2. **Uso por turno** (`TurnUsagePanel.tsx`): «consumido N» en el pie de cada turno, con caché leída/escrita,
   salida y razonamiento. **Alto, S.**
3. **Desglose del medidor de contexto** (`ContextMeter.tsx`): `◔ 43%` y, al expandir, sistema/tools/mensajes.
   `sessions.context` ya tiene el dato. **Alto, S.**
4. **Razonamiento plegado con vista previa del último párrafo terminado** (`ReasoningRow.tsx:48-101`): avanza
   por párrafos, no por tokens. Se apoya en `thinking-reducer.ts`. **Alto, S.**
5. **Modos de detalle** Compact / Standard / Detailed / Verbose (`conversation-nodes/README.md:113-130`):
   un solo ajuste (`/verbosity`) para cabeceras, cuerpos y plegado del turno; se combina con agrupar tool calls
   por familia (`leídos 4 ficheros · 2 comandos`, idea también de opencode). **Alto, M.**
6. **Tarjetas de tool por intención** (`ToolRow.tsx:118-199`): terminal / diff / read / search / web, con el
   cuerpo montado solo al expandir y rutas recortadas por la izquierda conservando la extensión. **Alto, M.**
7. **Esc Esc para parar** e indicador **Send/Steer/Queue**: el pie del prompt dice qué hará Enter con el
   agente trabajando (`ui-conversation/README.md:109,115`). Encaja con el steering. **Alto, S.**
8. **Confirmación con Enter/Esc** (`ApprovalPanel.tsx:36-85`): Enter = permitir una vez, Esc = rechazar, con
   guardas contra repetición de tecla e IME. Ojo: un `confirm-always` (`git push --force`) **no** debe
   aprobarse con un Enter heredado; tiene que seguir pidiendo un gesto explícito. **Medio-alto.**
9. **Menú `/` y `+` unificado con búsqueda fuzzy** y **`@fichero` atómico** (`ui-commands`, `ui-reference`):
   hoy `@` es para perfiles. Propuesta: `@perfil` si casa con uno y `@ruta` en otro caso, o `@@` para
   perfiles. Es una decisión de UX abierta. **Medio-alto, M.**
10. **Cambios por turno** (`ui-deliverables`): «N ficheros +X −Y *en este turno*» en lugar del estado del
    working tree. Sale casi solo con los snapshots del bloque 1. **Alto, tras el undo.**

### Para Desktop y Dot

- **Marco de 3 columnas con reglas de cesión** (`ui-layout/.../AppFrame.tsx`, `columns.ts`): barra lateral de
  280 px (raíl de 56 px), centro de 400 px como mínimo y panel derecho de 300 px hasta el 70 %, que se
  pliega solo por debajo de 1024 px. **Alto.**
- **Breadcrumb de linaje** padre → subagente, navegable (`ConversationSession.tsx`). **Medio-alto.**
- **Trayectoria con línea de tiempo con zoom** (`ui-trajectory`): ledger por turno, inspector
  (tokens/TTFT/duración) y filtro arrastrando sobre la línea temporal. Es el panel de trayectoria aplazado de
  Desktop y una mejora de `/auditor` (`trace/viewer-page.ts`). Requiere `trace.subscribe` (bloque 4). **Alto.**
- **Parar un job con dos pulsaciones** (armar y confirmar en 3 s) y terminados plegados (`ui-jobs`). **Medio.**
- Estética: bordes neutros de 0,5 px, elevación con sombra y no con borde, `StateDot` con loaders en fase y
  barras de scroll que solo aparecen al pasar. Sirve de guía de densidad, no de paleta (seguimos con ámbar
  solo para lo principal). **Medio.**

---

## 5. Hitos propuestos

Numeración tentativa. 18–20 siguen reservados a infraestructura, así que esto va como **«Hito UX-n»**
hasta decidir dónde encaja.

### Estado (2026-10-23): UX-1, UX-2 y UX-3 implementados

Rama `feat/ux-tui` (sin commit). La UI la hizo Opus; el núcleo, coders de opencode (`deepseek-v4-flash`)
en worktrees aparte, cada bloque pasado por un reviewer de opencode y con sus hallazgos corregidos.

#### UX-1 — Undo por turno ✅ (salvo protocolo)
- `src/snapshots/`: git en la sombra en `~/.stratum/snapshots/<id>/` (work-tree = proyecto; `GIT_DIR`,
  índice por sesión y config propios, `GIT_CONFIG_GLOBAL` vacío, `GIT_CONFIG_NOSYSTEM`,
  `GIT_LITERAL_PATHSPECS`). T0/T1 en `StratumAgent.runTurn`; registro por sesión con Zod, escritura
  atómica y lock entre procesos. `info/attributes` neutraliza los `.gitattributes` del proyecto (bytes
  exactos, CRLF/BOM incluidos). Límites: `maxFileBytes`, `maxFiles`, `timeoutMs` por invocación, y fuera
  `.git/`, `.stratum/` y `.stratumrc*`. GC que protege los árboles de todas las sesiones del proyecto.
- `planRevert`/`revertTurns`: conflictos contra T1 (con `f` para forzar), rutas confinadas a la raíz,
  registro persistido antes de tocar disco y aviso `<files_reverted>` al modelo en el siguiente mensaje.
- TUI: `/undo` y `/rewind` (selector de turnos) con `RevertConfirm`: listas restaurar / borrar /
  ⚠ cambiado / sin copia y qué **no** se deshace.
- Config `snapshots { enabled, maxFileBytes, retentionDays, timeoutMs, maxFiles }`. Doc: `.claude/docs/snapshots.md`.
- **Pendiente:** `sessions.revert` en el protocolo para Dot/Desktop. Antes hay que decidir si exige la
  clave de aprobador (ver §6.3). También falta «cambios por turno» en la UI.

#### UX-2 — Edición robusta y diagnósticos ✅
- `tools/fs/match.ts`: escalera `exact` (con el reintento CRLF) → `unicode` (comillas, guiones, espacios
  raros, `…`, zero-width; mapa de offsets al original, sin cortar expansiones) → `trailing-whitespace`.
  Exige unicidad en cada nivel, el nivel va en la salida, `new_string` nunca se normaliza y se quita un
  BOM inicial del `old_string`. Escenario de eval `code-edit-typographic-quotes`.
- `src/lsp/`: JSON-RPC propio (con tope de cabecera y cuerpo), `LspClient` (execa), `LspManager` (arranque
  perezoso, un fallo desactiva el servidor, cancelable, `dispose` también de los que están arrancando) y
  formato de diagnósticos. Tras `edit_file`/`write_file` se anexan los errores (`ToolContext.diagnostics`,
  compartido con los subagentes). Config `lsp` opt-in (`enabled: false`) con presets
  `typescript`/`pyright`/`rust-analyzer`.
- **Pendiente:** medir con eval si ahorra iteraciones frente a `exec tsc`; diagnósticos *pull*
  (`textDocument/diagnostic`) para los servidores sin `version`; un test de extremo a extremo con un
  servidor real.

#### UX-3 — Telemetría y densidad de la TUI ✅ (salvo desglose del contexto)
- Núcleo: `agent/usage.ts` (`TurnUsage` por request: tokens, caché, razonamiento, `llmMs` del intento que
  valió, `toolMs`, TTFT, tok/s, coste e `incomplete`). Nada se estima. `providers/pricing.ts` con
  `pricing` por provider o modelo en config (sin models.dev); el precio se toma por intento, así que un
  fallback factura con el suyo.
- `stratum run --output-format text|json|stream-json`: stdout solo JSON, `result` por turno, emitido antes
  del teardown y también en el segundo Ctrl+C.
- TUI: pie de prompt con `↵ enviar`/`↵ steer`, Esc Esc para parar y pastillas `⊙ paso 3 · 42 tok/s ⛁ 12K ·
  87% caché · $0.031`; pie de uso por turno; razonamiento plegado con el último párrafo terminado;
  `/verbosity compact|standard|verbose`; rachas de lecturas y búsquedas agrupadas en `✓ explorado │ …`.
- ✅ (2026-10-27) Persistir `/verbosity` (`tui.verbosity`, en la config global salvo que el proyecto la declare)
  y restaurar el uso de sesión al reanudar (`SessionContext.usage`). De paso, dos bugs: `/sessions resume` en
  caliente seguía mostrando y sumando el uso de la sesión anterior (`CLEAR` no lo toca y el agente no lo
  reiniciaba), y `chat --resume` reescribía a 0 `toolCallCount`.
- La confirmación con Enter/Esc **ya estaba**: Enter permite y Esc deniega en `DestructiveConfirm`,
  `RevertConfirm`, `PlanApproval` y `QuestionPrompt`; `confirmPhrase` y los conflictos (`f`) siguen exigiendo
  un gesto explícito.
- **Pendiente:** el desglose del medidor de contexto (sistema/tools/mensajes). `ContextBreakdown`
  (`agent/context-builder.ts`) ya lo calcula, pero solo para las sesiones con conversación duradera (daemon).
  También faltan las tarjetas de tool por intención.

### UX-4 — `/btw` y tool a segundo plano *(S + M)*
- ✅ (2026-10-27) `/btw <pregunta>`: `StratumAgent.askSideQuestion` (`agent/side-question.ts`), sin tools, por
  `tracedCompletion` con origen `side-question`. No entra en la conversación, la memoria ni el uso; vale con el
  turno en curso (`BUSY_COMMANDS`). La respuesta llega entera, no en streaming.
- «Pasar a segundo plano» un `exec` en curso → job: **sin empezar, y no es S**. El backend local se queda el
  proceso (`tools/exec/backends/local.ts`) y `JobManager` solo sabe lanzar los suyos (`start`): hace falta un
  `adopt` con su `JobOutput` redactado y decidir cómo encaja con «todo proceso que sobreviva a su exec es un
  job» (`decisiones.md`). Necesita un diseño antes de implementarlo.

### Contrato-1 — Cerrar v1 *(M)* ✅ (2026-10-23, sin commit)
- `sessions.open { resume }`: monta una sesión guardada del daemon (mismo id y ajustes; rechaza los de apertura).
- `trace.subscribe`/`unsubscribe`: `daemon/trace-feeds.ts` sigue el fichero de traza por tramos (el fichero es el búfer).
- `tool.blocked`: `tool_error.blocked` desde `vetoed()` (dispatcher) y `vetoOutcome()` (loop); `counters.blocked`.
- `session.detached` **retirado** del contrato (lo cuenta la foto, §14.3). `broker` queda reservada y sin conceder.
- Anotado en `docs/protocol.md` §11, §13.6 y §17.
- Fan-out de `EventHub` ✅: medido con `scripts/bench/event-hub-fanout.ts` y optimizado (cada evento se serializa
  una vez; la trama se monta concatenando, idéntica byte a byte). 50 clientes: de 1266 ms a 281 ms de CPU por 40 turnos.
- `sessions.revert` ✅ con la decisión §6.3 tomada: exige **`approve`** (clave de aprobador). Solo sesiones del daemon,
  en reposo; `dryRun`, `force`, `conflicts` sin tocar nada (`docs/protocol.md` §19.8).
- **Pendiente:** que Dot/Desktop llamen a `sessions.revert` (en Dot, por la conexión de aprobador y su confirmación
  nativa); la congelación en sí llega con el primer tag que publique `stratumd`.

### Eval-1 — Replay de sesión grabada *(M)*
- Escenario = traza grabada + `workspace.expected/`. Corre sin modelo en CI y verifica el mundo, no la
  respuesta del agente.

### Loop-1 — Tools de solo lectura en paralelo y guards de aviso *(M)*
- Pool acotado para tools sin efectos según `callEffects`; resultados confirmados en orden. Leer antes
  `agent-loop.md`, `tools.md` y la §12 de la spec (`spec-read`). Validar después con `spec-validator`.
- Aviso de tool repetida como decisión del runtime (`TraceScope.runtime`).
- Compactación que reproduce el prefijo cacheado y poda resultados de tools antes de resumir.

Después, por orden: **plugins (R1 → PL1)**, **Hitos 18–19** y la **cola de M9** de cara a la release firmada.

---

## 6. Decisiones que tomar

1. ~~¿UX-1/UX-2/UX-3 antes que plugins y que el Hito 18?~~ Decidido: sí, ya implementados.
2. Semántica de `@`: perfiles frente a ficheros.
3. ~~¿`sessions.revert` exige la clave de aprobador?~~ Decidido (2026-10-23): sí, capacidad `approve`.
4. ~~Coste en $~~ Decidido en la implementación: tabla de precios propia en config (`pricing`), sin models.dev.
5. §15.1.4 (Dot como modo compacto de Desktop), antes de rehacer el layout de Desktop con las 3 columnas.

## 7. Estado verificado (2026-10-27)

Comprobado contra el código por cuatro investigaciones de opencode (`stratum-buscador`, solo lectura). Las
rutas son de `stratum-cli/src/` salvo que se diga otra cosa.

| Bloque | Estado |
|---|---|
| **Loop-1** — paralelismo | ✅ (2026-10-27). `dispatchApproved` decide con `callEffects`: lo no mutante va en un pool de `PARALLEL_READ_LIMIT` = 2 y todo lo demás (escrituras, `exec` que muta, MCP, desconocidas) es barrera y va solo, en el orden del modelo. `isSerialized` retirado |
| **Loop-1** — aviso de tool repetida | No existe en el runtime. La regla ya está escrita como métrica (`countRepeatedCalls`, `eval/metrics.ts`); falta emitirla como `TraceScope.runtime` |
| **Loop-1** — compactación con prefijo cacheado | No existe: `callCompressor` y la ruta M11 mandan un único `user` sin system ni tools. Sí recortan los resultados de tools antes de resumir |
| **Eval-1** — replay | No existe: el runner siempre lanza `stratum run`, y no hay `workspace.expected/` |
| `sessions.revert` en Dot/Desktop | No: ningún bridge lo expone. Desktop no puede aprobar (le falta el broker nativo) |
| Plugins (R1 → PL1) | Sin código. R1 propone tomar como unidad de confianza el candidato resuelto (todos los ficheros que el entry puede cargar) |
| Hito 18 | Sin tools. Los nombres ya están reservados en `INFRA_TOOLS` (`agent/session-profile.ts`) |

Orden que se propone desde aquí: **Loop-1** (paralelismo → aviso de repetición → compactación, esta última
medida con eval), **Eval-1**, y después plugins, el Hito 18 y el revert en Dot.

## Anexo — fuentes

- Clones de solo lectura (no se ejecutaron): `opencode` rama `v2` y `deepseek-ai/deepseek-harness` `master`,
  en el scratchpad de la sesión del 2026-10-23.
- Documentos internos citados: `CLAUDE.md`, `.claude/docs/hitos.md`, `docs/PRD_STRATUM_DOT.md`,
  `docs/protocol.md` §13.6/§17, `docs/STRATUM_CLIENT_ARCHITECTURE.md`,
  `CLI-DOC/Orientacion-Infraestructura.md`, `CLI-DOC/Plugins-Implementacion.md`.
