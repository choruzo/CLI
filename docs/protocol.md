# Stratum Protocol v1

Contrato entre el harness Stratum y sus clientes (CLI, Dot y los que vengan).
Es la referencia: donde discrepe de `docs/PRD_STRATUM_DOT.md` §10–§12, manda este documento.

> **Estado (M1).** Están definidos y probados el contrato, la validación, el códec y el
> cliente Node. **No hay todavía ningún servidor**: ni daemon, ni registro de runs, ni bus de
> eventos, ni centro de aprobaciones. Lo que aquí se describe del lado servidor es lo que
> M2–M4 tienen que cumplir.

| Pieza | Dónde | Depende de |
|---|---|---|
| Tipos, constantes, tablas | `stratum-cli/src/protocol/` (`index.ts`) | nada |
| Validación (Zod) | `stratum-cli/src/protocol/schemas.ts` | `zod` |
| Framing, códec, `RpcPeer` | `stratum-cli/src/ipc/` | Node (`Buffer`) |
| Cliente Node | `stratum-cli/src/client/` | Node (`net`, `fs`) |

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

   Nunca `observe() → socket.write / await`. Se materializa en M3; `observe()` ya llama a
   sus observadores de forma síncrona y descarta sus excepciones. Qué hace la cola al
   llenarse lo fija M3; el contrato ya lo permite: lo volátil se puede descartar y una
   pérdida de eventos de estado se repara con una foto.
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
existe), `invalid` o `incompatible`. Publicarlo es de M2. El token no se registra.

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

`operationId` es un campo opcional y **reservado** de las peticiones mutantes: identifica la
operación para que el servidor pueda reconocer un reenvío deliberado. En la v1 puede ignorarlo.

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
`sessions.get`) y decidir. `operationId` queda reservado para que M2/M4 puedan ofrecer
reenvíos deliberados e idempotentes donde haga falta.

## 11. Qué deja M1 sin hacer

Definido en el contrato, sin implementación: registro de sesiones y runs, bus de eventos con
buffer y reenvío, centro de aprobaciones, alojamiento de sesiones en el daemon, ciclo de vida
del daemon y publicación de `endpoint.json`, publicación de las sesiones de la CLI, Dot.

Tampoco se tocaron los pendientes que M0 dejó para después (PRD, M0): `cwd` de los servers MCP,
atribución de `memory.write`, entorno completo, resolución de config y modelo para el daemon,
migración de `chat` y Desktop.

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
un pipe real, pero **no es un daemon**: no aloja sesiones ni guarda estado.
