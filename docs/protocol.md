# Stratum Protocol v1

Contrato entre el harness Stratum y sus clientes (CLI, Dot y los que vengan).
Es la referencia: donde discrepe de `docs/PRD_STRATUM_DOT.md` §10–§12, manda este documento.

> **Estado (M2).** Contrato, validación, códec y cliente Node (M1), y un servidor: `stratumd`
> (`stratum daemon run`), que aloja sesiones y las sirve a varios clientes. **No hay todavía**
> anfitriones pares (la CLI publicando sus sesiones, M3), centro de aprobaciones (M4) ni pausa
> (M5). Qué atiende hoy el servidor y con qué garantías: §13.

| Pieza | Dónde | Depende de |
|---|---|---|
| Tipos, constantes, tablas | `stratum-cli/src/protocol/` (`index.ts`) | nada |
| Validación (Zod) | `stratum-cli/src/protocol/schemas.ts` | `zod` |
| Framing, códec, `RpcPeer` | `stratum-cli/src/ipc/` | Node (`Buffer`) |
| Cliente Node | `stratum-cli/src/client/` | Node (`net`, `fs`) |
| Publicador de una sesión | `stratum-cli/src/host/session-publisher.ts` | el runtime |
| Servidor (`stratumd`) | `stratum-cli/src/daemon/` | `host/`, `ipc/` |

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
- Dentro de la v1 solo se añade: campos opcionales, métodos y eventos nuevos, anunciados en `features`.

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
rol. Qué identidad tiene derecho a `approve` es una decisión de M4 (PRD §22 Q2).

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
| `runs.pause` · `runs.resume` | control | ✓ | |
| `runs.cancel` | control | ✓ | Con `runId`: `STALE_STATE` si ya no es el run en curso |
| `approvals.list` | observe | | Aprobaciones, preguntas y planes pendientes |
| `approvals.resolve` | **approve** | ✓ | `approve` · `deny` · `allow-all`; `phrase?` |
| `questions.answer` · `plans.decide` | **approve** | ✓ | `ALREADY_RESOLVED` si otro llegó antes |
| `jobs.list` | observe | | |
| `jobs.cancel` | control | ✓ | |
| `memory.status` · `memory.decisions` | observe | | |
| `events.subscribe` · `events.unsubscribe` | observe | | Solo cambian el estado de la propia conexión |
| `trace.subscribe` · `trace.unsubscribe` | observe | | |
| `host.register` · `host.publish` · `host.unregister` | host | ✓ | Anfitrión par → servidor |
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
| `UNAVAILABLE` | No se puede atender ahora (anfitrión desconectado, servidor apagándose) |
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

Definido en el contrato y sin implementación tras M2: anfitriones pares (`host.*`, M3), centro
de aprobaciones (`approvals.resolve`, `questions.answer`, `plans.decide`, M4), pausa
(`runs.pause` / `runs.resume`, M5), `trace.subscribe`, reanudar una sesión guardada
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

### 13.6 Métodos atendidos en M2

| Respuesta | Métodos |
|---|---|
| Atendido | `core.*` · `agents.list` · `models.list` · `sessions.list` (solo vivas) · `sessions.get` · `sessions.open` · `sessions.close` · `sessions.set*` · `runs.list` · `runs.get` · `runs.start` · `runs.steer` · `runs.cancel` · `approvals.list` (siempre vacío) · `jobs.*` · `memory.*` · `events.*` |
| `UNAVAILABLE` | `runs.pause` · `runs.resume` (M5) · `sessions.open { resume }` |
| `NOT_FOUND` | `approvals.resolve` · `questions.answer` · `plans.decide`: no hay nada pendiente hasta M4 |
| `METHOD_NOT_FOUND` | `trace.*` · `host.*` |

Capacidades concedidas: `observe`, `control`, `approve`. `host` y `broker` aún no: quien pida
el rol `host` recibe solo `observe`.

Eventos que **no** se emiten todavía: `tool.blocked` (la decisión no viaja como evento del
turno), `plan.proposed` / `plan.resolved`, `question.*` y `approval.*` (M4), `session.detached`
(M3). `ProtocolRun.counters.llmCalls` y `.blocked` valen 0: no se estiman.

`memory.write` lleva la sesión que **intentó** guardar, no la del registro: con dedup, el
registro que queda puede ser de otra sesión.
