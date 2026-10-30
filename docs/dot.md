# Stratum Dot

Cockpit de escritorio de Stratum: una ventana pequeña y una bandeja desde las que ver qué
sesiones hay, en qué están, pausar, reanudar, cancelar o redirigir sus runs, **conversar con
Stratum** —abrir una sesión en el daemon y hablar con ella— y **contestar lo que una sesión
espera de una persona**: aprobaciones, preguntas y planes.

> **Estado (M9).** Shell nativo con Tauri v2, conectado a `stratumd` por el Stratum Protocol
> v1: descubre el daemon (o lo arranca), observa las sesiones vivas —las del daemon y las que
> publica la CLI—, sobrevive a sus caídas, da cuatro órdenes (`pause`, `resume`, `cancel`,
> `steer`), abre sesiones alojadas en el daemon y conversa con ellas (M7, §12) y, desde M8,
> **resuelve aprobaciones, preguntas y planes de cualquier sesión visible** con una autoridad
> de aprobar separada de su conexión normal y mantenida fuera del webview (§13). M9 lo
> endurece (§14): **cada resolución sensible exige una confirmación nativa**, el lado nativo
> verifica con el sistema quién atiende el canal antes de enviar credenciales, el endpoint y el
> socket son privados, y las colas están acotadas. Con M10 (§15), una sesión de la terminal que
> pasa a alojarse en el daemon se sigue viendo como **la misma** y se puede conversar con ella.
> Con M12 (§16), Stratum Desktop pasa a ser un cliente hermano que **comparte el enlace nativo**
> (`dot-link`, con su propio perfil); Dot no cambia de comportamiento.
> Sin trazas todavía. Contrato:
> `docs/protocol.md`. Producto: `docs/PRD_STRATUM_DOT.md`. Fronteras entre clientes:
> `docs/STRATUM_CLIENT_ARCHITECTURE.md`.

Las reglas que M8 y M9 no rompen:

```text
Dot = cliente        stratumd = plano de control        SessionHost = runtime

webview = UI no confiable    lado nativo = frontera de autoridad    stratumd = árbitro

webview pide  →  lado nativo comprueba  →  la persona confirma (nativo)  →  stratumd arbitra
```

**Dot es un cliente.** No es un segundo runtime, ni un segundo `EventHub`, ni un sidecar, ni
una API paralela: todo lo que sabe y todo lo que hace pasa por el protocolo, como
`stratum ps` o `stratum approvals`. Se puede cerrar, matar o desinstalar sin que cambie nada:

```text
cerrar Dot  →  las sesiones siguen · los runs siguen · las aprobaciones siguen · el daemon sigue
```

## 1. Arquitectura

```text
┌──────────────────────────── Stratum Dot ────────────────────────────┐
│  webview (React)        src/                                         │
│    screens/ components/     pintan                                   │
│    stores/                  proyección para pintar (no es la verdad) │
│    protocol/                el contrato, reexportado + validar/aplicar│
│    bridge/                  la frontera: comandos tipados y eventos   │
│        │  invoke `dot_*`            ▲  `dot://event`                 │
│  ──────┼────────────────────────────┼──────── frontera de confianza ─│
│        ▼                            │                                │
│  Rust   src-tauri/src/      ventana, bandeja, comandos (lista blanca)│
│         crates/dot-link/    cliente del protocolo, sin Tauri         │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │ Stratum Protocol v1 — NDJSON sobre
                                  │ named pipe / unix socket (sin TCP)
                                  ▼
                              stratumd
                       ┌──────────┴──────────┐
                sesiones del daemon     sesiones pares (CLI)
```

| Pieza | Dónde | Qué hace | Qué no hace |
|---|---|---|---|
| `dot-link` | `stratum-dot/crates/dot-link/` | Descubrir, conectar, `core.hello`, suscripciones, reconexión, relevar cuatro órdenes y cuatro llamadas (abrir sesión, iniciar run, listar perfiles y modelos). Y, aparte, el **broker de aprobador** (`approver.rs`): su propia conexión, solo para resolver (§13) | Interpretar DTOs, reducir eventos, depender de Tauri |
| Shell | `stratum-dot/src-tauri/` | Ventana, bandeja, instancia única, comandos `dot_*`, emitir `dot://event`, la **ventana de desbloqueo** (`unlock.rs`) | Hablar el protocolo por su cuenta |
| `bridge/` | `stratum-dot/src/bridge/` | Único punto que toca Tauri; reparte cada evento a su store | Lógica del protocolo |
| `protocol/` | `stratum-dot/src/protocol/` | Reexporta el contrato; valida y aplica; cómo se lee una foto | Tipos o reglas propias |
| `stores/` | `stratum-dot/src/stores/` | `connectionStore`, `sessionStore`, `uiStore` | Ser fuente de verdad; persistir estado del runtime |

### Decisión de transporte: cliente nativo en Rust, sin sidecar

Se evaluaron dos formas de hablar con `stratumd`:

- **A. Cliente nativo en Rust** (elegida): Tauri → pipe → `stratumd`.
- **B. Sidecar Node** que reutiliza `StratumClient`: Tauri → IPC privado → Node → `stratumd`.

B no duplicaba nada del cliente, pero metía en Dot un proceso Node permanente —y con él un
segundo contrato privado (Rust ⇄ sidecar), el empaquetado de un runtime (el SEA de Desktop
pesa decenas de MB; el objetivo de M6 es un instalador < 15 MB) y, sobre todo, **el sitio
equivocado para las credenciales**: la respuesta a Q2 (§7) pasa por que quien sostenga la
autoridad de aprobar sea un proceso nativo capaz de comprobar la identidad del otro extremo
del pipe, que es justo lo que Node no puede hacer.

A obliga a escribir en Rust lo que el cliente necesita, así que se acotó para que no se
convierta en «un segundo protocolo»:

| Lo que sí está en Rust | Equivalente en el cliente Node |
|---|---|
| Framing NDJSON (`framing.rs`) | `ipc/framing.ts` |
| Descubrimiento, con los cinco resultados (`discovery.rs`) | `client/discovery.ts` |
| Sobre de los mensajes y lista cerrada de métodos (`wire.rs`) | `protocol/messages.ts` |
| Handshake, reconexión, ciclo de vida (`link.rs`) | `client/client.ts`, `handshake.ts` |
| Reglas de entrega: duplicados, huecos, fragmentos tardíos (`subscriptions.rs`) | `client/subscriptions.ts` |

| Lo que **no** está en Rust | Dónde está |
|---|---|
| Los DTOs (`ProtocolSession`, `ProtocolRun`, eventos…) | `stratum-cli/src/protocol/`, importado por el webview |
| Validación campo a campo | `protocol/schemas.ts` (Zod), en `src/protocol/apply.ts` |
| Cómo un evento cambia una foto | `applySessionEvent` (`protocol/reduce.ts`) |
| `RunRegistry`, `EventHub`, `ApprovalCenter`, `PauseController` | En el daemon y en el runtime. Dot no tiene equivalente |

Rust solo lee de cada mensaje el **sobre** (`id`, `method`, `result`/`error`,
`subscriptionId`) y los **campos de orden** de un evento (`seq`, `after`, `sessionId`, y `type`
para saber qué sesiones existen). No hay en Rust un solo `struct` con la forma de una sesión o
de un run, ni el nombre de un evento de run, tool o mensaje: un cambio en esos DTOs no toca
`dot-link`. Lo fijan los tests de arquitectura (§8).

**Desviación respecto al PRD (§17).** El PRD decía que el webview no importaría
`protocol/schemas.ts`. Lo importa: la validación campo a campo tiene que estar en algún
sitio, y repetir 800 líneas de Zod en `serde` era exactamente la duplicación que se quería
evitar. `schemas.ts` es puro (solo importa `zod`; `protocol/purity.test.ts` lo recorre) y el
test de arquitectura de Dot comprueba que desde lo que importa no se alcanza Node.

### Una suscripción por sesión viva

Dot mantiene una suscripción `overview` y **una suscripción `session` por cada sesión viva**:

- `overview` solo se usa para saber **qué sesiones existen** (su foto de conjunto y los
  eventos `session.opened` / `session.closed`).
- El estado de cada sesión —también el que enseña la lista— sale de **su** foto y de **sus**
  eventos, con `applySessionEvent`.

Así hay un único reductor, el del contrato. La alternativa (pintar la lista con los eventos
de `overview`) habría exigido un segundo reductor en Dot para saber el estado del run de cada
sesión, que la foto de conjunto no trae. El coste son N suscripciones en vez de una, con N
pequeño; por encima de 64 sesiones vivas las siguientes no se siguen (y se registra).

Solo la sesión **enfocada** (la seleccionada) se suscribe con `volatile: true`: es la única
que recibe el texto según se genera.

## 2. Ciclo de vida de la conexión

`ConnectionState` es una máquina de estados (`dot-link/src/state.rs`), no un conjunto de
booleanos, y es lo único que la interfaz sabe de la conexión:

```text
starting ──► connecting ──► connected ──► reconnecting ──► connected
   │             ▲                              (el daemon volvió)
   ▼             │
daemon-starting ─┘            incompatible · error
```

| Estado | Significa | Cómo se sale |
|---|---|---|
| `starting` | Dot acaba de abrir (o se pulsó *Retry*) | Solo |
| `daemon-starting` | No había daemon y se está ejecutando `stratum daemon start` | Solo |
| `connecting` | Hay endpoint: conectando y saludando | Solo |
| `connected` | Handshake hecho. Lleva versión del daemon, protocolo y capacidades **concedidas** | Si se pierde la conexión |
| `reconnecting { attempt }` | Hubo conexión y se perdió. Se reintenta con espera creciente (250 ms → 5 s), releyendo el endpoint cada vez | Cuando el daemon vuelve |
| `incompatible` | El daemon habla otra versión del protocolo | *Check again*, o si aparece **otro** daemon |
| `error { message }` | No hay conexión ni se está estableciendo (no se pudo arrancar el daemon, lo rechazó…) | *Retry*, o solo si aparece un daemon |

### Descubrimiento

`~/.stratum/daemon/endpoint.json`, **solo lectura**, con los mismos resultados que el cliente
Node: `found`, `absent`, `stale` (el pid ya no existe), `invalid` (el motivo nombra el campo,
nunca el valor: el fichero lleva el token) e `incompatible`. No se asume ningún host ni
puerto: **no hay TCP**. El directorio personal se resuelve como lo hace Node
(`USERPROFILE` / `HOME`), que es quien publica el fichero.

### Arranque del daemon

Dot es una aplicación persistente, así que —a diferencia de la CLI, donde
`daemon.autoStart` es `false`— **arranca el daemon si no hay ninguno**. Lo hace con el comando
oficial y con nada más:

```text
stratum daemon start
```

No hay un lanzador propio: Dot no escribe `endpoint.json`, no elige el pipe ni conoce
`stratum daemon run`. `stratum daemon start` lanza `stratumd` desligado, de modo que
**sobrevive a Dot**. Reglas:

- Se arranca **una vez por intento explícito**: al abrir Dot y al pulsar *Retry*.
- **Nunca al reconectar.** Si había conexión y se perdió, Dot espera a que el daemon vuelva;
  si alguien lo paró con `stratum daemon stop`, no se le lleva la contraria.
- Si el comando falla (no está instalada la CLI, no arranca a tiempo), queda en `error` con el
  motivo, y se recupera solo en cuanto aparece un daemon (AC-7).
- **Dot nunca apaga el daemon.** No existe en su código el método `core.shutdown`.

`STRATUM_DOT_CLI` elige la CLI en lugar de `stratum` del `PATH` (un ejecutable, o un `.js` que
se lanza con `node`): para desarrollo y tests. `STRATUM_DOT_NO_AUTOSTART=1` desactiva el arranque.

### Reconexión y fotos

```text
conectado → el daemon muere → Dot sigue abierta, «Reconnecting…», con lo último que sabía
          → el daemon vuelve → handshake → suscripciones reabiertas → una foto por sesión
```

- **La foto es la autoridad.** Toda suscripción de sesión se abre **pidiendo foto** (nunca
  `sinceSeq`), al conectar y al reconectar: el estado local se **sustituye**, no se reconstruye
  con eventos antiguos ni se fusiona.
- Un hueco de `seq` (o un evento que el webview no puede validar) → se cambia la suscripción
  por otra que empieza con foto. Nunca se «remienda».
- Mientras no hay conexión **no se borra la interfaz**: se ve lo último conocido, atenuado y
  marcado *last known*, con los controles deshabilitados.
- **Reconectar no es reintentar.** Una orden enviada y sin respuesta tiene resultado
  **desconocido** (`kind: 'unknown'`): se dice, y no se reenvía. Sin conexión, una orden falla
  en el acto (`not-sent`); no se encola.
- Tras reiniciarse el daemon, una sesión de terminal tarda un momento en volver a registrarse:
  la lista queda vacía un instante y la sesión reaparece **seleccionada**, como estaba.
- `incompatible` y `PROTOCOL_MISMATCH` **no** entran en bucle: un intento, y a esperar. Lo
  mismo con un token rechazado (`UNAUTHORIZED`): no se insiste contra el mismo daemon.

## 3. Frontera nativo / webview

El webview es contenido: pinta texto que viene de un modelo. Por eso no tiene nada que pueda
filtrar ni nada con lo que pueda conectarse por su cuenta.

**Lo que el webview nunca recibe**: el token de `endpoint.json`, la ruta del pipe, la ruta del
endpoint, la clave de aprobador (ni nada derivado de ella), variables de entorno. La clave se
teclea en otra ventana, que no es este webview (§13.2). El token vive en un tipo (`Token`) que
no se serializa ni se imprime, y solo sale hacia `core.hello`. Lo que cruza al webview es
`DotEvent`, que por construcción no lo lleva; un test lo comprueba contra todo lo emitido y
contra el log.

**Lo que el webview puede pedir** — la lista completa (`src/bridge/native.ts` ⇄
`src-tauri/src/commands.rs`):

| Comando | Para qué |
|---|---|
| `dot_attach` | La interfaz está lista: recibe el estado y una foto de cada sesión |
| `dot_retry` | Volver a empezar (descubrir, arrancar, conectar) |
| `dot_focus_session` | Qué sesión se mira |
| `dot_resync_session` | Pedir una foto nueva de una sesión |
| `dot_pause_run` · `dot_resume_run` · `dot_cancel_run` · `dot_steer_run` | Las cuatro órdenes |
| `dot_open_session` | Abrir una sesión **alojada en el daemon**: `cwd?`, `agent?`, `provider?`, `model?` (M7) |
| `dot_start_run` | Un mensaje: un run nuevo de esa sesión (M7) |
| `dot_list_agents` · `dot_list_models` | Qué se puede elegir al abrir, según el daemon (M7) |
| `dot_approver_status` · `dot_approver_unlock` · `dot_approver_lock` | Estado de la autoridad de aprobar; abrir la ventana de desbloqueo; soltarla (M8). Ninguno recibe ni devuelve la clave |
| `dot_approve` · `dot_deny` · `dot_answer_questions` · `dot_decide_plan` | Resolver **una** solicitud de **una** sesión (M8). Los atiende el broker, con su conexión |
| `dot_set_attention` | Cuánto se enseña pendiente, para la bandeja (M8). Solo un contador |
| `dot_hide` · `dot_quit` | Ocultar la ventana · salir de Dot |

No existe un `rpc(method, params)` genérico. En Rust, los métodos del protocolo que se pueden
enviar son **dos** `enum` cerrados, uno por conexión (`wire.rs`):

- `MainMethod` (la conexión principal): `core.hello`, `events.subscribe`, `events.unsubscribe`,
  `runs.pause`, `runs.resume`, `runs.cancel`, `runs.steer` y, desde M7, `runs.start`,
  `sessions.open`, `agents.list` y `models.list`.
- `ApproverMethod` (la conexión de aprobador, M8): `core.hello`, `approvals.resolve`,
  `questions.answer` y `plans.decide`.

Cada conexión solo sabe escribir los suyos (el rasgo `WireMethod` está sellado y `Conn::request`
de `link.rs` solo acepta `MainMethod`): no compila mandar una aprobación por la principal ni un
`runs.*` por la de aprobador. Siguen fuera de las dos, a propósito: `core.shutdown`,
`sessions.close`, `sessions.set*` y `jobs.cancel`.

**Cada comando, solo desde su ventana.** Los comandos están declarados en el manifiesto de
`src-tauri/build.rs`, así que cada uno exige un permiso, y la única capacidad
(`capabilities/default.json`) es de la ventana `main`. La ventana de desbloqueo no tiene
ninguna: no puede invocar nada. Los de aprobador comprueban además que los pide `main`.

Los cuatro comandos de M7 devuelven el `result` del daemon **sin interpretar**: Rust no sabe
qué forma tiene una sesión, un run, un perfil o un modelo. El webview lo valida con los schemas
del contrato (`src/protocol/results.ts`), igual que una foto o un evento.

`dot_open_session` acepta cuatro textos opcionales y nada más. **No hay forma de pasar
variables de entorno a una sesión desde el webview** —el comando no tiene ese parámetro, y
`dot-link` no sabe escribir un `env`—, ni un `resume`, ni `readOnly`. El directorio es un
texto: Dot no lo abre, no lo lista y no comprueba que exista; eso lo hace el daemon.

**Lo que llega al webview** — un solo canal, `dot://event`, que conserva el orden:

| Evento | Contenido |
|---|---|
| `connection` | `ConnectionState` |
| `sessions` | Ids de las sesiones vivas. **Sustituye** |
| `snapshot` | Foto de una sesión. **Sustituye** |
| `events` | Eventos posteriores, en orden y sin repetidos |

Nunca tramas NDJSON. Los DTOs llegan **ya redactados por el anfitrión de la sesión** (el
protocolo no lleva parámetros crudos de tools, ni entorno, ni config) y el webview los pasa
por los schemas del contrato antes de guardarlos: lo que no es del contrato se descarta, y lo
que no valida no se pinta. De una tool se enseña su `description` acotada, nunca sus argumentos.

Permisos del webview: `core:default` y sus comandos `dot_*`, uno a uno, y nada más. Sin
sistema de ficheros, sin shell, sin diálogos, sin red (CSP `default-src 'self'`).

Lo único que se guarda entre arranques son **preferencias de interfaz**: geometría de la
ventana (`tauri-plugin-window-state`) y, en `localStorage`, la última sesión seleccionada y el
último directorio con el que se abrió un chat. Nunca fotos, estado de un run, **la
conversación**, un borrador, ni credenciales.

## 4. Roles y capacidades

La conexión principal de Dot pide **`operator`** (`observe` + `control`) y nada más: no pide
`approver` y nunca lleva una `approverKey`. La autoridad de aprobar es **otra conexión**, del
broker nativo, que pide solo `approver` y existe solo mientras la persona la desbloquea (§13).

**M7 no añade ninguna capacidad.** Abrir una sesión e iniciar un run exigen `control`, que es
exactamente lo que esa capacidad significa en el contrato desde M1 («conducir runs y sesiones:
abrir, cerrar, iniciar, cancelar…») y la que Dot ya tenía. Se valoró una capacidad más
estrecha para «crear sesiones» y se descartó: quien puede cancelar o redirigir el run de
cualquier sesión viva no gana autoridad por poder abrir una propia, y partir `control` habría
cambiado lo que conceden `stratum run --detach` (M10) y los clientes de texto sin proteger nada.
Lo que sí está separado sigue estándolo: `observe` no abre (un observador recibe `FORBIDDEN`),
`host` es excluyente y tampoco, y `approve` no sale de esta conexión.

La interfaz usa las capacidades **concedidas**, no las pedidas: sin `control` (o sin conexión,
o con el anfitrión de la sesión desconectado) los controles están, deshabilitados, y dicen por qué.

La autoridad de aprobar **no** se mezcla en esta conexión: es la del broker (§13.1).

## 5. Lo que se ve y lo que se puede hacer

**Lista** (el `stratum ps --watch` visual): título, estado, perfil, modelo, anfitrión
(`daemon`, o `cli (peer)`), tiempo del run, pendientes y directorio. La misma fila para las
sesiones del daemon y las de una terminal: solo cambia `host.kind`. Arriba, **+ New chat**.

**Una sesión** tiene una cabecera (título, estado, perfil, modelo, anfitrión, directorio), los
controles de su run, dos pestañas y, abajo, el campo para escribirle:

- **Chat** — la conversación (§12): lo que se le dijo, lo que contestó, qué tools usó, lo que
  está escribiendo ahora y lo que espera de una persona.
- **Activity** — la vista de M6, intacta: run (estado, duración, `stopReason`), anfitrión,
  perfil, modelo y provider, directorio, target y entorno, contexto, tokens (`n/a` si el
  backend no los reporta: no se estiman), jobs, tools, lo pendiente, las últimas tool calls y un
  registro de actividad reciente.

Las dos pestañas valen para las sesiones del daemon y para las de una terminal. Lo que cambia
es qué se les puede pedir (ver *El campo de escritura*, §12.3).

**Estados**: los del contrato y ninguno más — `running`, `waiting_approval`, `waiting_input`,
`paused`, `queued`, `idle`, `completed`, `failed`, `cancelled`, `interrupted`, `detached`.

- **`detached` no es un fallo.** Una sesión cuyo anfitrión perdió la conexión se ve
  *Detached*, con su último estado conocido, y nunca en rojo ni como *Failed*.
- **`pause-requested` no existe** como estado: es interno del runtime.
- Una tool `pending` o `running` se rotula **«Active»**, no «Executing»: `tool.started` se
  publica al conocerse la llamada, que puede estar esperando una aprobación o una pausa
  (deuda conocida del protocolo, §16 de `protocol.md`).
- El texto parcial es **volátil**: se pueden perder fragmentos. `message.completed` y la foto
  mandan; el estado es el mismo con todos los fragmentos o con ninguno.

**Órdenes** — siempre por el protocolo, y **sin actualización optimista**:

```text
clic en Pause → runs.pause → «Pause requested…»        (aviso local, no es run.status)
              → el runtime alcanza un punto seguro → run.updated → «Paused», botón Resume
```

| Orden | Se envía | La interfaz cambia cuando |
|---|---|---|
| Pause | `runs.pause { sessionId, runId }` | llega `run.status: paused` |
| Resume | `runs.resume { sessionId, runId }` | llega `run.status: running` |
| Cancel (con confirmación) | `runs.cancel { sessionId, runId }` | llega `run.cancelled`. La sesión no se quita de la lista |
| Steer | `runs.steer { sessionId, text }` | — (el campo se vacía solo si quedó `accepted`) |

| New chat | `sessions.open { cwd?, agent?, provider?, model? }` | el daemon publica la sesión (`session.opened` + su foto). Hasta entonces, «Opening session…» |
| Send (sesión parada) | `runs.start { sessionId, input }` | llega `run.started`: el mensaje aparece en la conversación. Hasta entonces, «Sending…» |

Con `runId`, una orden sobre un run que ya no es el vigente contesta `STALE_STATE` en lugar de
aplicarse a otro. Steering con el run en pausa se acepta y **no reanuda**: la interfaz lo dice.
Una sesión de terminal conserva su entrada en su terminal; lo que se envía desde Dot es steering.

«← Sessions» **deja de mirar** una sesión; no la cierra. Dot no tiene cómo cerrar una sesión
(`sessions.close` no está en su lista de métodos): si algún día lo hace, será una acción
explícita y confirmada, no una X.

**Teclado**: `Ctrl/Cmd+N` abre un chat nuevo; `Ctrl/Cmd+K` lleva al campo de escritura;
`Enter` envía y `Shift+Enter` es una línea nueva; `Esc` suelta el campo y, si no hay ninguno
enfocado, oculta la ventana.

## 6. Ventana, bandeja e instancia única

- **Cerrar la ventana** la oculta en la bandeja. **Quit Dot** (en la bandeja y en el pie de la
  ventana) termina Dot. Ninguna de las dos cosas toca el daemon.
- **Bandeja**: *Open Stratum Dot* · *Sessions: N* (informativo) · *Waiting for you: …*
  (informativo, M8) · *Open Approval Center* · *Quit Dot*. Clic izquierdo abre la ventana.
  Ninguna función depende de ella, y desde ella no se aprueba nada (§13.7).
- **Sin bandeja** (o con `STRATUM_DOT_NO_TRAY=1`): cerrar la ventana sale de Dot —si no, no
  habría por dónde volver— y `Esc` minimiza en vez de ocultar.
- **Una instancia por usuario** (`tauri-plugin-single-instance`): abrir Dot otra vez enfoca la
  ventana que ya hay y la segunda sale.
- La ventana funciona compacta (por debajo de 720 px, lista **o** detalle) y ancha (lista y detalle).

**Q4 — bandeja en Linux.** Tauri usa `libayatana-appindicator`: en GNOME sin la extensión
AppIndicator el icono no aparece aunque crearlo no falle, y eso no se puede detectar desde la
app. Por eso *Quit Dot* está también en la ventana y relanzar Dot la trae al frente. Si la
librería falta, crear la bandeja puede acabar en pánico: se captura y Dot sigue sin ella.
Comprobado en Windows 11; en Linux queda por probar en un escritorio real (ver §9).

## 7. Q2: lo que hay y lo que no

Ni M6, ni M8, ni M9 **cierran** Q2 para procesos del mismo usuario (`PRD_STRATUM_DOT.md` §22:
verificar la identidad del proceso al otro lado del canal), y Tauri por sí solo no la arregla:
un proceso del mismo usuario sigue pudiendo leer `endpoint.json` y conectarse como cualquier
cliente. Lo que se ha ido poniendo en **el sitio** que M6 dejó preparado:

```text
webview            nunca ve una credencial; pide qué resolver                  (M6–M8)
   │
lado nativo        conexión principal: operator                               (M6/M7)
   │               conexión de aprobador, aparte, bajo demanda                 (M8, §13)
   │               confirmación nativa de cada resolución sensible             (M9, §14.1)
   ▼               el sistema dice quién atiende el canal antes de enviar nada  (M9, §14.3)
stratumd           carpeta, endpoint y socket privados                         (M9, §14.4)
```

Qué protege M9, qué verifica el sistema operativo y qué sigue dentro del mismo dominio de
confianza, por separado: §14.3.

## 8. Tests

| Qué | Dónde | Cómo se ejecuta |
|---|---|---|
| Framing, descubrimiento, sobre, reglas de entrega, estados | `crates/dot-link/src/*.rs` | `cargo test -p dot-link` |
| El enlace contra un **daemon de pruebas sobre un pipe real**: conectar, arrancar el daemon, huecos, foco, reconexión, órdenes, resultado desconocido, incompatible, cerrar sin tocar nada, el token no sale | `crates/dot-link/tests/link.rs` | ídem |
| Validar y aplicar con el reductor del contrato; pérdida de fragmentos; eventos de un tipo futuro | `src/protocol/apply.test.ts` | `npm run test:run` |
| Del lado nativo a los stores: la foto sustituye, hueco → foto, `detached` | `src/bridge/connect.test.ts` | ídem |
| La interfaz: Pause sin optimismo, steer en pausa, cancel, sin conexión, incompatible, teclado | `src/app/App.test.tsx` | ídem |
| **El chat** (M7): chat nuevo sin sesión fantasma, enviar sin optimismo, fragmentos perdidos, reconexión a mitad de un mensaje, resultado desconocido sin reenvío, preguntar ≠ redirigir, dos chats que no se cruzan, sesión que desaparece, markdown sin HTML | `src/app/Chat.test.tsx` | ídem |
| **El centro de aprobaciones** (M8): sin autoaprobar, bloqueado sin poder resolver, foco fuera de *Approve*, Enter/Esc que no deciden, frase exacta, `allow-all` solo cuando vale, otro llegó antes, resultado desconocido sin reenvío, caducada/cancelada, aprobar ≠ reanudar, broker caído, reconexión, sesión sin anfitrión, preguntas, planes, varias sesiones, orden | `src/app/HumanInput.test.tsx` | ídem |
| **El broker de aprobador** (M8) contra el daemon de pruebas: otra conexión y bajo demanda, rol y capacidad comprobados, clave mala (genérico, sin bucles, conexión nueva), bloquear, caducar, conexión caída sin reconectar sola, daemon nuevo, `ALREADY_RESOLVED`, id de otra sesión, resultado desconocido, la clave no sale | `crates/dot-link/tests/approver.rs` | `cargo test -p dot-link` |
| **Arquitectura** (sobre el código) | `tests/architecture.test.ts` | `npm run test:run` |
| **Daemon real**, sin ventana: `dot-probe` (el mismo enlace) contra `stratumd`, `stratum run` y una sesión del daemon | `scripts/smoke-real.mjs` | `npm run smoke:real` |
| **Chat contra un daemon real** (M7), sin ventana: abrir, conversar en varios turnos, `BUSY`, cerrar y reabrir Dot, dos chats, convivencia con una sesión de terminal, muerte del daemon | `scripts/smoke-chat.mjs` | `npm run smoke:chat` |
| **Aprobar contra un daemon real** (M8), sin ventana: clave mala y buena, aprobar y la tool corre, denegar, id de otra sesión, frase de un entorno de producción, `allow-all` por sesión, preguntas, planes, dos Dot a la vez, pausa (y pausa + steering), cerrar y reabrir Dot, reinicio del daemon, bloquear, la clave en ningún fichero | `scripts/smoke-approvals.mjs` | `npm run smoke:approvals` |
| **La terminal contra Dot** (M8): `stratum run` en un pty de verdad con su prompt local; gana Dot / gana la terminal | `scripts/smoke-terminal.mjs` | `npm run smoke:terminal` |
| **La app de verdad**, en su ventana, con tauri-driver | `e2e/dot.e2e.mjs` (M6) · `e2e/chat.e2e.mjs` (M7) · `e2e/approvals.e2e.mjs` (M8) · `e2e/assistant.e2e.mjs` (M14) | `npm run e2e` |

En el contrato y el daemon (`stratum-cli`, `npm test`): `protocol/transcript.test.ts` (la
conversación como función de los eventos, sus límites y que una foto al límite cabe en una
trama) y `daemon/daemon-chat.test.ts` (varios turnos con contexto, un run a la vez, dos chats,
`cwd` por defecto y validado, `maxSessions`, quién puede abrir e iniciar, `env` del cliente
ignorado, `models.list`/`agents.list` sin secretos).

Invariantes que comprueba `tests/architecture.test.ts`: Dot solo importa de
`stratum-cli/src/protocol/` (y de ahí no se alcanza el runtime ni Node); ningún fichero nombra
`SessionHost`, `StratumAgent`, `EventHub`…; no hay otro reductor, ni en TS ni en Rust; solo
`bridge/native.ts` toca Tauri y cada comando es un literal registrado en Rust (no hay RPC
genérico); el webview no lee el endpoint, no usa Node ni red, y no guarda más que dos
preferencias; `dot-link` no depende de Tauri; los métodos salen de la lista cerrada; no hay
`core.shutdown`, ni aprobaciones, ni otro rol que `operator`; no hay TCP; y Dot no escribe el
endpoint ni lanza un daemon por su cuenta. Desde M8: dos listas de métodos, una por conexión,
sin solaparse (salvo el saludo); `"approver"` y `approverKey` solo en `approver.rs` y
`secret.rs`; la principal no conoce al broker ni el broker los métodos principales; el broker
exige `approve` concedido; `ApproverSecret` sin `derive`, sin `Clone`/`Debug`/`Serialize` y con
`Zeroizing`; en el shell solo `unlock.rs` crea uno y ningún comando lo recibe; cada comando
declarado en `build.rs` y concedido uno a uno a `main` (y la ventana de desbloqueo en ninguna
capacidad); ningún campo de contraseña en el webview; y solo `app/resolve.ts` pide resolver
(una sola tarjeta, `InteractionCard`). Desde M7, además: `dot_open_session` solo acepta
`cwd`, `agent`, `provider` y `model` (ni `env`, ni `resume`), y el lado nativo no toca el
sistema de ficheros por un directorio que le pasen; no existe `sessions.close` ni
`sessions.set*` en Dot; la conversación no se guarda ni se reconstruye en Dot (nadie trata
`message.delta` / `message.completed` por su cuenta, no hay un store de mensajes y lo que se
pinta es `snapshot.messages`); el webview no nombra la configuración de un provider; y no hay
`innerHTML` ni equivalente.

`dot-probe` (`crates/dot-link/src/bin/dot-probe.rs`) es el enlace de Dot con la interfaz
cambiada por líneas JSON: permite probar contra un daemon real sin automatizar una ventana.

## 9. Limitaciones conocidas

- **Sin trazas y sin cerrar sesiones**: posteriores. Límites propios del chat: §12.8; del
  centro de aprobaciones: §13.11.
- **Sesiones guardadas (*History*)**: el daemon ya las lista (`sessions.list`) y las monta con
  `sessions.open { resume }` (`protocol.md` §19.4); Dot todavía no las enseña.
- Una tool vetada por el runtime (también la descartada por steering) llega como
  `tool.blocked` con su `source` desde Contrato-1 (`protocol.md` §13.6).
- **`tool.started` no es «ejecutándose»** (ver §5).
- **El entorno de una sesión del daemon arrancado por Dot es el de Dot** (el de la sesión
  gráfica, no el de una terminal): es Q1 del PRD, sin cambios en M6.
- **Dot necesita la CLI instalada** para arrancar el daemon (`stratum` en el `PATH`). Sin ella
  funciona como observador de un daemon que arranque otro.
- **Linux**: `dot-link` y sus tests cubren el unix socket; la app (bandeja, instancia única,
  ocultar al cerrar) está comprobada en Windows y pendiente de un escritorio Linux real (Q4).
  macOS queda fuera de v1.
- **Desfase de versiones** Dot ↔ daemon dentro de la v1: un evento de un tipo que Dot no
  conoce avanza la secuencia sin aplicarse; el endurecimiento completo es M9.
- **Sin firma ni auto-update**: empaquetado y firma son M9.

### Deuda menor (no bloquea M6)

- **Canal de órdenes sin tope.** El canal interno entre la app y el actor del enlace
  (`link.rs`) es un `mpsc::unbounded_channel()`. Lo alimentan solo los comandos `dot_*` de una
  interfaz, así que en la práctica no crece, pero no tiene límite formal.
- **Tope de 64 sesiones seguidas** (`MAX_FOLLOWED_SESSIONS`). Por encima, las siguientes no se
  siguen y solo se registra en el log: la interfaz no lo dice.
- **Bandeja en GNOME/Wayland** sin probar en un escritorio Linux real (Q4, §6).

Deuda del **protocolo**, no de Dot: `tool.started` se publica antes de ejecutar (`protocol.md`
§13.6 y §16).

## 10. Convivencia con Stratum Desktop

Dos aplicaciones (`PRD_STRATUM_DOT.md` §9.5). Hasta M11, `stratum-desktop` tenía su sidecar y su
protocolo v9 y Dot no compartía nada con ella salvo el cliente WebDriver de pruebas. **Desde M12
(§16)** las dos son clientes hermanos del mismo `stratumd` y comparten el enlace nativo
(`dot-link`) y la capa cliente del contrato (`followSession`); no comparten estado, ni
identificador (`dev.stratum.dot` / `dev.stratum.desktop`), ni interfaz. La convergencia de
producto (si una es el modo compacto de la otra) queda fuera de M12.

## 11. Desarrollo

```bash
cd stratum-cli && npm ci && npm run build      # la CLI que Dot arranca en desarrollo
cd ../stratum-dot && npm ci

npm run test:native      # cargo test -p dot-link
npm run test:run         # vitest (frontend + arquitectura)
npm run smoke:real       # daemon real, sin ventana (M6)
npm run smoke:chat       # chat contra un daemon real, sin ventana (M7)
npm run smoke:approvals  # aprobar, contestar y decidir contra un daemon real (M8)
npm run smoke:terminal   # la terminal contra Dot por la misma aprobación (M8)

# La app, contra la CLI recién compilada:
STRATUM_DOT_CLI=../stratum-cli/dist/index.js npm run tauri dev

# E2E de la ventana (tauri-driver + driver nativo, como la suite de Desktop):
npx tauri build --debug --no-bundle && npm run e2e
```

Log de Dot: `dot.log` en la carpeta de logs de la app (`%LOCALAPPDATA%\dev.stratum.dot\logs`,
`~/.local/share/dev.stratum.dot/logs`). Cuenta arranque, descubrimiento, arranque del daemon,
conexión y desconexión, incompatibilidades, reconexiones y resincronizaciones. De una orden o
una llamada, su nombre (`control: pause`, `call: start-run`). Del broker (M8): cada intento de
desbloqueo y cómo acabó (`approver: unlock failed (UNAUTHORIZED)`), el ciclo de vida de su
conexión (`approver: locked (expired)`) y qué se resolvió y sobre qué solicitud
(`approver: resolve approve request=apr_…`). Nunca el token, la clave de aprobador, la frase de
una confirmación, las respuestas a una pregunta, entorno, el contenido de los eventos, el texto
de un mensaje ni el directorio de una sesión.

## 12. Chat (M7)

```text
Dot ── sessions.open ──► stratumd ── HostedSession ── SessionHost.create ── StratumAgent
Dot ── runs.start ─────► stratumd ── HostedSession.startRun ── host.run()
Dot ◄── foto + eventos ── EventHub ◄── SessionPublisher ◄── StratumAgent.observe()
```

Dot no ejecuta el agente, ni directamente ni a través de un sidecar: una sesión abierta desde
Dot es **una sesión del daemon como cualquier otra** (`HostedSession`, la de M2). No existe
una «sesión de Dot», ni un canal especial, ni una entidad «turno de chat»: un mensaje del
usuario es un **run** de una **sesión**.

### 12.1 Abrir una sesión

*New chat* abre un formulario con cuatro campos, todos opcionales:

| Campo | Viaja como | Si se deja vacío |
|---|---|---|
| Message | `runs.start`, después de abrir | Se abre la sesión sin run |
| Directory | `sessions.open.cwd` | El directorio por defecto del daemon: el *home* de su usuario |
| Agent | `sessions.open.agent` | Ninguno (`general`) |
| Model | `sessions.open.provider` + `.model` | Los de la configuración que aplique a ese directorio |

- **Lo que se puede elegir lo dice el daemon**: `agents.list { cwd }` (perfiles `primary` o
  `all`) y `models.list` (alias de provider + id de modelo; el de la configuración global va
  marcado `default`). Dot no lee `~/.stratum`, ni `.stratumrc.json`, ni sabe qué es una
  `baseUrl` o una API key: esos DTOs no las llevan.
- **El directorio lo valida el daemon**, no Dot: absoluto, existente, directorio y accesible
  para él (`INVALID_PARAMS` si no). El webview solo escribe un texto; no hay explorador de
  ficheros ni diálogo nativo, y el lado nativo no toca el disco por él.
- **El entorno de la sesión es el del daemon**: la copia que tomó al arrancar, más ese `cwd`
  (`protocol.md` §13.4). Nada del webview ni de Dot llega al entorno de una sesión;
  `sessions.open.env` sigue reservado y Dot no puede enviarlo.
- **Límites del daemon**: `daemon.maxSessions` (16). Al llegar, `sessions.open` contesta
  `UNAVAILABLE` y Dot enseña ese mensaje.
- **Sin sesión fantasma.** Dot no añade nada a su lista al abrir. Con el id que devuelve
  `sessions.open` solo hace dos cosas: seleccionarlo y pedir su texto en vivo. La sesión aparece
  cuando el daemon la publica; hasta entonces se ve «Opening session…». Si abrir falla, no
  queda nada a medias: ni fila, ni selección, y lo escrito sigue en el formulario.
- Perfil y modelo se eligen **al abrir**. Cambiarlos en una sesión viva (`sessions.set*`) no
  está en Dot.
- Abrir una sesión arranca sus servers MCP, así que tiene un plazo propio (90 s, frente a los
  10 s de una orden).

### 12.2 La conversación sale de la foto

Dot **no guarda la conversación**: ni en un store de mensajes, ni en `localStorage`, ni en
Rust. Lo que se pinta es, tal cual, lo que trae la foto de la sesión:

| De la foto | Qué es |
|---|---|
| `messages` | La conversación **cerrada**, de todos los runs de la sesión: lo que escribió el usuario (`user`), cada bloque del asistente (`assistant`), cada tool del agente principal con su estado (`tool`) y cómo acabó un turno que no terminó bien (`outcome`) |
| `messagesTruncated` | Se descartaron entradas antiguas: se dice («Earlier messages are not shown») |
| `partial.text` | Lo que el asistente está escribiendo **ahora**: efímero |

`messages` lo lleva el anfitrión de la sesión (su `SessionPublisher`) y es una **función pura
de los eventos de estado** (`applyTranscriptEvent`, en el contrato). `applySessionEvent` usa la
misma función, así que una foto y los eventos que la siguen dan siempre la misma conversación:
no hay un reductor de chat en Dot. Está acotada (`TRANSCRIPT_LIMITS`: 200 entradas, 12 000
caracteres por mensaje, 150 000 en total; lo más antiguo se va primero) y lo dice cuando recorta.

**Streaming.** El texto llega por `message.delta` a la sesión enfocada y va a `partial`. Es
volátil: se puede perder, y no se guarda en ningún sitio como autoridad.

```text
runs.start → run.started → message.delta* → message.completed → run.completed
                              (parcial)        (el bloque entero: entra en `messages`
                                                y `partial` se vacía, en el mismo paso)
```

Con todos los fragmentos, con algunos o con ninguno, la conversación acaba igual. Un bloque
se cierra cuando empieza una tool, cuando se entrega steering al modelo y al terminar el turno.

**Qué no es la conversación.** No es el historial del agente (ese se comprime y lleva los
resultados de las tools) ni la traza. No lleva el razonamiento del modelo, lo que dicen los
subagentes, la salida de las tools ni el texto de un mensaje de steering. De una tool se ve su
nombre, su estado —`pending` y `running` como **«Active»**, nunca «Executing»— y el resumen de
la llamada que da el anfitrión, ya redactado.

**Markdown.** Las respuestas se pintan como elementos de React, nunca como HTML: lo que el
modelo escriba como etiqueta se ve como texto. Los enlaces no navegan —el webview no abre
nada—: se ve su texto y, si es una dirección web, la dirección al lado.

**Desplazamiento.** Quien está al final sigue el texto; quien ha subido a leer no se mueve, y
aparece «↓ New output».

### 12.3 El campo de escritura: preguntar no es redirigir

Hace **una de dos cosas**, y dice cuál:

| Estado de la sesión | El campo | Envía |
|---|---|---|
| Parada (`idle`), alojada en el daemon | *Ask Stratum…* · **Send** | `runs.start`: un run nuevo |
| Con un run: `running`, `waiting_approval`, `waiting_input` | *Steer current run…* · **Steer**, con el aviso «Steering the current run. This does not start a new message.» | `runs.steer` |
| Con un run en `paused` | Lo mismo, y «gets it when you resume» | `runs.steer` (no reanuda) |
| Parada, de una terminal (`peer`) | Deshabilitado: «lives in a terminal» | — |
| Sin conexión, anfitrión desconectado, sin `control` | Deshabilitado, con el motivo | — |

- **Un run a la vez por sesión.** Nunca se abre un segundo run ni se encola un mensaje «para
  después». Si aun así llega un `runs.start` con un run en curso (dos ventanas, una carrera),
  el daemon contesta `BUSY`, Dot lo dice y el texto se queda en el campo.
- Lo escrito es un **borrador de la interfaz**, uno por sesión, en memoria: no sale de Dot
  hasta enviarlo, no se guarda entre arranques y no se borra si el envío falla.
- Un mensaje que no cabe en el protocolo (`LIMITS.inputChars`, 200 000 caracteres) no se
  envía **ni se recorta**: «Message too long».
- *Pause* y *Cancel* siguen siendo los de M6, junto al chat. Pausar no es «detener la
  generación»: es la pausa cooperativa de M5.

### 12.4 Sin actualización optimista

```text
Send → runs.start → «Sending…»          (aviso local: el mensaje NO se añade a la conversación)
     → run.started → el mensaje aparece, porque lo trae la foto / el reductor del contrato
```

Ni `run.status = running` a mano, ni un mensaje pintado antes de tiempo, ni una sesión en la
lista antes de que el daemon la publique. «Sending…» se **deriva** de la foto: desaparece en
cuanto enseña un run que no es el de antes (o a los 30 s).

### 12.5 Resultado desconocido

```text
runs.start enviado → la conexión cae antes de la respuesta
```

Dot **no reintenta**. Dice «Result unknown… check the conversation before sending it again»,
deja el texto en el campo y pide una foto: si el run existe, aparece en la conversación; si
no, no. Lo mismo con `sessions.open`: si la sesión se creó, aparece en la lista. Cada
`runs.start` y `sessions.open` lleva un `operationId` propio que pone el lado nativo, pero Dot
no lo usa para reenviar nada: queda reservado.

### 12.6 Reconexión, cerrar Dot y reiniciar el daemon

| Qué pasa | Qué se ve |
|---|---|
| La conexión cae y vuelve | Lo último conocido, atenuado y sin poder escribir → foto nueva → la conversación entera, sin duplicados |
| Se cambia de sesión mientras otra escribe | La que se deja pierde el texto en vivo; al volver, su foto y sus `message.completed` traen lo que faltó |
| **Se cierra Dot** (también a mitad de un run) | Nada: Dot no cierra sesiones ni cancela runs. La sesión y su run siguen en el daemon |
| **Se abre Dot otra vez**, con el mismo daemon | La sesión está en la lista y su conversación se reconstruye entera desde su foto |
| **El daemon se reinicia** (o muere) | *Desde M11* sus sesiones **vuelven** con el daemon nuevo: la misma sesión, con su conversación, parada (lo que estaba en marcha queda `interrupted`), y se le puede escribir otra vez (`docs/protocol.md` §19.4). Mientras no hay daemon, Dot no envía nada. Las de terminal vuelven cuando su proceso se registra otra vez |

La diferencia entre las dos últimas filas: **cerrar Dot no es cerrar la sesión, y desde M11
tampoco lo es que el daemon muera**: sus sesiones se guardan y vuelven. Solo `sessions.close`
acaba una sesión del daemon. (Hasta M10 una sesión del daemon vivía lo que vivía el daemon; los
smokes `smoke:real` y `smoke:chat` comprueban ahora la garantía nueva.)

### 12.7 Aprobaciones, preguntas y planes en el chat

La conversación **enseña** lo pendiente («Waiting for you», con qué es) y lleva al centro de
aprobaciones con *Open*, que es el único sitio donde se resuelve (§13.4). Lo que eso supone para
un chat abierto desde Dot es la política de M4, sin relajar:

- Si el daemon **no** acredita aprobadores (no hay `approver.json`), no hay a quién preguntar:
  lo destructivo se **deniega** sin preguntar, las preguntas del agente se contestan con
  supuestos y un plan no se aprueba, como `stratum run` sin terminal. Dot lo dice y no ofrece
  *Open*.
- Si los acredita, la solicitud queda pendiente —el run pasa a `waiting_approval` o
  `waiting_input`, y el campo sigue siendo de steering— hasta que alguien la resuelve (Dot,
  `stratum approvals`) o caduca (`daemon.approvalTimeoutMinutes`).

Responder no es escribir: una pregunta se contesta con `questions.answer` y un plan con
`plans.decide`, nunca con un mensaje nuevo (`runs.start`) ni con steering (`runs.steer`).

### 12.8 Limitaciones del chat

- **Sin persistencia entre reinicios del daemon** (§12.6) y sin historial de sesiones guardadas.
- **El texto del steering no aparece en la conversación**: el protocolo no lo transporta
  (`steering.queued` lleva su tamaño, no su texto). Dot dice «Steering queued» y lo ocurrido
  queda en Activity.
- **El mensaje del usuario se ve recortado a 2 000 caracteres** (lo que lleva `run.input`),
  con una nota que lo dice. El agente lo recibió entero.
- **Las tools de un subagente y lo que dice** no están en la conversación (sí en Activity).
- **Una sesión de terminal** enseña su conversación desde que se publicó en el daemon, no lo
  que tuviera de antes (`chat --resume`).
- **Sin cambiar de modelo o de perfil** en una sesión viva, **sin cerrar** una sesión desde
  Dot y **sin elegir carpeta con un diálogo**: el directorio se escribe.
- **La tool `question` se ve como *Interrupted*** en la conversación aunque se contestara: es
  una tool de control que el loop intercepta y el protocolo no publica cómo acabó (deuda del
  protocolo). La respuesta se ve en lo que dice después el asistente, y en *Recently resolved*.
- Una tool descartada por steering se ve como *Failed* y `tool.started` no es «ejecutándose»
  (deuda del protocolo, §9).
- **Tablas e imágenes** de markdown se quedan en texto.
- **«Default (modelo)» es el de la configuración global** del daemon (`models.list`). Si el
  directorio elegido tiene su propio `.stratumrc.json`, la sesión usa el de ese proyecto, que
  puede ser otro: lo que vale es lo que enseña la cabecera de la sesión una vez abierta.
- **Sin directorio, la sesión trabaja en el *home*** del usuario del daemon: su `.stratum/`
  «de proyecto» (planes, subagentes, guías) es entonces el global. Para trabajar sobre un
  proyecto hay que escribir su directorio.
- **Una tool que quedó abierta en un turno fallido o cancelado** se ve como *Interrupted*: el
  protocolo no publica cómo acabó.
- **En una sesión de terminal, `/clear` y `/sessions resume` no vacían la conversación
  publicada**: Dot sigue enseñando la anterior hasta que esa sesión se cierre.
- **Dot no puede cerrar sesiones**, así que los chats abiertos cuentan para
  `daemon.maxSessions` (16) hasta que el daemon se pare (`stratum daemon stop`).
- Por encima de 64 sesiones vivas, una recién abierta puede no seguirse (§9, deuda menor).

## 13. Aprobaciones, preguntas y planes (M8)

```text
webview (React)       UI no confiable: pide QUÉ resolver, nunca con qué autoridad
   │  dot_approve · dot_deny · dot_answer_questions · dot_decide_plan
   ▼
ApproverBroker (Rust) frontera de autoridad: su propia conexión, rol approver
   │  approvals.resolve · questions.answer · plans.decide   (siempre con sessionId)
   ▼
stratumd              árbitro (ApprovalCenter): la primera respuesta válida gana
   ▼
SessionHost           runtime: ejecuta, o no
```

Dot resuelve aprobaciones, preguntas y planes de **cualquier sesión visible** —las del daemon y
las de una terminal— por el Stratum Protocol existente (`docs/protocol.md` §15). Lo que M8
añade es dónde vive la autoridad de hacerlo.

### 13.1 Dos conexiones

| | Conexión principal | Conexión de aprobador |
|---|---|---|
| Quién | `link.rs` (M6/M7) | `approver.rs` (`ApproverBroker`) |
| Rol que pide | `operator` | `approver` (ni `operator` ni `host`) |
| Capacidades | `observe` + `control` | `observe` + `approve` — y solo se da por buena si el daemon **concedió** `approve` |
| Métodos | `MainMethod` | `ApproverMethod`: saludar y resolver |
| Cuándo existe | Siempre que hay daemon; reconecta sola | **Bajo demanda**: desde que la persona desbloquea hasta que bloquea, caduca, cae o se cierra Dot. **Nunca reconecta sola** |
| Si cae | Dot reconecta y pide fotos | Queda bloqueada (`connection-lost`). La principal sigue: se observa y se controla, solo no se resuelve |

Cada resolución lleva la **sesión** de la solicitud (`sessionId`, campo opcional del contrato
desde M8): el daemon rechaza con `NOT_FOUND` un id correcto con la sesión equivocada, sin
resolver nada ni decir cómo acabó (`docs/protocol.md` §15.2).

### 13.2 La clave no pasa por el webview

Tauri v2 no tiene un diálogo nativo con campo de texto, y un `<input type=password>` en la
ventana principal pondría la clave en el mismo JS que pinta lo que escribe un modelo. Se
descartó también el prompt de credenciales del sistema (`CredUIPromptForWindowsCredentials`):
solo existe en Windows y no se puede conducir en un E2E. La clave se teclea en **otra ventana**:

```text
Unlock approvals ──► dot_approver_unlock ──► ventana «unlock» (otra ventana, otro webview)
                                               │ página propia y estática (src-tauri/unlock/)
                                               │ origen propio: dot-unlock (no el de la principal)
                                               │ sin IPC: no está en ninguna capacidad
                                               ▼
                         POST dot-unlock://localhost/submit  (cuerpo: la clave)
                                               │ solo si viene de la ventana «unlock» (lo dice Tauri)
                                               │ y con el nonce de la página servida
                                               ▼
                         ApproverSecret ──► core.hello de la conexión de aprobador ──► se borra
```

- **Otro origen.** La página se sirve por un esquema propio (`dot-unlock`), así que no comparte
  almacenamiento, *service workers* ni nada con la ventana principal, y su CSP es la suya
  (`default-src 'none'`, script y estilo propios, `connect-src 'self'`, `frame-ancestors 'none'`).
- **Sin IPC.** No invoca ningún comando: entrega la clave con un `POST` a su propio origen, que
  atiende `unlock.rs`. Una petición de otra ventana —la principal incluida— se rechaza.
- **En Rust**, la clave es un `ApproverSecret`: sin `Clone`, `Debug`, `Display` ni `Serialize`;
  se borra (`zeroize`) al soltarse, también si no valía. Se escribe **una vez**, en el
  `core.hello`, en un búfer reservado de una vez que también se borra, y se olvida. Desde ahí
  la autoridad es la **conexión acreditada**, no la clave: no se guarda para reconectar. Lo que
  **no** se borra son las copias que hacen otros: el motor del webview de la ventana de
  desbloqueo, Tauri al pasar el cuerpo de la petición y la pila de E/S del propio proceso (en
  Windows, `mio` copia lo que se escribe en el pipe a un búfer suyo que reutiliza sin ponerlo
  a cero). Las lee quien puede leer la memoria de Dot: el mismo usuario (§13.8).
- **Nunca** va a `localStorage`, a una configuración, a `endpoint.json`, a un log, a `argv`, al
  entorno de un proceso, a un `DotEvent` ni a un error. Los errores de desbloqueo son genéricos:
  «Could not unlock approval authority.».
- El campo de la ventana de desbloqueo se vacía al enviar; la ventana se cierra al desbloquear.
  Cerrarla o cancelar a mitad de la comprobación **no** deja nada desbloqueado. El nonce de la
  página sale del generador del sistema (`getrandom`); sin él, la ventana no se abre.

**La frase de confirmación no es la clave.** Una aprobación con `confirmPhrase` exige teclear esa
frase, que viaja en el DTO de la solicitud. Desde M9 se teclea en la **ventana de confirmación
nativa** (§14.1), no en la tarjeta: el webview ya no la envía, y Dot no la rellena.

### 13.3 Estados del broker y ciclo de vida

Lo único que el webview sabe de la autoridad (`ApproverStatus`, sin datos):

| Estado | Significa | Cómo se sale |
|---|---|---|
| `unavailable` | Sin daemon (`not-connected`) o el daemon no acredita aprobadores (`no-approver-key`: no hay `approver.json`). Dot lo dice con cómo configurarlo (`stratum approvals set-key` y reiniciar el daemon). **Dot nunca crea una clave** | Cuando la conexión principal lo diga |
| `locked` | Hay a quién acreditarse, pero Dot no lo está. `reason`: `initial`, `manual`, `expired`, `connection-lost`, `daemon-changed` | *Unlock approvals* |
| `unlocking` | Comprobando la clave con el daemon (scrypt, en su cola) | Solo |
| `ready` | Acreditado hasta `expiresAt` | *Lock approvals*, caducar, perder la conexión, cerrar Dot |
| `error` | El último intento falló (mensaje genérico) | *Try again* |

- **Plazo**: 10 minutos desde el desbloqueo, fijos (`ApproverTimings::unlocked_for`), contados
  con el reloj monotónico **y** con el de pared —el monotónico no avanza con el equipo
  suspendido—; vencido, se cierra la conexión y no sale ninguna resolución más. *Lock approvals* lo hace a mano. Lo pendiente sigue pendiente: solo
  desaparece la capacidad de resolverlo desde Dot.
- **Cerrar Dot** suelta la autoridad y cierra la conexión de aprobador; el daemon, las sesiones,
  los runs y lo pendiente siguen. **Al abrir Dot otra vez, el broker está bloqueado**: el
  desbloqueo no se persiste.
- **Un daemon nuevo** exige desbloquear otra vez: la conexión con el anterior muere con él, y
  antes de cada resolución el broker comprueba que el daemon del endpoint es el mismo al que
  se acreditó (si no, `daemon-changed`).
- **Freno**: el del daemon (M4: un intento por conexión, comprobaciones de una en una, el fallo
  con retraso). Dot respeta esa semántica —cada intento es una conexión nueva, la rechazada se
  cierra— y añade una espera de 2 s tras un fallo, sin bucles.

### 13.4 El centro de aprobaciones

*Approvals N* en la cabecera (y `Ctrl/Cmd+Shift+A`) abre una pantalla con tres secciones
—**Approvals**, **Questions**, **Plans**— y una barra con el estado de la autoridad.

- **La fuente de verdad es la foto de cada sesión** (y sus eventos, con el reductor del
  contrato). Dot no guarda una lista propia de lo pendiente: aparece y desaparece con la foto.
  La suscripción `overview` sigue sirviendo solo para saber qué sesiones hay. Ni sondeo, ni
  endpoint nuevo.
- **Todas las sesiones**, cada solicitud con la suya: título, perfil, modelo, anfitrión
  (`daemon` o `cli (peer)`), directorio y run. Orden determinista: lo más antiguo primero.
- **Una aprobación** enseña tool, acción (la `description` ya redactada por el anfitrión, nunca
  los argumentos), target, entorno, motivo, si es forzada, si pide frase, cuándo se pidió y
  cuándo caduca («Expires in 4m 12s (then denied)»: `expiresAt` lo pone el anfitrión y solo se
  enseña; ninguna decisión depende del reloj local). Las forzadas y las de frase se distinguen
  con una etiqueta de texto y un borde, no solo por el color.
- **Botones**: *Deny* primero; *Allow for this session* y *Approve* al final, separados.
  *Allow for this session* (`allow-all`) solo aparece cuando la regla del contrato lo admite
  (`checkApprovalResolution`: ni forzada ni con frase) y dice que es **solo esa sesión** y que
  no cambia ninguna configuración. Con frase, la tarjeta dice cuál; se teclea en la ventana de
  confirmación (M9).
- **Foco y teclado**: al abrir el centro el foco va al título, y desde el chat (*Open*) a la
  tarjeta; nunca a un botón de aprobar. Enter en un campo de la tarjeta no envía nada. Esc
  suelta el campo y, otra vez, cierra el centro: **Esc nunca deniega**. No hay atajo para
  aprobar.
- **Preguntas**: una opción por pregunta, texto propio si la pregunta lo admite (`allowCustom`,
  o sin opciones), varias preguntas por tanda y *Skip questions* (omitir siempre vale). Lo que
  se envía se canoniza con `checkQuestionAnswers`, la regla del contrato, no con una propia.
- **Planes**: resumen y pasos, *Reject plan* / *Approve plan*. Se aprueba **el propuesto**: no
  hay editor (el contrato admite un plan editado; queda para después).
- **Una sola implementación**: `InteractionCard` (y `app/resolve.ts` detrás). El chat enseña lo
  pendiente y lleva hasta ella; no tiene su propia tarjeta.
- **Recently resolved**: cómo acabó lo que Dot vio resolverse, de sus eventos `*.resolved`
  (con `resolvedBy`: *from Stratum Dot*, *in its terminal*, *nobody answered in time*…). Es
  memoria de la interfaz: no se guarda y no sobrevive a una recarga.

### 13.5 Resolver: sin optimismo, sin reintentos

```text
Approve → dot_approve → confirmación nativa (M9, §14.1) → broker → approvals.resolve
        → «Approve: sent. Waiting for the session…»
        → el anfitrión publica approval.resolved → la tarjeta desaparece (lo dice la foto)
```

| Respuesta | Qué se ve | Qué se hace |
|---|---|---|
| Aceptada | «sent. Waiting for the session to confirm…», sin botones | Nada: el estado llega por eventos. **Nunca** se marca *Approved* a mano |
| `ALREADY_RESOLVED` | «Already resolved elsewhere» | Foto nueva: converge sola |
| `NOT_FOUND` | «This request no longer exists for this session» | Foto nueva |
| `INVALID_PARAMS` | Con frase: «The confirmation phrase does not match. Nothing was approved.» | Sigue pendiente; se puede volver a intentar a mano |
| `not-confirmed` (M9) | `cancelled`: nada (no es un error). El resto, su motivo («resolved elsewhere before you confirmed»…) | No salió nada. Con `resolved-elsewhere`, foto nueva |
| `UNAVAILABLE` (`host-unavailable`) | Solo se puede resolver en su terminal | — |
| Sin respuesta (`unknown`) | «Result unknown… It was not sent again» | Foto nueva. **No se reenvía** |
| No salió (`not-sent`) | El motivo (p. ej. bloqueado) | — |

**Gana la primera respuesta válida** —la terminal, otro Dot, `stratum approvals` o el plazo—, y
lo decide el anfitrión (`PendingInteractions.settle`). Una solicitud que caduca o se cancela
mientras se mira desaparece con su motivo y sin botones. Una sesión sin anfitrión
(`detached`, o `resolvable: 'origin'`) se ve, pero solo se puede resolver en su terminal.

### 13.6 Pausa y steering

M8 no cambia la semántica de M5:

- **Aprobar no reanuda.** Si el run está en pausa, la tarjeta lo dice («Resolving this does not
  resume it») y, tras aprobar, *Recently resolved* dice «Approved. The run remains paused:
  resume it to continue.» —solo para ese run—, con *Open session*. Dot no pide `resume` por su
  cuenta.
- Si durante esa pausa llega steering, lo aprobado se **descarta** al reanudar (M5); la
  aprobación sigue constando como resuelta.

### 13.7 Bandeja y atención

- La bandeja enseña *Waiting for you: 2 approvals · 1 question* y *Open Approval Center*, que
  abre la ventana en el centro. **Desde la bandeja no se aprueba nada.**
- Si aparece algo nuevo con la ventana sin foco, se pide atención al sistema (parpadeo en la
  barra de tareas): no se roba el foco ni se abre nada.
- El contador lo pasa el webview (`dot_set_attention`): es solo lo que se pinta, no da ni quita
  nada.
- Sin notificaciones del sistema en M8 (Q4). Si llegan, nunca serán un atajo para aprobar.

### 13.8 Modelo de amenaza y Q2

> M8 separates approval authority from the webview and from the normal operator connection.
> This prevents accidental credential exposure to frontend code, but does not yet provide strong
> isolation against arbitrary processes running as the same OS user.

Lo que **sí** se cierra:

- El webview principal —que pinta lo que escribe un modelo— **nunca tiene la clave**: ni la
  recibe, ni la puede pedir, ni puede leer la ventana donde se teclea (otro origen, otro
  webview, sin IPC).
- La conexión normal de Dot no puede aprobar, y la de aprobador no puede conducir runs ni
  observar más allá de su saludo.
- Lo que tiene un comando del agente (el token del canal) sigue sin bastar para aprobar (M4).

Lo que **no** se cierra, y no se afirma:

- **Un proceso del mismo usuario** sigue en el mismo dominio de confianza: puede leer la memoria
  de Dot (o de su webview mientras la persona teclea), sustituir `approver.json` y reiniciar el
  daemon, o manipular la interfaz con las APIs de accesibilidad o de entrada del sistema.
- ~~Mientras está desbloqueado, quien controle el webview principal puede pedir resoluciones de
  lo pendiente.~~ **Cerrado en M9** (§14.1): pedir ya no basta; cada resolución sensible exige
  una confirmación en una ventana nativa que el webview no controla, con lo que dice el daemon.
  Lo negativo (denegar, omitir, rechazar) sigue directo, a propósito.
- En la ventana de desbloqueo la clave es, durante un momento, una cadena de JavaScript, que no
  se puede borrar; y lo que copie el motor del webview o el sistema queda fuera del alcance de
  Dot.

### 13.9 Preparado para la identidad del par

> **M9** implementa el lado de Dot (cliente) de lo que sigue: §14.3. El lado del daemon sigue sin
> poder leer las credenciales del par (Node no las expone).

El broker es el sitio donde entrará la comprobación del proceso al otro lado del pipe; M8 no la
implementa (es endurecimiento, M9 o después):

- **Windows**: `GetNamedPipeServerProcessId` en `transport.rs`, tras conectar, para comprobar que
  el servidor es el `pid` del endpoint; y, del lado del daemon, `GetNamedPipeClientProcessId` y
  el token del proceso cliente (Node no lo expone: necesitaría un addon nativo).
- **Linux**: `SO_PEERCRED` del unix socket (pid, uid, gid del par), en los dos extremos.
- Firma de código del ejecutable del par y credenciales del sistema (Windows Hello, polkit) como
  alternativa a una clave tecleada.

### 13.10 Tests

`crates/dot-link/tests/approver.rs` (el broker contra el daemon de pruebas), `secret.rs` y
`approver.rs` (unidad), `src-tauri/src/unlock.rs` (la página no trae nada de fuera ni toca
almacenamiento o IPC), `src/app/HumanInput.test.tsx` (la interfaz), `tests/architecture.test.ts`
(las fronteras, sobre el código; el E2E las comprueba además en ejecución: un `POST` de la
ventana principal al esquema de desbloqueo no entrega nada, y desde la ventana de desbloqueo
ningún comando `dot_*` se atiende), `scripts/smoke-approvals.mjs` y `scripts/smoke-terminal.mjs`
(un `stratumd` real y una terminal real) y `e2e/approvals.e2e.mjs` (la ventana: New chat →
operación protegida → centro → desbloquear en su ventana, con una clave mala y la buena →
Approve → la tool termina → el asistente responde; pausa, pregunta, plan, bloquear, cerrar y
reabrir Dot con algo pendiente; la clave en ningún fichero ni en la ventana principal). En el
contrato: `daemon/approvals.test.ts` (id correcto con la sesión equivocada).

### 13.11 Limitaciones

- (M8) La comprobación del proceso par no existía, y desbloqueado el webview podía pedir
  resoluciones: ambas cosas se tratan en M9 (§14). Lo que queda, en §14.9.
- El plazo del desbloqueo es fijo (10 min) y no se renueva con el uso.
- Sin notificaciones del sistema; sin editar planes; *Recently resolved* no sobrevive a una
  recarga.
- La tool `question` se ve como *Interrupted* en la conversación (deuda del protocolo, §12.8).
- La ventana de desbloqueo está comprobada en Windows (WebView2); en Linux (WebKitGTK) compila
  en CI pero falta probarla en un escritorio real, como la bandeja (Q4).
- El E2E de la ventana sigue siendo local (tauri-driver), como en M6/M7.

## 14. Endurecimiento (M9)

M9 no añade capacidades de producto ni cambia la arquitectura: cierra lo que M8 dejó dicho como
abierto (§13.8, §13.9, §13.11) hasta donde se puede sin un addon nativo en el daemon, y dice con
precisión lo que sigue abierto. Lo que se puede afirmar al terminarlo:

> Un webview comprometido ya no puede usar por sí solo una autoridad de aprobación previamente
> desbloqueada para ejecutar una resolución sensible; las conexiones privilegiadas y el IPC tienen
> controles de identidad y de ciclo de vida más fuertes, las colas críticas están acotadas y las
> garantías reales de Q2 están documentadas y probadas (§14.3).

### 14.1 Confirmación nativa: pedir no es resolver

```text
webview (React)          pide QUÉ resolver: dot_approve(sessionId, approvalId, forSession)
   │
   ▼
commands.rs              lo negativo, directo · lo sensible, a la puerta de confirmación
   │
   ▼
ConfirmGate::request     broker `ready` (y su época) · lee DEL DAEMON la solicitud y su sesión
   │                     (approvals.list + sessions.get, por la conexión principal)
   ▼
ventana «confirm-N»      otra ventana, otro origen (dot-confirm), sin IPC, página propia
   │                     enseña lo que dijo el daemon · la persona lee y pulsa (o teclea la frase)
   ▼
ConfirmGate::confirm     su ventana y su nonce · ya armada · misma época · sigue pendiente
   │
   ▼
ConfirmedAction ──► broker.resolve_confirmed ──► stratumd (árbitro) ──► anfitrión
```

**Qué es sensible.** `ApproverAction::needs_confirmation`: aprobar, *Allow for this session*
(`allow-all`), enviar respuestas a preguntas y aprobar un plan. Lo que da permiso o dirige al
agente.

**Qué no, y por qué (decisión).** Denegar, omitir las preguntas y rechazar el plan van
**directos**, sin confirmación. Es exactamente lo que hace el runtime cuando nadie contesta (el
plazo, cancelar el turno, `cancelAll`): un webview comprometido que deniega todo puede estorbar,
pero no consigue que se ejecute nada. Pedir confirmación también para lo negativo duplicaría las
ventanas y enseñaría a confirmar sin leer, que es justo lo que la confirmación quiere evitar.

**El tipo lo impone.** El broker solo envía lo sensible si recibe una `ConfirmedAction`, y una
`ConfirmedAction` no se puede construir fuera de `dot-link` (campos privados, constructor
`pub(crate)`; dos doc-tests `compile_fail` lo fijan). La única que la crea es
`ConfirmGate::confirm`, y en el shell solo la llama la página de confirmación (`confirm.rs`, lo
fija el test de arquitectura). `ApproverHandle::resolve` rechaza lo sensible sin encolarlo
(`not-confirmed`, `reason: native-confirmation-required`), y el broker lo vuelve a comprobar.

**Lo que se enseña sale del daemon.** El webview solo da ids. La ventana enseña acción, tool,
descripción (la ya redactada por el anfitrión), target, entorno, motivo, si es forzada, la frase
si la pide, sesión (título, perfil, modelo, anfitrión), directorio y run, leídos con
`approvals.list` y `sessions.get`; si el id no está pendiente **en esa sesión**, ni se abre
(`NOT_FOUND`). Las respuestas a preguntas son lo único que viene del webview, y **no** se
enseñan tal cual: el lado nativo las pone en su forma canónica con la regla del contrato
(`checkQuestionAnswers`: una por pregunta, el texto de la pregunta del daemon, y si se eligió una
opción, **su etiqueta del daemon**), y eso mismo es lo que se envía. Un webview que dijera
«Conservarla» eligiendo la opción `drop` enseñaría «Borrar la tabla…»: lo que se envía. Nada se pinta como HTML: la
página construye el DOM con `textContent`. Ni la clave, ni el token, ni nada derivado viajan a
la ventana.

**La frase de una confirmación con nombre se teclea en la ventana nativa**, no en la tarjeta:
el webview ya no la tiene ni la envía (`dot_approve` no tiene parámetro `phrase`). La puerta la
compara exacta antes de nada; si no coincide, la ventana sigue abierta y no sale nada.

**Nunca se confirma sola.** La ventana abre con el foco en *Cancel*; Enter no confirma; el botón
se habilita solo con la ventana enfocada y tras `arm_delay` (800 ms) desde que se sirvió la
página —un doble clic o un clic que iba a otra ventana no aprueba— y la puerta vuelve a exigirlo
del lado nativo. Una confirmación a la vez: con una abierta, otra petición se rechaza
(`not-sent`) en vez de sustituir la ventana bajo el cursor; tras cancelar, 1 s antes de poder
abrir otra (sin bucles de ventanas).

**Cuándo deja de valer** (`CancelReason`, en `CommandError.reason` con `kind: not-confirmed`):

| Motivo | Qué lo dispara |
|---|---|
| `cancelled` | *Cancel*, Esc o cerrar la ventana |
| `expired` | 2 min sin confirmar (`ConfirmTimings::ttl`) |
| `locked` | El broker deja de estar `ready` (bloqueo, plazo, conexión perdida), o la confirmación es de **otro desbloqueo** (época) |
| `daemon-changed` | El endpoint ya no es el del daemon al que se acreditó el broker |
| `disconnected` | Se pierde la conexión principal, o el daemon no contesta al volver a comprobar |
| `resolved-elsewhere` | Llega su `*.resolved` (la terminal, otro cliente, el plazo), una foto ya no la trae, o al confirmar el daemon dice que no está pendiente |
| `session-gone` | Su sesión deja de estar en la lista, o llega `session.closed` |
| `closing` | Dot se cierra |

Caducada, **no se envía nada**. Confirmada, el broker comprueba otra vez la época y el daemon
antes de escribir, y sin respuesta el resultado es `unknown` y **no se reenvía** (M8). Si otro
llega antes entre la confirmación y la escritura, el árbitro contesta `ALREADY_RESOLVED`.

En la interfaz: mientras la ventana está abierta, la tarjeta dice «Approve: confirm it in the
Stratum Dot confirmation window…»; cancelar no es un error (la tarjeta vuelve a estar como
antes); `resolved-elsewhere` pide una foto. `dot-probe` tiene la misma puerta, con stdout como
«ventana» y `confirm`/`dismiss` por stdin (solo pruebas).

### 14.2 `ApproverBroker` y enlace endurecidos

- **Colas acotadas.** Fuera los `unbounded_channel`: el broker tiene una cola de 16 órdenes con
  respuesta y el enlace una de 64; llenas, la siguiente se rechaza en el acto (`not-sent`, «Too
  many requests at once») en vez de crecer. Lo que **no puede perderse** —bloquear, cerrar Dot,
  lo que dice la conexión principal, `attach`, reintentar, el foco— no ocupa cola: se anota y se
  coalesce, así que una avalancha no deja sin bloquear ni sin cerrar. En vuelo, como mucho 8
  resoluciones y 32 órdenes/llamadas; por encima, `not-sent`. La entrada del socket ya iba por
  canales acotados (64/256 líneas).
- **Época.** Cada desbloqueo tiene la suya; una confirmación vale para la época en que se pidió.
  Bloquear y desbloquear entre medias invalida lo confirmado (`authority-changed`).
- **El daemon, vigilado.** Desbloqueado, el broker comprueba cada 2 s que el endpoint sigue
  siendo el del arranque al que se acreditó: un endpoint sustituido o reiniciado bloquea
  (`daemon-changed`) aunque nadie esté resolviendo. Antes de cada resolución, además.
- **La clave solo va al daemon del endpoint** (§14.3): si el sistema no confirma usuario y pid,
  no se envía.
- Sin cambios en lo que M8 ya garantizaba: sin reconexión con autoridad, sin reintentos de una
  mutación con resultado desconocido, TTL de 10 min con los dos relojes, *Lock* inmediato,
  conexiones separadas `operator`/`approver` y `MainMethod`/`ApproverMethod` cerrados.

### 14.3 Identidad del par: lo que hay de Q2

Tres cosas distintas, que no hay que mezclar.

**Qué protege M9**

- La autoridad desbloqueada **no** la puede usar el webview por sí solo: cada resolución sensible
  exige una confirmación en una superficie que el webview no puede leer, escribir, enfocar ni
  enviar (§14.1, §14.5).
- Antes de enviar el token —y, por la conexión de aprobador, la clave— Dot pregunta al sistema
  **quién atiende el canal** y se niega si no es el proceso que publicó el endpoint o si es otro
  usuario. Un proceso que se adelante a crear el canal, o que conteste en un endpoint rancio, no
  recibe credenciales.
- El endpoint se lee sin seguir enlaces y, en POSIX, solo si es de este usuario y nadie más puede
  escribir en él ni en su carpeta; el daemon solo publica en una carpeta privada y deja su socket
  en `0600` (§14.4).

**Qué verifica el sistema operativo**

| | Lado de Dot (cliente, Rust: `peer.rs`) | Lado del daemon (Node: `peer-identity.ts`) |
|---|---|---|
| Linux / macOS | `SO_PEERCRED` / `LOCAL_PEERCRED`: uid del que escucha = el de Dot, y su pid = el del endpoint | El núcleo solo deja conectar a quien puede escribir en el socket (`0600` en carpeta `0700`): **este usuario o root**. No sabe qué proceso es |
| Windows | `GetNamedPipeServerProcessId` = pid del endpoint, y el SID de usuario del token de ese proceso = el de Dot | **Nada**: el pipe tiene la DACL por defecto (Node no permite otra). La barrera es el token, que vive en el perfil del usuario |
| Si el sistema no lo dice | Conexión principal: se registra y sigue (solo observar/conducir). Aprobador: **no se envía la clave** (falla cerrado) | — |

`client.kind` es lo que el cliente **declara** en `core.hello`: no es identidad y no da ni quita
capacidades (lo fijan los tests de arquitectura del daemon y de Dot).

**Qué sigue dentro del mismo dominio de confianza**

- **Cualquier proceso del mismo usuario.** Puede leer `endpoint.json` y conectarse como un cliente
  más; reescribir el endpoint con **su** pid y **su** canal (y entonces pasa la comprobación del
  par, porque es el mismo usuario y el pid publicado es el suyo); leer la memoria de Dot o de sus
  webviews mientras alguien teclea; sustituir `approver.json` y reiniciar el daemon; o manejar la
  ventana de confirmación con las APIs de accesibilidad o de entrada del sistema. M9 no lo
  impide y no lo afirma.
- **El daemon no sabe qué proceso hay al otro lado** en ninguna plataforma (Node no expone las
  credenciales del par). La abstracción `PeerVerification` está para que, si un día se puede, entre
  como otra variante sin tocar la autorización.
- **Root / administrador** queda por encima de todo esto.

El cierre de verdad sigue siendo el mismo de antes (PRD §22 Q2): credenciales del sistema
(Windows Hello, polkit) en vez de una clave tecleada, firma del ejecutable del par, o un addon
nativo en el daemon. Fuera de M9.

### 14.4 Endpoint e IPC

- **Dot lee el endpoint** abriéndolo sin seguir enlaces (`O_NOFOLLOW`; en Windows,
  `FILE_FLAG_OPEN_REPARSE_POINT` y se rechaza si es un enlace), y comprueba **lo abierto** —no la
  ruta: sin carrera entre comprobar y leer—: fichero regular, como mucho 64 KiB y, en POSIX, de
  este usuario y sin escritura para grupo u otros, en una carpeta de este usuario sin escritura
  para otros. Si no, `Invalid` con el motivo (sin rutas ni contenido) y no se conecta.
- **El daemon** (`private-dir.ts`): la carpeta no puede ser un enlace; en POSIX tiene que ser de
  este usuario y queda en `0700` —si sigue accesible a otros tras el `chmod`, no arranca—; el
  socket queda en `0600` tras escuchar y **antes** de publicar el endpoint; `endpoint.json` y
  `approver.json` en `0600`, escritos de forma atómica como en M2/M4. Si la ruta del socket no
  cabe en `sun_path`, va en una subcarpeta propia del temporal, creada también privada y quitada
  al apagar: nunca suelto en un directorio compartido. En Windows no se comprueba dueño ni ACL:
  hereda la del perfil.
- **Endpoint sustituido o reiniciado**: la conexión principal reconecta contra el nuevo (con su
  token, y verificando el par); la de aprobador **no** —se bloquea (`daemon-changed` o
  `connection-lost`) y hay que desbloquear otra vez—, y cualquier confirmación abierta cae.
- **Rancio**: lo resuelve el daemon al arrancar (M2: pid muerto o nadie escucha). Dot no toca el
  endpoint nunca (test de arquitectura). Sin TCP.

### 14.5 Frontera webview / nativo

- **Capacidades mínimas.** La ventana principal ya no tiene `core:default`: del núcleo de Tauri,
  solo `core:event:allow-listen` y `allow-unlisten`. Ni emitir eventos, ni listar o mover
  ventanas, ni webviews, menús, bandeja o rutas. El E2E lo comprueba en ejecución
  (`plugin:window|get_all_windows` → denegado).
- **Lista blanca cerrada** de `dot_*`, sin RPC genérico, igual que en M8. Las ventanas de
  desbloqueo y de confirmación no están en ninguna capacidad. `unlock` sigue sin IPC.
- **La ventana de confirmación** se atiende solo si la petición viene de **su** ventana (la
  etiqueta la da Tauri: `confirm-N`, una por confirmación, para que el cierre tardío de una no
  cancele la siguiente) y para la confirmación abierta (su nonce). Desde la principal, un `POST`
  a `dot-confirm` se rechaza.
- **Sin fugas.** Ni la frase, ni las respuestas, ni el plan, ni la descripción van a un log (solo
  qué y sobre qué id); los `DotEvent` siguen sin credenciales; los errores de desbloqueo siguen
  siendo genéricos; el lanzador del daemon no pasa nada más que `daemon start`, ni toca el
  entorno. Lo fijan tests de arquitectura (Dot y daemon), los de `dot-link` y los smokes, que
  barren ficheros, interfaz y logs.

### 14.6 Carreras cubiertas

| Escenario | Dónde se prueba |
|---|---|
| Aprobar solicitado → confirmación abierta → se resuelve en la terminal antes de confirmar | `tests/confirm.rs` (por evento y al volver a comprobar), `smoke:terminal` (terminal real) |
| Aprobar enviado → el daemon cae → `unknown`, no se reenvía | `tests/confirm.rs`, `tests/approver.rs` |
| El broker caduca o se bloquea con la confirmación abierta | `tests/confirm.rs` |
| Una confirmación de otro desbloqueo | `tests/confirm.rs` (`authority-changed`) |
| Dot se cierra durante la confirmación | `tests/confirm.rs` (`closing`); en la app, `RunEvent::Exit` |
| El daemon se reinicia o su endpoint se sustituye durante la confirmación | `tests/confirm.rs` |
| Pausa + aprobación + steering (M5) | `tests/confirm.rs`, `smoke:approvals` |
| Dos Dot sobre la misma solicitud: gana uno | `tests/confirm.rs`, `smoke:approvals` (dos `dot-probe` que confirman a la vez) |
| Id de otra sesión: nunca resuelve | `confirm.rs` (unidad), `tests/approver.rs`, `smoke:approvals` |
| Webview comprometido: invoca `dot_approve` por su cuenta | `tests/confirm.rs`, `e2e/approvals.e2e.mjs` (en la ventana real) |
| El canal lo atiende otro proceso | `tests/peer.rs` (token y clave no salen) |
| Avalancha de órdenes | `approver.rs` (unidad), `tests/peer.rs` |

### 14.7 Vista parcial

Dot sigue como mucho 64 sesiones a la vez (`MAX_FOLLOWED_SESSIONS`). Con más, `DotEvent::Sessions`
dice cuántas no sigue (`unfollowed`) y la lista lo enseña: «Partial view: N more live sessions
are not shown». Cuando una seguida termina, entra una de las que esperaban.

### 14.8 Tests

`crates/dot-link/tests/confirm.rs` (16, la confirmación contra el daemon de pruebas),
`tests/peer.rs` (identidad del par con otro proceso vivo, avalancha, vista parcial),
`tests/approver.rs` (adaptado: lo sensible pasa por la puerta), unidad en `confirm.rs`,
`peer.rs`, `discovery.rs` (enlace, permisos, tamaño) y `approver.rs` (cola llena, lo sensible no
se encola); `src-tauri/src/confirm.rs` (la página no trae nada de fuera ni pinta HTML; una
etiqueta por ventana); `tests/architecture.test.ts` (*M9 — pedir no es resolver*: un único
`broker.resolve` tras `needs_confirmation`, la `ConfirmedAction` solo la crea la puerta, solo la
página nativa confirma, capacidades mínimas, sin credenciales en argv/entorno/logs);
`src/app/HumanInput.test.tsx` y `App.test.tsx`; en la CLI, `daemon/private-dir.test.ts` y la
regla nueva de `daemon/architecture.test.ts`; `smoke:approvals` y `smoke:terminal` contra un
`stratumd` real; `e2e/approvals.e2e.mjs` con la ventana de confirmación real. CI (Windows y
Linux) corre además los tests del daemon, protocolo y cliente de la CLI.

### 14.9 Limitaciones de M9

- Q2 sigue abierta para procesos del mismo usuario (§14.3), y el daemon no verifica al cliente
  más allá de los permisos del socket (POSIX) o del token (Windows).
- La ventana de confirmación es un webview controlado por Rust, no un diálogo del sistema: el
  diálogo del sistema no tiene campo de texto (la frase) ni se puede probar en un E2E. Un proceso
  del mismo usuario puede manejarla con las APIs de entrada, como manejaría un diálogo.
- Probada en Windows (WebView2); en Linux (WebKitGTK) compila y sus tests nativos pasan en CI,
  pero falta probar la ventana en un escritorio real, como la bandeja (Q4).
- El E2E de la ventana sigue siendo local (tauri-driver).

## 15. Continuidad: una sesión que pasa de su terminal al daemon (M10)

Una sesión de `stratum chat` se puede traspasar viva a `stratumd` (`/detach` en la terminal,
`stratum detach <id>`, o `sessions.detach` desde un cliente): mismo id, misma conversación,
mismo contexto del agente (`docs/protocol.md` §18). **Dot no cambia**: ni código nativo, ni
`dot-link`, ni un estado propio.

- **Es la misma sesión.** El cambio llega como un `session.updated` con `host.kind: 'daemon'`
  en el `seq` siguiente, por la misma suscripción: la sesión **no desaparece ni reaparece** de
  la lista, la selección no se pierde y la conversación sigue donde estaba (sale de la foto y
  de `applySessionEvent`, como siempre).
- **El campo de escritura cambia solo**: `composerMode` pasaba a *off* («This session lives in a
  terminal») porque `host.kind` era `peer`; con `daemon`, pasa a *ask* (`runs.start`). La
  etiqueta del anfitrión pasa de `cli (peer)` a `daemon`.
- `detached` sigue significando **perder** al anfitrión (§9 de este documento y
  `docs/protocol.md` §14.3); un traspaso nunca pasa por ese estado.
- Dot no ofrece todavía un botón para traspasar (no es necesario para reflejarlo, y añadirlo
  pasa por la lista blanca de `dot_*` y `MainMethod`).

Tests: `src/protocol/apply.test.ts` (*M10*: el evento de cambio de anfitrión mantiene id,
conversación y run, y el campo pasa a preguntar) y `npm run smoke:detach` (`stratum chat` en un
terminal real + `dot-probe` contra un `stratumd` real: la sesión no sale de la lista durante el
traspaso, no hay `session.closed`/`session.opened`, la foto conserva la conversación y Dot le
escribe ya en el daemon con el contexto de la terminal; cerrar Dot no la toca).

## 16. Un enlace para dos clientes (M12)

Desde M12, Stratum Desktop es un cliente hermano de Dot (`docs/STRATUM_CLIENT_ARCHITECTURE.md` §8,
`docs/protocol.md` §20) y usa **el mismo** `dot-link`, con su propio perfil. Lo que cambia en el
crate, sin cambiar lo que hace Dot:

- **`ClientProfile`** (`link.rs`): `DOT` y `DESKTOP`, cerrados. Cada uno fija `core.hello.client`
  (`dot`/`stratum-dot`, `desktop`/`stratum-desktop`), qué sesiones se siguen y la **lista blanca**
  de métodos (`DOT_METHODS`, `DESKTOP_METHODS`). El perfil solo resta: lo que no está en su lista
  no sale (`invalid`, sin enviar nada); lo que sí, lo decide el daemon. Dot conserva exactamente su
  lista de M9 —ni cerrar ni reconfigurar sesiones—, y su test de arquitectura ahora lo comprueba
  sobre `DOT_METHODS` (antes, sobre que `wire.rs` no nombrara esos métodos: `MainMethod` es ahora
  la lista común y añade `sessions.history|context|memory|close|setModel`, que solo usa Desktop).
- **`FollowPolicy`**: `All` (Dot, como siempre) o `Focused` (Desktop: solo la sesión que se mira
  tiene suscripción `session`; la lista sale de la foto de conjunto, que con
  `forward_overview` se reenvía sin interpretar como `DotEvent::Overview`/`OverviewEvents`).
- `CliLauncher::from_env_var` (`STRATUM_DESKTOP_CLI` para Desktop; Dot sigue con
  `STRATUM_DOT_CLI`) y `Logger::to_file` (`desktop.log`).
- `dot-probe --client desktop` es el enlace de Desktop sin ventana: lo usa
  `stratum-desktop/scripts/smoke-clients.mjs`. `scripts/probe.mjs` acepta `client` y
  `autostart`.
- En el webview, `src/protocol/apply.ts` delega en `followSession`/`classifyEvent` del contrato
  (`stratum-cli/src/protocol/follow.ts`): la misma función que usa Desktop. Sus tests no cambian.

El nombre del crate se queda en `dot-link` (renombrarlo era ruido para el mismo código).

Tests: `cargo test -p dot-link` (añade `tests/desktop.rs`: perfil, seguimiento por foco, lo de
M11, cerrar, la lista blanca de Dot y una orden sin respuesta que no se repite) y todos los de Dot,
sin cambios de comportamiento (`npm run test:run`, `smoke:real`, `smoke:chat`, `smoke:detach`).

## 17. El asistente y su caja (M14)

Dirección en `docs/PRD_STRATUM_DOT.md` §23. Dot es la casa del asistente: el agente embebido
`companion` (`docs/protocol.md` §22), con su memoria y un ordenador propio, la caja
(`docs/protocol.md` §21). Sigue siendo un cliente: el asistente corre en `stratumd`, y la caja la
gobierna el daemon.

- **Vista *Asistente*** (botón *Assistant* de la cabecera; `src/screens/Assistant.tsx`). Al
  abrirse pide `sessions.open { agent: 'companion' }` **sin directorio**: el daemon devuelve la
  sesión del asistente si ya existe (también tras un reinicio) o crea una en el suyo. El id se
  guarda solo en memoria (`uiStore.companionId`); la conversación se pinta con el mismo detalle de
  sesión que la cabina, a partir de su foto. Si la sesión desaparece (se cerró en otro sitio), abrir
  otra es un botón, nunca automático. El asistente es además una sesión más de la cabina.
- **Panel de la caja**: estado (`unavailable`, `absent`, `stopped`, `running`), runtime, imagen,
  red y carpeta compartida (`/exchange`), tal como los contesta el daemon; *Start box*, *Stop box* y
  *Recreate box* cuando quedó desfasada. Lo que se enseña es la respuesta del daemon a la consulta o
  a la orden, nunca un estado supuesto; un arranque sin respuesta queda como «resultado
  desconocido» y no se repite. La primera vez el daemon construye la imagen: puede tardar minutos.
- **Lo que no hay**: borrar la caja (`box.reset` borra su home: se hace desde la CLI, que pide
  teclear el nombre). No está en `MainMethod`, así que ningún cliente del enlace puede enviarlo.
- **Nativo**: `MainMethod::BoxStatus|BoxStart|BoxStop`, solo en `DOT_METHODS` (Desktop no tiene
  caja); `CallAction::BoxStatus|BoxStart|BoxStop`, con arrancar y parar como órdenes que cambian
  algo (sin respuesta, `unknown`) y un plazo propio (`Timings.box_timeout`, 20 min). Comandos
  `dot_box_status`, `dot_box_start` y `dot_box_stop`, registrados como el resto (`lib.rs`,
  `build.rs`, `capabilities/default.json`, test de arquitectura).

Pendiente (fuera de M14): que *Asistente* sea la vista de inicio y el modo compacto (PRD §23.8),
y empezar desde Dot una conversación nueva del asistente (el perfil de Dot no tiene
`sessions.close`).

Tests: `src/app/Assistant.test.tsx`, `la_caja_solo_se_consulta_arranca_o_para_y_solo_desde_dot`
(`crates/dot-link/src/link.rs`), `tests/architecture.test.ts` y, en la ventana real,
`e2e/assistant.e2e.mjs`: abre al asistente sin directorio del cliente, enseña la caja tal como la
contesta el daemon (con un nombre propio y sin arrancarla), conversa con el prompt y las tools del
`companion`, ve vetado sin aprobación un `exec` a `local`, y tras cerrar Dot y reiniciar el daemon
vuelve la misma sesión con su conversación.

## 18. La pantalla de la caja (M15)

Dirección en `docs/PRD_STRATUM_DOT.md` §23.4; contrato en `docs/protocol.md` §21.1.

- **Pantalla en vivo, solo lectura** (*Screen*, en el panel de la caja): con la caja en marcha y con
  escritorio (`box.desktop`), Dot pide `box.screen` cada poco (`SCREEN_POLL_MS`: 1 s mientras el
  asistente la usa, 4 s si no, 15 s con la ventana oculta) y enseña la imagen que contesta el daemon.
  No hay forma de actuar en ella desde Dot (tomar el control queda fuera de M15). Un fallo se dice y
  no deja una imagen inventada.
- **Indicador y *Stop***: «The assistant is using the screen» cuando el run en curso del asistente
  tiene como última llamada una `screen_*` (`usingScreen`, `src/protocol/view.ts`: sale de la foto,
  no hay evento propio). *Stop* cancela ese run (`runs.cancel`, `useRunActions`) y, sin estado
  optimista, queda en «Stopping…» hasta que el daemon publica el run.
- **Visión del modelo**: Dot pide `models.list` y, si el modelo de la sesión del asistente está en la
  lista sin `vision`, avisa de que no puede usar la pantalla y de dónde se declara
  (`providers.<p>.models.<id>.vision`). Un modelo que la lista no trae no se da por «sin visión». En
  *New chat*, el selector marca `· vision`.
- **Nativo**: `MainMethod::BoxScreen` (solo en `DOT_METHODS`), `CallAction::BoxScreen` (consulta: no
  cambia nada; no se anota en el log, porque se pide cada poco) y el comando `dot_box_screen`,
  registrado como los demás. La respuesta cabe en un mensaje del enlace (JPEG ≤ 512 KiB).

Tests: `src/app/Assistant.test.tsx` (*la pantalla de la caja*), `la_caja_solo_se_consulta_arranca_o_para_y_solo_desde_dot`
y `tests/architecture.test.ts`.
