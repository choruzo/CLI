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
>
> **Actualización 2026-10-28:** Eval-1 (replay) y la compresión que reutiliza el prefijo cacheado (opt-in,
> `agent.compressionReusePrefix`). El estado de los siguientes candidatos —exec a segundo plano, plugins PL1 y
> Hito 18—, contrastado con el código, está en §8. Después, el `exec` a segundo plano con Ctrl+B (§8.2) y
> dos correcciones a los diseños de plugins (§8.3) y del Hito 18 (§8.4).

> **Actualización 2026-10-29:** cambios rápidos (publicar `/model` y compañía en reposo, «cambios por
> turno» en el pie, `stratum sessions export`) y **PL1 de plugins** hechos. Estado y lo que queda en §9.

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
- ✅ (2026-10-28) Desglose del contexto en `/context` (sistema / tools / memorias / conversación, estimado y
  rotulado con `~`; `cli/ui/context-format.ts`). `ContextBreakdown` ya se calculaba en cualquier sesión. De paso,
  dos bugs de su calibración, que también afectaban a `sessions.context` del daemon: `ContextManager.calibration`
  devolvía ×3,5 de más (también lo usaba la compactación M11 para medir la memoria de sesión) y las tools
  contaban dos veces (`prompt_tokens` las incluye y el factor se calibraba solo contra los mensajes).
- **Pendiente:** las tarjetas de tool por intención; un panel de contexto vivo (hoy es un comando). En la
  compactación M11, `before = usage().used + overhead` suma las tools encima de un `used` que ya las incluye
  (por `prompt_tokens` o por el factor calibrado): compacta antes de tiempo. Es la dirección segura, pero hay
  que decidirlo con eval.

### UX-4 — `/btw` y tool a segundo plano *(S + M)*
- ✅ (2026-10-27) `/btw <pregunta>`: `StratumAgent.askSideQuestion` (`agent/side-question.ts`), sin tools, por
  `tracedCompletion` con origen `side-question`. No entra en la conversación, la memoria ni el uso; vale con el
  turno en curso (`BUSY_COMMANDS`). La respuesta llega entera, no en streaming.
- ✅ (2026-10-28) «Pasar a segundo plano» un `exec` en curso → job, con **Ctrl+B** en la TUI. Detalle y
  decisiones en §8.2.

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
| **Loop-1** — aviso de tool repetida | ✅ (2026-10-28). Regla única en `agent/repeat.ts` (`RepeatTracker`), compartida con `countRepeatedCalls`. Sin veto: bloque `<repeated_tool_call>` al final del lote con `appendRuntimeNotice` y evento runtime `repeat` (no suma `warnings`). Solo cuenta lo ejecutado (`DispatchResult.notRun`) y la ventana se cierra tras delegar o preguntar. La métrica cuenta además lo vetado y las tools de control |
| **Loop-1** — doble conteo en M11 | ✅ (2026-10-28). `compactSession` sumaba `overheadTokens()` a un `used` que ya incluía las tools: compactaba antes de tiempo. Ahora `sessionInput` calibra contra mensajes + tools, como `getContextReport`. Queda: `overheadTokens()` mide el toolset `normal` sin filtro de perfil ni plan |
| **Loop-1** — compactación con prefijo cacheado | ✅ (2026-10-28), **opt-in** (`agent.compressionReusePrefix`, por defecto `false`) y solo en la compresión en línea de `chat`/`run`. El resumen manda el historial tal cual (mismas tools con `tool_choice: 'none'`, campo nuevo `CompletionRequest.toolChoice`) **solo si** deja fuera de caché menos que el digest; si no, el digest de siempre. Medido con el guion: en el caso favorable, 1 743 tokens sin caché frente a 3 495; en el típico (salta justo tras un resultado grande, lo único que no está en caché) reutilizar dejaría 5 041 frente a 1 003, y se elige el digest. M11 queda fuera: su extractor necesita los mensajes etiquetados con id para la procedencia. Detalle en §8.1 y `stratum-cli/docs/prompt-caching.md` |
| **Eval-1** — replay | ✅ (2026-10-28). `stratum eval import <traza> --setup <dir> --expected <dir>` (`eval/replay.ts`) escribe un escenario del grupo `replay`: guion = respuestas del loop, criterio nuevo `workspace_expected` (inline, `strict`). Falla cerrado ante lo que el guion no puede repetir (argumentos recortados o redactados, errores/reintentos, solapes, compresión, lo contestado por una persona). Incluido `replay-rename-across-files`, generado de una traza real. Queda: la traza no guarda la config ni los flags de `run` de la sesión |
| `sessions.revert` en Dot/Desktop | No: ningún bridge lo expone. Desktop no puede aprobar (le falta el broker nativo) |
| Plugins (R1 → PL1) | Sin código. R1 propone tomar como unidad de confianza el candidato resuelto (todos los ficheros que el entry puede cargar) |
| Hito 18 | Sin tools. Los nombres ya están reservados en `INFRA_TOOLS` (`agent/session-profile.ts`) |

Orden que se propone desde aquí: **Eval-1**, la **compactación con prefijo cacheado** medida con él, y
después plugins, el Hito 18 y el revert en Dot (que choca con dos invariantes de Dot: la confirmación nativa
está construida sobre una solicitud pendiente y `ApproverMethod` no admite `sessions.*`).

> 2026-10-28: Eval-1 y la compactación con prefijo, hechos. El orden actualizado está al final de §8.

## 8. Siguientes candidatos, contrastados con el código (2026-10-28)

Cuatro investigaciones de solo lectura (opencode, `stratum-buscador`, `deepseek-v4-flash`). Las rutas son de
`stratum-cli/src/` y las de §8.1 se comprobaron al implementar; las demás vienen de los informes y conviene
revisarlas antes de copiar nada.

### 8.1 Compactación con prefijo cacheado — hecha (opt-in)

- **Qué había:** las dos rutas mandaban un digest sin system ni tools: la compresión en línea, con
  recortes de 1 500/4 000 caracteres por mensaje y un tope del 60 % de la ventana, y M11, con
  extractor + resumen y `renderChunk`. `tool_choice` era fijo `'auto'` y el `ContextManager` no
  recibía ni las tools ni el `sessionId`.
- **Qué se hizo:**
  - `CompletionRequest.toolChoice`.
  - `CompressionPrefix` (las tools, la sesión y el provider del loop). El toolset se calcula antes
    de comprimir.
  - `ContextManager.recordSent`: qué se mandó, con el system, el último mensaje, las tools y el
    modelo para validar que sigue siendo prefijo.
  - `prefixRequest`: el historial tal cual más la instrucción entre `<context_compression_request>`,
    pegada al último `user` si acaba en uno.
  - Se elige la petición que deja menos fuera de caché.
  - Solo un **rechazo** del backend (error no reintentable o resumen vacío) prueba con el digest. Red,
    5xx o timeout son el Caso A de §12.4.
  - El modelo de guion la reconoce por la instrucción final y `tool_choice: 'none'`.
  - Escenarios: `cache-compression-reuses-prefix` y `cache-compression-prefix-not-worth`.
- **Hallazgo que decide el diseño:** reutilizar el prefijo casi nunca compensa en el momento en que salta
  la compresión, porque salta tras un resultado grande y eso es lo único que no está en caché, mientras
  que el digest lo recorta a 1 500 caracteres. Sin la heurística, la opción empeoraba el caso típico ×5.
- **Medido contra llama.cpp (2026-10-28) — no se activa por defecto.** Con Qwen3.5-9B, el prefijo
  dejó 8,9K tokens sin caché frente a 2,2K del digest. La plantilla añade `<think></think>` a los
  turnos del asistente posteriores al último `user`, y la instrucción entra como un `user` nuevo,
  así que el prompt renderizado diverge en el primer turno del asistente (comprobado con
  `/apply-template`). Pegada al último resultado de tool, comparte el 96,5 %. Detalle en
  `stratum-cli/docs/prompt-caching.md`, «Medido contra llama.cpp».
  - Para medirlo hubo que encadenar las lecturas: un modelo real lee los nueve ficheros en una ronda
    y no queda nada que comprimir. Los escenarios del repo solo comprueban la caché en `mock`.
  - Gemma 4 12B no sirvió: llama.cpp `31385c9ce` revienta con `bad allocation` pasados ~11K tokens.
    Los `launch-*.ps1` de `G:\models` que llevan `--mlock` ya no arrancan con ese build.
- **Pendiente:**
  - ~~Decidir si la instrucción va pegada al último resultado de tool~~ Decidido (2026-10-28): **no**.
    Mete una instrucción del runtime en un canal de datos que no es de fiar, y el beneficio es pequeño
    (opción opt-in, solo en el caso favorable). La causa es la plantilla, no el cliente.
  - Comprobar que el resumen es igual de bueno viendo el historial entero.
  - La misma plantilla rompería la caché en cada turno nuevo de `chat` con Qwen3: está por medir.
  - Que la traza compare el prefijo de la compresión con el del loop: hoy lo compara por origen y
    `sharedChars` no lo refleja.
  - M11 no aplica.

### 8.2 Pasar un `exec` en curso a segundo plano (UX-4) — hecho (2026-10-28)

- **Qué se hizo** (contrastado antes con una investigación de opencode que corrigió el diseño de abajo):
  - El `exec` en primer plano no cambia; el traspaso es un gesto del usuario, **Ctrl+B**, con el agente
    trabajando. El pie del prompt lo ofrece solo mientras hay un comando que ceder.
  - `backends/local.ts`: con `ctx.jobs`, la llamada se anuncia al manager mientras corre
    (`registerForeground`). `handOver` está **dentro** de la promesa (ahí viven `settled`, los
    temporizadores y el abort): primero adopta y después suelta, todo en el mismo tick, y resuelve con un
    tipo nuevo, `ExecHandedOver`, no con un `ExecStatus` (así no contamina la auditoría).
  - `JobManager`: `launch()` se parte en `createRecord` + `attach`, compartidos con `adopt()`.
    `backgroundForeground()` devuelve `{ jobs, errors }`. `closed` y `maxRunning` se comprueban **antes**
    de que el backend suelte nada: si fallan, el comando sigue en primer plano. La salida acumulada se
    siembra en bruto (el `JobOutput` la redacta al entrar), y lo que `maxBytes` ya había descartado queda
    como una línea en la salida y como `truncated` en la auditoría.
  - `exec` devuelve `<exec_job … handedOver="true">` y **no** escribe su registro: el único es el del job
    (`background_started` con `handedOver: true`, más el de cierre).
  - **Reloj (decidido: opción b):** `startedAt`, la duración y el timeout (`tools.jobs.maxRuntimeMs`) cuentan
    desde la adopción; el `timeout` de la llamada era de primer plano. Pero el barrido de descendientes de
    Windows usa el nacimiento real (`JobRecord.spawnedAt`): con `startedAt` no vería a los hijos creados antes.
  - Subagentes: el dueño es el scope de la llamada, así que lo adoptado se cancela con su `closeScope`, igual
    que un `background: true` suyo. Un proceso que ya salió con los pipes abiertos se adopta y termina en el
    acto. `ToolContext.callId` no hizo falta.
  - Tests: `jobs/handover.test.ts` (7, con procesos reales). Docs: `jobs.md`, `exec.md`, `cli-ui.md` y
    `decisiones.md` (fila de jobs).
- **Pendiente:** el traspaso por el protocolo (Dot/Desktop: un método que exigiría decidir la capacidad)
  y en `run` sin terminal no hay quien lo pida. SSH sigue fuera.

Diseño original, para referencia:

- **Hoy:**
  - El backend local (`tools/exec/backends/local.ts`, `run()`) guarda el proceso en una closure
    (`settle`/`cleanup`/`timers`). El abort de la llamada y su timeout siguen armados y matan el árbol.
  - `JobManager` solo nace de `spawnLocalShell` (`jobs/manager.ts`, `launch()`).
  - `ToolContext` no lleva `callId`, así que nadie puede pedir «pasa a segundo plano la llamada X».
- **Diseño propuesto:**
  - `JobManager.adopt(handover)`, sacando de `launch()` un `attach(rec, subprocess)` común: límite
    `maxRunning`, `JobOutput` redactado, fin por `exit`, auditoría `background_started` y traza.
  - En `local.ts`, un `handOver()` que en el **mismo tick** quite el listener de abort, limpie los
    temporizadores, marque `settled` y devuelva el proceso y lo acumulado.
  - Un estado nuevo de `ExecOutcome` que `exec.ts` formatee como `<exec_job>`.
  - `ToolContext.callId` desde `dispatchOne` (`tools/registry.ts`).
  - En la TUI, la tecla `b` sobre el bloque de un `exec` en curso.
- **Trampas:**
  - `SessionPublisher` publica cualquier `JobEvent` que no sea `created` como `job.ended`
    (`host/session-publisher.ts`).
  - Auditoría doble: el registro de primer plano de `exec.ts` y el de `background_started`.
  - `ByteBudget` guarda la **cabeza** y `JobOutput` la **cola**.
  - El job adoptado desde un subagente muere al cerrar su ámbito (`closeScope`).
  - `adopt` tiene que rechazar tras `shutdown()` o por encima de `maxRunning`, y el `exec` sigue en
    primer plano.
- **Decisiones pendientes:** si el reloj del timeout se reinicia al adoptar. SSH queda fuera: el manager
  mata por pid y el remoto es un `ClientChannel`.
- **Tests:** `local.test.ts` (ceder no mata; un abort posterior no toca al job), `exec.test.ts`,
  `manager.test.ts` y `manager-race.test.ts`, `output.test.ts`, `jobs-flow.test.ts`,
  `session-publisher.test.ts` y `session-runtime.test.ts`. Hay que añadir una frase a `jobs.md` y un
  matiz a `decisiones.md`: adoptar no relaja ninguna guarda, porque la confirmación ya ocurrió.

### 8.3 Plugins PL1 — se puede empezar, pero antes hay que corregir el diseño

> **Corrección (2026-10-28, investigación de opencode contrastada):** `chat` **no** arranca por
> `SessionHost` (`chat.ts` no lo importa; lo dice `session-host.md`), solo `run` y el daemon. Un
> `SessionHostOptions.plugins` no llegaría a `chat`: allí van por `StratumAgentOptions` → `extras` del
> `ReactLoop` → `ToolContext`, con `PluginHost.empty()` por defecto. Propuesta para R3: `tool.before`
> como primera sentencia de la fase de vetos (`tools/registry.ts`, antes de `readOnlyVeto ?? preflight`),
> con `ToolBlockSource` `'plugin'` y `countsAsFailure: false`; un lote descartado por steering nunca
> dispara hooks. Para R2: `tool.after` en `dispatchOne`, después de `redactResult` y antes del truncado, y
> `DispatchResult` con el resultado interno (para el write-log) y el presentado (para el modelo). R2 solo
> afecta al write-log: la auditoría de `exec` se escribe dentro de la tool.

- **R1** (huella de confianza del proyecto) sigue **sin decidir**. No bloquea PL1, que solo carga
  orígenes de confianza implícita (flag, config global y `~/.stratum/plugins/`). Hoy **no existe ningún
  mecanismo de confianza de proyecto**: el `.stratumrc.json` y `.stratum/agents/` del proyecto se cargan
  sin puerta.
- **R2 y R3 cambian PL1 y hay que cerrarlos antes:**
  - R2: el write-log se calcula después de `tool.after` (`agent/harness.ts`, tras `dispatch`). Hace
    falta guardar a la vez el resultado interno y el presentado, o calcular el write-log y la auditoría
    antes de `tool.after`.
  - R3: el orden real es en dos fases. Primero los vetos de todas las llamadas (`readOnlyVeto ??
    preflight`, `tools/registry.ts`) y después las confirmaciones, con `environmentGate` dentro.
    `tool.before` va en la fase de veto, y además hay que situarlo respecto a la pausa, el descarte por
    steering y la repetición, que el diseño no contempla.
- **Referencias obsoletas del documento:**
  - `run` ya no se cablea en `run.ts`: va por `resolveSessionStartup` → `SessionHost`. Cargar plugins
    dentro de `SessionHost.create` los cargaría también en `stratumd`, así que hace falta un
    `SessionHostOptions.plugins` que rellenen `chat` y `run`.
  - Desktop ya no es un sidecar: no hay `src/desktop/`.
  - Las skills tienen ahora una dimensión `preset`: el punto único es `sessionSkills()`, no `skillDirs()`.
  - R6 ya está resuelto en `observe()` (`agent/core.ts`), que es el punto único de `run()` y
    `runDelegate()`.
  - Las líneas citadas en R2, R3, R8 y R12 se han movido.
- **Además:** añadir `plugin__*` al perfil `infra` (`agent/session-profile.ts`, R9) y un test que fije que
  una tool con `callEffects` desconocido cuenta como mutante sin target (R8). R4, R5, R7 y R1 se aplazan a
  PL4/PL5 con una nota explícita. Tamaño de PL1: M.

### 8.4 Hito 18 — no se puede implementar sin escribir antes la spec

> **Corrección (2026-10-28):** la §12.21 está ocupada (pausa cooperativa) y también de la 12.22 a la 12.26.
> La sección de `sys_inspect` será la **§12.27**. Decisión previa: si la tool lanza sus propios procesos
> (`df`, `Get-CimInstance`), no pasa por las guardas de comando ni por `exec-audit.jsonl`, que son de `exec`.

- `CLI-DOC/Orientacion-Infraestructura.md` no es vinculante y da **prosa, no contratos**: no hay schemas,
  ni forma de salida, ni criterio de terminado, ni §12.21. Los nombres están reservados en `INFRA_TOOLS`
  (`agent/session-profile.ts`), pero la reserva es inerte hasta que algo se registre.
- **Lo que el documento no menciona y rompería invariantes:**
  - Sin declararlas en `callEffects` (`tools/environments.ts`), las tools nacen como mutantes sin
    target: el modo read-only las vetaría y `environmentGate` no vería su target.
  - Tienen que entrar en `READ_ONLY_SESSION_TOOLS` (`tools/call-policy.ts`) y en `PLAN_ALLOWLIST`
    (`agent/plan.ts`), o no estarán en `/readonly` ni en la Fase 1 del plan, que es justo donde más
    se usan.
  - Para el badge y la confirmación legible, `targetOfCall` y `describeCall`.
  - `auto` resuelve a `full`: quien tenga docker en el PATH vería estas tools, contra el principio de
    que quien solo escribe código no las ve.
  - No hay deduplicación de logs: el truncado 80/20 se come el medio.
  - La redacción es **por forma**: un token cualquiera en una línea de journal no casa.
- **Decisiones abiertas:**
  - Ejecución remota: sondas nativas de Node, solo en local, o `dig`/`curl` por SSH, que exige parsear.
  - Política de `n/d` por SO: Linux, PowerShell/CIM y macOS.
  - Si una lectura de logs en `prod` se audita.
  - §8.1 del documento está obsoleto: el ejecutor de PowerShell ya existe.
- **Primer corte propuesto, sin red ni servidores:**
  - `sys_inspect`, solo en local, con parsers puros en `tools/infra/sysinfo/` probados con salidas
    capturadas de Ubuntu y Windows, y el runner inyectado.
  - Después, `net_probe` reducido a `dns`/`tcp` con el resolver y el conector inyectados.
- **Antes de escribir código:** §12.21 con los schemas de las cuatro tools.

### 8.5 Orden propuesto

1. ~~**Exec a segundo plano** (§8.2)~~ ✅ 2026-10-28.
2. En paralelo y sin código: **corregir el diseño de plugins** (R2, R3 y las referencias obsoletas, §8.3)
   y **escribir §12.21** del Hito 18 (§8.4). Las dos cosas desbloquean bloques L.
3. ~~**Medir la compactación con prefijo contra llama.cpp** (§8.1)~~ ✅ 2026-10-28: sigue apagada por
   defecto (la plantilla de Qwen3 rompe el prefijo). Corregido también el diseño de plugins (§11 de
   `Plugins-Implementacion.md`), con sus tres decisiones tomadas: PL1 se puede empezar.
4. Después, PL1, el primer corte del Hito 18 y el revert en Dot.

## Anexo — fuentes

- Clones de solo lectura (no se ejecutaron): `opencode` rama `v2` y `deepseek-ai/deepseek-harness` `master`,
  en el scratchpad de la sesión del 2026-10-23.
- Documentos internos citados: `CLAUDE.md`, `.claude/docs/hitos.md`, `docs/PRD_STRATUM_DOT.md`,
  `docs/protocol.md` §13.6/§17, `docs/STRATUM_CLIENT_ARCHITECTURE.md`,
  `CLI-DOC/Orientacion-Infraestructura.md`, `CLI-DOC/Plugins-Implementacion.md`.

## 9. Cambios rápidos y PL1 (2026-10-29)

Elegidos tras cuatro investigaciones de solo lectura (opencode, `stratum-buscador`): PL1 listo para empezar,
Hito 18 sin spec (la §12.27 sigue sin escribir), revert en Dot bloqueado por invariantes de Dot (el broker
solo admite 4 métodos, descarta el `result` y la confirmación nativa exige una solicitud pendiente) y una
lista de piezas pequeñas.

### 9.1 Cambios rápidos — hechos

- `/model`, `/provider`, `/agent`, `/readonly` y `/profile` publican `session.updated` en el acto
  (`RemoteSessionLink.sessionChanged`), no al cerrar el turno siguiente. Cubierto en `npm run tui:peer`.
- «Cambios por turno»: `✓ hecho · 1.0 s · ✎ 1 fichero · +3 −0`. Trampa encontrada al probarlo en la TUI
  real: el turno entra en `<Static>` en el mismo `done` y no se repinta, así que T1 se toma **antes** de
  entregar el `done` (`runTurn`). Sin snapshots no se pinta nada. Cubierto en `npm run tui:smoke`.
- `stratum sessions export <id> [--format json|markdown] [-o fichero]`, con todo el historial redactado.
- `peer-host.md` decía que `/init` no se publicaba; sí se publica.
- De paso: `daemon-peer.mjs` esperaba un texto en inglés que la TUI ya no pinta (fallaba también en HEAD).

### 9.2 PL1 de plugins — hecho

Ver `Plugins-Implementacion.md` §12 y la §12.28 de la definición. Decisiones: tope por lote
`plugins.batchTimeoutMs` = 15 s, y `apiVersion` validado ya en PL1. La config de plugins sale solo de la capa
global. Probado en la TUI real: `/plugins` y un veto de `--plugin` sin pedir confirmación.

### 9.3 Lo siguiente

1. **PL2** (tools, comandos, bloques de prompt, `compaction.context`, `notify`, `.d.ts`); R10 aplica ahí.
2. **§12.27 y primer corte del Hito 18** (`sys_inspect` local): `LOCAL_READERS`, `READ_ONLY_SESSION_TOOLS`,
   `PLAN_ALLOWLIST` y `registerBuiltinTools` son los cuatro puntos de registro.
3. Piezas M que siguen pendientes: tarjetas de tool por intención, temas, `@fichero` (decidir la semántica
   de `@`), panel de contexto vivo y `/sessions resume` en caliente (cambiar el id publicado exige cerrar y
   registrar otra sesión).
4. Revert en Dot: exige decidir si se rompe «el aprobador solo resuelve» o se abre otra lista de métodos.