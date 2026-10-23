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

### UX-1 — Undo por turno *(M)*
- `src/snapshots/`: git en la sombra fuera del repo del usuario (con `scrubGitEnv`), snapshot al empezar y
  al terminar cada turno que mute, límite por fichero, `gc`. Escritura atómica y validación al leer.
- `/undo` (último turno) y `/rewind` (elegir turno); confirmación con la lista de ficheros que se van a
  restaurar. **No** deshace efectos de `exec` ni de SSH: decirlo en la propia UI.
- Método de protocolo `sessions.revert` (+ `schemas.ts`) para que Dot/Desktop lo ofrezcan.
- Leer antes: `riesgo.md`, `git-changes.md`, `sesiones.md`, `protocol.md`.

### UX-2 — Edición robusta y diagnósticos *(S + L)*
- Escalera de match en `edit_file` (exacto → Unicode → líneas sin espacios finales), siempre exigiendo
  unicidad y con el nivel en la traza. Escenarios de eval con comillas tipográficas, tabs y espacios.
- `lsp` opcional por `importOptional()`: tras `edit_file`/`write_file` se piden diagnósticos del fichero
  (TypeScript/pyright/rust-analyzer configurables en `.stratumrc.json`) y se anexan al resultado de la tool.
  Si falla, es un fallo auxiliar y no del agente. Conviene medir con eval si ahorra iteraciones frente a
  `exec tsc`.

### UX-3 — Telemetría y densidad de la TUI *(S–M)*
- Pills de actividad y uso, uso por turno, desglose del contexto, coste en $ (tabla de precios en config o
  snapshot de models.dev; sin precio → `n/d`).
- Razonamiento con vista previa por párrafo, `/verbosity`, tool calls agrupadas por familia, Esc Esc y el
  indicador Send/Steer/Queue.
- `run --output-format json|stream-json` (eventos `AgentEvent` serializados) para CI.
- Probar con build + `npm run tui:smoke` + un escenario propio (skill `tui-test`).

### UX-4 — `/btw` y tool a segundo plano *(S + M)*
- `/btw <pregunta>`: `tracedCompletion` con un origen nuevo, sin entrar en la conversación ni en la memoria.
- «Pasar a segundo plano» un `exec` en curso → job, con las mismas guardas.

### Contrato-1 — Cerrar v1 *(M)*
- Implementar o retirar `sessions.open{resume}`, `trace.subscribe`, `session.detached` y `tool.blocked`.
  Fan-out de `EventHub` con frame único por evento. Anotar en §17 y preparar la congelación.

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

1. ¿UX-1/UX-2/UX-3 antes que plugins y que el Hito 18? (recomendado: sí; son de M y se notan en el día a día).
2. Semántica de `@`: perfiles frente a ficheros.
3. ¿El undo se ofrece también en Dot/Desktop desde el principio (`sessions.revert`) o solo en la TUI?
4. Coste en $: tabla de precios propia en config o snapshot de models.dev empaquetado (choca con «sin red» si
   se refresca solo).
5. §15.1.4 (Dot como modo compacto de Desktop), antes de rehacer el layout de Desktop con las 3 columnas.

## Anexo — fuentes

- Clones de solo lectura (no se ejecutaron): `opencode` rama `v2` y `deepseek-ai/deepseek-harness` `master`,
  en el scratchpad de la sesión del 2026-10-23.
- Documentos internos citados: `CLAUDE.md`, `.claude/docs/hitos.md`, `docs/PRD_STRATUM_DOT.md`,
  `docs/protocol.md` §13.6/§17, `docs/STRATUM_CLIENT_ARCHITECTURE.md`,
  `CLI-DOC/Orientacion-Infraestructura.md`, `CLI-DOC/Plugins-Implementacion.md`.
