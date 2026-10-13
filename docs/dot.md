# Stratum Dot

Cockpit de escritorio de Stratum: una ventana pequeña y una bandeja desde las que ver qué
sesiones hay, en qué están, pausar, reanudar, cancelar o redirigir sus runs y **conversar con
Stratum**: abrir una sesión en el daemon y hablar con ella.

> **Estado (M7).** Shell nativo con Tauri v2, conectado a `stratumd` por el Stratum Protocol
> v1: descubre el daemon (o lo arranca), observa las sesiones vivas —las del daemon y las que
> publica la CLI—, sobrevive a sus caídas, da cuatro órdenes (`pause`, `resume`, `cancel`,
> `steer`) y, desde M7, **abre sesiones alojadas en el daemon y conversa con ellas** (§12). Sin
> resolver aprobaciones y sin trazas: eso es M8 y posteriores.
> Contrato: `docs/protocol.md`. Producto: `docs/PRD_STRATUM_DOT.md`.

La regla que M7 no rompe:

```text
Dot = cliente        stratumd = plano de control        SessionHost = runtime
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
| `dot-link` | `stratum-dot/crates/dot-link/` | Descubrir, conectar, `core.hello`, suscripciones, reconexión, relevar cuatro órdenes y cuatro llamadas (abrir sesión, iniciar run, listar perfiles y modelos) | Interpretar DTOs, reducir eventos, depender de Tauri |
| Shell | `stratum-dot/src-tauri/` | Ventana, bandeja, instancia única, comandos `dot_*`, emitir `dot://event` | Hablar el protocolo por su cuenta |
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
endpoint, una clave de aprobador, variables de entorno. El token vive en un tipo (`Token`) que
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
| `dot_hide` · `dot_quit` | Ocultar la ventana · salir de Dot |

No existe un `rpc(method, params)` genérico. En Rust, los métodos del protocolo que se pueden
enviar son un `enum` cerrado (`wire::Method`): `core.hello`, `events.subscribe`,
`events.unsubscribe`, `runs.pause`, `runs.resume`, `runs.cancel`, `runs.steer` y, desde M7,
`runs.start`, `sessions.open`, `agents.list` y `models.list`. Siguen fuera, a propósito:
`core.shutdown`, `sessions.close`, `sessions.set*`, `jobs.cancel` y todo lo que exige `approve`.

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

Permisos del webview: `core:default` y nada más. Sin sistema de ficheros, sin shell, sin
diálogos, sin red (CSP `default-src 'self'`).

Lo único que se guarda entre arranques son **preferencias de interfaz**: geometría de la
ventana (`tauri-plugin-window-state`) y, en `localStorage`, la última sesión seleccionada y el
último directorio con el que se abrió un chat. Nunca fotos, estado de un run, **la
conversación**, un borrador, ni credenciales.

## 4. Roles y capacidades

Dot pide **`operator`** (`observe` + `control`) y nada más. No pide `approver` y no manda
ninguna `approverKey`: todavía no hay centro de aprobaciones. Lo que una sesión espera de una
persona se **enseña** («Waiting for a person»), con dónde resolverlo (`stratum approvals`, o su
terminal), y no hay botones de aprobar.

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

Cuando Dot tenga que aprobar (M8), la autoridad de aprobar **no** se mezclará en esta
conexión: será una capacidad aparte, sostenida por el lado nativo (§7).

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
- **Bandeja**: *Open Stratum Dot* · *Sessions: N* (informativo) · *Quit Dot*. Clic izquierdo
  abre la ventana. Ninguna función depende de ella.
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

## 7. Q2 sigue abierta

M6 **no cierra** Q2 (`PRD_STRATUM_DOT.md` §22: verificar la identidad del proceso al otro lado
del canal), y Tauri por sí solo no la arregla: un proceso del mismo usuario sigue pudiendo leer
`endpoint.json` y conectarse como cualquier cliente. Lo que M6 deja es **el sitio**:

```text
webview            nunca ve una credencial
   │
lado nativo        conexión observer/operator  (hoy)
   │               conexión de aprobador, aparte  (M8: clave en el nativo, y comprobación
   ▼                                               del par del pipe, que Rust sí puede hacer)
stratumd
```

Reglas ya vigentes que preparan ese camino: la conexión de Dot pide la mínima autoridad; el
webview no puede pedir un método arbitrario; ningún comando acepta ni devuelve credenciales; y
`dot-link` no sabe nada de aprobar (un test lo fija), de modo que la capacidad de aprobador
tendrá que entrar como una pieza nueva y visible, no como un parámetro más de la que hay.

## 8. Tests

| Qué | Dónde | Cómo se ejecuta |
|---|---|---|
| Framing, descubrimiento, sobre, reglas de entrega, estados | `crates/dot-link/src/*.rs` | `cargo test -p dot-link` |
| El enlace contra un **daemon de pruebas sobre un pipe real**: conectar, arrancar el daemon, huecos, foco, reconexión, órdenes, resultado desconocido, incompatible, cerrar sin tocar nada, el token no sale | `crates/dot-link/tests/link.rs` | ídem |
| Validar y aplicar con el reductor del contrato; pérdida de fragmentos; eventos de un tipo futuro | `src/protocol/apply.test.ts` | `npm run test:run` |
| Del lado nativo a los stores: la foto sustituye, hueco → foto, `detached` | `src/bridge/connect.test.ts` | ídem |
| La interfaz: Pause sin optimismo, steer en pausa, cancel, sin conexión, incompatible, teclado | `src/app/App.test.tsx` | ídem |
| **El chat** (M7): chat nuevo sin sesión fantasma, enviar sin optimismo, fragmentos perdidos, reconexión a mitad de un mensaje, resultado desconocido sin reenvío, preguntar ≠ redirigir, dos chats que no se cruzan, sesión que desaparece, markdown sin HTML | `src/app/Chat.test.tsx` | ídem |
| **Arquitectura** (sobre el código) | `tests/architecture.test.ts` | ídem |
| **Daemon real**, sin ventana: `dot-probe` (el mismo enlace) contra `stratumd`, `stratum run` y una sesión del daemon | `scripts/smoke-real.mjs` | `npm run smoke:real` |
| **Chat contra un daemon real** (M7), sin ventana: abrir, conversar en varios turnos, `BUSY`, cerrar y reabrir Dot, dos chats, convivencia con una sesión de terminal, muerte del daemon | `scripts/smoke-chat.mjs` | `npm run smoke:chat` |
| **La app de verdad**, en su ventana, con tauri-driver | `e2e/dot.e2e.mjs` (M6) · `e2e/chat.e2e.mjs` (M7) | `npm run e2e` |

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
endpoint ni lanza un daemon por su cuenta. Desde M7, además: `dot_open_session` solo acepta
`cwd`, `agent`, `provider` y `model` (ni `env`, ni `resume`), y el lado nativo no toca el
sistema de ficheros por un directorio que le pasen; no existe `sessions.close` ni
`sessions.set*` en Dot; la conversación no se guarda ni se reconstruye en Dot (nadie trata
`message.delta` / `message.completed` por su cuenta, no hay un store de mensajes y lo que se
pinta es `snapshot.messages`); el webview no nombra la configuración de un provider; y no hay
`innerHTML` ni equivalente.

`dot-probe` (`crates/dot-link/src/bin/dot-probe.rs`) es el enlace de Dot con la interfaz
cambiada por líneas JSON: permite probar contra un daemon real sin automatizar una ventana.

## 9. Limitaciones conocidas

- **Sin aprobar, sin contestar preguntas ni decidir planes, sin trazas, sin cerrar sesiones**:
  M8 y posteriores. No hay botones para lo que no existe. Límites propios del chat: §12.8.
- **Sesiones guardadas (*History*)**: el daemon no las lista todavía (`protocol.md` §11); Dot
  no enseña ninguna.
- **Una tool descartada por steering se ve como *Failed***: el protocolo la publica como
  `tool.failed` (`tool.blocked` aún no se emite, `protocol.md` §13.6).
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

Deuda del **protocolo**, no de Dot: `tool.started` se publica antes de ejecutar y `tool.blocked`
no se emite (`protocol.md` §13.6 y §16).

## 10. Convivencia con Stratum Desktop

Dos aplicaciones durante el MVP (`PRD_STRATUM_DOT.md` §9.5). `stratum-desktop` 0.4 —sidecar,
protocolo v9— **no cambia**: M6 no toca ni una línea suya ni de `stratum-cli/src/desktop/`.
Dot usa otro identificador (`dev.stratum.dot`), otro puerto de desarrollo (1421) y no comparte
estado con ella. Lo único que Dot toma de Desktop es su cliente WebDriver de pruebas
(`stratum-desktop/e2e/webdriver.mjs`), que es herramienta de tests, no código de la app. La
convergencia es M12.

## 11. Desarrollo

```bash
cd stratum-cli && npm ci && npm run build      # la CLI que Dot arranca en desarrollo
cd ../stratum-dot && npm ci

npm run test:native      # cargo test -p dot-link
npm run test:run         # vitest (frontend + arquitectura)
npm run smoke:real       # daemon real, sin ventana (M6)
npm run smoke:chat       # chat contra un daemon real, sin ventana (M7)

# La app, contra la CLI recién compilada:
STRATUM_DOT_CLI=../stratum-cli/dist/index.js npm run tauri dev

# E2E de la ventana (tauri-driver + driver nativo, como la suite de Desktop):
npx tauri build --debug --no-bundle && npm run e2e
```

Log de Dot: `dot.log` en la carpeta de logs de la app (`%LOCALAPPDATA%\dev.stratum.dot\logs`,
`~/.local/share/dev.stratum.dot/logs`). Cuenta arranque, descubrimiento, arranque del daemon,
conexión y desconexión, incompatibilidades, reconexiones y resincronizaciones. De una orden o
una llamada, su nombre (`control: pause`, `call: start-run`). Nunca el token, claves, entorno,
el contenido de los eventos, el texto de un mensaje ni el directorio de una sesión.

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
| **El daemon se reinicia** (o muere) | Sus sesiones **desaparecen**: no hay persistencia ni reanudación de sesiones del daemon. Dot enseña «Session ended or unavailable» y no deja escribir. Las de terminal vuelven cuando su proceso se registra otra vez |

La diferencia entre las dos últimas filas es de fondo: **cerrar Dot no es cerrar la sesión; que
muera el daemon, sí.** Una sesión del daemon vive lo que vive el daemon, y Dot no lo disimula.
Un chat nuevo tras el reinicio es otra sesión, sin la conversación anterior.

### 12.7 Aprobaciones, preguntas y planes en el chat

Dot sigue siendo `operator`: **enseña** lo pendiente dentro de la conversación («Waiting for a
person», con qué y dónde resolverlo) y no lo resuelve. Lo que eso supone para un chat abierto
desde Dot es la política de M4, sin relajar:

- Si el daemon **no** acredita aprobadores (no hay `approver.json`), no hay a quién preguntar:
  lo destructivo se **deniega** sin preguntar, las preguntas del agente se contestan con
  supuestos y un plan no se aprueba, como `stratum run` sin terminal.
- Si los acredita, la solicitud queda pendiente —el run pasa a `waiting_approval` o
  `waiting_input`, y el campo sigue siendo de steering— hasta que alguien la resuelve con
  `stratum approvals` o caduca (`daemon.approvalTimeoutMinutes`).

Aprobar desde Dot, con su frontera nativa, es M8 (§7).

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
- **Sin responder** a una pregunta del agente ni decidir un plan (M8).
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
