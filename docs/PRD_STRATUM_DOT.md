# PRD — Stratum Dot

> Cockpit de escritorio del harness Stratum.
> Estado: **congelado** (2026-10-12). Solo cambia por descubrimientos de implementación,
> anotados en el hito que los encuentra. **M0–M12 implementados** (M12 completado: Desktop es un cliente hermano de `stratumd`; ver su estado y `docs/STRATUM_CLIENT_ARCHITECTURE.md` §8) (M4 con §22 Q2 abierta como endurecimiento: ver su estado; M6 y M7 con su alcance acotado; M9 ejecutado como endurecimiento de seguridad, autoridad e IPC, con el resto de su alcance original pendiente: ver su estado; M10 redefinido al empezarlo como continuidad de sesión —traspaso de una sesión viva al daemon—: ver su estado; M11 redefinido al empezarlo como conversación duradera y memoria de sesión —la decisión del default de `chat` se aplaza—: ver su estado).
> Base de código analizada: `stratum-cli` 0.8.0-beta.3, `stratum-desktop` 0.4.0-beta.0 (protocolo v9).
>
> **Revisión 2026-10-29 — dirección «asistente virtual».** Dot evoluciona de cockpit a asistente
> virtual **sin dejar de ser cockpit**: un agente embebido nuevo, `companion` (el que acompaña en
> el día a día, con memoria propia), pasa a ser su cara principal y gana un ordenador propio
> contenido (la caja), computer use dentro de ella, rutinas en segundo plano y herramientas
> conectables. Desktop sigue siendo la app de trabajo en local con su `assistant` y su memoria.
> Todo lo de M0–M12 se conserva. Diseño, evidencia e
> hitos (M13–M18) en **§23**; los apartados que cambian lo indican (§1, §5, §8.2, §13.6, §15.2).

Convención: **[existe]** = ya está en el repositorio; **[nuevo]** = hay que construirlo;
**[verificado]** = comprobado contra el código actual; **[decidido]** = decisión de producto
cerrada, no se reabre al implementar.

**Regla de orden (decidida).** M0 → M1 → M2 → M3 → M4 → M5 → M6–M8 → M9. No se empieza
Tauri/Dot (M6) antes de haber demostrado M0–M4. La interfaz depende del plano de control;
el plano de control no depende de la interfaz. El daemon consume **exactamente el mismo
`SessionHost`** que la CLI: no hay un cuarto cableado de sesión.

---

## 0. Estado actual relevante (resumen del análisis)

| Pregunta | Hallazgo |
|---|---|
| ¿Hay un runtime reutilizable? | Sí. `StratumAgent` (`src/agent/core.ts`) es un generador de `AgentEvent` sin dependencia de la UI. Los *gates* humanos ya son callbacks inyectados por `RunOptions` (`onConfirmDestructive`, `onAskQuestions`, `onApprovePlan`). |
| ¿Hay un servidor/daemon? | Hay un **sidecar** (`src/desktop/`, `desktop-server.ts`): servidor `net` sobre named pipe / unix socket, NDJSON, handshake con token, validación Zod `strict()`, `ShutdownRegistry`. Es el 70 % de un daemon, pero con tres propiedades que Dot necesita invertir (abajo). |
| ¿Qué impide usar el sidecar tal cual? | (1) **Un solo cliente** con *lease*: uno nuevo sustituye al anterior (`server.ts`, `ClientLease`). (2) **Desconectarse mata las ejecuciones**: `ConversationHost.detach()` llama a `closeAll()`. (3) **Muere con su padre** (`--watch-stdin`) y su pipe tiene nombre aleatorio que solo conoce Tauri: no es descubrible. (4) Datos **separados** de la CLI (`~/.stratum/desktop/{sessions,traces,memory}`) y preset `assistant` sin `exec`. |
| ¿Qué está acoplado a la CLI? | El **cableado de una sesión** está escrito tres veces: `cli/commands/chat.ts` + `cli/ui/App.tsx` (2 887 líneas; `getRunOptions`, gates como callbacks de React, `PlanStore`, `SubagentStore`), `cli/commands/run.ts` (lo mismo con readline) y `desktop/conversation.ts` (982 líneas, lo mismo con tramas). No hay una pieza «anfitrión de sesión» compartida. |
| ¿El core asume un proceso por sesión? | Sí, en dos sitios. `process.cwd()` aparece fuera de `cli/` en `agent/` (11), `config/` (5), `memory/project.ts`, `skills/registry.ts` y `tools/` (2). Y hay estado de módulo con forma de «una config por proceso»: `tools/ssh/runtime.ts` y `tools/exec/runtime.ts` (singleton por config), y el teardown es global: `closeExecRuntime()` → `shutdownAllJobs()` → `closeSshPool()` — cerrar una instancia afecta a todo el proceso **[verificado]**. El sidecar actual no lo sufre porque solo aloja el preset `assistant` (sin `exec`, sin SSH). |
| ¿Las tools ya son multi-cwd? | Las tools sí, la composición no. `read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep`, `exec`, el backend local y las operaciones locales de SFTP resuelven contra `ToolContext.cwd` **[verificado]**. Lo que sigue atado a `process.cwd()` es lo que monta la sesión: `agent/core.ts`, `memory/project.ts`, config, skills. Por eso M0 sigue siendo necesario. |
| ¿La observabilidad es del harness? | Sí. La traza (`~/.stratum/traces/<sessionId>.jsonl`) la escribe el runtime en cualquier cliente; `trace/model.ts` y `trace/records.ts` son puros (sin Node); `FileTail` y `desktop/trace-feed.ts` ya la retransmiten en vivo. Lo que **no** existe es un registro de qué sesiones están vivas ahora ni un canal para verlas desde otro proceso. |
| ¿Existe el concepto «run»? | No. Existen **sesión** (`SessionContext`) y **turno** (`turn`/`turn_end` en la traza, `turnId` en Desktop). Tampoco existe **pausa**: solo cancelación (`AbortSignal`) y *steering* (`RuntimeInbox`). |
| ¿Qué dice hoy la documentación sobre compartir sesiones? | Lo contrario de lo que pide Dot. `STRATUM_DESKTOP_PROJECT_DEFINITION.md` §1: «Instancias aisladas… No hay sesión compartida entre procesos»; §12 excluye la «sincronización de sesión en tiempo real entre instancias». Este PRD **revierte esa decisión** a propósito y lo declara en §16. |

---

## 1. Executive Summary

**Stratum Dot** es una aplicación de escritorio ligera y residente (bandeja del sistema +
ventana flotante) que actúa como *cockpit* del harness Stratum: desde ella se conversa
con Stratum, se ve qué agentes están trabajando —los haya lanzado Dot o una terminal—, se
inspecciona cada ejecución (tools, contexto, memoria, traza) y se atienden las
aprobaciones pendientes.

Dot no ejecuta agentes. Para que pueda observarlos hace falta una pieza que hoy no
existe: un **plano de control** local y persistente, `stratumd`, al que se conectan todos
los clientes con un mismo protocolo. El grueso de este PRD es ese plano de control; la
interfaz de Dot es la parte pequeña.

*Desde la revisión de 2026-10-29 (§23)*, Dot es además **la casa del asistente** (`companion`,
distinto del `assistant` de Desktop y con su propia memoria): un agente de
larga vida, alojado en `stratumd`, con su propio ordenador en un contenedor (donde puede
instalar, ejecutar y manejar un navegador por la pantalla), rutinas programadas, memoria y
herramientas conectables. Lo que sale de su caja sigue pasando por el mismo centro de
aprobaciones, con la autoridad fuera del webview.

## 2. Problem Statement

Con la CLI como único cliente:

1. **Una ejecución solo es visible en la terminal que la lanzó.** Un `stratum run` largo
   en otra pestaña, por SSH o en segundo plano no se ve desde ningún otro sitio; la
   traza existe, pero hay que saber el `sessionId` y abrir `stratum auditor`.
2. **Una confirmación bloquea en silencio.** Si el agente pide confirmar un `git push`
   y la terminal no está a la vista, el turno espera sin avisar. Sin TTY, directamente
   se deniega.
3. **No hay vista de conjunto.** Con varias sesiones (más subagentes y jobs) no hay
   respuesta a «¿qué está corriendo ahora mismo y cuánto contexto le queda?».
4. **La ejecución muere con su terminal.** Cerrar la ventana corta el turno.
5. **Stratum Desktop no lo resuelve**: es un cliente con su propio sidecar, sus propias
   sesiones y sin visibilidad de la CLI.

## 3. Product Vision

**Stratum es el harness. Dot es uno de sus clientes.**

```text
   stratum-cli      stratum-dot      (futuros: Desktop, IDE, web local)
        │                │                    │
        └────────────────┼────────────────────┘
                         │  Stratum Protocol (NDJSON sobre pipe/socket local)
                 ┌───────┴────────┐
                 │    stratumd    │  plano de control: registro de sesiones y runs,
                 │                │  bus de eventos, centro de aprobaciones, trazas
                 └───────┬────────┘
                         │  SessionHost (misma pieza en todos los anfitriones)
                 ┌───────┴────────┐
                 │ StratumAgent   │  loop ReAct · tools/MCP · memoria · políticas
                 └────────────────┘
```

Tres invariantes de producto:

- **Un runtime, un plano de control.** Solo hay una implementación del agente, un formato
  de sesión, un modelo de eventos y un sitio donde se registran las ejecuciones.
- **Dot es prescindible.** Cerrar Dot no detiene nada. Sin Dot instalado, la CLI y el
  daemon funcionan igual, y lo que Dot enseña se puede consultar con `stratum ps`.
- **La seguridad no depende del modelo ni de la interfaz.** Lo que el agente puede hacer
  lo decide el core (`ToolDispatcher`); lo que el escritorio permite, el proceso nativo.

## 4. Goals

- G1. Ver en tiempo real, desde Dot, cualquier ejecución de Stratum de la máquina, sin
  importar qué cliente la inició.
- G2. Resolver aprobaciones, preguntas y planes desde Dot, con notificación del sistema.
- G3. Controlar una ejecución: detener, pausar/reanudar, redirigir (*steering*).
- G4. Lanzar y conversar con agentes desde Dot; esas ejecuciones sobreviven a Dot.
- G5. Inspeccionar una ejecución: tarea, perfil, modelo, estado, duración, tokens,
  contexto, tools, memoria, errores, línea de tiempo.
- G6. Que todo lo anterior sea una capacidad **del harness** expuesta por protocolo, con
  Dot y la CLI como dos consumidores.
- G7. No romper nada: `stratum chat`, `stratum run`, `stratum eval` y Stratum Desktop
  siguen funcionando igual sin daemon.

## 5. Non-Goals (v1)

- Voz, hotkey con captura de contexto, clipboard, captura de pantalla, computer-use.
  El modelo de seguridad los contempla (§13); la v1 no los implementa.
  *Revisión 2026-10-29*: computer use **dentro de la caja del asistente** y las rutinas en
  segundo plano dejan de ser non-goals (§23, M13–M16). Siguen fuera la voz y el escritorio del
  propio host (§13.6).
- Acceso remoto o por red. El daemon es local y de un solo usuario. Nada de TCP.
- Cambiar dónde se ejecuta `stratum chat`: durante M0–M9 sigue en su proceso (§9.3).
- Fusionar o migrar Stratum Desktop: durante M0–M9 no se toca (§9.5).
- Mantener dos arquitecturas de escritorio indefinidamente: tampoco es un objetivo (§15).
- Persistir jobs en segundo plano más allá de su sesión (decisión vigente, no se toca).
- Un editor de configuración en Dot (Desktop ya tiene uno; la v1 enlaza al fichero).
- macOS (igual que Desktop v1: requiere firma y notarización).
- Multiusuario, cuentas, sincronización en la nube, telemetría.

## 6. Personas y casos de uso

| Persona | Situación | Qué le da Dot |
|---|---|---|
| **Developer** | Lanza `stratum run` y sigue trabajando en el editor | Aviso al terminar o al necesitar confirmación; un clic para ver qué hizo |
| **Operator / power user** | Varias sesiones contra entornos distintos (`ssh:prod-*`, local) | Vista de conjunto con el entorno y el modo (`RO`, `◑ PLAN`) de cada una; aprobaciones con nombre tecleado |
| **Usuario de agentes largos** | Una tarea de 40 minutos con subagentes y jobs | Progreso, contexto %, árbol de subagentes; puede cerrar la terminal si la ejecución vive en el daemon |
| **Supervisor** | No escribe prompts; autoriza lo sensible | Centro de aprobaciones con qué agente pide qué, en qué entorno, y el rastro de quién aprobó |

## 7. User Stories

Formato: *como … quiero … para …* → criterio observable.

- US-1. Como developer, quiero que un `stratum run` de cualquier terminal aparezca en Dot
  en menos de 1 s, para no buscar su sesión. → Aparece en Activity con perfil, tarea y estado.
- US-2. Como developer, quiero una notificación cuando una ejecución termina o falla.
  → Notificación del SO si duró más de `dot.notifications.minSeconds`.
- US-3. Como supervisor, quiero recibir cada solicitud de aprobación con el comando ya
  redactado y el entorno, y responder *rechazar / aprobar una vez / permitir en la sesión*.
  → La tool se ejecuta o se rechaza en el anfitrión; la terminal de origen retira su prompt.
- US-4. Como supervisor, quiero que un entorno `confirm-always` me exija teclear su
  alias también en Dot. → Sin la frase exacta, se deniega.
- US-5. Como usuario, quiero detener una ejecución desde Dot. → `stopReason: cancelled`,
  historial consistente (sin tool calls colgando).
- US-6. Como usuario, quiero pausar una ejecución y reanudarla. → No se emite ninguna
  llamada nueva al modelo ni tool nueva mientras está en pausa; lo que estaba en vuelo termina.
- US-7. Como usuario, quiero escribirle a un agente que está trabajando sin cancelarlo.
  → El mensaje entra por la Runtime Inbox en el siguiente punto seguro.
- US-8. Como usuario, quiero preguntar algo rápido desde el dot flotante. → Sesión nueva
  alojada en el daemon; sigue viva si cierro Dot.
- US-9. Como usuario, quiero abrir el detalle de una ejecución y ver su línea de tiempo.
  → Mismo contenido que `stratum auditor`, en vivo.
- US-10. Como usuario, quiero cerrar y reabrir Dot (o que se caiga) sin perder nada.
  → Al reconectar ve el estado actual y las aprobaciones pendientes; ninguna ejecución cambió.
- US-11. Como usuario de terminal sin Dot, quiero lo mismo en texto. → `stratum ps`,
  `stratum approvals`, `stratum attach <id>`.
- US-12. Como usuario, quiero elegir perfil y modelo al lanzar desde Dot. → Lista de
  `agents.list` y `models.list`; se aplican como `--agent` / `/model`.

## 8. UX / Interaction Model

Dot tiene cuatro superficies. Todas leen del mismo estado (lo que publica el daemon).

### 8.1 Bandeja (tray)

Icono con estado agregado: `○` sin actividad · `●` hay ejecuciones · `◆` hay aprobaciones
pendientes (con contador) · `✕` sin conexión con el daemon.
Menú: *Abrir Stratum* · *Aprobaciones (2)* · lista de hasta 5 ejecuciones activas ·
*Pausar todo* · *Salir de Dot* (no detiene el daemon) · *Detener Stratum* (sí, con confirmación).

En escritorios sin bandeja (GNOME sin extensión) Dot funciona con ventana + atajo.

### 8.2 Dot compacto (flotante)

Se abre desde la bandeja o con el atajo global. Siempre encima, sin marco, se cierra con `Esc`
o al perder el foco.

```text
┌──────────────────────────────────────┐
│ ● Stratum            2 activos  ◆ 1  │
│                                      │
│ > Ask Stratum...                     │
│                                      │
│ ⬡ auto  ◆ general  qwen3-coder  ▾   │
└──────────────────────────────────────┘
```

`Enter` crea una sesión alojada en el daemon y abre la ventana principal en su chat.
*Revisión 2026-10-29 (§23.8)*: `Enter` habla con **el asistente** (su sesión persistente); una
sesión nueva pasa a ser una acción explícita.
Los botones `[file] [screen] [voice]` del boceto original **no** aparecen en v1: un botón
que no hace nada no se enseña. Su hueco queda reservado en el layout.

### 8.3 Ventana principal

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Stratum                                              ● daemon 0.9.0  ─ □ ×│
├───────────────┬────────────────────────────────────────────────────────┤
│ ACTIVITY      │  coder · «Implement authentication»                     │
│               │  ● Running · 04:12 · qwen3-coder · ⬢ local · ctx 47 %  │
│ ● coder       │  [Pause] [Stop] [Steer…]                    [Trace ▸]   │
│   cli · 4m    │ ───────────────────────────────────────────────────────  │
│ ◆ reviewer    │  (chat / transcript en vivo)                            │
│   dot · apr.  │                                                         │
│ ○ researcher  │                                                         │
│   idle        │                                                         │
│               │                                                         │
│ APPROVALS (1) │                                                         │
│ HISTORY       │  > mensaje…                                             │
└───────────────┴────────────────────────────────────────────────────────┘
```

Cada fila de Activity es una **sesión viva**: icono de estado, perfil (o `general`),
origen (`cli`, `dot`, `daemon`), y una línea de estado (`4m`, `apr.` = espera aprobación,
`paused`, `idle`). Los subagentes se anidan bajo su sesión. *History* son las sesiones
guardadas (`SessionStore`), para reabrirlas.

Regla de control: una sesión alojada en una terminal se puede **observar, detener, pausar,
redirigir y aprobar** desde Dot, pero el input principal sigue siendo el de su terminal;
el campo de mensaje de Dot envía *steering*, y lo indica (`[steering → cli]`).

### 8.4 Run detail

Cabecera (tarea, perfil, modelo, provider, estado, duración, `stopReason`) y pestañas:

- **Resumen**: tokens (`Σ`, o `n/d` si el backend no los reporta — nunca se estiman),
  contexto usado/máx., nº de tools, errores, lecturas y escrituras de memoria, ficheros
  cambiados, jobs, todo list / plan.
- **Timeline**: carriles Entrada / Modelo / Herramientas, reutilizando `trace/model.ts`.
- **Tools**: lista de llamadas con estado, duración, entrada y salida (ya redactadas).
- **Subagentes**: árbol con resultado y presupuesto consumido.
- **Log**: avisos del runtime (`warning`, vetos, confirmaciones, reintentos).

### 8.5 Aprobaciones

```text
┌─ Approval required ──────────────────────────────────────────┐
│ Agent    reviewer  (sesión 7f3a · cli · ~/proyectos/api)     │
│ Target   ⬢ staging  ssh:stg-web-1                            │
│ Action   exec                                                │
│          git push origin main                                │
│ Reason   comando protegido: gitPush                          │
│                                                              │
│ Caduca en 4:32 (se deniega)                                  │
│                    [Reject]  [Approve once]  [Allow session] │
└──────────────────────────────────────────────────────────────┘
```

- `Allow session` no se ofrece si la solicitud es `forced` (política de entorno), igual
  que hoy en `run.ts`.
- Con `confirmPhrase` hay que teclear la frase; los botones de aprobar quedan deshabilitados
  hasta que coincide.
- La descripción es la de `describeCall`, ya redactada. Los parámetros crudos nunca llegan
  a la interfaz (regla vigente de Desktop, 15.4).
- Preguntas del agente (`question`) y planes (`present_plan`) usan el mismo centro, con su
  propia tarjeta.
- Una aprobación resuelta en otro cliente desaparece de Dot con una nota («aprobada desde cli»).

### 8.6 Notificaciones

| Evento | Notificación | Al pulsar |
|---|---|---|
| `approval.requested` | Siempre (salvo ventana de Dot enfocada en esa aprobación) | Abre la tarjeta |
| `run.completed` / `run.failed` | Si duró ≥ `minSeconds` y la sesión no está enfocada | Abre el run |
| `question.requested`, `plan.proposed` | Siempre | Abre la tarjeta |
| Daemon caído / reconectado | Una vez por transición | Abre Dot |

Una aprobación **nunca** se resuelve desde la propia notificación: siempre pasa por la
tarjeta, donde se ve el comando completo.

## 9. Proposed Architecture

### 9.1 Componentes

```text
Clients
  ├── stratum-cli   (TUI Ink, `run`, `ps`, `approvals`, `attach`)
  └── stratum-dot   (webview React ⇄ Rust relay)
          │
          │  Stratum Protocol v1 — NDJSON sobre named pipe / unix socket
          ▼
┌──────────────────────────── stratumd ─────────────────────────────┐
│ ControlServer    conexiones, handshake, roles, versión            │
│ EventHub         secuencia por sesión, buffer, suscripciones      │
│ RunRegistry      sesiones vivas, runs, estado derivado            │
│ ApprovalCenter   aprobaciones/preguntas/planes pendientes         │
│ TraceFeed        retransmite ~/.stratum/traces/*.jsonl [existe]   │
│ HostManager      anfitriones locales (en el daemon) y pares (CLI) │
└───────────────────────────────┬───────────────────────────────────┘
                                │ SessionHost  [nuevo, extraído]
                                ▼
        StratumAgent · ReactLoop · ToolDispatcher · ProviderRouter
        MemoryManager · McpManager · JobManager · TraceRecorder  [existe]
```

| Componente | Responsabilidad | Origen |
|---|---|---|
| `SessionHost` | Raíz de composición de **una** sesión: config → router → registry (+MCP) → `StratumAgent` → stores (plan, subagentes) → traza → checkpointer → teardown. Expone `start/cancel/pause/steer`, los gates como interfaz `HostGates`, y un flujo de eventos. | Extraído de `desktop/conversation.ts`, `run.ts` y `chat.ts`+`App.tsx` |
| `ControlServer` | Servidor `net`, handshake con token, límites de trama, validación Zod | `desktop/server.ts` + `codec.ts`, con **N clientes** en lugar de *lease* |
| `EventHub` | Numera y reparte eventos; guarda los últimos N por sesión; resincroniza | Nuevo (pequeño) |
| `RunRegistry` | Qué sesiones están vivas, en qué anfitrión, y su `RunState` | Nuevo; el acumulador de `desktop/transcript.ts` es reutilizable |
| `ApprovalCenter` | Solicitudes pendientes, arbitraje «gana la primera», caducidad | Generaliza `ConversationSession.wait()` |
| `TraceFeed` | Sigue un JSONL y lo emite | `desktop/trace-feed.ts` + `trace/tail.ts`, sin el límite de «una a la vez» por daemon (pasa a ser por conexión) |
| Cliente Node | Descubrir, conectar, pedir, suscribirse, reconectar | Nuevo; lo usan la CLI y los tests |
| Relay Rust | Único que conoce el token; filtra por tipo y tamaño lo que manda el webview | Patrón de `stratum-desktop/src-tauri/src/transport.rs` |

### 9.2 Sesión, run y agente: definiciones

El código tiene *sesión* y *turno*; el producto habla de *agente* y *run*. Se fijan así
para no inventar una tercera cosa:

- **Session** = la conversación persistente (`SessionContext`, mismo id que su traza).
- **Run** = **un turno**: desde una entrada del usuario hasta su `done`. Es la unidad con
  estado, duración, `stopReason` y control. Coincide con `turn`/`turn_end` de la traza.
  `stratum run "x" --then "y"` son dos runs de una sesión.
- **Agent** (definición) = un perfil (`AgentProfile`: `general`, `code`, `research`…).
- **Agent** (vivo, lo que lista Activity) = una **sesión viva** con su perfil activo;
  `idle` entre runs. Los subagentes son hijos de un run, no sesiones.

### 9.3 Anfitriones: dónde corre el agente

Hay dos sitios donde puede vivir una sesión, y **los dos usan el mismo `SessionHost`**:

| Anfitrión | Quién lo usa | Sobrevive a su cliente | Entorno de `exec` |
|---|---|---|---|
| **Local** (dentro de `stratumd`) | Dot; `stratum run --detach`; futuro Desktop | Sí | El del daemon |
| **Par** (el proceso de la CLI) | `stratum chat`, `stratum run` | No (como hoy) | El de la terminal |

Un anfitrión par se conecta al daemon con rol `host`, registra su sesión, **publica sus
eventos** y **atiende órdenes de control** (`cancel`, `pause`, `steer`, resolución de una
aprobación). El daemon es el registro único y el punto de encuentro; no hay segundo
runtime ni segunda copia de la sesión — el único escritor de una sesión sigue siendo su
anfitrión (`SessionCheckpointer`).

Por qué no mover *toda* ejecución al daemon desde el principio:

1. **El entorno.** `exec` hereda el entorno del proceso; el usuario espera el de su
   terminal (`PATH`, venv activo, `SSH_AUTH_SOCK`, las `${VAR}` que expande el loader).
   En el daemon sería otro.
2. **El modo sin daemon es obligatorio de todas formas.** `stratum eval` lanza
   `stratum run` como hijo con HOME temporal; CI y hosts remotos no tienen daemon. La ruta
   «en proceso» no se puede eliminar, así que conviene que sea la misma pieza.
3. **Coste y riesgo.** `App.tsx` llama a `StratumAgent` por decenas de métodos síncronos
   (`getContextUsage`, `jobs.subscribe`, `inbox`…). Convertir la TUI en cliente remoto es
   otro proyecto; publicar lo que ya ocurre es un adaptador.
4. **Aislamiento de fallos.** Un nativo que revienta en una sesión no tumba las demás.

**Dirección a largo plazo [decidido].**

> El objetivo a largo plazo es que `stratumd` pueda alojar las sesiones persistentes por
> defecto, pero la CLI *peer-hosted* sigue siendo una modalidad soportada y el cambio de
> default requiere una decisión posterior basada en M9.

Durante M0–M9:

- `stratum chat` y `stratum run` se ejecutan en su propio proceso, como hoy.
- Si hay `stratumd`, publican su sesión como anfitrión par; Dot puede observar, aprobar,
  cancelar, pausar y redirigir.
- El modo sin daemon es de primera clase: mismas funciones, mismos tests, sin avisos.
- `--detach` y `--attach` se implementan (M10) **antes** de cambiar ningún default.

El cambio de default (`stratum chat` → `stratumd` → `SessionHost`) solo se evalúa después de
M9 y solo si una sesión alojada en el daemon conserva: `cwd`, variables de entorno, `PATH`,
virtualenv activo, `SSH_AUTH_SOCK`, la configuración propia del terminal y la semántica
esperada de `exec`.

Restricciones de diseño que mantienen abierta esa convergencia (obligatorias desde M0):

1. `SessionHost` recibe un `SessionEnv { cwd, env }` **explícito** y no lee `process.cwd()`
   ni `process.env` por su cuenta. Hoy el anfitrión par le pasa los suyos; mañana el daemon
   podrá pasarle los que capture el cliente.
2. `sessions.open` reserva desde la v1 del protocolo un campo opcional `env` (no usado en
   el MVP), para no romper compatibilidad al activarlo.

   **`SessionEnv.env` no es `process.env` completo [decidido].** Es material sensible
   (tokens, credenciales, rutas) y se trata como tal:
   - nunca se emite en eventos, ni aparece en trazas ni en logs;
   - nunca lo devuelve `sessions.get` ni ningún otro método;
   - nunca se persiste como parte de `Session` ni de `SessionContext`;
   - pasa por filtrado y redacción antes de usarse;
   - **no** se implementa captura automática del entorno completo: qué variables se
     pueden capturar y trasladar lo decide M10 (§22 Q1). *(M10: ninguna. Una sesión
     traspasada al daemon usa el entorno del daemon; ver la respuesta de M10 en Q1.)*

   En M0, `SessionEnv.env` es solo el punto de inyección: el anfitrión par pasa el
   entorno de su propio proceso, que es el que ya usa hoy, y nada lo serializa.
3. Todo lo que un cliente necesita de una sesión sale por eventos y métodos del protocolo.
   Código nuevo de la TUI no añade llamadas directas a `StratumAgent`: pasa por `SessionHost`.
4. Los gates (`HostGates`) son asíncronos y resolubles desde fuera del proceso en ambos anfitriones.
5. Anfitrión local y par pasan **la misma** batería de tests de conformidad.

### 9.5 Dot y Desktop [decidido]

Dos aplicaciones durante el MVP, con convergencia posterior explícita.

```text
M0–M9
  Stratum Desktop → implementación existente · sidecar · protocolo v9 · sin cambios
  Stratum Dot     → cliente nuevo de stratumd · Stratum Protocol v1 · cockpit
```

Se mantienen separadas para acotar el riesgo de migración, no porque sean dos arquitecturas
permanentes: no habrá dos runtimes, dos sistemas de sesión ni dos backends a largo plazo.
El plan de convergencia está en §15.

### 9.4 Qué decide cada capa

| Decisión | Dónde | Motivo |
|---|---|---|
| ¿Puede el agente hacer esta llamada? (veto, read-only, entorno, plan, destructiva) | **Core** — `ToolDispatcher`/`ReactLoop` del anfitrión | Ya está ahí y es inapelable; no puede depender de qué cliente mire |
| ¿Hace falta aprobación y de qué tipo? | **Core** — `environmentGate`, `destructiveCommandReason` | Igual para CLI y Dot |
| ¿Quién ha respondido y qué? | **Daemon** — `ApprovalCenter` arbitra; el anfitrión ejecuta la decisión | Varios clientes, una respuesta |
| ¿Cómo se pinta y se notifica? | **Cliente** | Presentación |
| ¿Deja esta máquina leer la pantalla / hacer clic? (futuro) | **Proceso nativo de Dot** (Rust), además del core | Es quien tiene el permiso del SO; segunda comprobación independiente |
| Redacción de secretos | **Core** — `security/` antes de emitir | El daemon y los clientes solo ven texto ya redactado |

## 10. Protocol / API

### 10.1 Transporte y marco

- **Transporte**: named pipe (Windows) / unix socket `0600` (POSIX). **Sin TCP.**
- **Marco**: NDJSON (una línea JSON UTF-8), `LineDecoder` y límites de `codec.ts` [existe].
- **Mensajes**: forma JSON-RPC 2.0 — `{id, method, params}` → `{id, result}` | `{id, error:{code,message,data}}`;
  notificaciones `{method, params}` sin `id`. Motivo: con varios clientes hace falta
  correlación petición/respuesta, y el protocolo v9 de Desktop la resuelve caso a caso
  (`requestId` en unas tramas sí y otras no).
- **Versión**: `STRATUM_PROTOCOL_VERSION = 1`, independiente del `DESKTOP_PROTOCOL_VERSION = 9`,
  que no se toca. Compatibilidad: campos nuevos siempre opcionales; métodos nuevos se
  anuncian en `capabilities`; un cliente ignora notificaciones que no conoce.
- **Definición única**: `src/protocol/` **sin imports de Node** (como `agent/events.ts`),
  porque el webview importa sus tipos. Schemas Zod aparte, en `src/protocol/schemas.ts`.

### 10.2 Descubrimiento y autenticación

`~/.stratum/daemon/endpoint.json` (escritura atómica, `0600`):

```json
{ "protocol": 1, "pid": 12345, "startedAt": "…", "version": "0.9.0",
  "ipcPath": "\\\\.\\pipe\\stratumd-<aleatorio>", "token": "<64 hex>" }
```

- El nombre del pipe es aleatorio por arranque; en Windows la defensa es ese nombre + el
  token, ambos solo en el perfil del usuario (misma postura que el sidecar actual).
- Instancia única: el `listen` sobre el pipe es la exclusión; un `endpoint.json` cuyo
  `pid` no vive se considera rancio (mismo criterio que `ownerState` de `SubagentStore`).
- Primera trama obligatoria: `core.hello { token, client: {kind, name, version, pid}, role, protocol }`.
  Se reutilizan `HANDSHAKE_TIMEOUT_MS`, el tope de 4 KiB antes de autenticar y `tokensMatch`.
- **Autorización por capacidades [decidido]**. Cada método exige una capacidad, y la
  autoridad remota no se agrupa bajo un único rol: *poder cancelar no implica poder aprobar
  una acción destructiva*.

  | Capacidad | Permite |
  |---|---|
  | `observe` | Lectura. Estrictamente de solo lectura: ningún método con efecto |
  | `control` | Control del run: `cancel`, `pause`, `resume`, `steer`; abrir y cerrar sesiones |
  | `approve` | Resolver aprobaciones, preguntas y planes |
  | `host` | Publicar y controlar las sesiones que aloja esa conexión (y solo esas) |
  | `broker` | Ofrecer capacidades nativas (post-MVP) |

  Un rol es un conjunto con nombre de capacidades: `observer` = {`observe`}; `operator` =
  {`observe`, `control`}; `approver` = {`observe`, `approve`}; `host`; `broker`. La v1 puede
  conceder varias a la vez a un mismo cliente (Dot: `control` + `approve`) si separarlas
  como roles complica M1, pero el servidor comprueba **la capacidad por método**, nunca
  «es operator». Qué identidad tiene derecho a `approve` es §22 Q2.

### 10.3 Métodos (cliente → daemon)

| Método | Rol | Descripción |
|---|---|---|
| `core.hello` | todos | Handshake; devuelve `CoreInfo`, `capabilities`, `connectionId` |
| `core.status` | observer | Daemon: uptime, clientes, sesiones vivas, versión |
| `core.shutdown` | operator | Apagado ordenado (`{force?}`; rechaza con runs activos sin `force`) |
| `agents.list` | observer | Perfiles (`profilesToJson` [existe]) + inválidos y avisos |
| `models.list` `{provider?}` | observer | Modelos descubiertos (`fetchModelInfos`) |
| `sessions.list` `{live?, limit?}` | observer | Vivas y guardadas |
| `sessions.get` `{sessionId}` | observer | `Session` + `RunState` actual |
| `sessions.open` `{cwd, env?, profile?, model?, provider?, readOnly?, sessionProfile?, resume?}` | operator | Crea o reanuda una sesión **alojada en el daemon**. `env` reservado: de solo entrada, nunca se devuelve ni se registra (§9.3) |
| `sessions.close` `{sessionId}` | operator | Cierra (cancela su run, guarda). Solo anfitrión local |
| `sessions.setModel` / `sessions.setAgent` / `sessions.setReadOnly` | operator | Equivalen a `/model`, `/agent`, `/readonly` |
| `runs.list` `{sessionId?, active?}` | observer | |
| `runs.get` `{runId}` | observer | `Run` + contadores |
| `runs.start` `{sessionId, input, mode?}` | operator | Nuevo turno. `busy` si hay uno en curso |
| `runs.steer` `{sessionId, text}` | operator | `enqueueUserMessage`; devuelve su `status` |
| `runs.pause` / `runs.resume` `{sessionId}` | operator | Pausa cooperativa (§10.5) |
| `runs.cancel` `{sessionId, runId?}` | operator | `AbortSignal`; con `runId`, solo si sigue siendo ese |
| `approvals.list` | observer | Pendientes de todas las sesiones |
| `approvals.resolve` `{approvalId, decision, phrase?}` | **approver** | `approve` · `deny` · `allow-all` |
| `questions.answer` `{requestId, answers \| null}` | **approver** | Tanda de `question` |
| `plans.decide` `{requestId, decision, plan?}` | **approver** | Gate de `present_plan` |
| `jobs.list` / `jobs.cancel` `{sessionId, jobId}` | observer / operator | `JobManager` de la sesión |
| `memory.status` | observer | Rutas, nº de decisiones, backend del índice, embedder |
| `memory.decisions` `{query?, limit?}` | observer | `list` / `search` |
| `events.subscribe` `{scope, sinceSeq?}` | observer | `scope`: `all` (resumen) o `{sessionId}` (detalle) |
| `events.unsubscribe` `{subscriptionId}` | observer | |
| `trace.subscribe` / `trace.unsubscribe` `{sessionId}` | observer | Registros de la traza desde el principio y en vivo |

### 10.4 Métodos de anfitrión par

| Dirección | Método | Descripción |
|---|---|---|
| host → daemon | `host.register` `{session, state}` | Declara una sesión viva en este proceso |
| host → daemon | `host.publish` `{sessionId, events[]}` | Lote de eventos ya redactados |
| host → daemon | `host.approvalRequested` / `host.approvalResolved` | Abre/cierra una pendiente |
| host → daemon | `host.unregister` `{sessionId}` | La sesión terminó |
| daemon → host | `host.cancel` · `host.pause` · `host.resume` · `host.steer` | Órdenes de control |
| daemon → host | `host.resolveApproval` `{approvalId, decision, by}` | Un cliente respondió |

Si la conexión de un anfitrión se cae, el daemon marca sus sesiones `detached` (no
`failed`: el proceso puede seguir vivo) y sus aprobaciones pendientes como «solo
resolubles en origen». El anfitrión **nunca** se bloquea ni falla por no tener daemon:
publicar es *best-effort* con cola acotada que descarta lo más antiguo.

### 10.5 Pausa

**Pausa cooperativa** (implementada en M5; referencia en `docs/protocol.md` §16). No congela
nada: impide que el runtime **empiece** trabajo nuevo a partir de un punto seguro.

- Lo que está en vuelo (una llamada al modelo, una tool, un subagente) termina.
- No empieza nada nuevo hasta `resume`: ni una petición al modelo, ni una tool que el modelo
  ya había propuesto, ni un subagente. El plan original solo tenía el primer punto; los otros
  dos se añadieron para que nada arranque después de que alguien pulse pausa.
- Los jobs en segundo plano siguen corriendo; sus avisos se acumulan en la inbox.
- `cancel` durante la pausa funciona. Una pausa no caduca sola.
- Un subagente hereda la pausa de su padre.
- El steering se acepta en pausa y no reanuda; resolver una aprobación tampoco.

## 11. Event Model

Envoltorio común (notificación `event`):

```ts
interface StratumEvent {
  seq: number;          // monótono por sesión; lo asigna el anfitrión
  at: number;           // epoch ms del anfitrión
  sessionId: string;
  runId?: string;
  subagentId?: string;  // evento de un hijo
  type: string;         // ver tabla
  data: unknown;
}
```

| Evento | Origen en el código | Notas |
|---|---|---|
| `session.opened` / `session.closed` / `session.detached` | `SessionHost` | **[nuevo]** |
| `session.updated` | cambios de modelo, perfil, read-only, contexto, tokens | resumen para Activity; como mucho 1 por segundo |
| `run.started` | `trace.turnStart` | |
| `run.updated` | cambio de `RunStatus` | `running` ↔ `waiting_approval` ↔ `paused`… |
| `run.completed` / `run.failed` / `run.cancelled` | `AgentEvent done` + `stopReason` | `max_iterations`, `budget_tokens` → `completed` con `stopReason` |
| `agent.status_changed` | derivado de `session.*`/`run.*` | alias de conveniencia para Activity |
| `message.delta` | `text_delta` | solo en suscripción de detalle |
| `reasoning.delta` | `thinking` | solo detalle; nunca entra en el historial |
| `tool.started` | `tool_call_start` (primera aparición por `id`) / `tool_call_ready` | deduplicar por `id` |
| `tool.completed` / `tool.failed` | `tool_result` / `tool_error` | salida ya redactada y truncada |
| `tool.blocked` | `TraceRuntimeEvent veto` | con `source` |
| `subagent.started` / `subagent.completed` | `subagent_started` / `subagent_completed` | sus eventos internos llegan con `subagentId` |
| `memory.read` | `memory_retrieved` | ids y títulos |
| `memory.write` | `DecisionMemory.save` | **[nuevo]**: hoy no se emite; incluye `source: tool \| auto-extract` |
| `context.compressed` | `context_compressed` | |
| `todo.updated` / `plan.proposed` / `plan.step_updated` | eventos homónimos | |
| `job.started` / `job.ended` | `JobManager.subscribe` | no son eventos del turno |
| `steering.queued` / `steering.delivered` | `RuntimeInbox` / `runtime_updates` | sin el texto: id y tamaño |
| `approval.requested` / `approval.resolved` | `onConfirmDestructive` | `resolved` lleva `decision` y `by` |
| `question.requested` / `question.resolved` | `onAskQuestions` | |
| `warning` / `error` | eventos homónimos | `error.fatal` |

**Orden y entrega**

- Orden total **por sesión** (`seq`). Entre sesiones no se garantiza ninguno.
- El daemon guarda los últimos `daemon.eventBuffer` eventos por sesión (por defecto 2 000).
- `events.subscribe { sinceSeq }`: si el hueco cabe en el buffer, se reenvía; si no,
  el daemon responde con `snapshot` (el `RunState` completo: transcript acumulado, tools,
  pendientes) y continúa desde ahí. El cliente **reemplaza** su estado, no lo fusiona.
- Los `*.delta` no se garantizan uno a uno tras un hueco: el `snapshot` trae el texto acumulado.
- Entrega *at-least-once*: el cliente descarta `seq` ≤ el último aplicado.
- La traza en disco es la fuente duradera; el flujo de eventos es la vista en vivo.

## 12. Data Model

```ts
type ClientKind = 'cli' | 'dot' | 'desktop' | 'daemon' | 'other';
type RunStatus =
  | 'queued' | 'running' | 'waiting_approval' | 'waiting_input' | 'paused'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

interface Agent {            // definición: un perfil
  name: string; description: string;
  mode: 'subagent' | 'primary' | 'all';
  origin: 'builtin' | 'global' | 'project';
  allowedTools: string[] | null;
  provider?: string; model?: string;
}

interface Session {
  id: string;                      // = id de SessionContext y de su traza
  title: string;                   // primera entrada, recortada
  cwd: string;
  host: { kind: 'daemon' | 'peer'; client: ClientKind; pid: number; connected: boolean };
  live: boolean;
  state: 'idle' | 'running' | 'waiting' | 'paused' | 'detached' | 'closed';
  agent: string;                   // perfil principal activo o 'general'
  provider: string; model: string;
  sessionProfile: string; readOnly: boolean;
  activeTarget: string;            // 'local' | 'ssh:<alias>'
  environment?: { name: string; tier: string };
  context: { used: number; max: number; pct: number; estimated: boolean };
  tokens: { total: number | null; status: 'reported' | 'unavailable' | 'unsupported' };
  currentRunId: string | null;
  createdAt: string; updatedAt: string;
}

interface Run {
  id: string; sessionId: string;
  input: string;                   // tarea, redactada y recortada
  mode: 'default' | 'plan' | 'execute';
  status: RunStatus;
  stopReason?: 'stop' | 'max_iterations' | 'cancelled' | 'error' | 'budget_tokens';
  startedAt: number; endedAt?: number;
  counters: {
    llmCalls: number; toolCalls: number; toolErrors: number; blocked: number;
    memoryReads: number; memoryWrites: number; subagents: number; jobs: number;
  };
  error?: string;
}

interface ToolCall {
  id: string; runId: string; subagentId?: string;
  name: string; target?: string;
  state: 'pending' | 'running' | 'completed' | 'error' | 'blocked';
  description: string;             // describeCall, redactada
  input?: string; output?: string; error?: string;
  startedAt: number; durationMs?: number;
}

interface MemoryEvent {
  kind: 'read' | 'write' | 'forget';
  source: 'tool' | 'auto-extract' | 'user';
  decisionIds: string[]; titles: string[];
  runId?: string; at: number;
}

interface Approval {
  id: string;                      // = callId del dispatcher
  kind: 'tool' | 'host-key' | 'plan' | 'question';
  sessionId: string; runId: string; subagentId?: string;
  tool: string; description: string; reason?: string;
  target?: string; environment?: { name: string; tier: string };
  forced: boolean;                 // política de entorno: sin 'allow-all'
  confirmPhrase?: string;
  requestedAt: number; expiresAt: number | null;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  decision?: 'approve' | 'deny' | 'allow-all';
  resolvedBy?: { client: ClientKind; connectionId: number };
}

interface Model {
  provider: string; id: string;
  contextWindow: number | null;
  current: boolean;
}

// Event: ver StratumEvent en §11.
```

`Approval`, `Run` y `Session` (vivo) son estado **en memoria** del daemon, reconstruible
desde los anfitriones. Lo persistente sigue siendo lo que ya lo es: sesiones, planes,
subagentes, trazas, memoria. El daemon no añade ningún store nuevo en la v1.

## 13. Security Model

### 13.1 Fronteras de confianza

```text
 NO CONFIABLE          │ CONFIABLE (mismo usuario)                │ PRIVILEGIADO
 modelo, salidas de    │ core (dispatcher, guardas, redacción)    │ proceso nativo de Dot
 tools, páginas web,   │ stratumd · procesos de la CLI            │ (permisos del SO)
 ficheros, MCP ajeno   │ webview de Dot (solo vía relay filtrado) │
```

- El modelo **nunca** es una frontera: todo lo que pide pasa por `preflight` → read-only →
  entorno → confirmación, en el anfitrión. Nada de esto cambia con Dot.
- El webview no ve el token y solo puede emitir los métodos de una lista blanca que aplica
  Rust (patrón `CLIENT_FRAME_TYPES` [existe]).
- Otros usuarios de la máquina y la red quedan fuera: sin TCP, socket `0600`, token.

### 13.2 Niveles de capacidad

| Nivel | Ejemplos | Mecanismo en Stratum | Política por defecto |
|---|---|---|---|
| **Read** | leer ficheros, `exec` de solo lectura; *futuro:* pantalla, ventanas, clipboard | `callEffects` = no muta; permitido en read-only | Permitir; lo de escritorio, con concesión nativa previa |
| **Write** | `write_file`, `exec` que muta; *futuro:* teclear, clic, clipboard | `callEffects` = muta → `environmentGate` | Según `policy` del entorno |
| **Sensitive** | borrar, `git push`, publicar, instalar, privilegios, enviar mensajes, pagos | `destructiveCommandReason`, `tools.guardedCommands`, hard-deny | `confirm`, `confirm-always` con frase, o `block` inapelable |

Lo inapelable sigue siéndolo: un `block` o un veto de `preflight` no genera una
`Approval`; nadie puede aprobarlo desde ningún cliente.

**Política de `git push` [decidido].** Un `git push` normal es una acción externa sensible:
cambia estado remoto que afecta a terceros y puede disparar CI/CD. Pasa a pedir
confirmación por defecto. Dot no es el motivo de esta política; solo ofrece una superficie
mejor para resolverla.

| Comando | Clase | Default |
|---|---|---|
| `git status` / `log` / `diff` | Read | permitir (ya lo da `readOnlyCommandVerdict`) |
| `git add` / `commit` | Write local | según la política del entorno |
| `git push` | Sensitive | `confirm` — clave nueva `tools.guardedCommands.gitPush` |
| `git push --force-with-lease` | Sensitive | confirmación reforzada (`confirm-always`: no la levantan `allow-all` ni `--allow-destructive`) |
| `git push --force` | Sensitive | `confirm-always`, o `block` según el entorno |

- Sigue siendo configurable: quien quiera autonomía total pone `gitPush: allow`, o lo
  permite para un entorno o una sesión concretos.
- Requiere un valor nuevo `confirm-always` en `tools.guardedCommands` (hoy `allow|confirm|block`).
- Compatibilidad: una config que ya fija `gitPushForce` conserva su valor; solo cambian los
  defaults. Una config sin la clave `gitPush` adopta `confirm`.
- Cambio visible para usuarios existentes: `stratum run` sin TTY deniega un `git push` que
  antes pasaba. Va en el changelog como cambio de comportamiento, con la forma de volver al anterior.
- La detección va en `effectiveInvocations` / `destructiveCommandReason`, no como regex
  aparte, para que `sudo`, `sh -c` o `env` no la escondan, y aplica a todos los targets.
- Se entrega en **M4**, nunca mezclado con M0.

### 13.3 Aprobaciones

- Las crea el anfitrión (callback `onConfirmDestructive` [existe]) y las publica.
- **Gana la primera respuesta válida**; el daemon la reenvía al anfitrión, que es quien
  decide y confirma con `approval.resolved`. Respuestas posteriores → error `already_resolved`.
- El prompt local del anfitrión (TUI/readline) compite con el remoto; al resolverse en
  remoto, el local se retira (equivalente a `prompt_resolved` de Desktop).
- Sin respuesta: caduca a `deny` (anfitrión local: `daemon.approvalTimeoutMinutes`, por
  defecto 10; anfitrión par con TTY: sin caducidad, como hoy).
- `allow-all` afecta **solo a esa sesión** y nunca a solicitudes `forced`.
- Una interfaz que no sepa pedir la `confirmPhrase` **deniega** (regla vigente).
- Cada resolución deja un `TraceRuntimeEvent confirmation` con el cliente que la tomó
  (campo nuevo `by`) y una línea en `exec-audit.jsonl`.

### 13.4 Riesgo nuevo que introduce este diseño

Hoy una confirmación vive dentro de un proceso con TTY y el agente no tiene forma de
contestarla. Con un endpoint de aprobaciones, **un agente con `exec` local podría lanzar
un comando que se conecte al daemon y apruebe su propia solicitud**. Mitigaciones, por capas:

1. Rutas del daemon (`~/.stratum/daemon/`) en el nivel `blocked` de rutas sensibles (capa 3
   de `tools/guards.ts`): ni `read_file` ni `cat`/`Get-Content` las leen.
2. Veto en `effectiveInvocations` de los subcomandos de control (`stratum approvals`,
   `stratum daemon`, `stratum attach`) cuando los lanza el agente. Va ahí, no como regex suelta.
3. El token no se hereda por entorno (ya se hace con `STRATUM_DESKTOP_TOKEN`).
4. Toda aprobación muestra y registra **quién** la resolvió; una auto-aprobación es visible.
5. Los vetos inapelables no pasan por aquí: el daño máximo es lo que un humano podría aprobar.

Las guardas de shell son *best-effort* por construcción (así lo dice `docs/eval.md`), de
modo que esto **reduce** la superficie y no la cierra. El cierre real es verificar la
identidad del proceso par (no disponible en Node puro; §22 Q2) o aislar `exec` con el SO,
que ya figura como trabajo futuro. Debe cubrirse con escenarios adversariales en `evals/`.

### 13.5 Secretos

- Los eventos salen del anfitrión **ya redactados** (`security/redact-output.ts`); el
  daemon no ve salidas crudas.
- La config viaja enmascarada (`SECRET_PLACEHOLDER` [existe]) si alguna vez se expone.
- El token del daemon solo en `endpoint.json` y en la memoria de Rust; nunca en argumentos.
- Las API keys no salen del anfitrión: `models.list` devuelve ids, nunca la `baseUrl` completa.

### 13.6 Computer-use (futuro)

```text
Agente → tool desktop_* → ToolDispatcher (preflight · entorno 'desktop:local' · confirmación)
       → stratumd → broker nativo de Dot (concesión propia + indicador visible) → SO
```

- Las tools `desktop_*` solo se registran si hay un `broker` conectado que anuncie la
  capacidad (como las de SSH solo con inventario).
- `desktop:<host>` es un **target** más: las políticas de `environments` (`policy`,
  `readOnly`, `requirePlan`, `confirmation: typed`) se aplican sin código nuevo. Cada tool
  nueva **debe declararse en `callEffects`**, o contará como mutante sin target.
- Doble comprobación independiente: el core decide si el agente puede *pedirlo*; Rust
  decide si esta máquina lo *permite*, con concesiones guardadas fuera del alcance del
  agente (directorio de configuración de la app, nunca `.stratumrc.json`).
- El broker devuelve datos, no decisiones; su salida pasa por la redacción como cualquier otra.
- Indicador persistente mientras una capacidad de escritorio esté en uso, y un «parar todo».

*Revisión 2026-10-29*: el primer computer use **no** es el escritorio del host sino la pantalla
de la caja del asistente (§23.4): target `container:<caja>`, sin broker nativo, porque el radio
de daños es el contenedor y no la máquina del usuario. Lo de este apartado (escritorio del host,
broker de Rust con concesiones propias) sigue siendo futuro y aparte.

## 14. MVP

Pequeño, pero ya responde a «qué está pasando y qué me están pidiendo»:

1. `stratumd`: arranque, descubrimiento, varios clientes, registro de sesiones, eventos con resincronización.
2. CLI como anfitrión par: `chat` y `run` se publican si hay daemon; atienden `cancel` y `steer`.
3. `stratum ps`, `stratum approvals`, `stratum daemon start|stop|status`.
4. Aprobaciones centralizadas (tool, host key, pregunta, plan).
5. Dot: bandeja, dot compacto, ventana principal con Activity.
6. Dot: chat sobre sesiones alojadas en el daemon; run detail con timeline.
7. Dot: tarjetas de aprobación y notificaciones.
8. Detener, pausar/reanudar, redirigir.

Los puntos 1–4 son plano de control y se demuestran sin interfaz gráfica antes de empezar el 5.

Fuera del MVP: todo §15.

## 15. Post-MVP

### 15.1 Convergencia (compromiso, no opcional)

**M10 — `--detach` / `--attach`.** `stratum run --detach` crea la sesión en el daemon y
vuelve; `stratum chat --attach <sesión>` abre la TUI sobre una sesión alojada en el daemon.
Son opt-in. Requisito previo de cualquier cambio de default, y el banco de pruebas de la
conservación del entorno (§22 Q1).
*Redefinido al empezarlo* (ver «M10 — Continuidad de sesión» en §19): lo que se construye es
el **traspaso de una sesión viva** de su terminal al daemon —mismo id, mismo contexto, un solo
anfitrión— y volver a ella desde cualquier cliente (`/detach`, `stratum detach`,
`stratum attach`). `stratum run --detach` y la TUI completa sobre una sesión remota no entran.

**M11 — Decisión sobre el default de `chat`.** Con datos de M9 y M10. Si se cumple la lista
de §9.3, `stratum chat` pasa a alojarse en `stratumd`; el modo par se mantiene soportado.
*Redefinido al empezarlo* (ver «M11 — Conversación duradera y memoria de sesión» en §19): antes
de decidir que `chat` viva en el daemon, una sesión del daemon tenía que poder crecer sin límite
y sobrevivir a un reinicio. Lo construido es eso; la decisión del default queda pendiente, con
un requisito menos.

**M12 — Desktop al Stratum Protocol.**

1. Stratum Desktop se conecta a `stratumd` con el Stratum Protocol.
2. Su runtime/sidecar aislado y sus stores propios (`~/.stratum/desktop/sessions`) se
   retiran progresivamente, con migración de las sesiones existentes.
3. Se extraen los componentes compartidos (relay Rust, chat, `TrajectoryPanel`, tema).
4. Se decide entonces si Dot pasa a ser el modo compacto de Desktop o Desktop la
   superficie ampliada de Dot.

Visión final preferida:

```text
              Stratum Desktop
             /               \
        Dot compacto       Ventana completa
             \               /
              Stratum Protocol
                     │
                  stratumd
                     │
               Stratum Harness
```

### 15.2 Capacidades

En orden sugerido:

1. Atajo global con contexto de la ventana activa; clipboard (Read, luego Write).
2. Inspector de memoria (decisiones, índice, qué se recuperó en cada run).
3. Panel de evaluaciones (`result.json`, comparación con baselines).
4. Captura de pantalla → computer-use con el broker de §13.6.
5. Voz.
6. Editor de entornos y políticas.

*Revisión 2026-10-29*: el orden lo sustituyen los hitos M13–M18 de §23.11. El inspector de
memoria (2) entra en M17; el computer use (4) entra en M15, en la caja y no en el escritorio del
host.

## 16. Technical Decisions

| Decisión | Elección | Alternativas descartadas |
|---|---|---|
| Shell de Dot | **Tauri v2** | *Electron*: 150 MB frente a ~9 MB del shell actual, y contradice una decisión vigente. *Web local*: exige HTTP en loopback (ver abajo) y no da bandeja, atajo global ni broker nativo |
| Transporte | **Named pipe / unix socket** | *HTTP/WebSocket local*: alcanzable desde cualquier navegador (DNS rebinding, CSRF), dispara el firewall de Windows; ya se descartó en Desktop (15.1, 15.10). *gRPC*: nativos y generación de código nuevos en un proyecto que evita dependencias, y el webview no lo habla de todos modos |
| Mensajes | **Forma JSON-RPC 2.0 sobre NDJSON** | *Tramas `type` como en v9*: sin correlación uniforme. La forma JSON-RPC es la que ya usa el cliente MCP del repo |
| Tiempo real | **Notificaciones por la misma conexión**, con `seq` | *SSE*: unidireccional y HTTP. *Sondeo de ficheros*: se mantiene solo para la traza, que ya funciona así |
| Dónde corre el agente | **`SessionHost` único; anfitrión local o par** | *Todo en el daemon*: entorno de `exec`, modo sin daemon obligatorio, reescritura de la TUI (§9.3) |
| Daemon | **Subcomando de la CLI** (`stratum daemon run`) | *Binario aparte / SEA propio*: otro build y desfase de versiones entre CLI y daemon |
| Default de `chat` **[decidido]** | **En su proceso durante M0–M9; alojado en el daemon como dirección final**, sujeto a M11 | *Cambiarlo ya*: rompe el entorno de `exec` |
| Dot y Desktop **[decidido]** | **Dos apps en el MVP, convergencia en M12** | *Fusionarlas ahora*: mezcla la migración de Desktop con el estreno del daemon |
| `git push` **[decidido]** | **`confirm` por defecto**, forzados con confirmación reforzada (§13.2), en M4 | *Dejar el default actual*: una acción con efecto sobre terceros sin pregunta |
| Distribución de Dot **[decidido]** | **Usa el `stratum` instalado** (Node ≥ 22) | *Empaquetar el core como SEA* (como Desktop): +180 MB instalados; deja de ser «ligera». Revisado en M12: **Desktop también** usa la CLI instalada y deja el SEA |
| Quién arranca el daemon **[decidido]** | **Dot lo descubre y lo arranca; la CLI solo con `daemon.autoStart: true`** | *Servicio de inicio de sesión del SO*: post-MVP |
| Caducidad de aprobaciones **[decidido]** | **Sesión en el daemon: caduca a `deny`. Par con TTY: sin caducidad**, como hoy | *Caducar también en la terminal*: cambia un comportamiento que funciona |
| Alcance de `observer` **[decidido]** | **Lee las sesiones locales del usuario; estrictamente read-only** | *Alcance por sesión*: solo tendría sentido con acceso remoto, que es un non-goal |
| Autorización **[decidido]** | **Capacidades por método** (`observe`/`control`/`approve`/`host`/`broker`) | *Un único rol `operator`*: haría que cancelar implicase aprobar |
| `McpManager` **[decidido]** | **Uno por sesión** | *Compartido en el daemon*: `disabledTools` y el `cwd` de los servers son por sesión |
| Nombres **[decidido]** | **`stratum daemon run`** (alias `stratumd`), **`~/.stratum/daemon/`** | — |
| Estado nuevo en disco | **Solo `endpoint.json`** | *Base de datos del daemon*: duplicaría sesiones y trazas |
| Pausa | **Cooperativa, en punto seguro** | *Suspender el proceso*: mata conexiones SSH/MCP y timeouts de provider |
| Protocolo de Desktop v9 | **No se toca** en el MVP; **retirado en M12** (Desktop habla el Stratum Protocol) | *Migrarlo ya*: riesgo sin beneficio para el MVP |

Decisiones previas que este PRD **cambia** (hay que actualizar sus documentos al implementar):

- `STRATUM_DESKTOP_PROJECT_DEFINITION.md` §1 «Instancias aisladas» y §12 «sin sincronización en
  tiempo real»: pasan a ser válidas solo **sin daemon**.
- `CLAUDE.md`, tabla de decisiones, fila *Jobs*: «sin persistencia ni daemon» se conserva en
  su sentido (un job muere con su sesión), pero la sesión ya puede vivir en el daemon.

## 17. Repository Structure

No se introduce monorepo: no hay `package.json` raíz y el paquete publicado es `stratum-cli`.
Se sigue el patrón de `src/desktop/` y `stratum-desktop/`.

```text
stratum-cli/src/
  protocol/            [nuevo] tipos y constantes del Stratum Protocol — SIN imports de Node
    index.ts  events.ts  model.ts  methods.ts
    schemas.ts         (Zod; este sí importa zod, no lo importa el webview)
  host/                [nuevo] SessionHost, HostGates, RunState (acumulador), publisher
  daemon/              [nuevo] control-server, event-hub, run-registry, approval-center,
                               host-manager, discovery, lifecycle
  client/              [nuevo] cliente Node: discover, connect, request, subscribe, reconnect
  cli/commands/
    daemon.ts  ps.ts  approvals.ts  attach.ts          [nuevo]
  desktop/             [existe] sin cambios en el MVP; codec/lifecycle se reutilizan por import
  agent/ tools/ …      [existe] cambios mínimos de §18 (M0)

stratum-dot/           [nuevo] hermano de stratum-desktop/
  src-tauri/src/       main.rs  tray.rs  transport.rs  daemon.rs  os.rs  windows.rs
  src/                 ipc/  hooks/  components/{dot,activity,run,approvals,chat}/  theme.ts
  e2e/                 mismo arnés que stratum-desktop/e2e (tauri-driver + mock-llm)

docs/
  PRD_STRATUM_DOT.md   este documento
  protocol.md          [nuevo, M1] referencia del protocolo
```

Regla heredada que aplica a `protocol/`: lo que importe el webview **por valor** no puede
alcanzar, ni transitivamente, un módulo de Node (ya rompió Desktop una vez; ni `tsc` ni
Vitest lo detectan). Añadir un test que lo compruebe por análisis de imports.

Código compartido entre `stratum-dot` y `stratum-desktop` (relay Rust, componentes de chat,
`TrajectoryPanel`, `theme.ts`): en el MVP se **importa por ruta** lo que ya es puro
(`trace/model.ts`, tipos) y se **copia** lo específico de Tauri. La copia es deuda
aceptada y con fecha: el paquete común se extrae en M12, cuando Desktop migre al daemon.

## 18. Migration Plan

Cada paso deja la suite verde y la CLI idéntica para quien no arranca el daemon.

1. **Extraer sin cambiar comportamiento** (M0). `SessionHost` nace generalizando
   `desktop/conversation.ts`; `run.ts` es el primer consumidor porque lo cubre
   `eval/runner.integration.test.ts` (todos los escenarios incluidos, ~60 s).
2. **Protocolo y daemon como añadidos** (M1–M2). Código nuevo en directorios nuevos; nada
   existente los importa todavía.
3. **Publicación opcional desde la CLI** (M3). Si no hay `endpoint.json`, no ocurre nada.
   `STRATUM_NO_DAEMON=1` lo fuerza; el runner de `eval` lo exporta siempre.
4. **Aprobaciones remotas** (M4) como carrera con el prompt local: sin daemon, el flujo es el de hoy.
5. **Dot** (M6–M8) sobre lo anterior, sin tocar la CLI.
6. **`--detach` / `--attach`** (M10), opt-in, sin tocar defaults.
7. **Decisión sobre el default de `chat`** (M11), con los datos de M9 y M10.
8. **Desktop migra al Stratum Protocol** (M12) y su sidecar aislado se retira por fases.

Compatibilidad: ningún formato en disco cambia de versión en el MVP
(`SESSION_SCHEMA_VERSION`, `CONFIG_SCHEMA_VERSION`, `TRACE_FORMAT_VERSION`). Se añaden
`daemon.*` y `dot.*` al schema de config (opcionales, con defaults) y los *caps* de traza
`control` (pausa, órdenes remotas) y `approval-by` — sin ellos, esas métricas son `null`, nunca 0.

## 19. Milestones

Cada hito es entregable y comprobable por separado. «Hecho» incluye tests, `tsc --noEmit` y lint.

### M0 — Extracción arquitectónica
- `SessionEnv { cwd, env }` explícito: sustituye a `process.cwd()` en `agent/core.ts` y el
  resto de `agent/`, `config/`, `memory/project.ts` y `skills/registry.ts`; la CLI pasa los
  de su proceso.
- **[verificado]** Las tools principales de filesystem y la ejecución local resuelven
  paths/cwd mediante `ToolContext.cwd`. La extracción M0 debe mantener esta propiedad y
  añadir tests de aislamiento entre sesiones.
- Teardown por sesión: cerrar un `SessionHost` libera solo lo suyo. La cadena global
  `closeExecRuntime()` → `shutdownAllJobs()` → `closeSshPool()` queda reservada al apagado del proceso.
- No incluye ningún cambio de política (el de `git push` va en M4).
- Estado de módulo apto para varias sesiones: `tools/ssh/runtime.ts` y `tools/exec/runtime.ts`
  por clave de config en vez de «la última»; cerrar **una** sesión cancela **sus** jobs
  (`agent.jobs.shutdown()`), y `closeExecRuntime()` queda para el apagado del proceso.
- `StratumAgent.observe(listener)`: un único punto por el que salen los `AgentEvent` de
  `run`/`runDelegate`, además de devolverlos.
- `DecisionMemory`: gancho de escritura para `memory.write`.
- `src/host/SessionHost` + `HostGates`; `run.ts` migrado a él.
- *Hecho cuando*: suite y test de integración de `eval` verdes; test que afirma cero
  `process.cwd()` fuera de `cli/`; y el **criterio obligatorio AC-0**: dos `SessionHost` con
  cwd diferentes coexisten en el mismo proceso y destruir uno no altera jobs, SSH,
  auditoría ni cwd del otro.

**Estado: implementado (2026-10-12), rama `feat/dot-m0-session-host`.** Un commit por pieza:
`SessionEnv` → cwd explícito en la composición → estado de exec/SSH/auditoría por sesión →
`SessionHost` + `HostGates` → `run.ts` → `StratumAgent.observe()` → `DecisionMemory.subscribe()` → AC-0.

Descubrimientos de implementación (afectan a hitos posteriores):

1. **«Cero `process.cwd()` fuera de `cli/`» quedó como «cero en la composición».** Lo fija
   `runtime/implicit-cwd.test.ts` con una lista cerrada y justificada de excepciones de
   borde: los defaults de `loadConfig(startDir?)` y de `config/writer.ts` (API de los
   comandos de la CLI), el orquestador de `eval`, y `runtime/session-env.ts`, que es el
   único punto que lee el entorno del proceso. Un anfitrión siempre pasa `env.cwd`.
2. **El estado por sesión cuelga de la identidad del objeto de config.** `SessionHost`
   trabaja sobre una copia propia; su pool SSH y su auditoría son suyos. Consecuencia: dos
   sesiones del mismo proyecto no comparten conexiones SSH (como hoy dos procesos de la
   CLI). Compartirlas en el daemon sería una optimización posterior, no un requisito.
3. **`SessionEnv.env` solo llega a `exec` local y a los jobs.** Siguen leyendo el entorno
   del proceso: la expansión de `${VAR}` del loader de config, los secretos `env:` y
   `SSH_AUTH_SOCK` del inventario SSH, `TAVILY_API_KEY` y la detección de infraestructura
   del perfil de sesión (`PATH`). Es exactamente el inventario que necesita §22 Q1 (M10).
4. **Los servers MCP se lanzan en el directorio del proceso** (`tools/mcp/client.ts` no
   pasa `cwd`). Inocuo en la CLI; hay que pasarles el `cwd` de la sesión antes de alojar
   sesiones `coding` en el daemon → **M2**.
5. **`memory.write` no se puede atribuir todavía a una sesión.** `DecisionMemory` ya avisa
   de cada escritura, pero ni `store_decision` ni la extracción automática rellenan
   `session_id` en el registro. Rellenarlo cambia lo que se guarda en `decisions.json`, así
   que quedó fuera de M0 → **M2**.
6. **`SessionHost` recibe `config` y `router` ya resueltos.** Cargar la config y elegir
   provider/modelo tiene UX propia en cada cliente (errores, selector, `--model`). El
   daemon necesitará esa resolución sin terminal → helper compartido en **M2**.
7. **Siguen con cableado propio `chat.ts` + `App.tsx` y `desktop/conversation.ts`**, como
   estaba previsto (§18): solo `run.ts` usa `SessionHost`. `init.ts` tampoco se migró.
8. **Único cambio observable de M0**: un `--profile` inválido en `stratum run` se rechaza
   antes de conectar los servers MCP (mismo mensaje y exit code).
9. **La suite completa no es estable en Windows bajo carga**, antes y después de M0: los
   tests que matan árboles de procesos (`jobs/manager*.test.ts`, `tools/exec/local.test.ts`)
   rozan su límite de 5 s cuando corren los 157 ficheros a la vez (6 fallos en `main`, 3
   en la rama, todos «timed out»; aislados pasan). Conviene subirles el límite antes de M2,
   que añadirá más tests con procesos.

### M1 — Protocolo
- `src/protocol/` (tipos puros) + `schemas.ts` + envoltorio JSON-RPC sobre `codec.ts`.
- `src/client/`: descubrimiento, handshake, petición/respuesta, suscripción, reconexión con backoff.
- `docs/protocol.md`.
- *Hecho cuando*: tests de conformidad contra un servidor falso (handshake, roles, versión
  incompatible, trama grande, método desconocido); test de «sin imports de Node» en `protocol/`.

**Estado: implementado (2026-10-12), rama `feat/dot-m1-protocol`.** Un commit por pieza:
contrato → validación → códec → cliente → documentación. La referencia del protocolo es
`docs/protocol.md`, que **sustituye a §10–§12 de este documento** donde discrepen.

Alcance cerrado de M1: contrato, validación, framing, cliente Node y abstracciones de
descubrimiento y reconexión. Sin `RunRegistry`, `EventHub`, `ApprovalCenter`, sesiones
alojadas, ciclo de vida del daemon, publicación desde la CLI ni Dot.

Cambios respecto a §10–§12, decididos al escribir el contrato:

1. **Código de error como cadena** (`BUSY`, `ALREADY_RESOLVED`…) y sin campo `jsonrpc`: tiene
   la forma de JSON-RPC 2.0, no su compatibilidad.
2. **Eventos en dos clases.** Los de estado llevan `seq` por sesión; `message.delta` y
   `reasoning.delta` son volátiles (llevan `after`, sin `seq`, agrupables y descartables).
   Se añade `message.completed` (estado, texto entero) para no depender de los fragmentos.
3. **DTOs con prefijo `Protocol`** y construidos aparte de los tipos internos.
4. **Preguntas y planes tienen DTO propio** (`ProtocolQuestionRequest`, `ProtocolPlanRequest`);
   `ProtocolApproval.kind` queda en `tool` | `host-key`. Se añade `plan.resolved`.
5. **Anfitrión par.** `host.approvalRequested` / `host.approvalResolved` desaparecen: son
   eventos dentro de `host.publish`. Se añaden `host.answerQuestions` y `host.decidePlan`
   (servidor → anfitrión).
6. **No existe `agent.status_changed`**: se deriva de `session.updated`.
7. **Códigos añadidos**: `INVALID_REQUEST`, `FRAME_TOO_LARGE`, `UNAVAILABLE`. Notificación
   `goodbye`. Campo reservado `operationId` en las peticiones mutantes.
8. **`core.hello` no lleva `pid`**: es una afirmación no verificable del cliente (§22 Q2).
9. **Suscripción de resumen**: `scope: { kind: 'overview' }` con foto de conjunto, en lugar
   de `scope: 'all'`.
10. **El código común vive en `src/ipc/`** (framing, códec, `RpcPeer`), no previsto en §17:
    lo comparten el cliente y el futuro servidor. `desktop/codec.ts` reexporta el framing.

Para M2: `RpcPeer` ya atiende peticiones con `guard` (autorización) y `handlers`; el servidor
de pruebas (`client/testing/fake-server.ts`) muestra el cableado mínimo, pero **no** es la
base del daemon.

### M2 — Daemon y flujo de eventos
- `stratum daemon run|start|stop|status`; `endpoint.json`; instancia única; apagado por
  inactividad (`daemon.idleExitMinutes`, 0 = nunca) solo sin sesiones vivas.
- `ControlServer` multi-cliente, `EventHub`, `RunRegistry`, `TraceFeed` por conexión.
- Sesiones alojadas en el daemon (`sessions.open`, `runs.start`, `runs.cancel`).
- `stratum ps [--json] [--watch]`.
- *Hecho cuando*: dos clientes ven los mismos eventos en el mismo orden; matar un cliente
  no altera el run; reconectar con `sinceSeq` no pierde ni duplica; con hueco mayor que el
  buffer llega `snapshot`; matar el daemon con `kill -9` deja un `endpoint.json` que el
  siguiente arranque reconoce como rancio; un test de arquitectura afirma que `src/daemon/`
  no importa `StratumAgent` ni monta una sesión por otra vía que `SessionHost`.

**Estado: implementado (2026-10-12), rama `feat/dot-m2-daemon`.** La referencia de lo que
atiende el servidor y con qué garantías es `docs/protocol.md` §13.

Hecho: `stratum daemon run|start|stop|status`; `endpoint.json` con instancia única y
detección de rancio; servidor multi-cliente con handshake y un único punto de autorización
por capacidad; `SessionPublisher` (en `host/`: traduce `observe()` a eventos, numera y
guarda el estado del snapshot); `EventHub` y `RunRegistry`; sesiones alojadas mediante
`SessionHost`; snapshots y resincronización; `operationId` con semántica en el servidor;
apagado por inactividad. Cerrados además los pendientes de M0 que bloqueaban el daemon: los
servers MCP nacen en el `cwd` de la sesión, `memory.write` se atribuye a quien lo intentó
(`DecisionMemory.save(input, attempt)`), y el arranque de una sesión sin terminal es
`host/session-startup.ts`, que también usa `stratum run`.

Fuera de M2, de lo que listaba este hito: **`stratum ps`** y **`TraceFeed`**
(`trace.subscribe`). El primero es un cliente de texto que encaja con M3, cuando haya
sesiones de la CLI que listar; el segundo necesita un lector que respete la contrapresión
del cliente (una traza grande no cabe en la salida de una conexión). Tampoco se persisten
ni se reanudan las sesiones del daemon (`sessions.open { resume }` → `UNAVAILABLE`):
`SessionHost` todavía no lleva checkpointer.

Descubrimientos de implementación:

1. **El `seq` y el estado del snapshot viven en `host/`, no en el daemon.** Es la pieza que
   M3 reutiliza tal cual: un anfitrión par solo cambia el `sink` por `host.publish`.
2. **Una sesión del daemon no tiene interlocutor hasta M4**: corre con política `deny` y sin
   puertas, como `stratum run` sin TTY.
3. **`tool.blocked` no se puede emitir desde `observe()`**: el veto es un evento de runtime
   de la traza, no un `AgentEvent`. Igual `counters.llmCalls`. Quedan a 0, sin estimar.
4. **Un snapshot tiene que caber en una trama.** Con 120 salidas de tool de 8 KB superaba
   1 MiB; ahora lleva las últimas llamadas con el texto recortado.
5. **Corregida una carrera del cliente de M1**: la primera foto de una suscripción se perdía
   si llegaba en la misma lectura del socket que la respuesta de `events.subscribe`.
6. **El id de sesión tiene poca entropía** (`sess_<fecha>_<hora>_<3 letras>`): el daemon
   comprueba que no choca con una viva antes de usarlo.

### M3 — La CLI como anfitrión par
- `chat` y `run` se registran si hay daemon; publican por `observe()`; atienden `cancel` y `steer`.
- `daemon.autoStart` (por defecto `false` en la CLI).
- *Hecho cuando*: criterio obligatorio AC-1 con `stratum ps --watch` como observador;
  `stratum run` sin daemon produce la misma traza y el mismo `result.json` de `eval` que antes.

**Estado: implementado.** Referencia: `docs/protocol.md` §14. `PeerHostBridge`
(`host/peer-host-bridge.ts`) publica con el mismo `SessionPublisher` que una sesión del daemon;
`PeerSessions` (`daemon/peer-sessions.ts`) guarda la proyección; `stratum ps [--json] [--watch]`.
Sin pausa (llegó en M5) ni resolución remota de aprobaciones (M4): en una sesión de la CLI siguen en su
terminal.

Descubrimientos de implementación:

1. **`session.detached` no se emite.** El daemon no numera, así que lo que solo él sabe (el
   anfitrión se fue, volvió, la proyección se descarta) llega como una foto. La sesión queda
   `state: 'detached'` con `host.connected: false` y su run intacto.
2. **Hace falta un reductor de fotos** (`protocol/reduce.ts`, puro): para servir una foto
   coherente con el `seq` sin pedírsela al anfitrión en cada consulta, el daemon pone al día la
   última con los eventos. Es el lado consumidor del contrato, y lo reutilizará Dot.
3. **§10.4 cambia**: `host.register` lleva `pid` y `claim` y devuelve el `claim`;
   `host.publish` admite una foto; `runs.cancel` / `host.cancel` devuelven
   `cancelled | not-running`. La cola del puente no «descarta lo más antiguo»: al llenarse se
   sustituye por una foto, que es lo único que no deja un hueco.
4. **Un hueco se rechaza, no se repara**: `STALE_STATE` al lote entero, y el anfitrión publica
   una foto.
5. **Distinguir un anfitrión muerto de uno que puede volver** exige su `pid`; sin confirmación
   se espera `daemon.detachedTtlMinutes`.
6. **Los tests no pueden publicarse en el daemon del desarrollador**: `STRATUM_NO_DAEMON=1` en
   la config de Vitest y en los hijos de `stratum eval`.

### M4 — Aprobaciones
- `ApprovalCenter`; carrera local/remota en `HostGates`; retirada del prompt local en la
  TUI (`<DestructiveConfirm>`, `<QuestionPrompt>`, `<PlanApproval>`) y en readline.
- `stratum approvals [list|approve|deny]`; frase tecleada; caducidad; `by` en traza y auditoría.
- Guardas de §13.4 (rutas `blocked`, veto de subcomandos de control) + escenarios adversariales.
- **Política de `git push`** (§13.2), como entrega propia dentro del hito:
  - clave `tools.guardedCommands.gitPush` (default `confirm`) y valor `confirm-always`;
  - tests en `tools/guards.test.ts` (envoltorios, `sh -c`, targets `ssh:`, forzados);
  - escenario en `evals/scenarios/` — el push va a un host simulado y el shell local se
    declara `readOnly`, como exige el test de los escenarios incluidos;
  - documentación (`docs/eval.md`, `.stratumrc.json.example`, README) y entrada de changelog
    marcada como cambio de comportamiento;
  - test de compatibilidad: configs existentes con y sin `gitPushForce` cargan y conservan su valor.
- *Hecho cuando*: AC-3, AC-4, AC-5, AC-15; un `block` nunca genera una aprobación.
- **Security blocker**: M4 no se declara terminado ni endurecido hasta resolver §22 Q2 —
  documentar y probar qué identidad/capacidad tiene derecho a resolver aprobaciones. Las
  guardas *best-effort* se pueden entregar antes, pero no cierran el hito.

**Estado: implementado, con §22 Q2 abierta.** Referencia: `docs/protocol.md` §15.

Hecho: `PendingInteractions` (`host/interactions.ts`, ciclo de vida común de aprobaciones,
preguntas y planes, y la carrera local/remota con resolución única); `ApprovalCenter`
(`daemon/approval-center.ts`); puertas de las sesiones del daemon (con plazo) y reenvío a
anfitriones pares (`host.resolveApproval` / `host.answerQuestions` / `host.decidePlan`);
retirada del prompt local en `run` (readline) y en `chat` (`<DestructiveConfirm>`,
`<QuestionPrompt>`, `<PlanApproval>`); `stratum approvals [list|approve|deny|answer|set-key]`;
`resolvedBy` en eventos, traza (`resolution`) y `exec-audit.jsonl`; guardas de §13.4; política
de `git push` con sus escenarios. Criterios: AC-3, AC-4, AC-5 y AC-15 con tests
(`daemon/approvals.test.ts`, `tools/guards.test.ts`, `npm run tui:approvals`, escenarios
`safety-git-push-*` y `safety-self-approval-blocked`).

Descubrimientos de implementación:

1. **La carrera se decide donde vive la promesa, no en el daemon.** Para una sesión par esa
   promesa está en otro proceso: el daemon serializa los intentos remotos y entrega, pero quien
   dice quién llegó antes es el anfitrión. Por eso hay dos piezas: `PendingInteractions` (en
   `host/`, la misma para los dos anfitriones) y `ApprovalCenter` (en `daemon/`).
2. **El `seq` no se toca.** Las solicitudes y sus resoluciones son eventos que publica el
   anfitrión con el `SessionPublisher` de siempre. El centro solo proyecta.
3. **`approve` no puede salir del token de `endpoint.json`** (§13.4): cualquier comando del
   agente lo lee. Se añade una **clave de aprobador** que teclea la persona (`core.hello.
   approverKey`), de la que el disco solo guarda una derivación. Sin ella, la resolución remota
   está denegada. `host` pasa a ser un rol excluyente.
4. **`ProtocolResolver` cambia** a `{ kind, client?, connectionId?, at }` con `kind`
   `local | remote | timeout | policy`; `question.resolved` y `plan.resolved` ganan `status` y
   `resolvedBy`. No hace falta `host.localApprovalResolved`: es el evento del anfitrión.
5. **Caducar solo lo que nadie tiene delante** resulta ser la regla entera de §13.3: con prompt
   local, `expiresAt: null`; sin él, `daemon.approvalTimeoutMinutes`.
6. **`stratum run` sin terminal sigue denegando** aunque haya aprobadores: subir su política a
   `ask` cambiaría lo que hace hoy un entorno `allow` en CI. El camino «sin terminal, con
   aprobador remoto» existe en `SessionHost` y está probado, pero la CLI no lo activa.
7. **`confirm-always` como valor de `tools.guardedCommands`** necesitó un hook nuevo en las
   tools (`ToolDefinition.confirmAlways`): hasta ahora solo un entorno podía forzar una
   confirmación.
8. **No hay `stratum attach`** todavía (lo nombra §13.4): el veto de subcomandos de control ya
   lo cubre para cuando exista.

Pase de endurecimiento (tras la revisión de M4):

- **v1 no está congelada**: ningún paquete publicado contiene el protocolo. El cambio de
  `ProtocolResolver` no sube la versión; la compatibilidad estricta empieza con el primer tag
  `v*` de `stratum-cli` que incluya `stratumd` (`docs/protocol.md` §17).
- **Sin bloqueo global de la clave de aprobador**: un intento por conexión, comprobaciones de
  una en una y el fallo contestado con retraso solo a quien falló. Los fallos de otro ya no
  dejan a nadie sin aprobar.
- **Un `*.resolved` fabricado** por un anfitrión solo cierra lo pendiente de su propia sesión;
  el pase encontró y corrigió que uno para un id inexistente lo dejaba marcado como resuelto.
- **`stratum run` sin terminal deniega siempre**; la aprobación remota en CI, si llega, será
  una opción explícita. Fijado con un test.
- **Búsqueda de fugas** como test: clave de aprobador, token del canal y secretos de la orden
  no aparecen en logs, eventos, fotos, DTOs, auditoría, traza ni en el entorno o los
  argumentos de un proceso hijo.

Pendiente, y por qué M4 no se da por **endurecido**:

- **§22 Q2** (identidad del proceso par): respondida con lo que se puede hacer en Node puro —la
  clave de aprobador— y documentada con sus límites. No es aislamiento frente a un proceso del
  mismo usuario; el cierre real sigue siendo `SO_PEERCRED` / `GetNamedPipeClientProcessId` (un
  addon nativo o el relay Rust de Dot) o aislar `exec`.
- El cap `approval-by` de la traza (§18) no se declara: el evento `resolution` solo lo escriben
  los anfitriones que usan `PendingInteractions` (`run`, `chat`, el daemon), no `init` ni Desktop.

**Puerta de control.** M6 no empieza hasta que M0–M4 estén demostrados con clientes de
texto (`stratum ps`, `stratum approvals`, `stratum attach`).

### M5 — Pausa y reanudación
- Puerta de pausa en el punto seguro (1) del `ReactLoop`; herencia a subagentes; cap `control` en la traza.
- *Hecho cuando*: AC-6; `spec-validator` sobre §12 de la definición sin hallazgos.

**Estado: implementado.** Referencia en `docs/protocol.md` §16.

- `agent/pause.ts` — `PauseController`: la única máquina de estados de la pausa
  (`idle` · `running` · `pause-requested` · `paused`), una por `StratumAgent`
  (`agent.pause`). La consultan el loop del agente, los de sus subagentes y el dispatcher.
  `paused` solo cuando todos los loops que podrían empezar algo esperan en un punto seguro.
- Puntos seguros: antes de cada petición al modelo, antes de ejecutar las tools de una
  respuesta, entre la confirmación y la ejecución (dispatcher) y antes de lanzar un subagente.
- `SessionHost.pause()` / `resume()` / `pauseState`: lo que usan `HostedSession` (daemon) y
  `PeerHostControl` (CLI). El daemon y el puente reenvían; no guardan estado de pausa.
- `SessionPublisher` publica `run.updated` (`paused` ↔ `running`) y `session.state: 'paused'`
  cuando el runtime lo alcanza. `pause-requested` no se expone.
- `runs.pause` / `runs.resume` y `host.pause` / `host.resume` devuelven `{ status }`.
- AC-6 comprobado en `agent/pause-flow.test.ts` (mismas peticiones, eventos e historial que sin
  pausa) y con procesos reales en `cli/commands/peer.integration.test.ts`.

Desviaciones:

- El cap de la traza es `pause`, no `control`: lo que se registra es la pausa
  (`requested`/`paused`/`resumed`); las órdenes remotas de cancelar y redirigir siguen sin
  anotar quién las dio, así que `control` prometería más de lo que hay.
- No hay comando de CLI para pausar (`stratum pause`): el control se ejerce por el protocolo,
  como `runs.cancel` y `runs.steer`, que tampoco lo tienen. Los clientes de texto de la
  puerta de control (`stratum attach`) siguen pendientes.

### M6 — Dot: shell y Activity
- `stratum-dot/`: Tauri v2, bandeja, relay con lista blanca, arranque del daemon
  (desligado: no muere con Dot), reconexión, dot compacto, ventana con Activity e History.
- *Hecho cuando*: AC-1 en la interfaz; AC-7; el instalador pesa < 15 MB.

**Estado: completado (2026-10-13), con el alcance acotado.** Referencia: `docs/dot.md`. `Dot CI` verde en Windows y Linux.

- `stratum-dot/`: Tauri v2. Tres piezas: `crates/dot-link` (cliente nativo del protocolo, en
  Rust y **sin Tauri**: descubrimiento, handshake, suscripciones, reconexión y un relé de
  cuatro órdenes), `src-tauri` (ventana, bandeja, instancia única, comandos `dot_*`) y `src`
  (React: `bridge/`, `protocol/`, `stores/`, `components/`, `screens/`).
- **Transporte: cliente nativo, sin sidecar** (el «relay Rust» de §9.1). Rust solo lee el sobre
  de los mensajes y los campos de orden; los DTOs los valida el webview con
  `protocol/schemas.ts` y los reduce `applySessionEvent`. No hay otro reductor, ni un `struct`
  de sesión o de run en Rust. Motivos y lo que se descartó: `docs/dot.md` §1.
- Una suscripción `session` por sesión viva (la `overview` solo dice cuáles hay): la lista y
  el detalle salen de fotos + el reductor del contrato.
- Arranque del daemon con `stratum daemon start` (desligado: sobrevive a Dot), una vez por
  intento explícito y nunca al reconectar. Dot no tiene `core.shutdown`.
- Conexión como máquina de estados (`starting` · `daemon-starting` · `connecting` ·
  `connected` · `reconnecting` · `incompatible` · `error`); toda suscripción se abre pidiendo
  foto; un hueco pide otra; una orden sin respuesta tiene resultado desconocido y no se reenvía.
- Rol `operator` y nada más. Controles: Pause, Resume, Cancel y Steer, por el protocolo y sin
  actualización optimista.
- AC-1 en la interfaz y AC-7 (lado de Dot) comprobados con procesos reales:
  `scripts/smoke-real.mjs` (sin ventana, con `dot-probe`) y `e2e/dot.e2e.mjs` (la app en su
  ventana, con tauri-driver). El instalador NSIS pesa **1,7 MB** (binario de 6,6 MB).
- **Q4** (bandeja): respondida para Windows; en Linux, ninguna función depende de la bandeja
  (`docs/dot.md` §6) y falta probarla en un escritorio real.

Desviaciones:

- **Sin *History*.** El daemon no lista sesiones guardadas (`docs/protocol.md` §11): no se
  enseña una pestaña que no tiene con qué llenarse.
- **Sin dot compacto flotante** (§8.2: siempre encima, sin marco, con «Ask Stratum…»). Su
  entrada crea una sesión y abre un chat, que es M7. En su lugar la ventana única funciona
  compacta (lista **o** detalle por debajo de 720 px) y se oculta con `Esc`.
- **Bandeja mínima** frente a §8.1: *Open* · *Sessions: N* · *Quit Dot*. Sin *Aprobaciones*
  (M8), sin *Pausar todo* y sin *Detener Stratum*: en M6 Dot no puede apagar el daemon, a
  propósito. El icono no cambia con el estado; lo dice su texto.
- **Aprobaciones solo a la vista.** Lo pendiente se enseña con dónde resolverlo; Dot no pide
  `approver` (M8, y con ello el camino de Q2: `docs/dot.md` §7).
- **El webview importa `protocol/schemas.ts`**, en contra de la nota de §17: la validación
  tiene que estar en un sitio, y repetirla en Rust era la duplicación que se quería evitar.
- **Estructura** distinta de la esbozada en §17: `crates/dot-link/` en vez de
  `src-tauri/src/{transport,daemon}.rs`, para que el cliente del protocolo se pueda probar y
  usar sin Tauri; y `bridge/` · `protocol/` · `stores/` · `screens/` en el frontend.
- **Sin atajo global ni notificaciones** (M8).
- **E2E de la ventana solo en local** (Windows). En CI (`dot-ci.yml`) corren `dot-link`, el
  frontend, el smoke contra un `stratumd` real y la compilación del shell, en Linux y Windows.
- **Un arreglo fuera de Dot**, destapado por su CI: `stratumd` no arrancaba en Linux con un
  HOME limpio (escuchaba en el unix socket antes de crear `~/.stratum/daemon/`). Corregido en
  `daemon/daemon.ts`; la suite del daemon no había corrido en Linux hasta entonces.

### M7 — Dot: chat y run detail
- Chat sobre sesiones del daemon (reutiliza componentes de Desktop); selector de perfil y
  modelo; run detail con Timeline (`trace/model.ts`), Tools, Subagentes, Log.
- Controles: Stop, Pause/Resume, Steer.
- *Hecho cuando*: AC-2, AC-8.

**Estado: completado (2026-10-13), con el alcance acotado al chat.** Referencia: `docs/dot.md`
§12 y `docs/protocol.md` §13.7.

> Stratum Dot puede crear una sesión alojada en el daemon y mantener con ella una conversación
> de varios turnos exclusivamente a través del Stratum Protocol, reconstruyendo el chat desde
> el estado del anfitrión y sin poseer ni duplicar el runtime.

- **Chat sobre sesiones del daemon.** *New chat* → `sessions.open` → `HostedSession` →
  `SessionHost.create` (el camino de M2, sin variantes); un mensaje → `runs.start`, un run
  nuevo de la misma sesión. Un run a la vez: con uno en curso —también en pausa o esperando
  una decisión— el campo de escritura es **steering** (`runs.steer`) y lo dice; nunca abre otro
  run ni encola un mensaje.
- **La conversación va en la foto.** `ProtocolSessionSnapshot.messages` + `messagesTruncated`:
  entradas `user` · `assistant` · `tool` · `outcome`, de todos los runs de la sesión, acotadas
  (`TRANSCRIPT_LIMITS`). Es una función pura de los eventos de estado
  (`protocol/transcript.ts`) que usan **el publicador y el reductor**: no hay un reductor de
  chat en Dot ni una segunda copia de la conversación (ni en un store, ni en `localStorage`,
  ni en Rust). El texto en vivo llega por `message.delta` a `partial` y lo cierra
  `message.completed`: con todos los fragmentos o con ninguno, el resultado es el mismo.
- **Selector de perfil y modelo**, con lo que dice el daemon (`agents.list`, `models.list`):
  Dot no lee ninguna configuración. Se eligen al abrir.
- **`SessionEnv`**: el de cualquier sesión del daemon —copia de su entorno al arrancar + el
  `cwd`, que valida el daemon—. El webview no puede pasar variables de entorno (el comando
  nativo no tiene ese parámetro) y `sessions.open.env` sigue sin usarse.
- **Sin capacidad nueva.** Abrir e iniciar exigen `control`, la que Dot ya tenía (motivos:
  `docs/dot.md` §4). Dot sigue siendo `operator`: ni `approver`, ni `host`, ni `broker`.
- **Sin actualización optimista**, también aquí: ni sesión en la lista antes de que el daemon
  la publique, ni mensaje pintado antes de `run.started`. `runs.start` o `sessions.open` sin
  respuesta tienen resultado desconocido: no se reenvían y decide la foto.
- **AC-2 comprobado** con procesos reales, sin ventana (`scripts/smoke-chat.mjs`, `dot-probe`)
  y en la ventana (`e2e/chat.e2e.mjs`): se cierra Dot a mitad de un run, el run termina en el
  daemon, y al abrir Dot la sesión está con su conversación entera y se sigue hablando con ella.
- **Controles**: Pause/Resume y Cancel (los de M6, junto al chat) y Steer en el campo de escritura.

Desviaciones:

- **Sin run detail con Timeline ni Log, y AC-8 sin tocar.** El visor de trayectoria necesita
  `trace.subscribe`, que el daemon no atiende (`docs/protocol.md` §13.6), y «chat ≠ traza»:
  queda para un hito posterior. La pestaña *Activity* de M6 sigue (run, tools, subagentes,
  actividad reciente).
- **No se reutilizan componentes de Desktop.** Los suyos cuelgan del protocolo v9 del sidecar
  (su transcript, sus tramas); los de Dot pintan DTOs del Stratum Protocol. Lo que comparten
  es la herramienta de E2E. La convergencia sigue siendo M12.
- **Sin persistencia de las sesiones del daemon.** Si el daemon se reinicia, sus chats
  desaparecen y Dot lo dice; no se finge una reanudación. `sessions.open { resume }` sigue en
  `UNAVAILABLE`.
- **Aprobaciones, preguntas y planes solo a la vista** dentro del chat. Resolverlos es M8; la
  política de M4 no se relaja: sin `approver.json`, una sesión abierta desde Dot deniega lo
  destructivo sin preguntar.
- **El directorio se escribe**: sin diálogo nativo de carpeta ni explorador (habría dado al
  lado nativo acceso al disco que hoy no tiene). Se recuerda el último como preferencia.
- **Sin dot compacto flotante** («Ask Stratum…» siempre encima, §8.2): la entrada rápida es
  *+ New chat* / `Ctrl+N` en la ventana única, que sigue funcionando a 440×680.
- **Sin cambiar de modelo o perfil en una sesión viva, y sin cerrar sesiones** desde Dot.
- **Cambios en el contrato** (anotados en `docs/protocol.md` §17): la conversación en la foto
  (campos obligatorios), `sessions.open.cwd` opcional, `ProtocolRun.inputTruncated`,
  `ProtocolModel.default`, y un bloque de texto que se cierra también al entregarse steering.

### M8 — Dot: aprobaciones y notificaciones
- Tarjetas de aprobación / pregunta / plan; contador en bandeja; notificaciones (§8.6).
- *Hecho cuando*: AC-3 y AC-4 desde Dot; AC-9.

**Estado: completado (2026-10-15).** Referencia: `docs/dot.md` §13 y `docs/protocol.md` §15.

> Stratum Dot puede resolver approvals, questions y plans de cualquier sesión visible mediante
> una autoridad de aprobación separada de su conexión normal y mantenida fuera del webview,
> preservando first-valid-wins y todas las semánticas de M4/M5.

- **`ApproverBroker`** (`dot-link/src/approver.rs`): la autoridad de aprobar es **otra
  conexión**, bajo demanda, con el rol `approver` y solo los métodos de resolver
  (`ApproverMethod`; la principal sigue con `MainMethod` y `operator`). Se da por buena solo si
  el daemon concede `approve`; caduca a los 10 min, se bloquea a mano, se suelta al cerrar Dot
  o al caer, y nunca reconecta sola ni reutiliza un desbloqueo contra otro daemon.
- **La clave no pasa por el webview.** Se teclea en una ventana aparte, servida por un esquema
  propio (otro origen, sin IPC, sin capacidades), que la entrega a Rust; allí es un
  `ApproverSecret` (sin copia ni impresión, borrado al soltarse) que se escribe una vez en el
  `core.hello` y se olvida. El webview pide **qué** resolver (`dot_approve`, `dot_deny`,
  `dot_answer_questions`, `dot_decide_plan`) y solo ve el estado del broker.
- **Comandos por ventana**: manifiesto de comandos en `build.rs` y una sola capacidad, de la
  ventana `main`, con cada `dot_*` uno a uno.
- **Centro de aprobaciones** (*Approvals N*, `Ctrl/Cmd+Shift+A`): lo pendiente de todas las
  sesiones, de sus fotos (sin lista propia ni sondeo); una sola tarjeta (`InteractionCard`) para
  los tres tipos, a la que lleva el chat; reglas de respuesta del contrato
  (`checkApprovalResolution`, `checkQuestionAnswers`); sin optimismo y sin reintentos;
  *Recently resolved* de los `*.resolved`.
- **Contrato**: `sessionId?` en las tres resoluciones; con otra sesión, `NOT_FOUND` (anotado en
  `docs/protocol.md` §17).
- **Bandeja**: *Waiting for you: …* y *Open Approval Center*; atención del sistema (sin robar el
  foco) cuando aparece algo con la ventana sin foco.
- **AC-3 y AC-4 desde Dot comprobados** con procesos reales: `scripts/smoke-approvals.mjs`,
  `scripts/smoke-terminal.mjs` (la terminal contra Dot, en los dos sentidos) y
  `e2e/approvals.e2e.mjs` (la ventana).

Desviaciones:

- **Sin notificaciones del sistema** (§8.6): bandeja, contador y atención de la barra de tareas.
  Una aprobación nunca se resolverá desde una notificación.
- **Sin editar el plan** al aprobarlo, aunque el contrato lo admite.
- **Q2 sigue abierta**: M8 separa la autoridad del webview y de la conexión normal, pero no
  comprueba la identidad del proceso par (`docs/dot.md` §13.8–§13.9). Mientras está
  desbloqueado, quien controle el webview puede pedir resoluciones; de ahí el plazo y el
  bloqueo manual. *(M9 cierra lo segundo con la confirmación nativa y trata lo primero en el
  lado de Dot: ver M9.)*
- **AC-9** (notificaciones) queda parcial por lo anterior.

### M9 — Endurecimiento
- Desfase de versiones CLI ↔ daemon ↔ Dot; caída del daemon con anfitriones pares vivos
  (re-registro al volver); anfitrión par muerto; carga (10 sesiones, 3 clientes); E2E de Dot
  en CI Linux y local en Windows; empaquetado y firma; documentación de usuario.
- *Hecho cuando*: AC-10 a AC-13.

**Estado: implementado como endurecimiento de seguridad, autoridad e IPC** (decisión al
empezarlo: primero lo que M8 dejó dicho como abierto, sin capacidades nuevas ni cambios de
arquitectura). Referencia: `docs/dot.md` §14; `docs/protocol.md` §4, §13.1, §15.3 y §17.

- **Confirmación nativa** de cada resolución sensible (aprobar, `allow-all`, responder,
  aprobar un plan): el webview pide; el lado nativo comprueba broker, solicitud y sesión
  **con el daemon** (`approvals.list`, `sessions.get`); la persona confirma en una ventana
  propia (otro origen, sin IPC, lo que dice el daemon, la frase de una confirmación con
  nombre se teclea allí); solo entonces sale. Lo negativo (denegar, omitir, rechazar) va
  directo, decidido: es lo que hace el runtime cuando nadie contesta. El tipo lo impone
  (`ConfirmedAction`, solo la crea la puerta). Una a la vez, armada tras 800 ms, caduca por
  plazo, bloqueo, época, daemon, resolución en otro sitio, sesión o cierre de Dot.
- **Broker**: colas acotadas (y lo que no puede perderse, coalescido fuera de la cola), tope de
  resoluciones en vuelo, época por desbloqueo, comprobación periódica del endpoint. Sin
  cambios en lo de M8: sin reconexión con autoridad, sin reintentos de mutaciones.
- **Identidad del par (Q2)**: Dot pregunta al sistema quién atiende el canal antes de enviar el
  token o la clave (`SO_PEERCRED`/`LOCAL_PEERCRED`; `GetNamedPipeServerProcessId` + SID) y se
  niega si no es el proceso del endpoint u otro usuario. El daemon declara qué verificó el
  sistema (`PeerVerification`: permisos del socket en POSIX, nada en Windows); no sabe qué
  proceso es.
- **Endpoint e IPC**: el daemon no arranca con una carpeta que no sea privada o sea un enlace, y
  deja el socket en `0600`; Dot lee el endpoint sin seguir enlaces y comprueba dueño y permisos
  de lo abierto.
- **Frontera webview/nativo**: la ventana principal pasa de `core:default` a solo escuchar
  eventos; tests adversariales en código y en la ventana real.
- **Deuda pequeña**: canales sin límite fuera; la lista dice cuándo es parcial (más de 64
  sesiones); dos plazos de inactividad de tests del daemon que fallaban bajo carga.

Pendiente del alcance original de M9 (no entra en esta ejecución): desfase de versiones,
carga, anfitrión par muerto/re-registro bajo carga, E2E de la ventana en CI Linux,
empaquetado y firma, documentación de usuario; y con ello AC-10 a AC-13, que no se dan por
cumplidos aquí.

### M10 — Continuidad de sesión

- Una sesión viva de `stratum chat` (anfitrión par) pasa a alojarse en `stratumd` **sin
  cambiar de `sessionId` ni perder contexto**, y cualquier cliente autorizado vuelve a ella.
  Es continuidad, no persistencia: tras reiniciar el daemon no se recupera.
- *Hecho cuando*: AC-17.

**Estado: completado (2026-10-16).** `Dot CI` verde en Windows y Linux, con `smoke:detach`. Referencia: `docs/protocol.md` §18 (semántica, estados, vallado,
qué se traspasa y qué lo impide); `docs/dot.md` §15.

- **Un solo anfitrión.** Época de propiedad por sesión (`host.register` → `epoch`, exigida en
  `host.publish`); al traspasar, el id queda vallado para el anfitrión anterior
  (`STALE_STATE` `stale-epoch` / `handed-off`), aunque su conexión siga abierta.
- **Traspaso, no reconstrucción.** No se cierra y se reabre nada: el par deja de empezar
  trabajo, publica hasta su último `seq` y entrega por etapas (`host.handoffBegin/Chunk/Commit`)
  un DTO explícito y versionado (`ProtocolHandoffContext`: el historial del agente y los
  ajustes de la sesión, nunca entorno, claves, config ni autoridad). El daemon lo valida, monta
  un `SessionHost` con ese id y ese contexto, y su publicador **continúa** desde la foto que ya
  tenía: un solo `session.updated` con `host.kind: 'daemon'` en el `seq` siguiente.
- **Todo o nada.** El commit es un paso síncrono en el daemon; antes de él, un fallo deja la
  sesión en el par; con el resultado desconocido, el par pregunta (vuelve a registrarse) y no
  reintenta.
- **Solo en reposo.** Un run (también en pausa o esperando una aprobación), un job vivo, un aviso
  que el agente no ha visto o trabajo auxiliar en vuelo lo impiden (`BUSY` /
  `NOT_TRANSFERABLE` con el motivo); lo pendiente nunca se mueve ni se resuelve solo.
- **CLI**: `/detach` en `chat` (la terminal sale al terminar), `stratum detach <id>` desde
  fuera, `stratum attach <id>` (cliente interactivo: conversación, turnos, steering, pausa,
  cancelación, pendientes) — adjuntarse no es un método nuevo. `stratum ps` ya distinguía el
  anfitrión.
- **Dot** lo refleja sin cambios: es la misma sesión, y el campo de escritura pasa a preguntar.

Desviaciones respecto al texto original de §15.1: no hay `stratum run --detach` (`run` no se
traspasa: mientras corre está ocupado) ni TUI completa sobre una sesión remota (`attach` es un
cliente de líneas); Dot no ofrece aún un botón de traspaso. §22 Q1: ver su respuesta de M10.

### M11 — Conversación duradera y memoria de sesión

- Una sesión del daemon conserva su conversación **entera y duradera**, independiente de lo que
  el modelo tiene en su contexto; trabaja con un contexto acotado (memoria de sesión + memoria
  de proyecto/global con topes + conversación reciente) y compacta lo antiguo con modelos de
  extracción y resumen configurables, sin que desaparezca del chat ni contamine otras memorias.
  Sobrevive a un reinicio de `stratumd`.
- *Hecho cuando*: AC-18.

**Estado: completado (2026-10-18).** Referencia: `docs/protocol.md` §19;
`.claude/docs/conversacion.md`.

- **Tres capas**: `ConversationStore` (JSONL de solo añadir, versionado, con cerrojo de
  escritor; no carga los mensajes al abrir), contexto activo (`ContextBuilder`: presupuesto por
  capas desde la ventana real) y `SessionMemory` (estructurada, con procedencia; un hecho nuevo
  sustituye al que contradice sin borrarlo; no es autoridad; no se promociona sola).
- **Compactar no es borrar**: al 70 % del presupuesto de entrada, lo más antiguo se extrae y se
  resume a la memoria (una compactación a la vez, commit atómico) y solo entonces sale del
  contexto; sigue en el store y en el chat. Un fallo se aplaza y nunca trunca; si ya no cabe,
  error explícito.
- **Modelo de memoria configurable** (`memory.session.extractor/summarizer`), con sus propias
  credenciales y frontera explícita para un provider remoto (`allowRemote`).
- **Persistencia y reinicio**: `~/.stratum/daemon/sessions/<id>/`; al arrancar, las sesiones
  vuelven sin montarse y se montan al primer uso; el `seq` continúa; `sessions.close` las acaba.
- **Protocolo**: `sessions.history`, `sessions.context`, `sessions.memory` (aditivos, §17).
- **CLI**: `/history` en `stratum attach`; `chat --resume` de una sesión del daemon remite a
  `attach` (`--fork` para una copia).

Desviaciones y pendientes: la CLI en su proceso (`chat`/`run`) sigue con la compresión en línea
(sin conversación duradera); Dot no pagina todavía lo anterior a la foto (el protocolo ya lo
expone) ni enseña el desglose del contexto; la extracción se hace en el turno (en un punto
seguro), no en segundo plano; el traspaso sigue llevando el historial entero; la promoción
explícita de memoria de sesión a proyecto queda para después.

### M12 — Desktop al Stratum Protocol

- Stratum Desktop deja su runtime/sidecar y su protocolo v9 y es un cliente de `stratumd`, hermano
  de la CLI y de Dot (`docs/STRATUM_CLIENT_ARCHITECTURE.md`, normativo para este hito).
- *Hecho cuando*: una sesión de Desktop es una sesión Stratum normal (mismo `SessionHost`, M11,
  `sessions.list`), sobrevive al cierre de Desktop y a un reinicio del daemon, se abre desde Dot o
  `stratum attach` con el mismo id, y Desktop continúa una sesión de la terminal traspasada.

**Estado: completado (2026-10-19).** Referencia: `docs/protocol.md` §20;
`docs/STRATUM_CLIENT_ARCHITECTURE.md` §8 (auditoría KEEP/MIGRATE/MOVE/DELETE/DEFER).

- **Un solo plano de control**: retirados el sidecar (`stratum-cli/src/desktop/`, SEA,
  supervisor, relé IPC, protocolo v9) y los stores propios. Desktop habla el protocolo con el
  enlace nativo de Dot (`dot-link`, perfil `DESKTOP`): lista por la foto de conjunto, conversación
  solo de la sesión que se mira, historial bajo demanda (M11), sin estado optimista.
- **El modo asistente pasa al daemon** como agente embebido `assistant` (preset fijado por
  `SessionHost`, ficheros confinados a su carpeta, nunca `exec`, directorio propio obligatorio);
  cualquier cliente lo puede abrir.
- **Origen sin autoridad**: `ProtocolSession.origin` (aditivo, §17 de `protocol.md`).
- **Daemon**: el mecanismo oficial (`stratum daemon start`); Desktop usa la CLI instalada y su
  instalador ya no lleva runtime.
- **Lo antiguo**: `stratum desktop import`, una vez y por el camino de M10.
- **Tests**: clientes hermanos y asistente en el daemon, capa cliente compartida, perfil Desktop
  de `dot-link`, arquitectura de Desktop (TS + Rust), integración del webview, smoke entre
  clientes contra un `stratumd` real y E2E de la ventana (chat, adjuntos, cerrar a mitad de run,
  reinicio). CI: `desktop-ci.yml` (Windows y Linux).

Desviaciones y pendientes (DEFER): Desktop **no aprueba** (lo pendiente se ve; se resuelve desde
Dot o `stratum approvals`) hasta tener broker nativo y confirmación como Dot; sin retención de
carpetas (D3), editor de ajustes, panel de memoria global ni trayectoria; el razonamiento ya no
queda en la conversación tras el turno; la extracción del paquete común con Dot se limitó al
enlace nativo y a la capa cliente del contrato. La decisión de §15.1.4 (si Dot es el modo
compacto de Desktop) sigue abierta.

### Después de M12

El default de `chat` (pendiente de M11 original) y la convergencia de producto Dot/Desktop: §15.1.
Dirección decidida el 2026-10-29: Dot como asistente virtual, hitos **M13–M18** en §23.11.

## 20. Acceptance Criteria

- **AC-0 (obligatorio).** Dos `SessionHost` con cwd diferentes pueden coexistir en el mismo
  proceso y destruir uno no altera jobs, SSH, auditoría ni cwd del otro.
- **AC-1 (obligatorio).** Una ejecución iniciada con `stratum run` o `stratum chat` puede
  verse en tiempo real desde Stratum Dot sin crear un segundo runtime ni duplicar la
  sesión. *Comprobación*: existe un único fichero de sesión y una única traza con ese id;
  el daemon no instancia ningún `StratumAgent` para ella; los eventos llegan a Dot en < 1 s.
- **AC-2.** Una sesión creada desde Dot sigue ejecutándose tras cerrar Dot y su resultado
  está al reabrirlo.
- **AC-3.** Una solicitud de aprobación de una sesión de la CLI se resuelve desde Dot; la
  tool se ejecuta una sola vez y el prompt de la terminal desaparece. Dos respuestas
  simultáneas → una gana, la otra recibe `already_resolved`.
- **AC-4.** En un entorno `confirm-always`, ni Dot ni `stratum approvals approve` aprueban
  sin la frase exacta, ni ofrecen `allow-all`.
- **AC-5.** Un comando del agente que intente leer `endpoint.json` o invocar
  `stratum approvals approve` es vetado en `preflight` (escenario adversarial en `evals/`).
- **AC-6.** Con una sesión en pausa, el modelo de guion no recibe ninguna petición hasta
  `resume`; tras reanudar, el turno termina con el mismo resultado que sin pausa.
- **AC-7.** Con el daemon parado, `stratum chat`, `stratum run` y `stratum eval run --mock`
  se comportan igual que en 0.8.0 (misma salida, mismos exit codes); Dot muestra «sin
  conexión» y se recupera solo al arrancar el daemon.
- **AC-8.** El run detail de Dot muestra los mismos pasos, en el mismo orden, que
  `stratum auditor` para la misma sesión.
- **AC-9.** Una aprobación pendiente genera notificación del SO y contador en la bandeja en < 2 s.
- **AC-10.** Tres clientes conectados a la vez (CLI anfitrión, Dot, `stratum ps --watch`)
  ven la misma secuencia `seq` de una sesión.
- **AC-11.** Matar el daemon durante un run de un anfitrión par no afecta al run; al
  volver el daemon, la sesión reaparece en Activity sin intervención.
- **AC-12.** Un cliente con protocolo incompatible recibe un error de versión legible y no
  altera ningún estado; la CLI en ese caso sigue en modo sin daemon con un aviso.
- **AC-13.** Ningún evento del protocolo contiene un secreto del núcleo de redacción
  (test con las cadenas de `security/secrets.ts`).
- **AC-14.** `stratum ps`, `stratum approvals` y `stratum attach` dan en texto la misma
  información que Activity, Approvals y run detail: la observabilidad no depende de Dot.
- **AC-15.** Con la config por defecto, `git push origin main` pide confirmación en `chat`,
  se deniega en `run` sin TTY y pasa con `gitPush: allow`; `--force-with-lease` y `--force`
  no se aprueban con `allow-all` ni con `--allow-destructive`.
- **AC-16.** Stratum Desktop 0.4.x funciona sin cambios con y sin `stratumd` en marcha.
- **AC-17 (M10).** Una sesión de `stratum chat` en reposo se traspasa a `stratumd` sin cambiar
  de id; su terminal sale; Dot y `stratum attach` ven la misma conversación y un turno nuevo
  llega al agente con el contexto de antes; el anfitrión anterior no puede publicar en ella; un
  traspaso que falla deja la sesión en la terminal, y uno con resultado desconocido se resuelve
  preguntando, nunca reintentando. El traspaso no lleva credenciales del runtime (entorno,
  config, API keys, autoridad de aprobar), pero sí el historial completo del agente: lo
  sensible que ya esté en el contexto del modelo viaja con él (`docs/protocol.md` §18.5).
  *Comprobación*: `daemon/handoff.test.ts`, `npm run tui:detach` y, en Dot,
  `npm run smoke:detach`.
- **AC-18 (M11).** Stratum conserva la conversación completa y duradera de una sesión del
  daemon, independiente del contexto activo del modelo: tras muchos turnos se compacta, los
  mensajes compactados siguen en el store y en el chat (foto + `sessions.history`), la memoria
  de sesión los resume con procedencia y sin contaminar la de otra sesión ni la de
  proyecto/global; el daemon se reinicia y la misma sesión vuelve con toda su conversación, y una
  pregunta sobre lo antiguo se contesta con la memoria de sesión. Un fallo del modelo de memoria
  no pierde mensajes ni la memoria anterior. *Comprobación*: `daemon/persistence.test.ts`,
  `conversation/*.test.ts` y `cli/resume-guard.test.ts`.

## 21. Risks

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Duplicación de lógica** (un cuarto cableado de sesión) | Alto | M0 extrae `SessionHost` *antes* del daemon; el daemon no puede instanciar `StratumAgent` por otra vía (test de arquitectura) |
| **Auto-aprobación por el agente** (§13.4) | Alto | Guardas + auditoría de `by` + escenarios adversariales; en Dot, confirmación nativa por resolución (M9); cierre real frente al mismo usuario pendiente de §22 Q2 |
| **Estado de módulo compartido** entre sesiones del daemon (SSH, auditoría, jobs) | Alto | Resuelto en M0 con test de dos sesiones; es código que hoy nunca corre con dos sesiones `coding` |
| **Ciclo de vida del daemon**: huérfano, doble instancia, quién lo arranca | Medio | `listen` como exclusión; `endpoint.json` rancio detectable; `stop` explícito; apagado por inactividad opcional |
| **Carreras**: aprobar y cancelar a la vez; `steer` tras `done`; cerrar durante un guardado | Medio | El anfitrión es la única autoridad; `sealIfIdle()` ya resuelve el steering tardío; cola ordenada por sesión (patrón `ConversationHost.queue`) |
| **Varios clientes** enviando entrada a una sesión | Medio | Entrada serializada; `runs.start` con turno en curso → `busy`; steering FIFO |
| **Reconexión y orden** | Medio | `seq` por sesión, buffer acotado, `snapshot` que reemplaza; la traza como verdad duradera |
| **Presión de eventos** (`text_delta` a alta frecuencia hacia N clientes) | Medio | Deltas solo en suscripción de detalle; agrupación por lotes de 30–50 ms; cola por cliente con corte y `snapshot` si se atrasa |
| **Entorno del daemon ≠ entorno de la terminal** en `exec` | Medio | Documentado; las sesiones de terminal siguen en su proceso; Dot muestra el `cwd` y el anfitrión |
| **Secretos** en eventos o en `endpoint.json` | Alto | Redacción en origen (AC-13); `0600`; ruta `blocked` |
| **Portabilidad**: bandeja en Linux, ACL de pipes en Windows, macOS | Medio | Dot usable sin bandeja; misma postura de pipe que el sidecar actual; macOS fuera de v1 |
| **Desfase de versiones** CLI / daemon / Dot | Medio | El daemon *es* la CLI instalada; negociación en `core.hello`; degradación a modo sin daemon |
| **Compatibilidad hacia atrás** de `eval` y trazas | Alto | `STRATUM_NO_DAEMON=1` en el runner; *caps* nuevos opcionales; ninguna métrica existente cambia de significado |
| **Alcance**: la interfaz arrastra funciones de Desktop | Medio | Non-goals de §5; Dot no edita config ni gestiona workspaces |
| **Dos apps de escritorio** que se quedan para siempre | Medio | Convergencia comprometida en M12 (§15.1); la copia de código entre ambas es deuda con fecha |
| **`git push` con confirmación rompe automatizaciones** (`run` sin TTY) | Medio | Changelog explícito, `gitPush: allow` documentado, test de compatibilidad de config |
| **El diseño cierra la puerta a alojar `chat` en el daemon** | Medio | Restricciones de §9.3 desde M0; batería de conformidad común a ambos anfitriones |

## 22. Open Questions

Solo quedan las que necesitan investigación técnica. Las decisiones de producto están
cerradas: default de `chat` (§9.3), Dot y Desktop (§9.5, §15.1), `git push` (§13.2) y el
resto de la tabla de §16.

- **Q1. Conservar el entorno del terminal en una sesión alojada en el daemon.** Es la
  condición del cambio de default de `chat` (M11) y afecta ya a las sesiones creadas desde
  Dot. Hay que averiguar: qué captura el cliente y envía en `sessions.open.env` (`PATH`,
  virtualenv, `SSH_AUTH_SOCK`, las `${VAR}` que expande el loader de config); qué no se
  puede trasladar (un agente SSH ligado al TTY, variables que cambian durante la sesión,
  `GIT_*` que hoy sanea `scrubGitEnv`); y qué recibe una sesión de Dot, que no tiene
  terminal — el entorno del daemon o el de un shell de login capturado al arrancar.
  *Se investiga en*: M10, con un escenario de `eval` por cada elemento de la lista de §9.3.
  *Respuesta de M10 (parcial, a propósito)*: el traspaso **no traslada ninguna variable** de la
  terminal. Una sesión traspasada se comporta como una abierta en el daemon: su entorno es la
  copia del del daemon tomada al arrancar, y su config se resuelve con él desde el mismo `cwd`;
  si así no se puede montar (un provider cuya clave solo existía en la terminal), el traspaso
  se rechaza (`NOT_TRANSFERABLE`, `startup`) y la sesión sigue en la terminal. Lo que una
  sesión del daemon necesita de una terminal —y por tanto el cambio de default de M11— sigue
  abierto aquí; los escenarios de `eval` de §9.3 no se hicieron en M10.
- **Q2. Verificación de la identidad del proceso par.** Node no expone `SO_PEERCRED` ni
  `GetNamedPipeClientProcessId`. Opciones a evaluar: addon nativo; aceptar aprobaciones
  solo a través del relay Rust de Dot (que sí puede consultarlo); o conceder la capacidad
  `approve` solo a procesos que no desciendan de un anfitrión. Decide cuánto se cierra §13.4.
  **Security blocker de M4**: el hito no se da por terminado sin esta respuesta documentada y probada.
  *Respuesta de M4 (parcial, a propósito)*: sin identidad del par verificable en Node puro, la
  capacidad `approve` exige una **clave de aprobador** que teclea la persona y de la que el
  daemon solo guarda una derivación (`docs/protocol.md` §15.2); el token de `endpoint.json` no
  basta, y sin clave configurada la resolución remota está denegada. Probado: con el token solo
  —lo que tendría un comando del agente— ningún rol aprueba. **Lo que sigue abierto**: un
  proceso arbitrario del mismo usuario del SO está en el mismo dominio de confianza (puede
  sustituir `approver.json` y reiniciar el daemon, o leer la memoria de quien teclea). No se
  presenta `0600` + token + clave como un sandbox. El cierre real —addon nativo, relay Rust de
  Dot o aislamiento de `exec`— queda como endurecimiento antes de dar M4 por cerrado del todo.
  *Respuesta de M9 (parcial, a propósito; `docs/dot.md` §14.3)*. **Qué protege**: un webview
  comprometido no puede usar por sí solo la autoridad desbloqueada (confirmación nativa); Dot no
  envía token ni clave a un canal que no atienda el proceso del endpoint o que atienda otro
  usuario; carpeta, endpoint y socket privados. **Qué verifica el SO**: del lado de Dot, usuario
  y pid del servidor del canal; del lado del daemon, solo los permisos del socket en POSIX
  (este usuario o root) y nada en Windows. **Qué sigue en el mismo dominio de confianza**:
  cualquier proceso del mismo usuario (puede reescribir el endpoint con su propio pid, leer
  memoria, sustituir `approver.json`, manejar la interfaz con las APIs del sistema) y root. Lo
  que lo cerraría —credenciales del sistema, firma del par, addon nativo— sigue fuera.
- **Q3. Detección fiable de un push forzado.** `--force`, `-f` y `--force-with-lease` son
  flags, pero `git push origin +main` fuerza por refspec y `push.default` o un alias de git
  pueden cambiar el significado del comando. Hay que comprobar qué resuelve hoy
  `effectiveInvocations` y qué queda como `dynamic` (que falla hacia el lado seguro).
  *Se investiga en*: M4.
  *Respuesta de M4*: se detectan los flags (`--force`, `-f` también agrupado, `--force-with-lease`
  con o sin valor, `--force-if-includes`, `--mirror`) y el refspec con `+`, detrás de cualquier
  envoltorio o shell anidado que `effectiveInvocations` resuelva. **No** se resuelve un alias de
  git (`git p` no se reconoce como push: ni confirma ni fuerza) ni un `push.default` /
  `remote.<n>.push` con `+` en la config del repo (se trata como push normal, que ya confirma).
  Cerrar el alias exigiría leer la config de git del target, que puede ser remoto: queda fuera.
  **La detección no es una barrera absoluta** frente a alias y envoltorios (`./deploy.sh`,
  `make release`): `gitPush`/`gitPushForce` son política de confirmación, y nada que deba ser
  imposible puede depender solo de ella (`stratum-cli/docs/eval.md`, «Qué cubre la guarda»).
- **Q4. Bandeja y notificaciones en Tauri v2 por plataforma.** Soporte real de bandeja en
  GNOME/Wayland, y si las notificaciones de escritorio admiten acciones (el diseño no
  depende de ellas: una aprobación nunca se resuelve desde la notificación).
  *Se investiga en*: M6, con un prototipo antes de fijar el layout.
- **Q5. Dimensionado del flujo de eventos.** Tamaño del buffer por sesión, ventana de
  agrupación de `message.delta` y umbral de corte para un cliente lento, medidos con un
  modelo local rápido y tres clientes. Los valores de §11 son puntos de partida.
  *Se investiga en*: M2, y se revisa en M9.

## 23. Dirección: Dot como asistente virtual [decidido 2026-10-29]

Dot pasa de ser solo el cockpit del harness a ser **la casa del asistente**, sin perder nada de
lo que ya hace.

**Dot y Desktop son productos distintos [decidido 2026-10-29, responde a §15.1.4].** Dot te
acompaña en el día a día; Desktop es la aplicación de escritorio para **trabajar en local**
(conversaciones por carpeta, su agente `assistant`, sin cambios). Cada uno tiene **su propia
memoria**: lo que aprende uno no lo ve el otro. Los dos siguen siendo clientes hermanos de
`stratumd` (M12) y la cabina de Dot ve también las sesiones de Desktop.

Por eso el asistente de Dot es un **agente embebido nuevo, `companion`**, con su preset (derivado
del de `assistant`), su directorio y su memoria (`~/.stratum/companion/`). Frente al `assistant`
de Desktop, gana:

- **un ordenador propio contenido** (la caja: un contenedor Podman o Docker que gestiona `stratumd`);
- **computer use dentro de esa caja** (pantalla, ratón y teclado sobre un escritorio virtual);
- **trabajo en segundo plano y rutinas** programadas;
- **memoria propia, visible y editable** desde Dot (la del `companion` y la de sesión de M11);
- **herramientas conectables** (MCP) con sus efectos declarados.

La cabina (Activity, Approvals, sesiones de terminal, run detail) sigue igual: el asistente es una
sesión más, de larga vida, que se supervisa como las demás.

### 23.1 Por qué

Comparativa del 2026-10-29 (fuentes mayoritariamente secundarias):

| Producto | Qué es | Cómo protege |
|---|---|---|
| Grok Bot (SpaceXAI + Cursor), *dots* de OpenAI | Agentes en un ordenador de la nube del proveedor; cerrados; atados a su modelo | Reglas del servicio |
| Vellum (MIT) | Un asistente personal multicanal, local o en su nube | Sandbox por tool + permiso por acción (una vez / 10 min / siempre) |
| Rakazo (Apache-2.0) | Equipo de bots autónomos, autoalojado con Postgres | Aislamiento por bot; sin aprobación humana documentada |
| Codex app-server, opencode, Goose | Núcleo local con servidor y varios clientes | Aprueba el cliente conectado |

Lo que ninguno documenta y Stratum ya tiene: runtime local y agnóstico de provider, autoridad de
aprobar separada del webview con confirmación nativa (M8–M9), una misma sesión observada y
gobernada desde varios clientes y su traspaso entre anfitriones (M10). La dirección combina el
**aislamiento** de Rakazo (la caja es el radio de daños) con la **autorización** de Stratum (lo que
sale de la caja lo aprueba una persona), y el principio de Vellum de que el asistente toca la
máquina real solo con aprobación.

La pieza que hacía dudar de la viabilidad —que un modelo accesible maneje una pantalla— se midió
antes de decidir (§23.9).

### 23.2 Invariantes que no cambian

- **Dot sigue siendo un cliente.** El asistente corre en `stratumd` por `SessionHost` con el preset
  `companion`; Dot no ejecuta agentes, no habla con Docker ni toca la caja. Lo fija su test de
  arquitectura, que no cambia.
- **La autoridad de aprobar sigue fuera del webview** (broker nativo, clave de aprobador,
  confirmación nativa por resolución). Una rutina o un conector no traen autoridad propia.
- **Memoria por preset**, ahora con tres: `coding` ve la del proyecto, `assistant` (Desktop) la
  global, y `companion` (Dot) solo la suya (`~/.stratum/companion/memory/` y
  `~/.stratum/companion/STRATUM.md`), además de su memoria de sesión. Ninguno ve la de otro. Lo
  recordado no es autoridad.
- **`origin` no decide permisos**; tampoco que un run lo haya lanzado una rutina.
- **Falla cerrado**: sin Docker, sin caja o con la caja caída, las tools de la caja no se
  registran o se vetan; nunca caen a `local`.
- **Nada se estima**: el formato de coordenadas, la visión de un modelo o el coste de una rutina
  se declaran o se miden, no se suponen.
- **El asistente no carga plugins** (decisión PL1) y **la CLI no depende del daemon**.

### 23.3 La caja del asistente

- **Target de `exec`**: `container:<nombre>` (la sintaxis ya está reservada en `parseTarget`).
  Backend `IExecBackend` nuevo que lanza `podman exec` o `docker exec` con execa, con el mismo contrato que `ssh`:
  cancelación estructurada, `timeout`, `maxBytes`, auditoría en `exec-audit.jsonl` y comando
  redactado. Es un target general: una sesión `coding` también puede usar una caja.
- **Ciclo de vida a cargo del daemon**: crear, arrancar, parar y recrear con órdenes fijas (nunca
  un `docker` que componga el agente). CLI `stratum box status|start|stop|reset` y su método de
  protocolo; Dot solo los pide.
- **Imagen de Stratum versionada**: Xvfb, Chromium, `xdotool`, ImageMagick y utilidades básicas,
  usuario no root. Un **volumen persistente** para su `home`: reiniciar o actualizar la caja no
  borra su trabajo; `reset` lo borra, con confirmación.
- **Aislamiento por defecto**: no se monta el `home` del usuario ni `~/.stratum`; no hay socket de
  Docker ni pipe del daemon dentro; sin `--privileged`. Una única **carpeta de intercambio**
  explícita (`~/.stratum/companion/exchange` ↔ `/exchange`) para pasarle o recoger ficheros.
- **La caja es un entorno** (H17) con su política: lo que muta **dentro** está permitido; lo que
  sale de ella (otro target, un conector que actúa fuera, enviar o publicar) sigue en `confirm`.
- **Sin Docker** (ni Podman, preferido desde A5) el asistente funciona como hoy (sin caja ni
  pantalla) y Dot lo dice. Stratum detecta el runtime; no lo instala.
- **Decisión nueva [confirmada 2026-10-29]** (se aplica en M14, no antes): el `companion` **sí
  tiene `exec`**, solo contra **su** caja; nunca `local` ni `ssh:`. El `assistant` de Desktop no
  cambia (sin `exec`, ficheros confinados a su carpeta). En M14 hay que actualizar a la vez
  `.claude/docs/decisiones.md` (filas de clientes hermanos y de memoria por preset), `CLAUDE.md`,
  `.claude/docs/memoria.md`, `.claude/docs/skills.md` (las skills de serie declaran también
  `companion`) y añadir los tests que fijen el `exec` del `companion` a su caja.

### 23.4 Computer use en la caja

- **Tools** `screen_screenshot`, `screen_click`, `screen_type`, `screen_key`, `screen_scroll`,
  `screen_wait` contra la pantalla de la caja. Solo se registran si la caja tiene escritorio y el
  modelo está declarado con visión. Declaradas en `callEffects`: la captura es lectura; el resto
  muta sobre el target `container:<caja>`.
- **Formato de coordenadas por modelo**, en la config del modelo (`vision.coordinates:
  "pixels" | "norm1000"`), por defecto `pixels`. El spike mostró que modelos que localizan bien
  devuelven 0–1000 (`gemma4`, `qwen3.6`) y, sin reescalar, parecen ciegos (§23.9).
- **Las capturas no inflan el contexto**: solo las últimas N (el spike usó 2) van como imagen; las
  anteriores se sustituyen por un marcador. La compactación de M11 nunca resume una imagen.
- **Las capturas no se redactan** (la redacción es de texto): no van a logs, a la memoria de
  sesión ni a la traza en línea. La traza guarda metadatos (tamaño, hash, paso); guardar los
  ficheros es una opción explícita (§23.13 A6).
- **Dot enseña la pantalla en vivo, en solo lectura**, con un indicador mientras el asistente la
  usa y un «parar» que es la cancelación del run. Tomar el control desde Dot queda fuera de M15.
- Prompt injection por lo que aparece en pantalla: el radio es la caja; lo que sale de ella pide
  aprobación (§23.10).

### 23.5 Trabajo en segundo plano y rutinas

- **Planificador en `stratumd`** (`RoutineScheduler`): una rutina es `{ id, schedule (cron o
  intervalo), prompt, modelo?, límites }`, guardada en `~/.stratum/companion/routines.json`
  (escritura atómica, Zod, `schemaVersion`). Al vencer, hace `runs.start` en **su propia sesión**
  del asistente (visible en Activity con su nombre) y pasa antes por `waitAtSafePoint`.
- **Nadie mirando**: una aprobación pendiente caduca a `deny` (§13.3) y la rutina sigue o falla;
  nunca se rebaja una política porque el run sea programado. Al terminar, notificación en Dot
  (§8.6) con el resumen.
- **Quién crea una rutina**: la persona, desde Dot o `stratum routines add|list|rm|run`. El agente
  solo puede **proponerla** con una tool de control (`propose_routine`, interceptada como
  `present_plan`), que se resuelve en el centro de aprobaciones: es trabajo autónomo futuro.
- **Jobs**: la regla de jobs no cambia; los de la caja viven con su sesión, que es de larga vida.
- **Proactividad libre** (que el asistente escriba por iniciativa propia fuera de una rutina):
  fuera por ahora.
- **Límite físico**: sin nube, una rutina solo corre con la máquina encendida y el daemon vivo.
  El arranque del daemon con la sesión del SO entra en M16 como opción.

### 23.6 Memoria

El `companion` tiene **su propia memoria**, separada de la de Desktop (`assistant`, que sigue
usando `~/.stratum/assistant/memory/` y `~/.stratum/STRATUM.md`) y de la de cualquier proyecto:
`~/.stratum/companion/memory/` (decisiones e índice) y `~/.stratum/companion/STRATUM.md`, más la
memoria de sesión de M11. Se monta con el mismo `MemoryManager`, solo cambian las rutas (por
preset, en `buildCompanionConfig`, como hoy `buildAssistantConfig`). No hay importación de la
memoria de Desktop: empieza vacía. Lo nuevo en Dot es el **inspector**: ver, buscar y borrar lo
que recuerda, con procedencia. Nada de lo recordado decide permisos, aprobaciones ni guardas.

### 23.7 Herramientas conectables

- **MCP del asistente**: servidores declarados en la capa global de la config (nunca la de un
  proyecto), con efectos en `callEffects`. Una tool sin declarar cuenta como mutante sin target y
  pide confirmación.
- **Credenciales**: las de los conectores no entran en el contexto del modelo ni en la caja. Un
  proceso aparte que las custodie (como el `credential-executor` de Vellum) queda como
  endurecimiento posterior.
- **Concesiones con caducidad** («permitir 10 minutos») como término medio entre una vez y la
  sesión: abierto (§23.13 A3), sin tocar `confirm-always` ni las solicitudes `forced`.

### 23.8 UX

- **Dos vistas, una app**:
  - *Asistente* (la de inicio): chat con el asistente, panel de la caja (pantalla en vivo,
    estado, jobs), rutinas y memoria.
  - *Cabina*: lo actual (Activity, Approvals, run detail).
- **Dot compacto**: `Enter` habla con el asistente persistente; una sesión nueva es explícita.
- Las aprobaciones del asistente son tarjetas del mismo centro: misma confirmación nativa.

### 23.9 Evidencia: spike del 2026-10-29

Fuera del repo, con Docker 29.9 en Windows y los modelos del provider de NaN.

**Localización en pantalla.** Capturas reales a 1280×800 de Wikipedia y GitHub hechas por Chromium
dentro de Docker, 9 elementos con su caja real sacada del DOM (algunos de 20 px), 2 pasadas. Cuenta
como acierto solo si el punto cae dentro del elemento:

| Modelo | Aciertos | Coordenadas |
|---|---|---|
| `glm5.3-flash` | 18/18 | píxeles |
| `gemma4` | 18/18 | 0–1000 |
| `qwen3.6` | 17/18 | 0–1000 |
| `deepseek-v4-flash` | 16/18 | píxeles |
| `mimo-v2.6-flash` | variable | mezcla ambos según la llamada |
| `qwen3.8-flash` | bajo | — |

**Bucle completo.** Un agente con `glm5.3-flash` y solo captura, clic, escribir, tecla, scroll y
espera, sobre Chromium con su interfaz normal en un escritorio virtual (Xvfb) dentro de la caja,
sin acceso al DOM. Una acción por turno; en el contexto, las 2 últimas capturas:

| Tarea | Resultado | Pasos | Tiempo | Tokens |
|---|---|---|---|---|
| Buscar un artículo con el buscador de Wikipedia y leer un dato de la ficha | 3/3 | 6–7 | 68–77 s | ~20–24 k |
| Navegar por las carpetas de un repo de GitHub y comprobar si existe una | 3/3 | 7–11 | 98–294 s | ~25–47 k |
| Rellenar un formulario (texto, radio, dos checkbox), enviarlo y leer la respuesta | 4/4 | 11–18 | 117–175 s | ~40–70 k |

10/10. La tarea de GitHub se dio primero por fallida y era error del esperado: la carpeta no
existe, y el modelo lo dijo con la lista real.

**Límites de la evidencia**: tareas cortas, páginas públicas sin sesión iniciada, 10 ejecuciones;
no se probó recuperarse de errores, ventanas emergentes, descargas ni sesiones largas. Conclusión:
el computer use en la caja es **trabajo de ingeniería, no una apuesta**; los escenarios de este
spike pasan a ser el criterio de M15.

### 23.10 Seguridad

- **La caja es el radio de daños**: lo que haga dentro no alcanza los ficheros del usuario, sus
  claves SSH ni el daemon. De paso, cierra para el asistente la vía de auto-aprobación de §13.4:
  desde la caja no hay `endpoint.json` ni pipe que alcanzar.
- **Lo que sale de la caja pide aprobación**: otro target, un conector que actúa fuera, enviar,
  publicar o pagar.
- **Contenido no confiable**: la web y lo que aparezca en pantalla pueden intentar dar órdenes al
  modelo. No se mitiga en el modelo sino en la política: dentro de la caja da igual; fuera, decide
  una persona.
- **Red de la caja**: con salida a internet por defecto. El acceso a la red local y al host
  (`host.docker.internal`) está por decidir (§23.13 A2).
- **Docker es privilegiado** (en Linux, equivalente a root; Podman sin root no lo es, una razón
  más para preferirlo): solo el daemon habla con el runtime, con
  órdenes fijas. El agente nunca recibe el socket ni compone un `docker`.
- **Capturas**: no se redactan, así que no salen de la sesión salvo como metadatos (§23.4).

### 23.11 Hitos

Mismo orden que hasta ahora: cada hito se demuestra sin interfaz antes de pintarlo en Dot.

- **M13 — La caja.** *Hecho 2026-10-29* (`.claude/docs/box.md`, `docs/protocol.md` §21). Backend
  `container:` de `exec`, imagen versionada, ciclo de vida en el daemon
  (`stratum box …` y su método), volumen persistente, carpeta de intercambio, la caja como
  entorno. *Hecho cuando*: una sesión hace `exec` en `container:<caja>` con el mismo contrato que
  `ssh:` (auditoría, cancelación, timeout, `maxBytes`), la caja sobrevive a un reinicio del daemon
  con su volumen, y sin Docker todo lo anterior se deshabilita con un mensaje y sin errores. Los
  tests que necesitan Docker se saltan si no está.
- **M14 — El `companion` en su caja.** Agente embebido `companion` (preset, directorio y memoria
  propios, §23.6) con `exec` solo contra su caja (§23.3). Vista *Asistente* básica en Dot
  (conversación con el `companion`, estado de la caja, `start`/`stop`). *Hecho cuando*: el
  `companion` instala y ejecuta en su caja sin pedir aprobación; cualquier `exec` suyo a `local` o
  `ssh:` se veta en `preflight` (escenario adversarial en `evals/`); lo que recuerda no aparece
  en Desktop ni lo de Desktop en él (test de memoria por preset); el `assistant` de Desktop no
  cambia; y la documentación de decisiones está actualizada.
- **M15 — Computer use en la caja.** Tools `screen_*`, formato de coordenadas por modelo, poda de
  capturas, capturas fuera de traza y logs, pantalla en vivo en Dot con indicador. *Hecho cuando*:
  las tres tareas de §23.9, ejecutadas por las tools reales, salen al menos 8 de 10 veces cada una
  con `glm5.3-flash`, y un modelo `norm1000` declarado acierta igual que uno en píxeles.
- **M16 — Rutinas.** `RoutineScheduler`, `routines.json`, `stratum routines …`,
  `propose_routine`, notificaciones, arranque del daemon con la sesión (opcional). *Hecho
  cuando*: una rutina corre a su hora con nadie mirando, lo que pide aprobación caduca a `deny`
  sin bloquear el daemon, y su resultado está en Dot.
- **M17 — Conectores e inspector de memoria.** MCP del asistente desde la capa global con
  `callEffects`; inspector de memoria en Dot.
- **M18 — Canales externos (Telegram, etc.).** Solo después de distinguir quién habla (dueño, de
  confianza, desconocido): otro canal es otra puerta de entrada. Se decide con datos de M13–M17.

### 23.12 Fuera, por ahora

Proactividad libre, voz, el escritorio del propio host (§13.6), ejecución con la máquina apagada
o en una nube, multiusuario, y tomar el control de la caja desde Dot.

### 23.13 Preguntas abiertas

- **A1. Dot y Desktop.** *Resuelta 2026-10-29*: son productos distintos. Dot acompaña en el día
  a día (`companion`); Desktop es la app para trabajar en local (`assistant`), y cada uno tiene su
  memoria (§23, introducción). Cierra §15.1.4: Dot no es el modo compacto de Desktop.
- **A2. Red de la caja.** *Resuelta 2026-10-29*: salida a la red **por defecto** (sin ella el
  navegador de la caja no sirve), con un ajuste para quitarla (`box.network: false` → `--network
  none`; se aplica al recrear la caja en su siguiente `start`). Bloquear solo la LAN o el host, o
  una lista de dominios, queda para más adelante.
- **A3. Concesiones con caducidad** («permitir N minutos») frente a `allow-all` de sesión, y cómo
  se muestran en Dot.
- **A4. Rutinas**: ¿sesión propia por rutina (propuesta) o la sesión principal del asistente?
  ¿Qué parte del resultado vuelve al chat principal?
- **A5. Docker en Windows**. *Resuelta 2026-10-29*: **Podman preferido** (no necesita un servicio
  en Linux; en Windows y macOS usa su `podman machine`) y Docker como alternativa
  (`box.runtime: auto | podman | docker`; `auto` prueba Podman y luego Docker).
- **A6. Capturas en la traza**: ¿se guardan los ficheros para el auditor (depuración) o solo
  metadatos (privacidad)? Propuesta: solo metadatos por defecto, y los ficheros con opción explícita.
- **A7. Modelo con visión**: cómo se declara (`vision: true` en la config del modelo) y qué ve el
  usuario si elige uno sin visión con computer use activo.
