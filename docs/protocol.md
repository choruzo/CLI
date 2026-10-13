# Stratum Protocol v1

Contrato entre el harness Stratum y sus clientes (CLI, Dot y los que vengan).
Es la referencia: donde discrepe de `docs/PRD_STRATUM_DOT.md` §10–§12, manda este documento.

> **Estado (M5).** Contrato, validación, códec y cliente Node (M1); un servidor, `stratumd`
> (`stratum daemon run`), que aloja sesiones y las sirve a varios clientes (M2); **anfitriones
> pares**: `stratum run` y `stratum chat` publican en él su sesión sin dejar de alojarla (M3,
> §14); y **centro de aprobaciones**: aprobaciones, preguntas y planes se ven y se resuelven
> desde otro cliente, en carrera con el prompt local (M4, §15); y **pausa cooperativa**: un run
> se pausa y se reanuda desde otro cliente, en su runtime real (M5, §16).
> Qué atiende hoy el servidor y con qué garantías: §13 a §16.

| Pieza | Dónde | Depende de |
|---|---|---|
| Tipos, constantes, tablas | `stratum-cli/src/protocol/` (`index.ts`) | nada |
| Validación (Zod) | `stratum-cli/src/protocol/schemas.ts` | `zod` |
| Framing, códec, `RpcPeer` | `stratum-cli/src/ipc/` | Node (`Buffer`) |
| Cliente Node | `stratum-cli/src/client/` | Node (`net`, `fs`) |
| Reductor de fotos | `stratum-cli/src/protocol/reduce.ts` | nada |
| Publicador de una sesión | `stratum-cli/src/host/session-publisher.ts` | el runtime |
| Puente de un anfitrión par | `stratum-cli/src/host/peer-host-bridge.ts` | `client/`, el publicador |
| Servidor (`stratumd`) | `stratum-cli/src/daemon/` | `host/`, `ipc/` |
| Reglas de qué respuestas valen | `stratum-cli/src/protocol/resolve.ts` | nada |
| Decisiones pendientes de una sesión | `stratum-cli/src/host/interactions.ts` | el runtime |
| Centro de aprobaciones | `stratum-cli/src/daemon/approval-center.ts` | `protocol/`, `ipc/` |

## 1. Invariantes

Reglas que no se negocian al implementar los hitos siguientes.

1. **`src/protocol/` es puro.** Sin Node, sistema de ficheros, sockets, `process`, runtime,
   `SessionHost` ni `StratumAgent`. Solo importa de sí mismo (`schemas.ts`, además, `zod`).
   `protocol/purity.test.ts` recorre los imports de forma transitiva y falla si algo sale.
2. **Los DTOs no son los tipos internos.** `ProtocolSession`, `ProtocolRun`,
   `ProtocolApproval`… se construyen campo a campo. Ningún objeto del runtime
   (`StratumConfig`, `ToolContext`, `DecisionRecord`) se serializa «por comodidad».
3. **Sin compatibilidad implícita.** La versión se intercambia en `core.hello`; si no
   coincide, la conexión termina con `PROTOCOL_MISMATCH` antes de cualquier otro método.
4. **Autorización por capacidad.** Cada método exige una. Cancelar, pausar o redirigir
   (`control`) no es aprobar (`approve`).
5. **`sessions.open.env` es de solo entrada.** No está en `ProtocolSession`, ni en snapshots,
   eventos, resultados o errores; no se traza ni se registra. La v1 lo reserva y no lo usa:
   no hay captura automática del entorno.
6. **`seq` por sesión, nunca global.** Sesión A: 1 2 3 4. Sesión B: 1 2 3.
7. **Los fragmentos de texto son volátiles.** Se pueden agrupar y perder; nadie está
   obligado a guardarlos. Se recuperan con una foto o con `message.completed`.
8. **Reconectar no es reintentar.** Una petición enviada y sin respuesta tiene resultado
   **desconocido**. El cliente lo dice y no la reenvía. Al reconectar solo se restablecen
   las suscripciones.
9. **El runtime no espera al IPC.** Publicar lo que hace un agente nunca bloquea al agente:

   ```text
   StratumAgent.observe()
           ↓ síncrono
   cola local acotada
           ↓ asíncrono
   transporte del protocolo
   ```

   Nunca `observe() → socket.write / await`, tampoco de forma indirecta. Lo materializa
   `SessionPublisher` (§13.2), igual para una sesión del daemon que para una de la CLI.
10. **Los errores no filtran el interior.** Sin stack, rutas internas, entorno, config ni
    secretos. El código es para el cliente; el texto, para una persona.

## 2. Transporte y framing

- Named pipe (Windows) o unix socket `0600` (POSIX). **Sin TCP.**
- NDJSON: un mensaje JSON por línea, UTF-8, terminado en `\n`. Es el framing que ya usa el
  sidecar de Desktop (`ipc/framing.ts`, `LineDecoder`).
- Límites: `MAX_UNAUTHENTICATED_MESSAGE_BYTES` = 4 KiB antes del handshake,
  `MAX_MESSAGE_BYTES` = 1 MiB después. Se miden en bytes.
- Una trama mayor que el límite cierra la conexión. El servidor avisa antes con un error
  `FRAME_TOO_LARGE` (`id: null`); el cliente no llega a enviarla (error local con el mismo código).
- Una trama cortada por una desconexión no es un mensaje: se descarta.

## 3. Mensajes

Tienen la **forma** de JSON-RPC 2.0, pero no son compatibles con librerías JSON-RPC: no llevan
`jsonrpc`, no hay lotes y el código de error es una cadena.

```jsonc
{ "id": 7, "method": "runs.get", "params": { "runId": "run_1" } }   // petición
{ "id": 7, "result": { "run": { /* … */ } } }                       // respuesta
{ "id": 7, "error": { "code": "NOT_FOUND", "message": "…" } }       // respuesta de error
{ "method": "events", "params": { /* … */ } }                       // notificación (sin id)
```

- `id`: cadena o número; lo elige quien envía la petición.
- Las respuestas pueden llegar en cualquier orden.
- Los dos extremos envían peticiones: el cliente al servidor, y el servidor a un anfitrión par.
- Sin `params` equivale a `{}`.
- Una notificación desconocida se ignora; un mensaje mal formado con `id` legible recibe
  `INVALID_REQUEST`.

## 4. Handshake

`core.hello` es la primera petición de toda conexión. Hasta que no termina bien, cualquier otro
método contesta `UNAUTHORIZED`.

```jsonc
// →
{ "protocol": 1, "token": "<64 hex>",
  "client": { "kind": "dot", "name": "stratum-dot", "version": "0.1.0" },
  "roles": ["operator", "approver"], "features": [] }
// ←
{ "protocol": 1, "server": { "version": "0.9.0", "platform": "win32" },
  "connectionId": 3, "capabilities": ["observe", "control", "approve"], "features": [] }
```

- Versión distinta → error `PROTOCOL_MISMATCH` con `data.protocol` (la del servidor).
- El cliente comprueba además la versión que devuelve el servidor, y la del endpoint antes
  de conectar (`ProtocolMismatchError` en los tres casos).
- `capabilities` es lo **concedido**, que puede ser menos de lo pedido.
- `approverKey` (opcional, **de solo entrada**): lo que acredita a quien pide el rol
  `approver` (§15.2). No se devuelve en ningún resultado, evento ni error, y no se registra.
  Una clave que no vale rechaza el handshake con `UNAUTHORIZED`; sin clave, el rol `approver`
  se concede sin la capacidad `approve`.
- `features` del servidor: `remote-approvals` si acredita aprobadores (solo entonces algo
  pendiente se puede resolver desde otro cliente).
- Dentro de la v1 solo se añade: campos opcionales, métodos y eventos nuevos, anunciados en
  `features` — **a partir de su congelación** (§17): hasta entonces la v1 se puede corregir.

### Descubrimiento

`~/.stratum/daemon/endpoint.json` — `{ protocol, pid, startedAt, version, ipcPath, token }`.
El cliente solo lo **lee** (`client/discovery.ts`): `found`, `absent`, `stale` (el pid ya no
existe), `invalid` o `incompatible`. Lo publica el daemon (§13.1). El token no se registra.

## 5. Roles y capacidades

| Capacidad | Permite |
|---|---|
| `observe` | Leer: listados, estado, eventos, trazas. Ningún método con efecto |
| `control` | Abrir y cerrar sesiones; iniciar, cancelar, pausar, reanudar y redirigir runs |
| `approve` | Resolver aprobaciones, preguntas y planes |
| `host` | Publicar y gobernar las sesiones que aloja esa conexión |
| `broker` | Capacidades nativas del escritorio (reservado) |

| Rol | Capacidades |
|---|---|
| `observer` | `observe` |
| `operator` | `observe`, `control` |
| `approver` | `observe`, `approve` |
| `host` | `observe`, `host` |
| `broker` | `broker` |

Un cliente pide uno o varios roles. El servidor comprueba **la capacidad del método**, nunca el
rol. Dos reglas al conceder (`daemon/authorize.ts`, único punto):

- **`approve` no sale del token del canal.** Exige una clave de aprobador verificada (§15.2).
- **`host` es excluyente.** Una conexión que pide `host` recibe `observe` + `host` y nada más,
  pida lo que pida y presente lo que presente: alojar una sesión no es gobernar las de otros
  (`control`) ni autorizar lo que la propia pide (`approve`).

```text
host ownership  !=  operator control  !=  approver authority
```

## 6. Métodos

`M` = cambia estado (no se reenvía a ciegas, admite `operationId`).

| Método | Capacidad | M | Notas |
|---|---|---|---|
| `core.hello` | — | | Handshake |
| `core.status` | observe | | |
| `core.shutdown` | control | ✓ | `force?` |
| `agents.list` · `models.list` | observe | | |
| `sessions.list` · `sessions.get` | observe | | `get` devuelve una foto |
| `sessions.open` | control | ✓ | `cwd`, `resume?`, `agent?`, `model?`… y `env?` (reservado, solo entrada) |
| `sessions.close` · `sessions.setModel` · `sessions.setAgent` · `sessions.setReadOnly` | control | ✓ | |
| `runs.list` · `runs.get` | observe | | |
| `runs.start` | control | ✓ | `BUSY` si hay un turno en curso |
| `runs.steer` | control | ✓ | Devuelve `accepted` · `not-accepting` · `empty` · `too-large` |
| `runs.pause` | control | ✓ | Pausa cooperativa (§16). Devuelve `requested` · `already-requested` · `already-paused` · `not-running`. `runId?` como en `runs.cancel` |
| `runs.resume` | control | ✓ | Devuelve `resumed` · `not-paused` · `not-running` |
| `runs.cancel` | control | ✓ | Devuelve `cancelled` · `not-running`. Con `runId`: `STALE_STATE` si ya no es el run en curso |
| `approvals.list` | observe | | Aprobaciones, preguntas y planes pendientes |
| `approvals.resolve` | **approve** | ✓ | `approve` · `deny` · `allow-all`; `phrase?` |
| `questions.answer` · `plans.decide` | **approve** | ✓ | `ALREADY_RESOLVED` si otro llegó antes |
| `jobs.list` | observe | | |
| `jobs.cancel` | control | ✓ | |
| `memory.status` · `memory.decisions` | observe | | |
| `events.subscribe` · `events.unsubscribe` | observe | | Solo cambian el estado de la propia conexión |
| `trace.subscribe` · `trace.unsubscribe` | observe | | |
| `host.register` | host | ✓ | Anfitrión par → servidor. `{ snapshot, pid?, claim? }` → `{ claim }` (§14) |
| `host.publish` | host | ✓ | `{ sessionId, snapshot?, events[] }`. Un hueco de `seq` → `STALE_STATE` |
| `host.unregister` | host | ✓ | Baja de una sesión propia. Repetirla no es un error |
| `host.cancel` · `host.pause` · `host.resume` · `host.steer` | host | ✓ | **Servidor → anfitrión par** |
| `host.resolveApproval` · `host.answerQuestions` · `host.decidePlan` | host | ✓ | **Servidor → anfitrión par**; llevan `by` |

Parámetros y resultados exactos: `protocol/methods.ts` (tipos) y `protocol/schemas.ts` (validación).

`operationId` es un campo opcional de las peticiones mutantes: identifica la operación para
que el servidor reconozca un **reenvío deliberado** y no la aplique dos veces (§13.5). El
cliente sigue sin reenviar nada por su cuenta.

### Notificaciones (servidor → cliente)

| Nombre | Contenido |
|---|---|
| `events` | `{ subscriptionId, events[] }` — uno o varios, en orden |
| `snapshot` | `{ subscriptionId, snapshot }` — sustituye el estado de esa sesión |
| `overview` | `{ subscriptionId, overview }` — foto de conjunto |
| `trace.records` | `{ subscriptionId, sessionId, reset, format, records[] }` |
| `goodbye` | `{ reason }` — el servidor va a cerrar la conexión |

Las notificaciones de una suscripción nunca preceden a la respuesta de su `subscribe`.

## 7. Errores

| Código | Cuándo |
|---|---|
| `PROTOCOL_MISMATCH` | Versiones incompatibles (solo en `core.hello`) |
| `UNAUTHORIZED` | Sin handshake o con un token que no vale |
| `FORBIDDEN` | Falta la capacidad del método (`data.capability`) |
| `INVALID_REQUEST` | El mensaje no es una petición, respuesta ni notificación |
| `METHOD_NOT_FOUND` | El método no existe o no se atiende en ese extremo |
| `INVALID_PARAMS` | Los parámetros no validan (`data.issues`: ruta y motivo, nunca el valor) |
| `NOT_FOUND` | La sesión, el run, la aprobación… no existe |
| `BUSY` | La sesión ya tiene un turno en curso |
| `ALREADY_RESOLVED` | Otro cliente resolvió antes (`data.resolution`) |
| `STALE_STATE` | La petición parte de un estado que ya no es el vigente |
| `FRAME_TOO_LARGE` | Mensaje mayor que el límite (`data.limit`) |
| `UNAVAILABLE` | No se puede atender ahora (servidor apagándose…). Con `data.reason`: `host-unavailable` = el anfitrión par no está conectado o no contestó; `peer-hosted` = eso solo puede hacerlo el proceso que aloja la sesión |
| `INTERNAL_ERROR` | Fallo del servidor. Sin detalle: está en su log |

Solo un `ProtocolError` lanzado a propósito conserva su código y su mensaje. Cualquier otra
excepción de un handler sale como `INTERNAL_ERROR` con un texto fijo (`ipc/codec.ts`).

Errores **del cliente**, que no viajan por el canal:

| Clase | Significado | ¿Reenviar? |
|---|---|---|
| `NotSentError` | No salió (sin conexión, o cancelada antes de enviarla) | Sí, es seguro |
| `UnknownOutcomeError` | Salió y no hubo respuesta: conexión caída, plazo vencido o cancelada | **No** a ciegas si `mutating`: primero leer el estado |
| `ProtocolViolationError` | La respuesta no cumple el contrato | No |
| `ProtocolMismatchError` | Versión incompatible | No: actualizar el lado antiguo |
| `ServerUnavailableError` | No hay servidor (`absent`, `stale`, `invalid`) | Cuando lo haya |

## 8. Eventos

Dos clases, y la diferencia es de contrato (`protocol/events.ts`).

### De estado

Cuentan algo que ocurrió. Llevan `seq`, **monótono y sin huecos dentro de su sesión**, desde 1.
Lo asigna el anfitrión de la sesión. Son los que se reenvían tras una reconexión y por los que
un cliente detecta una pérdida.

```jsonc
{ "type": "tool.completed", "sessionId": "ses_…", "runId": "run_1", "at": 1760000000600,
  "seq": 4, "data": { "call": { /* ProtocolToolCall */ } } }
```

`session.opened` · `session.updated` · `session.closed` · `session.detached` ·
`run.started` · `run.updated` · `run.completed` · `run.failed` · `run.cancelled` ·
`message.completed` · `tool.started` · `tool.completed` · `tool.failed` · `tool.blocked` ·
`subagent.started` · `subagent.completed` · `memory.read` · `memory.write` ·
`context.compressed` · `todo.updated` · `plan.proposed` · `plan.resolved` · `plan.step_updated` ·
`job.started` · `job.ended` · `steering.queued` · `steering.delivered` ·
`approval.requested` · `approval.resolved` · `question.requested` · `question.resolved` ·
`warning` · `error`

### Volátiles

`message.delta` y `reasoning.delta`: el texto del modelo según se genera.

```jsonc
{ "type": "message.delta", "sessionId": "ses_…", "at": 1760000000700,
  "after": 4, "data": { "text": "Voy a " } }
```

- No tienen `seq`. Llevan `after`: el `seq` del último evento de estado anterior.
- El emisor puede **agrupar** varios fragmentos en un `text`.
- El transporte puede **descartarlos** si un cliente va lento.
- **No se reenvían** tras una reconexión.
- Lo perdido se recupera con `partial` (en una foto) o con el `message.completed` que cierra
  cada bloque de texto, que es de estado y trae el texto entero.

Un evento de estado con `after`, o uno volátil con `seq`, no valida.

### Fotos

`ProtocolSessionSnapshot` — `session`, `seq`, `run`, `partial { text, reasoning }`,
`toolCalls`, `subagents`, `todos`, `jobs`, `approvals`, `questions`, `plans`. Quien la recibe
**sustituye** lo que tenía de esa sesión y sigue desde `seq`.

`ProtocolOverviewSnapshot` — sesiones vivas y todo lo pendiente de una decisión.

## 9. Suscripciones

```jsonc
{ "scope": { "kind": "overview" } }
{ "scope": { "kind": "session", "sessionId": "ses_…", "sinceSeq": 41, "volatile": true } }
```

- **`overview`**: recibe una foto de conjunto y después los eventos de `OVERVIEW_EVENT_TYPES`
  de todas las sesiones, cada uno con el `seq` de la suya.
- **`session`**: todo lo de una sesión. La respuesta dice el modo:
  - `replay` — llegan los eventos de estado posteriores a `sinceSeq`;
  - `snapshot` — el hueco no se puede cubrir (o no se dio `sinceSeq`): llega una foto.

Reglas del cliente (`client/subscriptions.ts`):

1. Un evento de estado con `seq` ≤ el último aplicado se descarta (entrega *at-least-once*).
2. Un `seq` que salta en una suscripción de sesión es una pérdida: el cliente cambia la
   suscripción por otra que empieza con foto e ignora lo que llegue hasta recibirla.
3. En `overview` los saltos son normales (solo llegan algunos tipos): solo se deduplica.
4. Un fragmento volátil con `after` menor que el último `seq` aplicado llega tarde y se descarta.
5. Tras reconectar, cada suscripción se reabre sola con su último `seq`.

## 10. Reconexión y resultado desconocido

El cliente reconecta solo, con espera creciente, relocalizando el endpoint en cada intento.
Deja de intentarlo ante `PROTOCOL_MISMATCH`, `UNAUTHORIZED` o `FORBIDDEN`.

Lo que **no** hace:

- No reenvía ninguna petición. Las que estaban en vuelo terminan en `UnknownOutcomeError`.
- No encola peticiones mientras reconecta: fallan en el acto con `NotSentError`.

Ante un `UnknownOutcomeError` de un método mutante (`approvals.resolve`, `runs.start`,
`runs.cancel`, `sessions.open`…), quien llamó tiene que **leer el estado** (`approvals.list`,
`sessions.get`) y decidir, o reenviarla **con el mismo `operationId`** que llevaba (§13.5).

## 11. Qué queda sin hacer

Definido en el contrato y sin implementación tras M5: `trace.subscribe`, reanudar una sesión guardada
(`sessions.open { resume }`) y listar las guardadas, y Dot. Detalle en §13.6.

## 12. Tests de conformidad

| # | Qué fija | Dónde |
|---|---|---|
| 1 | Versión incompatible: error claro antes de cualquier método | `client/conformance.test.ts` |
| 2 | Método desconocido → `METHOD_NOT_FOUND` | `client/conformance.test.ts`, `ipc/peer.test.ts` |
| 3 | Payload inválido → `INVALID_PARAMS`, sin ejecutar el handler | ídem |
| 4 | Trama demasiado grande, en los dos sentidos | `ipc/framing.test.ts`, `client/conformance.test.ts` |
| 5 | Desconexión a mitad de trama: nada a medias se entrega | ídem |
| 6 | Dos peticiones concurrentes con respuestas fuera de orden | `ipc/peer.test.ts`, `client/conformance.test.ts` |
| 7 | Una notificación sin `id` no se toma por respuesta | ídem |
| 8 | Petición y respuesta correlacionadas | ídem |
| 9 | Un cliente lento no rompe el decoder (byte a byte, multibyte partido) | `ipc/framing.test.ts`, `client/conformance.test.ts` |
| 10 | Reconectar no reenvía peticiones mutantes | `client/conformance.test.ts` |
| 11 | Los tipos públicos no alcanzan Node, ni de forma transitiva | `protocol/purity.test.ts` |
| 12 | `env` no aparece en ningún DTO serializable | `protocol/schemas.test.ts` |

Además: sin handshake no se atiende nada; cancelar no da derecho a aprobar (`FORBIDDEN`); un
error del servidor no trae stack ni rutas; las suscripciones deduplican, detectan huecos y se
restablecen al reconectar.

El servidor de esos tests (`client/testing/fake-server.ts`) habla el protocolo de verdad sobre
un pipe real, pero **no es un daemon**: no aloja sesiones ni guarda estado. El daemon tiene
los suyos en `src/daemon/*.test.ts`, contra un `Stratumd` real con clientes reales.

## 13. El servidor: `stratumd` (M2)

`stratum daemon run | start | stop | status`. Un proceso que aloja sesiones (cada una con su
`SessionHost`, la misma pieza que usa `stratum run`) y las sirve a varios clientes a la vez.

### 13.1 Ciclo de vida y dueños

| De quién es | Qué | Quién lo cierra |
|---|---|---|
| Una sesión | Su agente, tools, servers MCP, jobs, SSH, auditoría y traza | `sessions.close` → `SessionHost.dispose()` |
| El proceso | El canal, `endpoint.json` y el runtime global de ejecución | Solo el apagado del daemon |
| Un cliente | Nada | — |

- **Cerrar una sesión no es cerrar el proceso.** `sessions.close` desmonta lo de esa sesión y
  nada más; las demás siguen con sus jobs, su SSH y sus servers MCP. El cierre global
  (`closeExecRuntime()`) solo ocurre al apagar el daemon.
- **Un cliente que se va no cambia nada.** Tampoco el que abrió la sesión: sesión y run siguen.
- **`endpoint.json`** se crea de forma atómica y exclusiva, con el servidor ya escuchando; el
  nombre del canal y el token son nuevos en cada arranque; la carpeta va en `0700` y el fichero
  en `0600`; al apagar se borra solo si sigue siendo el de ese proceso.
- **Instancia única.** Si el endpoint publicado tiene dueño vivo —su pid existe **y** alguien
  escucha en su canal—, un segundo arranque falla y no toca nada. Si no, es **rancio** (un
  `kill -9`, un pid reutilizado, un fichero ilegible) y se sustituye. Queda una ventana de
  milisegundos entre dos arranques simultáneos sobre un endpoint rancio: el que pierde lo ve al
  releer el fichero y se retira.
- **Apagado.** `core.shutdown` contesta `BUSY` con runs en curso salvo `force`. El orden es:
  cada sesión por su camino (`session.closed` con `server-shutdown`) → `goodbye` a los
  clientes → retirar el endpoint → cierre global del proceso.
- **Inactividad** (`daemon.idleExitMinutes`, `0` = nunca): el daemon solo se apaga solo sin
  sesiones vivas **y** sin operaciones en curso. Que no haya clientes conectados no cuenta.

### 13.2 De la sesión al cliente

```text
StratumAgent.observe()
        ↓ síncrono: traducir, numerar, actualizar el estado
cola local de la sesión (acotada)          SessionPublisher
        ↓ asíncrono
RunRegistry (proyección) + EventHub (buffer por sesión)
        ↓
cola por suscripción (acotada)
        ↓ solo mientras el cliente admite datos
socket
```

- **El `seq` lo pone el anfitrión de la sesión** (`SessionPublisher`) y nadie lo cambia. El
  bus guarda, reparte, filtra y detecta huecos; no numera. No hay contador global.
- **`RunRegistry` es una proyección** de esos eventos, en memoria. No decide nada, no se
  guarda en disco y se rehace desde los snapshots de las sesiones.

**Qué pasa cuando una cola se llena.** Nunca se bloquea al runtime ni crece sin límite:

| Cola | Volátil | Estado |
|---|---|---|
| Local de la sesión | Se descarta | Si no cabe: se vacía y se avisa a quien recibe, que resincroniza con una foto |
| De una suscripción | Se agrupa; si no basta, se descarta | Si no cabe: la suscripción queda **desincronizada** |

Una suscripción desincronizada se vacía y, cuando el cliente vuelve a admitir datos, recibe
una notificación `snapshot` por esa misma suscripción —sin pedirla— y sigue desde su `seq`.
El cliente **sustituye** su estado: no hay «fusión como se pueda». Lo mismo ocurre si el
anfitrión perdió eventos (un hueco de `seq` a la entrada del bus).

Un cliente que ni siquiera lee las respuestas (más de 16 MiB pendientes) pierde la conexión.

### 13.3 Qué representa una foto

> Un snapshot contiene el estado de la sesión **después de aplicar todos los eventos de estado
> hasta `seq = N`**, incluido ese, y ninguno posterior.

El cliente hace `replace(snapshot); lastSeq = N` y el siguiente evento de estado que aplica es
`N + 1`. Un evento con `seq ≤ N` que llegue después se descarta; un fragmento volátil con
`after < N`, también. Es así porque el estado se actualiza en el mismo paso síncrono que
numera cada evento.

Una foto es **un** mensaje y tiene que caber en una trama: lleva las últimas 100 llamadas a
tools y 50 subagentes del run, con sus textos recortados (1 000 caracteres). El detalle
completo viajó en los eventos y está en la traza.

`events.subscribe` con `sinceSeq`: si todo lo posterior sigue en el buffer del servidor
(`daemon.eventBuffer`, 2 000 eventos de estado por sesión) el modo es `replay`; si no —o si
`sinceSeq` es mayor que el último `seq` conocido, que es un cliente de otra vida del
servidor—, `snapshot`.

### 13.4 Entorno y configuración de una sesión del daemon

- **Config**: se carga desde el `cwd` de la sesión, como haría la CLI en ese directorio.
  Provider y modelo se resuelven sin preguntar (`host/session-startup.ts`): con varios modelos
  y ninguno elegido, `sessions.open` falla listándolos.
- **Entorno**: una **copia del entorno del daemon tomada al arrancar**. No es el de ningún
  cliente: `sessions.open.env` sigue reservado, se acepta y no se usa. Reproducir el entorno
  de una terminal es M10.
- **Servers MCP**: nacen en el `cwd` de la sesión.
- **Sin interlocutor**: hasta M4 una sesión del daemon no tiene a quién preguntar. Lo que
  pediría confirmación se deniega, las preguntas se contestan con supuestos y un plan no se
  aprueba, como `stratum run` sin terminal.

### 13.5 `operationId`

Para una petición mutante que lo trae:

| Caso | Resultado |
|---|---|
| Mismo cliente, mismo `operationId`, misma petición | El resultado ya conocido (o el mismo error), sin ejecutar otra vez. Si sigue en curso, se espera a la misma |
| Mismo cliente, mismo `operationId`, otra petición | `INVALID_PARAMS` (`issues[0].path = "operationId"`) |
| `operationId` desconocido | Se ejecuta |

Límites: vive **en memoria** (un reinicio del daemon lo olvida), hasta 1 000 operaciones
durante 10 minutos cada una; el «cliente» es lo que la conexión declaró ser (`kind` + `name`),
así que sobrevive a una reconexión pero no es una identidad verificada: evita duplicados
accidentales, no es una medida de seguridad. Un `INTERNAL_ERROR` no se recuerda.

### 13.6 Métodos atendidos

| Respuesta | Métodos |
|---|---|
| Atendido | `core.*` · `agents.list` · `models.list` · `sessions.list` (solo vivas) · `sessions.get` · `sessions.open` · `sessions.close` · `sessions.set*` · `runs.list` · `runs.get` · `runs.start` · `runs.steer` · `runs.cancel` · `runs.pause` · `runs.resume` (§16) · `approvals.list` · `approvals.resolve` · `questions.answer` · `plans.decide` (§15) · `jobs.*` · `memory.*` · `events.*` |
| `UNAVAILABLE` | `sessions.open { resume }` |
| `METHOD_NOT_FOUND` | `trace.*` (y `host.*` hasta M3: ver §14) |

Capacidades que se conceden: `observe`, `control`, `host` y, **solo con una clave de aprobador
verificada**, `approve` (§5, §15.2). `broker` sigue sin concederse.

Eventos que **no** se emiten todavía: `tool.blocked` (la decisión no viaja como evento del
turno) y `session.detached`, que no lo emite nadie (§14.3). `ProtocolRun.counters.llmCalls` y
`.blocked` valen 0: no se estiman.

`memory.write` lleva la sesión que **intentó** guardar, no la del registro: con dedup, el
registro que queda puede ser de otra sesión.

## 14. Anfitriones pares: la CLI publica su sesión (M3)

`stratum run` y `stratum chat` siguen ejecutándose **en su proceso**. Si hay un `stratumd`,
publican en él su sesión, que aparece y se comporta como cualquier otra del protocolo:

```text
terminal → sesión → SessionPublisher → PeerHostBridge ── host.publish ──▶ stratumd
                                                      ◀── host.cancel / host.steer ──
```

El daemon es plano de control. El runtime, sus jobs, sus servers MCP, su SSH, su memoria, su
traza y su entorno son de la CLI, y de ellos al daemon solo llegan DTOs del protocolo.

### 14.1 Una sola pieza, dos destinos

Una sesión del daemon y una de la CLI usan **el mismo** `SessionPublisher`; solo cambia a dónde
entrega (`PublisherSink`): el bus del daemon, o el puente (`host/peer-host-bridge.ts`) que lo
envía por `host.publish`. El `seq` lo sigue poniendo el anfitrión —aquí, la CLI— y el daemon lo
conserva: comprueba que es consecutivo y nada más. Un test de arquitectura fija que no hay otro
publicador, que el puente no numera ni desmonta nada y que `src/daemon/` no construye eventos.

El puente no guarda estado de la sesión: tiene la conexión, una cola de salida acotada y lo
necesario para reclamar la sesión al reconectar.

### 14.2 Registro, publicación y huecos

| Paso | Qué viaja | Qué hace el servidor |
|---|---|---|
| `host.register` | La **foto** actual (`snapshot`), el `pid` del proceso y, si vuelve, su `claim` | Crea la proyección (o la devuelve a su anfitrión) y contesta con el `claim` |
| `host.publish` | Eventos en orden; opcionalmente una foto, que va antes | Comprueba, aplica a la proyección y reparte |
| `host.unregister` | — | Descarta la proyección |

- Una sesión se registra normalmente con `seq` 0, antes de su primer evento: `session.opened`
  es su evento 1, como en una sesión del daemon. Si el daemon aparece después, se registra con
  la foto del `seq` por el que vaya.
- **Validación**: todo evento es de esa sesión; un `session` o un `run` dentro de un evento
  también, y un `runId` no puede ser el de otra sesión; `host.kind` es `peer`; un id que ya es
  de una sesión del daemon no se puede registrar. Lo que no cumple es `INVALID_PARAMS` y no se
  aplica nada del lote.
- **Huecos**: si un evento de estado no es el siguiente (`seq + 1`), el lote entero se rechaza
  con `STALE_STATE` (`data.reason: 'seq-gap'`). El servidor no rellena ni renumera: el
  anfitrión contesta publicando una foto, que **sustituye** la proyección, y sigue desde ella.
  Los repetidos (`seq` ≤ el último) se ignoran.
- **Contrapresión**: el puente tiene una sola `host.publish` en vuelo y una cola acotada. Si se
  llena, descarta lo volátil; si no basta, la vacía y lo siguiente que envía es una foto. Sin
  conexión no encola nada. El agente nunca espera al daemon.
- **Órdenes y eventos no se estorban**: cada petición va con su id. Un `host.cancel` no espera
  detrás de lo que el anfitrión esté publicando.

La proyección es la última foto del anfitrión, puesta al día con `applySessionEvent`
(`protocol/reduce.ts`): el lado consumidor del contrato de las fotos, puro, el mismo que usará
un cliente para pintar una sesión a partir de sus eventos. No decide ni numera; `partial` es
aproximado mientras un bloque de texto está abierto, y `session.context` / `session.tokens`
solo cambian con cada `session.updated`.

### 14.3 Propiedad, desconexión y vuelta

- **Una sesión es de la conexión que la registró.** Otra conexión con capacidad `host` no puede
  publicar en ella, darla de baja ni registrarla (`FORBIDDEN`), aunque conozca su id. No
  sustituye a la identidad del proceso (PRD §22 Q2): aísla dentro de un canal ya autenticado.
- **`host` no es `control` ni `approve`.** Un anfitrión no puede cancelar, redirigir ni cerrar
  nada por el protocolo, tampoco lo suyo: eso lo hace en su proceso.
- **Perder al anfitrión no cierra la sesión.** Queda con `host.connected: false` y
  `state: 'detached'`; **su run no se toca** (puede seguir en marcha: lo que falta es
  visibilidad, no un resultado) y sigue contando como run en curso.
- **El daemon no numera eventos propios.** Lo que él sabe —que el anfitrión se fue, que volvió,
  que la proyección se descarta— llega a los clientes como una **foto** (`snapshot` a quien
  sigue la sesión, `overview` a quien sigue el conjunto), que sustituye su estado. Por eso
  `session.detached` no se emite.
- **Vuelta**: el anfitrión reconecta, se registra con su `claim` y su foto actual, y la foto
  manda. Sin el `claim` correcto no se puede reclamar una sesión sin anfitrión (`FORBIDDEN`);
  con una foto anterior a lo ya conocido, tampoco (`STALE_STATE`). Lo ocurrido mientras tanto
  **no se reenvía**. Si el que volvió es el daemon (otro proceso, sin memoria de la sesión),
  es un registro nuevo con el `seq` por el que vaya la CLI.
- **Sin anfitrión no para siempre**: la proyección se descarta cuando se confirma que el proceso
  (`pid`) murió, o a los `daemon.detachedTtlMinutes` (10; `0` = sin plazo) si no se puede saber.
  Los clientes reciben una última foto con la sesión `closed`, y su run queda `interrupted`.
- **Cierre normal**: la CLI publica `session.closed` (su último evento), se da de baja y cierra.

### 14.4 Control remoto

| Petición del cliente | Sobre una sesión par |
|---|---|
| `runs.cancel` | Se reenvía (`host.cancel`): contesta el runtime — `cancelled`, `not-running`, o `STALE_STATE` |
| `runs.steer` | Se reenvía (`host.steer`): contesta la Runtime Inbox — `accepted` · `not-accepting` · `empty` · `too-large` |
| `runs.pause` · `runs.resume` | Se reenvían (`host.pause` · `host.resume`): contesta el controlador de pausa del runtime (§16) |
| `sessions.get` · `jobs.list` · `events.subscribe` | Desde la proyección |
| `runs.start` · `sessions.close` · `sessions.set*` · `jobs.cancel` | `UNAVAILABLE`, `reason: 'peer-hosted'` |

El daemon no simula ningún resultado. Sin anfitrión conectado, o si no contesta en 5 s, la
respuesta es `UNAVAILABLE` con `reason: 'host-unavailable'`.

Las confirmaciones, preguntas y planes de una sesión de la CLI se siguen resolviendo en su
terminal, como antes: el centro de aprobaciones es M4.

### 14.5 La CLI nunca depende del daemon

- Sin daemon, con un `endpoint.json` corrupto o rancio, con otra versión del protocolo, con el
  token rechazado o con cualquier error de `host.*`, `stratum run` y `stratum chat` hacen lo
  mismo que antes. Publicar es una mejora, y ningún fallo de esa ruta llega al turno.
- Si el daemon muere a mitad de un run, el run sigue; el puente vuelve a buscarlo (cada 0,5–5 s,
  sin retener el proceso) y, cuando lo hay, registra la sesión otra vez.
- `daemon.autoStart` (default `false`): con `true`, la CLI arranca el daemon si no hay ninguno,
  **una vez** y con plazo; si no arranca, sigue sin él. Con `false` solo publica si ya existe.
- `STRATUM_NO_DAEMON=1` desactiva la publicación. `stratum eval` lo pone a sus escenarios.

### 14.6 `stratum ps`

`stratum ps [--json] [--watch]`: cliente `observer` (`sessions.list`, `runs.list`, suscripción
`overview`). Columnas `SESSION · HOST · STATE · AGENT · MODEL · CWD · RUN`; `HOST` es `daemon` o
el tipo de cliente que la aloja (`cli`). `--json` devuelve los DTOs del protocolo.

### 14.7 Limitaciones conocidas

- Las aprobaciones, preguntas y planes de una sesión de la CLI se resuelven también desde otro
  cliente (§15). `stratum run` **sin terminal** sigue denegando lo destructivo.
- En `chat`, un cambio de modelo, perfil o read-only se publica al cerrar el turno siguiente, y
  `/sessions resume` en caliente no cambia el id con el que la sesión ya está publicada.
- `stratum init` no se publica.

### 14.8 Tests

`daemon/peer-host.test.ts` (daemon real + `SessionHost` con su puente, sobre el pipe):
equivalencia entre una sesión del daemon y una par, caída y vuelta del daemon, muerte de la
CLI, dos anfitriones, control remoto, sin daemon, `autoStart`, huecos y cola acotada.
`cli/commands/peer.integration.test.ts` lo repite con procesos reales (`daemon start`,
`stratum run`, `stratum ps`, `daemon stop --force`). `scripts/tui/daemon-peer.mjs` hace lo
mismo con `stratum chat` en un terminal real.

## 15. Aprobaciones, preguntas y planes (M4)

Lo que una sesión pide a una persona —confirmar una operación, contestar una tanda de
preguntas, decidir un plan— deja de vivir solo en la terminal que la aloja: se publica, se
lista y se puede resolver desde otro cliente. Tres reglas lo gobiernan todo:

```text
1. Una solicitud se resuelve UNA vez. Gana la primera respuesta válida.
2. Alojar una sesión, o poder cancelarla, no da autoridad para aprobar lo que pide.
3. El centro arbitra una decisión; quien ejecuta, o no, es el runtime de la sesión.
```

### 15.1 Dónde vive cada cosa

```text
                          anfitrión de la sesión                        stratumd
 runtime ── puerta ──▶ PendingInteractions ── eventos (su seq) ──▶ ApprovalCenter ◀── approvals.list
              ▲          ▲   ▲   ▲                                      │
              │  prompt  │   │   └─ cancelación del turno / cierre      │ approvals.resolve
              │  local ──┘   └───── plazo                               │ questions.answer
              │                                                         │ plans.decide
              └──────────── decisión ◀── ruta de la sesión ◀────────────┘
                                         · alojada en el daemon: llamada directa
                                         · par: host.resolveApproval / answerQuestions / decidePlan
```

- **`PendingInteractions`** (`host/interactions.ts`) está en el proceso que aloja la sesión,
  porque ahí está la promesa que espera el runtime. Es **una** pieza para los tres tipos
  (`approval`, `question`, `plan`) con un ciclo de vida común: `pending` → `resolved` |
  `expired` | `cancelled`. Prompt local, respuesta remota, plazo y cancelación compiten sobre
  ese único estado; `settle` comprueba y cambia en un paso síncrono, así que de dos respuestas
  simultáneas la segunda no cambia nada. Al resolverse, la señal de la solicitud se aborta: el
  prompt local se retira.
- **`ApprovalCenter`** (`daemon/approval-center.ts`) es el único sitio del daemon por el que se
  resuelve algo. Guarda una **proyección** de lo pendiente de todas las sesiones (lo que cuentan
  sus anfitriones: eventos y fotos), comprueba quién puede contestar, serializa los intentos
  sobre una misma solicitud y entrega la decisión por la ruta de la sesión. **No ejecuta tools,
  no numera eventos y no decide por su cuenta.**
- El **runtime** no sabe quién contestó: espera la promesa de su puerta (`HostGates`), y
  sigue —ejecuta la tool o la deja sin ejecutar— cuando se resuelve.

Para una sesión **par**, la última palabra es del anfitrión: su prompt local compite con lo
que el daemon le reenvía y él dice quién llegó antes. El daemon solo da una solicitud por
resuelta cuando el anfitrión lo confirma —con la respuesta a la entrega, o con su evento
`*.resolved`—. Si el anfitrión no está o no contesta: `UNAVAILABLE` (`reason:
'host-unavailable'`), y la solicitud **sigue pendiente**. No se inventa un resultado.

### 15.2 Quién puede resolver

| Quién | `approvals.resolve` / `questions.answer` / `plans.decide` |
|---|---|
| `observer` | `FORBIDDEN` (ve lo pendiente con `approvals.list`) |
| `operator` | `FORBIDDEN` (puede cancelar el run; aprobar es otra capacidad) |
| `host` | `FORBIDDEN`, también sobre la sesión que aloja |
| `approver` **sin** clave | `FORBIDDEN`: el rol se concede sin `approve` |
| `approver` con clave verificada | Sí. Y `runs.cancel` → `FORBIDDEN` |

**La clave de aprobador.** El token de `endpoint.json` autentica el acceso al canal; con él
solo, ninguna conexión obtiene `approve`. Hace falta además una frase que elige la persona
(`stratum approvals set-key`) y que teclea en cada cliente que quiera aprobar:

- En disco solo hay una derivación `scrypt` con sal (`~/.stratum/daemon/approver.json`,
  `0600`). Quien lea el fichero no obtiene la clave.
- No se pasa por argumentos ni por variables de entorno, no está en el workspace, no se
  registra, no llega a ninguna tool y no viaja en ningún evento. `stratum approvals` la pide
  por la terminal, sin eco, y se niega a funcionar sin una.
- El daemon la carga **al arrancar**. Sin fichero —o con uno que no valida: falla cerrado— no
  hay aprobadores: `features` no anuncia `remote-approvals`, nada se resuelve en remoto y todo
  se contesta donde siempre, en la terminal del anfitrión.
- **Freno contra quien prueba claves, sin bloqueo global.** Cada conexión tiene un solo
  intento (un fallo rechaza el handshake y la cierra); las comprobaciones van de una en una,
  en orden de llegada, así que el ritmo de prueba es el de la derivación scrypt por muchas
  conexiones que se abran; y el fallo se contesta con 1 s de retraso que espera solo la
  conexión que falló. **Que alguien falle no le quita a nadie la posibilidad de aprobar.** Lo
  que queda: quien tiene el token del canal puede llenar esa cola y retrasar unos segundos el
  handshake de un aprobador legítimo (la cola no pasa del número de conexiones admitidas); no
  puede impedirlo. El freno no sustituye a una clave que no sea adivinable.
- La clave vive lo que dura el saludo: el servidor la comprueba y no la guarda en la conexión;
  `stratum approvals` la borra de su cliente al terminar el handshake. No está en `argv` ni en
  el entorno de ningún proceso, así que un proceso hijo —el `exec` de una sesión, por ejemplo—
  no la hereda. Tampoco el token del canal: no se pone en el entorno de nadie.

**Una solicitud es de la sesión que la abrió.** Un anfitrión no puede publicar una solicitud a
nombre de otra sesión (`INVALID_PARAMS`), y si publica una con el id de una ajena el centro la
ignora. Un `*.resolved` fabricado solo cierra lo que estaba **pendiente y era de la sesión que
lo publica**: para una solicitud de otra sesión, una ya resuelta o una que nunca existió no
cambia nada — ni lo pendiente, ni el recuerdo de cómo acabó (`ALREADY_RESOLVED` sigue diciendo
la resolución real). De su propia sesión, en cambio, el anfitrión es la autoridad: ahí vive
la promesa, y su `*.resolved` es la resolución local.

**`pid` y `claim` no son credenciales de aprobación.** El `pid` que declara un anfitrión es una
pista de ciclo de vida (¿murió o puede volver?); el `claim`, la propiedad de la *publicación* de
una sesión. Ninguno de los dos interviene, ni directa ni indirectamente, en quién puede
resolver: `ApprovalCenter` no los conoce (lo fija `daemon/architecture.test.ts`).

### 15.3 Modelo de amenaza: lo que esto cierra y lo que no

La amenaza que introduce un endpoint de aprobaciones:

```text
agente ─▶ exec ─▶ un cliente / el socket / endpoint.json ─▶ approvals.resolve ─▶ se aprueba a sí mismo
```

Capas, de fuera adentro:

1. **Reparto de capacidades.** Con lo que un comando del agente tiene a mano —el token del
   canal— se puede pedir cualquier rol, y ninguno aprueba: falta la clave. Es lo que
   comprueban los tests adversariales (`daemon/approvals.test.ts`, `npm run tui:approvals`).
2. **Guardas de shell** (`tools/guards.ts`, *best-effort*): `~/.stratum/daemon/` es ruta
   bloqueada para las tools de fichero y para el shell, y `stratum approvals | daemon | attach`
   se vetan en `preflight` cuando los lanza el agente (también envueltos o vía `node`/`npx`).
3. **Sin terminal no hay clave.** `stratum approvals` no la acepta por otra vía, y `exec` local
   no tiene PTY.
4. **Rastro.** Cada resolución lleva `resolvedBy` en su evento, en la traza de la sesión y en
   `exec-audit.jsonl`: una aprobación que no dio la persona es visible.
5. **Lo inapelable no pasa por aquí.** Un `block` o un veto de `preflight` no genera una
   solicitud: el daño máximo es lo que una persona podría aprobar.

> **Lo que no se afirma.** La separación de capacidades evita los caminos accidentales y
> ordinarios de auto-aprobación, pero **un proceso arbitrario que corre como el mismo usuario
> del sistema sigue dentro del mismo dominio de confianza**. Puede sustituir `approver.json` y
> reiniciar el daemon, leer la memoria del proceso en el que la persona teclea la clave, o
> depurar el propio anfitrión. Los permisos `0600`, el token y la clave **no son un sandbox**:
> protegen frente a otros usuarios y frente al camino obvio, no frente a código hostil con la
> cuenta del usuario. Cerrarlo de verdad exige identidad del proceso par verificada por el
> sistema operativo (`SO_PEERCRED`, `GetNamedPipeClientProcessId`: no disponibles en Node puro)
> o aislar `exec`. Queda como endurecimiento posterior (PRD §22 Q2).

Consecuencia práctica de lo anterior, y política por defecto: **sin clave de aprobador
configurada, la resolución remota está denegada**. Se prefiere eso a una garantía falsa.

### 15.4 Ciclo de vida y eventos

Los publica el anfitrión de la sesión, con su `seq`. El daemon no numera nada.

| Evento | Cuándo | Datos |
|---|---|---|
| `approval.requested` | El runtime pide confirmar una operación | `approval` (`ProtocolApproval`, `status: 'pending'`) |
| `approval.resolved` | Deja de estar pendiente | `approvalId`, `status` (`approved` · `denied` · `expired` · `cancelled`), `decision`, `resolvedBy` |
| `question.requested` / `question.resolved` | Tool `question` | `request` / `requestId`, `answers` (o `null`), `status`, `resolvedBy` |
| `plan.proposed` / `plan.resolved` | `present_plan`, o un entorno con `requirePlan` | `request` / `requestId`, `decision`, `plan`, `status`, `resolvedBy` |
| `run.updated` | El run empieza o deja de esperar | `status`: `waiting_approval` (aprobación o plan) · `waiting_input` (preguntas) · `running` |

`resolvedBy` es `{ kind, client?, connectionId?, at }`, con `kind`:

| `kind` | Qué pasó |
|---|---|
| `local` | Contestó la persona en la terminal del anfitrión |
| `remote` | Un cliente con `approve`, a través del daemon (`client` y `connectionId` son los suyos) |
| `timeout` | Nadie contestó a tiempo: equivale a denegar / omitir / rechazar |
| `policy` | No había a quién preguntar y se resolvió sin preguntar |

Una solicitud **cancelada** (se canceló el turno, se cerró la sesión) no lleva `resolvedBy`: no
la resolvió nadie. `status` distingue `resolved` de `expired` y `cancelled` en preguntas y
planes; ausente equivale a `resolved`.

La foto de una sesión lleva `approvals`, `questions` y `plans`, y su `session.state` es
`waiting` mientras haya algo pendiente. `approvals.list` y la suscripción `overview` dan lo
pendiente de todas las sesiones; `core.status.pendingApprovals`, el recuento.

**Lo que viaja de una aprobación** es lo que hace falta para decidir: sesión, run, tool,
descripción ya redactada, target, entorno, si es forzada, si pide frase, cuándo se pidió y
cuándo caduca. Nunca los parámetros crudos de la tool, la config ni el entorno.

### 15.5 Qué respuestas valen

Reglas puras (`protocol/resolve.ts`) que aplican igual el daemon —para no reenviar lo que no
puede valer— y el anfitrión, que es la autoridad. Una respuesta que no vale contesta
`INVALID_PARAMS` y **no resuelve nada**: la solicitud sigue pendiente.

- **Aprobación.** `deny` vale siempre. `allow-all` no vale para una solicitud `forced`
  (política `confirm-always`) ni para una con `confirmPhrase`: se aprueban de una en una. Con
  `confirmPhrase`, aprobar exige `phrase` exactamente igual. `allow-all` cubre el resto de esa
  sesión —no es global ni sobrevive a un reinicio—, nunca lo forzado, y queda auditado.
- **Preguntas.** `answers: null` omite la tanda. Si no, una respuesta por pregunta; con
  opciones, por su `optionId` o por una etiqueta que coincida con una sola. El texto libre
  solo vale si la pregunta no tiene opciones o declara `allowCustom`. Nada se aproxima.
- **Plan.** `approve` | `reject`. Aprobar sin `plan` aprueba el propuesto; con `plan`, la
  versión editada (al menos un paso).

### 15.6 Plazos

| Dónde vive la sesión | Prompt local | Plazo |
|---|---|---|
| En el daemon | No hay | `daemon.approvalTimeoutMinutes` (10); al vencer, `expired` → denegar / omitir / rechazar |
| En la CLI, con terminal | Sí | **Ninguno** (`expiresAt: null`): nadie corta una operación porque la persona tarde en leerla |
| En la CLI, sin terminal ni aprobadores | No | No se pregunta: lo destructivo se bloquea, como antes |

Una sesión del daemon solo pregunta si el daemon acredita aprobadores; si no, se comporta como
`stratum run` sin terminal (política `deny`, también en un entorno `allow`).

**`stratum run` sin terminal deniega siempre**, haya o no un daemon con aprobadores: ese
default no cambia. Una automatización que quiera aprobación remota (CI que espera a una
persona) tendrá que pedirlo con una opción explícita, que hoy no existe. Lo fija un test.

### 15.7 Cancelación, cierre y desconexión

- **`runs.cancel` con algo pendiente**: la solicitud pasa a `cancelled`, la puerta devuelve su
  respuesta negativa, el prompt local se retira y **la tool no se ejecuta**. Una respuesta que
  llegue después recibe `ALREADY_RESOLVED`.
- **Cerrar la sesión**: lo mismo con todo lo que tuviera pendiente. Ninguna promesa queda
  colgada y nada suyo sigue en `approvals.list`.
- **El anfitrión par se desconecta**: no se resuelve nada. La sesión queda `detached`, sus
  aprobaciones siguen listadas con `resolvable: 'origin'` (solo se pueden contestar en su
  terminal) y resolverlas en remoto contesta `UNAVAILABLE`. Si vuelve, su foto manda. Si la
  proyección se descarta (su proceso murió, o venció `daemon.detachedTtlMinutes`), sus
  solicitudes desaparecen con ella.
- **Un aprobador lento** no frena a nadie: recibe sus eventos por la cola acotada de su
  suscripción (§13.2), y el runtime, el prompt local y los demás aprobadores no esperan por él.

### 15.8 `stratum approvals`

Cliente de texto del centro de aprobaciones.

| Comando | Rol | Qué hace |
|---|---|---|
| `stratum approvals [list] [--json]` | `observer` | Lo pendiente de todas las sesiones |
| `stratum approvals approve <id> [--all]` | `approver` | Aprueba una aprobación o un plan; pide la frase si la hay. `--all` = `allow-all` |
| `stratum approvals deny <id>` | `approver` | Deniega, rechaza el plan u omite las preguntas |
| `stratum approvals answer <id>` | `approver` | Contesta una tanda de preguntas |
| `stratum approvals set-key` | — | Fija la clave de aprobador (hay que reiniciar el daemon) |

### 15.9 Tests

`host/interactions.test.ts` (la carrera, sin daemon), `daemon/approvals.test.ts` (daemon real,
sesiones alojadas y pares: roles, doble resolución, local contra remoto, cancelación, cierre,
desconexión, plazo, `confirm-always`, lo que no sale en los logs, y el mismo ciclo visto desde
fuera en los dos anfitriones), `daemon/architecture.test.ts` (el centro no ejecuta ni numera;
`pid` y `claim` no cuentan; `approve` se concede en un solo sitio) y
`scripts/tui/daemon-approvals.mjs` (`npm run tui:approvals`: `chat` y `run` en un terminal real
contra un aprobador externo).

### 15.10 Cambios en el contrato respecto a M1

Se cambian dentro de la v1, que aún no está congelada (§17):

1. `ProtocolResolver` pasa de `{ client, connectionId }` a `{ kind, client?, connectionId?, at }`:
   hacía falta decir la vía, y una resolución local no tiene conexión.
2. `question.resolved` y `plan.resolved` llevan `status` y `resolvedBy`.
3. `core.hello` admite `approverKey`, y el servidor anuncia `remote-approvals` en `features`.
4. No existe `host.localApprovalResolved`: la resolución local es el evento `*.resolved` que el
   anfitrión publica con `host.publish`, explícito y con su `seq`. El daemon no la infiere de
   que aparezca un `tool.started`.

## 16. Pausa cooperativa (M5)

> **Pausar no congela nada.** Ni threads, ni procesos, ni jobs, ni sockets: evita que el runtime
> **empiece** trabajo nuevo del agente a partir de un punto seguro. Lo que ya estaba en marcha
> termina por su cuenta.

```text
operador ── runs.pause ──▶ stratumd ──┬── HostedSession ──┐
                                      │                   ├──▶ SessionHost.pause()
                                      └── host.pause ─────┘        │
                                          (sesión par)             ▼
                                                        StratumAgent.pause  (PauseController)
                                                                   │
                                              puntos seguros del ReactLoop, de los
                                              subagentes y del dispatcher
```

Una sola implementación (`agent/pause.ts`) y una sola autoridad por sesión: el daemon y el
puente par **reenvían** la orden; ninguno guarda un estado de pausa ni da un run por pausado.

### 16.1 Pedir no es alcanzar

| | |
|---|---|
| `runs.pause` | Devuelve en el acto **cómo quedó la petición**: `requested` · `already-requested` · `already-paused` · `not-running` |
| `run.status: 'paused'` | Lo publica **el anfitrión** (`run.updated` + `session.updated`, con su `seq`) cuando el runtime llega a un punto seguro y ya no avanza nada del agente |
| `runs.resume` | `resumed` · `not-paused` · `not-running`. Sobre una pausa solo pedida, la retira (`resumed`) |

Entre una cosa y otra el run sigue figurando `running` (o `waiting_approval` /
`waiting_input`): el estado intermedio no se expone. Repetir cualquiera de las dos órdenes no
es un error. Con `runId`, `STALE_STATE` si ya no es el run en curso — la orden no se aplica
al siguiente.

Mientras dure: `session.state: 'paused'`, `run.status: 'paused'`, y la foto conserva todo lo
demás (texto parcial, llamadas, solicitudes, jobs, `currentRunId`).

### 16.2 Puntos seguros

| Punto | Qué no empieza |
|---|---|
| Antes de cada petición al modelo | La petición, y la compresión de contexto que la precede |
| Tras la respuesta del modelo, antes de ejecutar sus tools | Ninguna tool del lote, ni de control ni delegaciones |
| En el dispatcher, entre la confirmación y la ejecución | Lo que una persona acaba de aprobar |
| Tras las tools de un lote, antes de delegar o de preguntar | Las delegaciones, la tanda de preguntas y el plan de ese mismo lote |
| Antes de lanzar un subagente | El subagente: ni se anuncia |

Lo que ya estaba en marcha **termina**: una respuesta del modelo en curso no se corta (el
texto sigue llegando) y una tool que ya se ejecuta no se interrumpe. Pausar no usa la señal de
cancelación en ningún caso. Las tools de un mismo lote que ya se está ejecutando se completan
todas (entre ellas no hay punto seguro): el run sigue sin figurar `paused` hasta que acaban.

Si la respuesta en curso era la última del turno (sin tools, sin steering pendiente), no queda
nada por empezar: el run **termina** y la pausa se va con él. La pausa es del run: el
siguiente empieza sin ella.

`tool.started` anuncia la llamada cuando se conocen sus argumentos, antes de ejecutarla. Un
run pausado en el segundo punto puede mostrar una llamada en `running` que todavía no ha
empezado: se ejecuta (o se descarta, §16.4) al reanudar. Si el run se **cancela** en esa
pausa, la llamada se cierra con `tool.failed`: ninguna queda `running` en un run terminado.
Que `tool.started` no distinga «propuesta» de «en ejecución» es deuda conocida, anterior a M5.

### 16.3 Lo que la pausa no toca

- **Jobs en segundo plano.** Siguen corriendo: `session.state = paused` con un job `running`
  es correcto. Sus finales se acumulan en la inbox y se entregan al reanudar.
- **Cancelar.** `runs.cancel` funciona igual con la pausa pedida o alcanzada, sin `resume`
  previo, y el run termina `cancelled`. Cerrar la sesión o apagar el daemon también sueltan
  la espera.
- **El resto del sistema.** La espera está en el runtime de esa sesión. El daemon, el bus de
  eventos, el centro de aprobaciones y las demás sesiones siguen atendiendo.
- **La inactividad del daemon.** Una sesión en pausa es una sesión viva: no hay salida por
  inactividad.

Una pausa no caduca sola.

### 16.4 Con steering, aprobaciones y subagentes

- **Steering.** `runs.steer` con el run en pausa es `accepted` y **no reanuda**: queda en la
  inbox y el modelo lo recibe al continuar. Si la pausa era anterior a ejecutar un lote de
  tools, al reanudar ese lote se descarta por el steering (igual que cualquier mensaje que
  llega antes del dispatch) y el modelo decide de nuevo. Es el flujo *pausar → mirar →
  redirigir → reanudar*.
- **Aprobaciones.** Pedir pausa con una solicitud abierta no la toca: sigue pendiente, el run
  sigue `waiting_approval` y el prompt local no se retira. **Resolverla no es reanudar**: lo
  aprobado no se ejecuta hasta `runs.resume`, y entonces se ejecuta una vez, sin volver a
  preguntar — **salvo que entretanto haya llegado steering**: la aprobación era anterior al
  mensaje, así que la acción se descarta (`tool.failed`, sin ejecutarse) y el modelo decide de
  nuevo con el mensaje delante. La aprobación sigue constando como resuelta
  (`approval.resolved`); si el modelo repite la acción, se vuelve a preguntar. El descarte
  alcanza a todo lo que quedaba del lote: delegaciones, preguntas y plan tampoco empiezan. Una pregunta o un plan resueltos dejan el run en pausa antes de su siguiente
  petición al modelo.
- **Subagentes.** Comparten el controlador del run: un hijo espera en los mismos puntos
  seguros que el padre. `paused` solo se publica cuando todos los loops que podrían empezar
  algo están esperando. El tiempo en pausa no cuenta para el presupuesto de tiempo de un
  subagente (`agents.subagentTimeoutMs`).

### 16.5 Sesiones pares y caídas del plano de control

`runs.pause` / `runs.resume` sobre una sesión par se reenvían (`host.pause` /
`host.resume`) con la misma autoridad que `host.cancel`: contesta el runtime de la CLI; sin
anfitrión o sin respuesta, `UNAVAILABLE` con `reason: 'host-unavailable'`. El daemon no marca
la proyección: pasa a `paused` cuando el anfitrión lo publica.

El estado de pausa es del runtime, no del daemon:

| Qué ocurre | Qué pasa con la pausa |
|---|---|
| El daemon muere con una sesión par en pausa | El runtime sigue en pausa. Al volver un daemon, el anfitrión se registra con su foto: `paused` |
| El anfitrión se desconecta en pausa | Proyección `detached`, y su run sigue `paused`: no es un fallo |
| Se cierra la sesión del daemon, o `core.shutdown { force }` | Se cancela como cualquier turno: la espera se suelta |

En la terminal, `stratum run` escribe `[paused from another client · Ctrl+C cancels]` y
`[resumed]` en stderr, y `stratum chat` lo dice en la conversación: una pausa pedida desde
fuera no puede parecer un cuelgue.

### 16.6 Traza

`TraceRuntimeEvent` `pause` (`requested` · `paused` · `resumed`, con `waitMs`), cap
`pause`. La duración de un turno en la traza incluye el tiempo que pasó en pausa.

### 16.7 Tests

`agent/pause.test.ts` (máquina de estados, carreras, reloj pausable) · `agent/pause-flow.test.ts`
(puntos seguros en el loop: tool en curso, respuesta en curso, tool no empezada, reanudar,
cancelar, steering, jobs, subagentes, aprobación) · `host/session-publisher.test.ts` (eventos
y foto) · `daemon/pause.test.ts` (a través del protocolo: sesión del daemon, sesión par,
**equivalencia** entre las dos, aprobación, caída del daemon, desconexión, inactividad,
apagado) · `cli/commands/peer.integration.test.ts` (procesos reales: `stratum run` +
`stratumd` + `stratum ps --watch`) · `scripts/tui/daemon-pause.mjs` (`npm run tui:pause`:
`stratum chat` en un terminal real) · `daemon/architecture.test.ts` (una sola pausa; daemon y
puente no la guardan; nada suspende un proceso).

### 16.8 Cambios en el contrato respecto a M1

Dentro de la v1, que aún no está congelada (§17): `runs.pause` y `runs.resume` admiten
`runId` y devuelven `{ status }` en vez de `{ run }`; `host.pause` y `host.resume`, lo
mismo en vez de `{}`.

## 17. Estabilidad: cuándo se congela la v1

`STRATUM_PROTOCOL_VERSION` es `1` desde M1, pero **la v1 todavía no es una superficie
estable**:

- Ningún paquete publicado la contiene. El último, `stratum-cli` 0.8.0 (tag `v0.8.0`), es
  anterior al protocolo: no trae `src/protocol/` ni `stratumd`.
- No hay clientes fuera de este repositorio. Cliente y servidor se construyen del mismo árbol.

Mientras eso sea así, la forma de la v1 se puede **corregir sin subir el número**, y cada
corrección se anota aquí. Subirlo ahora no protegería a nadie y dejaría una «v1» que nunca
existió fuera del repo.

**La compatibilidad estricta empieza con la primera versión publicada de `stratum-cli` que
incluya `stratumd`** (su tag `v*` en npm y GitHub). A partir de ese tag, v1 es exactamente lo
que esa versión publicó, y rige la regla de §4: dentro de una versión solo se añade; quitar o
cambiar el significado de algo exige `STRATUM_PROTOCOL_VERSION = 2`. Antes de publicar ese tag
hay que revisar esta lista y dar la superficie por buena.

Correcciones hechas a la v1 antes de congelarla:

| Hito | Cambio | Por qué no es un bump |
|---|---|---|
| M3 | `host.register` lleva `pid` y `claim`; `host.publish` admite una foto; `runs.cancel` devuelve `cancelled \| not-running` | Sin publicar |
| M4 | `ProtocolResolver`: de `{ client, connectionId }` a `{ kind, client?, connectionId?, at }` | Sin publicar, y **ningún servidor llegó a emitirlo**: hasta M4 no había nada que resolver (`approvals.list` devolvía siempre vacío), así que tampoco existe ningún dato con la forma antigua. Por eso no se aceptan las dos formas |
| M4 | `question.resolved` y `plan.resolved` ganan `status` y `resolvedBy` (opcionales) | Aditivo |
| M4 | `core.hello.approverKey` (opcional) y la *feature* `remote-approvals` | Aditivo |
| M5 | `runs.pause` / `runs.resume` / `host.pause` / `host.resume` admiten `runId` y devuelven `{ status }` (antes `{ run }` y `{}`) | Sin publicar, y **ningún servidor llegó a atenderlos**: hasta M5 contestaban `UNAVAILABLE` |
| M4 | El servidor deja de conceder `approve` por el token, y `host` pasa a ser excluyente | Cambia lo que se **concede**, no el contrato: `capabilities` siempre pudo ser menos de lo pedido (§4) |
