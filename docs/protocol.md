# Stratum Protocol v1

Contrato entre el harness Stratum y sus clientes (CLI, Desktop, Dot y los que vengan).
Es la referencia: donde discrepe de `docs/PRD_STRATUM_DOT.md` §10–§12, manda este documento.

> **Estado (M5; M6 añade un cliente, no cambia el contrato).** Contrato, validación, códec y cliente Node (M1); un servidor, `stratumd`
> (`stratum daemon run`), que aloja sesiones y las sirve a varios clientes (M2); **anfitriones
> pares**: `stratum run` y `stratum chat` publican en él su sesión sin dejar de alojarla (M3,
> §14); y **centro de aprobaciones**: aprobaciones, preguntas y planes se ven y se resuelven
> desde otro cliente, en carrera con el prompt local (M4, §15); y **pausa cooperativa**: un run
> se pausa y se reanuda desde otro cliente, en su runtime real (M5, §16); y **continuidad**:
> una sesión de `stratum chat` se traspasa viva al daemon, mismo id y contexto, y se vuelve a
> ella desde cualquier cliente (M10, §18); y **conversación duradera**: las sesiones del daemon
> guardan su conversación entera, compactan lo antiguo a una memoria de sesión con procedencia y
> sobreviven a un reinicio (M11, §19); y **clientes hermanos**: Stratum Desktop deja su runtime
> propio y es un cliente más, con el origen de cada sesión y el agente embebido `assistant` (M12,
> §20).
> Qué atiende hoy el servidor y con qué garantías: §13 a §16 y §18 a §20.

| Pieza | Dónde | Depende de |
|---|---|---|
| Tipos, constantes, tablas | `stratum-cli/src/protocol/` (`index.ts`) | nada |
| Validación (Zod) | `stratum-cli/src/protocol/schemas.ts` | `zod` |
| Framing, códec, `RpcPeer` | `stratum-cli/src/ipc/` | Node (`Buffer`) |
| Cliente Node | `stratum-cli/src/client/` | Node (`net`, `fs`) |
| Reductor de fotos | `stratum-cli/src/protocol/reduce.ts` | nada |
| Seguir una sesión y la foto de conjunto desde un cliente (M12) | `stratum-cli/src/protocol/follow.ts`, `overview.ts` (+ `classifyEvent` en `schemas.ts`) | nada |
| Publicador de una sesión | `stratum-cli/src/host/session-publisher.ts` | el runtime |
| Puente de un anfitrión par | `stratum-cli/src/host/peer-host-bridge.ts` | `client/`, el publicador |
| Servidor (`stratumd`) | `stratum-cli/src/daemon/` | `host/`, `ipc/` |
| Reglas de qué respuestas valen | `stratum-cli/src/protocol/resolve.ts` | nada |
| Decisiones pendientes de una sesión | `stratum-cli/src/host/interactions.ts` | el runtime |
| Centro de aprobaciones | `stratum-cli/src/daemon/approval-center.ts` | `protocol/`, `ipc/` |
| Cliente nativo de Dot y de Desktop (M12) | `stratum-dot/crates/dot-link/` (Rust; un `ClientProfile` por app) | este documento; ningún código de `stratum-cli` |

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

Un cliente que lleve credenciales (M9; lo hace Stratum Dot, `docs/dot.md` §14.3–14.4) debería
además: abrir el endpoint **sin seguir enlaces** y comprobar lo abierto (en POSIX, de este
usuario y sin escritura para otros, en una carpeta igual), y, tras conectar y **antes de
enviar el token**, preguntar al sistema quién atiende el canal —`SO_PEERCRED` en un unix
socket, `GetNamedPipeServerProcessId` en un named pipe— y negarse si no es el `pid` del
endpoint o es otro usuario. El cliente Node (`client/`) no lo hace: Node no expone esas
credenciales.

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
| `agents.list` · `models.list` | observe | | Lo que se puede elegir al abrir una sesión: nombres y alias, sin secretos (§13.7) |
| `skills.list` | observe | | Skills que vería una sesión nueva de ese agente: `{ cwd?, agent? }`; `cwd` absoluto obligatorio salvo con `agent: 'assistant'` |
| `sessions.list` · `sessions.get` | observe | | `get` devuelve una foto |
| `sessions.open` | control | ✓ | `cwd?`, `agent?`, `provider?`, `model?`, `readOnly?`, `sessionProfile?`, `resume?`… y `env?` (reservado, solo entrada). Lo que falte lo decide el servidor (§13.4). `resume`: id de una sesión guardada del daemon, que se monta y se devuelve con sus ajustes (§19.4); no admite `cwd`, `agent`, `provider`, `model`, `readOnly` ni `sessionProfile` (`INVALID_PARAMS`) |
| `sessions.close` · `sessions.setModel` · `sessions.setAgent` · `sessions.setReadOnly` | control | ✓ | |
| `sessions.revert` | **approve** | ✓ | Deshace los ficheros de los últimos turnos de una sesión del daemon: `{ sessionId, turns?, dryRun?, force? }` → `{ status, plan }` (§19.8). Exige la clave de aprobador |
| `sessions.detach` | control | ✓ | Traspasa una sesión par al daemon, mismo id y contexto (§18). Devuelve `{ status: 'detached' \| 'already-daemon', session }`; `BUSY`/`NOT_TRANSFERABLE` con `data.reason` |
| `runs.list` · `runs.get` | observe | | |
| `runs.start` | control | ✓ | Un mensaje del usuario: un run nuevo de una sesión existente. `BUSY` si hay un turno en curso (también en pausa o esperando una decisión) |
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
| `host.register` | host | ✓ | Anfitrión par → servidor. `{ snapshot, pid?, claim? }` → `{ claim, epoch }` (§14, §18.3) |
| `host.publish` | host | ✓ | `{ sessionId, epoch, snapshot?, events[] }`. Un hueco de `seq` → `STALE_STATE` (`seq-gap`); otra época → `STALE_STATE` (`stale-epoch`) |
| `host.unregister` | host | ✓ | Baja de una sesión propia. Repetirla no es un error |
| `host.handoffBegin` · `host.handoffChunk` · `host.handoffCommit` · `host.handoffAbort` | host | ✓ | Anfitrión par → servidor: el traspaso por etapas (§18.4). Tras `begin` se identifican por `handoffId` |
| `host.cancel` · `host.pause` · `host.resume` · `host.steer` · `host.detach` | host | ✓ | **Servidor → anfitrión par**. `host.detach` lo envía `sessions.detach` |
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
| `BUSY` | La sesión ya tiene un turno en curso. En un traspaso, `data.reason`: `run-active` · `handoff-in-progress` |
| `ALREADY_RESOLVED` | Otro cliente resolvió antes (`data.resolution`) |
| `STALE_STATE` | La petición parte de un estado que ya no es el vigente. `data.reason`: `seq-gap` · `changed` (la sesión cambió durante un traspaso) · `stale-epoch` · `handed-off` (quien publica ya no es su anfitrión, §18.3) |
| `NOT_TRANSFERABLE` | La sesión no se puede traspasar al daemon: depende de algo del proceso que la aloja (`data.reason`, §18.5) |
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

`session.opened` · `session.updated` · `session.closed` ·
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
`toolCalls`, `subagents`, `todos`, `jobs`, `approvals`, `questions`, `plans`, `messages` y
`messagesTruncated`. Quien la recibe **sustituye** lo que tenía de esa sesión y sigue desde `seq`.

`toolCalls` y `subagents` son **del run** (uno nuevo los vacía). `messages` es **de la sesión**:
su conversación, de todos sus runs (§13.7).

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

Desde Contrato-1 todo lo que declara el contrato está atendido o retirado (§13.6, §17): no queda
ningún método que conteste `METHOD_NOT_FOUND` o `UNAVAILABLE` por no estar hecho. Lo único
reservado es la capacidad `broker` (y su rol), que el servidor **nunca concede**: los clientes
nativos aprueban con la clave de aprobador (§15.2), no con ella. Las sesiones del daemon se
guardan y vuelven tras un reinicio desde M11 (§19.4).

Stratum Dot (M6) es el primer cliente que no es Node: su lado nativo (`stratum-dot/crates/dot-link`,
Rust) habla este protocolo —framing, descubrimiento, handshake, las reglas de §9 y §10— y su
webview valida y reduce con `protocol/schemas.ts` y `protocol/reduce.ts`. Desde M7 también abre
sesiones y conversa con ellas (`sessions.open`, `runs.start`), con los mismos métodos que
cualquier otro cliente: no hay un canal propio de Dot. Lo que M7 añadió al contrato —la
conversación en la foto— está en §13.7 y §17. Ver `docs/dot.md` §12.

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
- **Carpeta y canal privados (M9, `daemon/private-dir.ts`).** La carpeta no puede ser un enlace
  simbólico; en POSIX tiene que ser del usuario del daemon y queda en `0700` (si sigue accesible
  a otros, el daemon **no arranca**), y el unix socket queda en `0600` tras escuchar y antes de
  publicar el endpoint. En Windows no se comprueban dueño ni ACL (hereda la del perfil) y el
  named pipe tiene la DACL por defecto: Node no permite otra.
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
tools y 50 subagentes del run, con sus textos recortados (1 000 caracteres), y la conversación
acotada de la sesión (§13.7). El detalle completo viajó en los eventos y está en la traza.

`events.subscribe` con `sinceSeq`: si todo lo posterior sigue en el buffer del servidor
(`daemon.eventBuffer`, 2 000 eventos de estado por sesión) el modo es `replay`; si no —o si
`sinceSeq` es mayor que el último `seq` conocido, que es un cliente de otra vida del
servidor—, `snapshot`.

### 13.4 Entorno y configuración de una sesión del daemon

- **Directorio**: `sessions.open.cwd` es opcional. Ausente, el servidor usa el suyo por
  defecto, que es el *home* de su usuario (nunca el directorio desde el que se lanzó el
  proceso). Pedido o por defecto, **lo valida el servidor**, que es quien va a trabajar en él:
  absoluto, existente, un directorio y accesible; si no, `INVALID_PARAMS` (`issues[0].path =
  "cwd"`) y no se monta nada. Lo que diga el cliente es solo un texto.
- **Config**: se carga desde el `cwd` de la sesión, como haría la CLI en ese directorio.
  Provider y modelo se resuelven sin preguntar (`host/session-startup.ts`): con varios modelos
  y ninguno elegido, `sessions.open` falla listándolos. `agent`, `provider` y `model` ausentes
  significan «lo que diga esa configuración».
- **Límite**: `daemon.maxSessions` sesiones vivas (16). Por encima, `UNAVAILABLE`.
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
| Atendido | Todos los métodos de §6. `sessions.open { resume }` monta una sesión guardada (§19.4); `trace.subscribe` sirve la traza (abajo) |

Capacidades que se conceden: `observe`, `control`, `host` y, **solo con una clave de aprobador
verificada**, `approve` (§5, §15.2). `broker` está reservada y no se concede nunca (§11).

**`trace.subscribe { sessionId }`** (`observe`). Retransmite la traza de una sesión del daemon
(`<trace.dir>/<id>.jsonl`, la que escribe su runtime ya redactada) como `trace.records`:

- El primer `trace.records` de la suscripción lleva `reset: true`, también si la traza aún no
  existe (va vacío). Después, solo lo nuevo con `reset: false`. Si el fichero se trunca o se
  sustituye, otro `reset: true` con el contenido desde el principio.
- `format` es el de la traza (`TRACE_FORMAT_VERSION`); cada registro es opaco para el protocolo.
- Sirve las sesiones montadas y las guardadas sin montar (no las monta). La de una sesión par la
  escribe su proceso: `UNAVAILABLE` (`peer-hosted`). Un id que no es del daemon, `NOT_FOUND`.
- El fichero es el búfer: se lee por tramos y solo mientras la salida del cliente admite datos,
  así que un cliente lento no hace crecer la memoria del daemon ni pierde registros. Un registro
  de más de 512 KB se salta. Como mucho 8 suscripciones de traza por conexión.
- La traza no tiene `seq`: tras reconectar, el cliente se suscribe otra vez y recibe un `reset`.

Eventos que **no** se emiten: `ProtocolRun.counters.llmCalls` vale 0 (no se estima). Desde
Contrato-1, `tool.blocked` sí: lo publica el anfitrión cuando el runtime veta una llamada antes
de ejecutarla (`source`: `preflight`, `read-only`, `environment`, `toolset`, `plan` o
`steering`), con `call.state: 'blocked'`, y cuenta en `counters.blocked`, no en `toolErrors`. Una
confirmación denegada (por una persona o por la política de la sesión) no es un veto: sigue
siendo `tool.failed`.

`memory.write` lleva la sesión que **intentó** guardar, no la del registro: con dedup, el
registro que queda puede ser de otra sesión.

### 13.7 Conversar con una sesión (M7)

Una conversación es una **sesión** con varios **runs**: no hay una entidad «chat» ni un «turno»
aparte.

```text
sessions.open { cwd?, agent?, provider?, model? }  →  { session }     una sesión alojada en el servidor
runs.start    { sessionId, input }                 →  { run }         un mensaje = un run de esa sesión
   run.started → message.delta* → [tool.*] → message.completed → run.completed
runs.start    { sessionId, input }                 →  otro run, misma sesión, mismo contexto
```

- **Un run a la vez por sesión.** `runs.start` con un run en curso —en marcha, en pausa o
  esperando una decisión— contesta `BUSY`. No hay cola de mensajes: para decirle algo a un run
  que ya está en marcha existe `runs.steer`.
- **Quién**: los dos métodos exigen `control`. Un `observer`, un `approver` o un anfitrión
  (`host`, excluyente) reciben `FORBIDDEN`. No se añadió una capacidad nueva: abrir e iniciar
  son, desde M1, lo que `control` significa (§5).
- **Dueño**: el cliente que abre una sesión **no es su dueño**. Que se desconecte no la cierra
  ni cancela su run (§13.1); la cierra `sessions.close` o el apagado del servidor.
- **Sobre una sesión par**, `runs.start` es `UNAVAILABLE` (`reason: 'peer-hosted'`): su entrada
  está en su proceso (§14.4).

**Qué se puede elegir al abrir**, para un cliente que no lee la configuración:

| Método | Devuelve | No devuelve |
|---|---|---|
| `agents.list { cwd? }` | Perfiles: `name`, `description`, `mode`, `origin`, `allowedTools`, `provider?`, `model?` | El prompt del perfil, su ruta |
| `models.list { provider? }` | `provider` (alias de la config), `id`, `contextWindow`, `default?` | `baseUrl`, claves, cabeceras |
| `skills.list { cwd?, agent? }` | `name`, `description`, `scope` (`builtin`/`user`/`project`), `presets`. Agente de código: las de serie, de usuario y del proyecto de `cwd` que declaran `coding`; `assistant`: solo las de serie que declaran `assistant` | La ruta y el cuerpo |

`default: true` marca el modelo que usa una sesión abierta sin pedir provider ni modelo (el de
la configuración global). El modelo configurado se ofrece aunque el backend no liste modelos;
si un provider no contesta, `error` lo dice sin nombrar su dirección.

#### La conversación en la foto

`ProtocolSessionSnapshot.messages` es la conversación de la sesión como la ve una persona, y
`messagesTruncated` dice si le falta el principio.

| `kind` | Qué es | De qué evento sale |
|---|---|---|
| `user` | Entrada de un turno (`text`, `truncated?`) | `run.started` (`run.input`) |
| `assistant` | Un bloque de texto cerrado del agente principal | `message.completed` |
| `tool` | Una llamada del agente principal: `callId`, `name`, `description`, `target?`, `state` | `tool.started`; cambia de estado con `tool.completed` / `tool.failed` / `tool.blocked` |
| `outcome` | Un turno que no terminó bien: `status` (`failed` · `cancelled`), `text` | `run.failed` / `run.cancelled` |

Cada entrada lleva `id` (`m` + el `seq` del evento que la creó: estable entre fotos), `runId`
y `at`.

- **Es una función pura de los eventos de estado**: `applyTranscriptEvent`
  (`protocol/transcript.ts`). El anfitrión la usa para llevar lo que pone en sus fotos y
  `applySessionEvent` usa la misma, de modo que la foto en `seq = N` y los eventos hasta `N`
  dan exactamente la misma conversación (§13.3). No hay dos implementaciones que mantener
  iguales.
- **Los fragmentos volátiles no entran.** El texto a medias vive en `partial`; se vuelve
  mensaje cuando un `message.completed` lo cierra, y en ese mismo paso `partial` se vacía. Un
  bloque se cierra al empezar una tool, al entregarse steering al modelo
  (`steering.delivered`) y al terminar el turno.
- **Está acotada** (`TRANSCRIPT_LIMITS`): 200 entradas, 12 000 caracteres por mensaje (más
  largo se recorta y lleva `truncated`), 300 por descripción de tool y 150 000 en total. Lo
  más antiguo se descarta primero, y entonces `messagesTruncated` es `true` y no vuelve a
  `false`. `run.input` viaja recortado a 2 000 caracteres: si la entrada era más larga,
  `run.inputTruncated` lo dice y el mensaje `user` lleva `truncated`.
- **No es el historial del agente ni la traza.** No lleva el razonamiento, lo que dicen los
  subagentes ni sus tools, la salida de una tool, ni el texto de un mensaje de steering (el
  protocolo no lo transporta). De una tool viaja la misma `description` que en
  `ProtocolToolCall`, más corta.
- **Vale para los dos anfitriones.** Una sesión de la CLI publica su conversación igual; de
  ella, desde que se publicó (lo anterior de un `chat --resume` no está).
- **La foto no la guarda nadie; la conversación sí (M11).** La foto vive en el anfitrión de la
  sesión mientras vive la sesión. Una sesión **del daemon** guarda además su conversación entera
  —también lo que la foto ya no lleva— y sobrevive a un reinicio: §19.
- **Una tool se identifica por `callId` dentro de su run.** Los ids del modelo se repiten: el
  mismo `callId` en otro run es otra llamada, aunque la anterior quedase abierta. Una entrada
  `tool` que sigue `pending`/`running` con su run ya terminado no llegó a cerrarse (turno
  fallido o cancelado): un cliente no debe enseñarla como activa.
- **Recortar no parte un carácter.** Todo recorte del contrato (`clipText`) respeta los pares
  de *surrogates*: medio emoji es un texto mal formado que un parser JSON estricto rechaza con
  todo el mensaje.

**Una foto cabe en una trama, medida en bytes.** Los límites de arriba son en caracteres; con
un run enorme y texto de varios bytes por carácter la suma podría pasar de
`MAX_MESSAGE_BYTES`, y una foto que no cabe no llega nunca. El anfitrión la mide al construirla
(`fitSnapshot`, `host/session-publisher.ts`) con una **postcondición**: toda foto que publica,
serializada, ocupa como mucho `SNAPSHOT_BYTE_BUDGET` (768 KiB). Solo si hace falta le quita
detalle, por etapas, y se para en la primera que cabe:

1. El razonamiento parcial; los textos largos de tools y subagentes (y `filesChanged`); la
   cola del texto parcial. No se quita ningún elemento.
2. La conversación más antigua, por mitades (con `messagesTruncated`).
3. Si ni así —la conversación ya es una entrada y lo que pesa es lo demás—, lo **terminado**
   se reduce a lo más reciente (tools cerradas, subagentes acabados, jobs terminados, tareas
   hechas, conversación) y todos los textos se acortan, en tres pasos (512, 128 y 32
   caracteres). **Lo vivo se conserva entero**: la sesión, el run, las tools y subagentes
   abiertos, los jobs en marcha, las tareas sin terminar y cada solicitud pendiente con sus
   ids, sus opciones y su `confirmPhrase`, sin los que no se podría resolver.
4. Un último paso acota también esas listas vivas (20 por lista, textos de 8 caracteres), y
   tiene un tamaño máximo fijo. Como garantía final, si aun así no cupiera —imposible con el
   presupuesto por defecto—, se publica la sesión y su run sin nada más.

En todos los casos sigue siendo el estado en su `seq`, con menos detalle, y nunca se inventa
nada: lo que falta, falta. El detalle completo viajó en los eventos.

`agents.list.cwd`, como `sessions.open.cwd`, tiene que ser una ruta absoluta.

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
  visibilidad, no un resultado) y sigue contando como run en curso. `detached` es **siempre**
  una pérdida inesperada del anfitrión; un traspaso explícito al daemon (`sessions.detach`,
  §18) nunca pasa por ese estado.
- **El daemon no numera eventos propios.** Lo que él sabe —que el anfitrión se fue, que volvió,
  que la proyección se descarta— llega a los clientes como una **foto** (`snapshot` a quien
  sigue la sesión, `overview` a quien sigue el conjunto), que sustituye su estado. Por eso no
  hay un evento `session.detached` (se retiró del contrato en Contrato-1, §17).
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
| `sessions.detach` | Se le pide al anfitrión (`host.detach`), que hace el traspaso (§18) |

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

| Quién | `approvals.resolve` / `questions.answer` / `plans.decide` / `sessions.revert` |
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

**Un id cruzado no resuelve nada (M8).** `approvals.resolve`, `questions.answer` y
`plans.decide` admiten `sessionId` (opcional): la sesión a la que el cliente cree que pertenece
la solicitud. Si se da y no es la suya, `NOT_FOUND`: no se resuelve nada, la solicitud sigue
pendiente y **no se dice cómo acabó** (tampoco `ALREADY_RESOLVED` de una ya resuelta de otra
sesión). Stratum Dot lo envía siempre; `stratum approvals` no lo necesita (trabaja por id).

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

**Q2 tras M9, por separado** (detalle: `docs/dot.md` §14.3):

| | Qué hay |
|---|---|
| Qué protege M9 | En Dot, cada resolución sensible exige una confirmación nativa que su webview no controla; Dot no envía token ni clave a un canal que el sistema diga que atiende otro proceso u otro usuario, y la clave solo si el sistema confirma usuario **y** pid (si el sistema no lo dice, el token sí sale —esa conexión solo observa y conduce— y la clave no); carpeta, endpoint y socket privados |
| Qué verifica el sistema, lado servidor | POSIX: el socket `0600` en carpeta `0700` solo admite conexiones de **este usuario o root** (`PeerVerification: socket-permissions`). Windows: **nada** más que el token (`none`). El daemon no sabe qué proceso es en ninguna plataforma |
| Qué verifica el sistema, lado Dot | Usuario y pid del proceso que atiende el canal (`SO_PEERCRED`/`LOCAL_PEERCRED`; `GetNamedPipeServerProcessId` + SID del token) |
| Qué sigue en el mismo dominio de confianza | Cualquier proceso del mismo usuario: puede conectarse con el token, reescribir el endpoint con su propio pid y canal, leer memoria, sustituir `approver.json`, o manejar la interfaz con las APIs del sistema. Y root |

`client.kind` es una declaración, no una identidad, y no da ni quita capacidades.

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
5. (M8) `approvals.resolve`, `questions.answer` y `plans.decide` admiten `sessionId` opcional
   (§15.2). Aditivo.

Desde M8, Stratum Dot resuelve con una conexión de aprobador propia, separada de la que observa
y controla, y sin que la clave pase por su webview: `docs/dot.md` §13.

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
| M7 | `ProtocolSessionSnapshot` gana `messages` y `messagesTruncated`, **obligatorios** (`ProtocolChatMessage`, `TRANSCRIPT_LIMITS`, `applyTranscriptEvent`) | Sin publicar. Son obligatorios y no opcionales a propósito: una foto sin conversación no es «una conversación vacía», y todos los que producen fotos (el daemon y la CLI) salen de este árbol. Es el cambio que hay que mirar antes de congelar |
| M7 | `sessions.open.cwd` pasa a ser opcional (directorio por defecto del servidor) | Aditivo: quien lo enviaba sigue igual |
| M7 | `ProtocolRun.inputTruncated?`, `ProtocolModel.default?` | Aditivos |
| M7 | `models.list` incluye el modelo configurado de cada provider aunque su `/models` falle | No cambia el contrato |
| M7 | Un bloque de texto se cierra (`message.completed`) también al entregarse steering | Corrige lo que se emite: antes el texto de dos respuestas del modelo separadas por steering salía en un solo bloque |
| M8 | `approvals.resolve`, `questions.answer` y `plans.decide` admiten `sessionId?`: con una sesión que no es la de la solicitud, `NOT_FOUND` | Aditivo: quien no lo envía sigue igual |
| M10 | `host.register` devuelve `epoch`, y `host.publish` la exige; métodos `sessions.detach`, `host.handoffBegin/Chunk/Commit/Abort` y `host.detach`; código `NOT_TRANSFERABLE`; `ProtocolHandoffContext` (`HANDOFF_FORMAT` 1) | Sin publicar. `epoch` es obligatoria en `host.publish` a propósito: un anfitrión que no la mande no puede demostrar que sigue siéndolo. Todos los anfitriones salen de este árbol |
| M9 | Ningún cambio de contrato. El daemon no arranca si su carpeta no es privada (POSIX) o es un enlace, y deja su socket en `0600`. Stratum Dot usa `approvals.list` y `sessions.get` (que ya existían) para la confirmación nativa | Comportamiento del servidor y de un cliente; el contrato no cambia |
| M11 | Métodos `sessions.history`, `sessions.context` y `sessions.memory` (`observe`); DTOs `ProtocolHistoryPage`, `ProtocolContextReport`, `ProtocolSessionMemory`; `HISTORY_LIMITS`. Las sesiones del daemon se recuperan tras un reinicio: el mismo id vuelve a `sessions.list` | Aditivo. Que una sesión del daemon sobreviva a su proceso cambia una garantía documentada (§13.7, §18.10), no la forma del contrato |
| M12 | `ProtocolSession.origin?` (`ClientKind`); `sessions.open { agent: 'assistant' }` abre el agente embebido y `agents.list` lo ofrece el primero; `sessions.setAgent` hacia o desde `assistant` → `INVALID_PARAMS`; `ProtocolHandoffContext.agent` puede ser `assistant`. Funciones de cliente puras `followSession`, `applyOverviewEvent`, `boundedTranscript` y, en `schemas.ts`, `classifyEvent`/`parseSessionSnapshot`/`parseOverviewSnapshot` | Aditivo: `origin` es opcional y solo procedencia; el resto no cambia la forma de ningún mensaje |
| Skills de serie | Método `skills.list` (`observe`) y DTO `ProtocolSkill`. `memory.status`/`memory.decisions` sin `cwd` miran la memoria global (la del asistente), no la del directorio del proceso del daemon; con `cwd`, la del proyecto (`<raíz del worktree>/.stratum/memory/`) | Método aditivo. Lo de `memory.*` cambia qué memoria se mira, no la forma: la de la CLI dejó de ser global |
| Contrato-1 | Se **retira** el evento `session.detached` (y de `OVERVIEW_EVENT_TYPES`). `tool.blocked` se emite; `sessions.open { resume }` y `trace.subscribe`/`unsubscribe` se atienden (§13.6, §19.4). `broker` queda reservada y sin conceder | Sin publicar, y **ningún servidor llegó a emitir `session.detached`**: lo que contaba ya viaja como foto (§14.3), y emitirlo exigiría que el daemon numerase eventos propios. Lo demás era contrato declarado sin atender: atenderlo no cambia ninguna forma |
| Contrato-1 | Método `sessions.revert` (**`approve`**) y DTO `ProtocolRevertPlan`, `REVERT_LIMITS` | Aditivo. Es `approve` y no `control` a propósito: pisa ficheros del proyecto sin pasar por las aprobaciones del agente, así que pide la misma autoridad que resolverlas (§15.2) |

## 18. Continuidad: traspasar una sesión de la CLI al daemon (M10)

Una sesión viva de `stratum chat` (anfitrión par) puede **pasar a alojarse en `stratumd`** sin
cambiar de id ni perder contexto, y después cualquier cliente autorizado puede volver a ella.
Es **continuidad**, no persistencia: si el daemon se reinicia, la sesión se pierde como
cualquier otra suya (§18.10).

```text
peer-hosted (época N)
      │ sessions.detach / `/detach`
      ▼
  traspaso: el par deja de empezar trabajo, publica hasta su último seq,
            entrega su contexto, y el daemon monta la sesión
      │ commit (un paso síncrono en el daemon)
      ▼
daemon-hosted (época N+1) ── stratum attach / Dot: ver, escribir, redirigir, pausar, cancelar
      el par anterior: vallado (STALE_STATE) y fuera
```

Invariantes: una sesión tiene **un solo anfitrión autoritativo** en cada momento; traspasar no
crea otra sesión ni otro `sessionId`; adjuntarse no crea otro `SessionHost`; un run en curso
nunca acaba con dos anfitriones escribiendo eventos; las fotos y el flujo de eventos siguen
siendo la fuente de verdad; Dot y la CLI siguen siendo clientes.

### 18.1 Estados de propiedad

| Estado | Qué ve un cliente | Quién ejecuta |
|---|---|---|
| **peer-hosted** | `host: { kind: 'peer', connected: true }` | El proceso de la CLI |
| **detaching** | Nada distinto: sigue `peer-hosted` hasta el commit | Nadie empieza trabajo: el par tiene la puerta de turnos cerrada (`SessionOwnership`) y el daemon está montando la sesión |
| **daemon-hosted** | `host: { kind: 'daemon', connected: true }`, mismo id, `seq` siguiente | `stratumd` (su `SessionHost`) |
| **detached** | `host.connected: false`, `state: 'detached'` | Quizá el par, sin conexión. Es una **pérdida inesperada** del anfitrión (§14.3), nunca un traspaso |
| **closed** | `session.closed`, o la última foto `closed` | Nadie |

`detaching` no se publica a propósito: el cambio de anfitrión es **un solo evento**
(`session.updated` con `host.kind: 'daemon'`, el `seq` siguiente al último del par), así que
ningún cliente ve un estado intermedio ni la sesión desaparece y reaparece. Los clientes que
la seguían siguen en la misma suscripción.

### 18.2 Quién lo pide y quién lo hace

- **El par lo hace siempre.** `/detach` en `stratum chat` lo hace directamente; `sessions.detach`
  (capacidad `control`: `stratum detach`, un cliente) llega al par como `host.detach` y es él
  quien traspasa. Es quien sabe si puede soltar la sesión ahora.
- `sessions.detach` sobre una sesión que ya es del daemon devuelve `already-daemon` sin tocar
  nada. Su respuesta sale del **estado del daemon**: si la del par se pierde pero la sesión ya
  es suya, el resultado es `detached`.
- Solo sabe traspasar `stratum chat`. `stratum run` contesta `NOT_TRANSFERABLE`
  (`unsupported-host`): es un turno que termina, y mientras corre está ocupado.

### 18.3 Propiedad y vallado (`epoch`)

Cada sesión par tiene una **época** que da el daemon al registrarla (`host.register` →
`{ claim, epoch }`) y que el anfitrión manda en cada `host.publish`. Al traspasarla:

- la sesión deja de ser par en el daemon y su id queda **vallado** (en memoria, mientras viva
  el daemon): `host.publish` con la época vieja → `STALE_STATE` (`stale-epoch`);
  `host.register` o `host.handoffBegin` de ese id → `STALE_STATE` (`handed-off`). Da igual que
  la conexión vieja siga abierta: no se confía en que «la conexión vieja debería cerrarse»;
- el daemon pasa a la época N+1 (`host.handoffCommit` → `{ session, epoch }`);
- el par, al recibir `stale-epoch`/`handed-off`, deja de considerarse anfitrión y suelta la
  sesión sin cerrarla (sin `session.closed` ni `host.unregister`);
- las órdenes de control (`runs.*`, aprobaciones) ya no se reenvían al par: la sesión es local
  del daemon.

### 18.4 El traspaso, paso a paso (todo o nada)

| Paso | Dónde | Qué pasa |
|---|---|---|
| 1 | Par | `prepareHandoff`: cierra la puerta de turnos **y** comprueba que nada del proceso esté en vuelo (§18.5), en un solo paso síncrono. Si algo lo impide, la puerta se reabre y se contesta con el motivo |
| 2 | Par | Publica todo lo pendiente y espera a que el daemon lo tenga; desde ahí **retiene** lo nuevo. Vacía la traza a disco (el daemon sigue en el mismo fichero) |
| 3 | Par → daemon | `host.handoffBegin { epoch, seq, chunks, chars }`: el daemon comprueba dueño, época, que su proyección está **exactamente** en ese `seq` (si no, `STALE_STATE` `changed`) y que, según lo publicado, no hay run ni nada pendiente |
| 4 | Par → daemon | `host.handoffChunk` × n: el contexto (`ProtocolHandoffContext`) serializado y troceado (≤ 96 Ki caracteres por trozo, sin partir surrogates; en orden, o se invalida). Si el `seq` local cambió entretanto (un `/model`), el par aborta |
| 5 | Par → daemon | `host.handoffCommit`: el daemon reúne y **valida** el contexto (Zod, `strict`), resuelve config/provider/modelo **con su entorno** para ese `cwd`, monta el `SessionHost` con ese id y ese contexto, y un publicador que continúa desde su foto. Durante el montaje (`committing`) la proyección no cambia, no se descarta y nadie puede registrar ni publicar en ella (`BUSY` `handoff-in-progress`) |
| 6 | Daemon | **Commit, síncrono**: valla al par, registra la sesión como suya y publica `session.updated` (`seq` + 1). Si algo falló antes de este paso, desmonta lo montado **sin haber publicado nada** y la sesión sigue siendo del par |
| 7 | Par | Con el commit confirmado: `handed-off` (definitivo), suelta la sesión y la terminal puede salir. Con un no del daemon: reabre la puerta y sigue siendo el anfitrión |

Nunca hay dos anfitriones: antes del paso 6 el único que puede ejecutar es el par (y tiene la
puerta cerrada); después, solo el daemon (y el par está vallado).

| Si… | Entonces |
|---|---|
| el daemon rechaza (config/provider que no resuelve con su entorno, perfil que no existe, contexto inválido, demasiadas sesiones) | El par sigue siendo el anfitrión y vuelve a trabajar |
| el par muere antes del commit | Lo recibido se descarta; la sesión queda sin anfitrión como cualquier otra (§14.3) y se descarta al confirmarse que el proceso murió |
| el par muere (o se cae su canal) con el commit en marcha | Decide el montaje: si sale bien, la sesión es del daemon; si no, queda sin anfitrión, como cualquier otra |
| el par sigue publicando tras el commit | Rechazado (`stale-epoch`); su publicador está soltado y su runtime no empieza turnos |

### 18.5 Qué se traspasa, qué no, y qué lo impide

**Se traspasa** (`ProtocolHandoffContext`, versionado con `HANDOFF_FORMAT`): el **historial del
agente** completo —system prompt incluido, llamadas a tools y sus resultados, lo que dejó la
compresión—, con el que el agente rehidrata su lista de tareas y su evidencia de TDD como al
reanudar una sesión guardada; el provider y el modelo **por nombre**; el perfil principal; el
modo read-only; el perfil de sesión pedido; la ref del plan; y los contadores (tool calls;
tokens solo si el backend los había reportado). La **foto** (conversación, último run, tool
calls, todos, jobs terminados) no viaja: el daemon ya la tiene por lo publicado, y el
publicador nuevo continúa desde ella.

**No se traspasa**: el entorno del terminal, la config cargada, `apiKey`/`baseUrl`, tokens del
canal, la clave o la autoridad de aprobar, la política destructiva o `--allow-destructive`,
procesos, sockets, descriptores, conexiones SSH ni servers MCP. El daemon monta los suyos.

**Secretos: lo que el traspaso no lleva y lo que sí puede llevar.** El DTO no serializa
ninguna credencial **del runtime**: ni entorno, ni config, ni API keys, ni tokens del canal, ni
la autoridad de aprobar. Pero **sí lleva el historial interno completo del agente**, tal cual,
porque es el contexto que el modelo ya tiene y sin él no hay continuidad. Por tanto, un dato
sensible que **ya forme parte del contexto del modelo** viaja con él: lo que el usuario
escribió en un mensaje, lo que el modelo repitió en su respuesta o en los argumentos de una
tool, o la salida de una tool que la redacción del núcleo (`src/security/`, solo formatos
reconocibles: PEM, `Bearer`, `sk-…`, JWT, tokens de GitHub…) no reconoció. Lo ya redactado
viaja como `[redacted: …]`, igual que estaba en el historial. El traspaso no filtra ni borra
contexto: hacerlo cambiaría lo que el modelo sabe. Ese historial va por el canal privado del
daemon (M9), solo al daemon del mismo usuario; no se publica en ningún evento ni foto y no se
registra. Tras el traspaso queda en el agente de `stratumd`, con
el mismo tratamiento que el de una sesión abierta allí.

**Lo impide** (`data.reason`):

| Motivo | Código | Por qué |
|---|---|---|
| `run-active` | `BUSY` | Hay un turno —también en pausa, o esperando una aprobación, pregunta o plan—. Lo pendiente es una promesa del proceso par: **se rechaza el traspaso** en vez de mover o resolver nada; las solicitudes siguen siendo las mismas, con su id |
| `handoff-in-progress` | `BUSY` | Ya se está traspasando |
| `jobs-running` | `NOT_TRANSFERABLE` | Un job es un proceso del par: no se teletransporta. Hay que esperarlo o cancelarlo |
| `inbox-pending` | `NOT_TRANSFERABLE` | Hay steering o el final de un job que el agente aún no ha visto: con un turno se le cuenta |
| `background-work` | `NOT_TRANSFERABLE` | Trabajo auxiliar en vuelo (extracción de memoria) |
| `unsupported-host` | `NOT_TRANSFERABLE` | Ese anfitrión no sabe traspasar (`stratum run`) |
| `startup` | `NOT_TRANSFERABLE` | El daemon no puede montarla con **su** entorno: config, provider, modelo o perfil que no resuelve |
| `cwd` | `NOT_TRANSFERABLE` | El daemon no puede usar el directorio |
| `context` | `NOT_TRANSFERABLE` | El contexto no valida, no es de esa sesión o no cabe (48 Mi caracteres) |

No se finge migrar una llamada al modelo en vuelo, un proceso, una conexión SSH ni una tool en
ejecución: por eso solo se traspasa una sesión parada. Los jobs **terminados** se conservan en
la foto, pero su salida se queda en el proceso par.

### 18.6 El entorno después del traspaso

Una sesión par nació con el entorno de su terminal; en el daemon, como las que abre
`sessions.open` (§13.4), lanza procesos con la **copia del entorno del daemon tomada al
arrancar** y resuelve su config desde el mismo `cwd` con ese entorno. No se copia ninguna
variable de la terminal al daemon. Si el daemon no puede montar la sesión así (un provider cuya
clave solo existía en la terminal), el traspaso se rechaza (`startup`): no se debilita el
aislamiento de M0/M9 para conseguirlo. La política es la del daemon: `ask` si acredita
aprobadores, `deny` si no (nunca la de la terminal).

### 18.7 Conversación, contexto y pendientes

- **Transcript idéntico**: la conversación de la foto del daemon antes y después es la misma
  (mismos mensajes, mismos ids), y los turnos nuevos se añaden a continuación con `seq`
  consecutivos.
- **Mismo contexto lógico**: lo que el agente sabía (no solo lo que se ve) sigue ahí, porque
  viaja su historial, no la vista para personas.
- **Pendientes**: un traspaso exige no tener ninguno (§18.5), así que no hay ids que cambiar ni
  nada que se resuelva solo. M8 y M9 no cambian.
- La traza sigue en el mismo fichero (`<sessionId>.jsonl`); el par la vacía antes del commit.

### 18.8 Resultado desconocido

`sessions.detach` y `host.handoffCommit` son mutantes. Si el canal cae después de enviar el
commit y antes de su respuesta, **no se reintenta**: el par vuelve a registrar la sesión con su
`claim` para preguntar quién es el anfitrión — vallada (`handed-off`) → es del daemon;
registrada → el daemon no la montó y sigue siendo del par; `BUSY` (`handoff-in-progress`) →
aún se decide, espera. Si el daemon que la recibió ya no existe (no hay endpoint, su pid murió
u otro proceso ocupa el endpoint), nadie puede alojarla —el daemon no persiste— y sigue siendo
del par. Si no se puede saber, el par **no** vuelve a ejecutarla (podría ser ya del daemon) y lo
dice. `stratum detach` hace lo mismo desde fuera: ante una respuesta perdida pregunta con
`sessions.get` quién la aloja.

### 18.9 Adjuntarse no es un método

Ver y conducir una sesión del daemon ya existía (`events.subscribe` + `runs.*`). «Adjuntarse»
es **elegir una sesión, seguirla y conducirla**; no hay `sessions.attach`, ni un anfitrión
nuevo, ni ningún estado en el servidor. `stratum attach <id>` es exactamente eso, en una
terminal: la conversación de la foto, el texto en streaming, `runs.start` con la sesión parada
y alojada en el daemon, `runs.steer` con un run en curso, `/pause` · `/resume` · `/cancel`,
`/pending` (lo que espera a una persona; se resuelve con `stratum approvals`: la clave de
aprobador no pasa por `attach`) y `/detach` si aún la aloja una terminal. Salir —también con
Ctrl+C— no toca la sesión.

### 18.10 Fuera de alcance

- **Reinicio del daemon** *(cerrado en M11, §19.4)*: en M10 una sesión traspasada moría con el
  daemon. Desde M11 se guarda (conversación, memoria de sesión, contexto y ajustes) y vuelve al
  reiniciarlo. El chat sigue guardando al salir su copia local hasta el traspaso.
- Migrar entre daemons, alta disponibilidad, máquinas remotas, la convergencia de Desktop y un
  sistema de secretos nuevo.
- Migrar trabajo en vuelo (llamadas al modelo, procesos, SSH, tools).
- `chat --resume <id>` *(cambiado en M11, §19.6)*: antes abría otro runtime local con ese id
  que el daemon no aceptaba como anfitrión (dos copias de la conversación). Ahora se niega si la
  aloja el daemon y remite a `stratum attach`; `--fork` hace la copia explícita con otro id.

### 18.11 Tests

`daemon/handoff.test.ts` (daemon real, par con `SessionHost` + puente, sobre el pipe): traspaso
en reposo de punta a punta (tres turnos, el par se va, Dot lo ve, turno nuevo con el contexto),
`sessions.detach` desde otro cliente, vallado del par anterior, rechazo del daemon (el par
sigue), muerte del par antes y durante el commit, resultado desconocido en los dos sentidos,
caída del daemon con el commit en marcha, run activo, aprobación pendiente, job vivo y aviso
sin ver, `stratum run`, sin daemon, dos sesiones, y la validación de cada paso.
`host/handoff.test.ts`: captura, rehidratación, puerta de turnos, troceado y continuación del
publicador. `scripts/tui/daemon-detach.mjs` (`npm run tui:detach`): `chat` → `/detach` →
`stratum attach` en otra terminal, y `stratum detach` desde fuera, con procesos reales. En Dot,
`npm run smoke:detach`.

## 19. Conversación duradera, contexto activo y memoria de sesión (M11)

Una conversación con una sesión del daemon puede crecer indefinidamente sin que todo su
historial entre en cada llamada al modelo, y sobrevive a un reinicio de `stratumd`. Tres capas
que no se mezclan:

```text
Conversation Log  ≠  Active Agent Context  ≠  Session Memory
```

| Capa | Qué es | Quién la ve |
|---|---|---|
| **Conversation Log** | Todo lo que se dijo, entero y duradero (`ConversationStore`) | Las personas: la foto (lo último) y `sessions.history` (lo anterior) |
| **Active Agent Context** | Lo que recibe el modelo: system prompt (con la memoria global y de proyecto, cada una con su tope) + memoria de sesión + conversación reciente + mensaje actual | El modelo |
| **Session Memory** | Hechos, decisiones, restricciones, preferencias, tareas, resultados y entidades extraídos de lo antiguo, más un resumen narrativo, cada uno con su procedencia | El modelo (en el system prompt) y `sessions.memory` |

Implementación y trampas: `.claude/docs/conversacion.md`.

### 19.1 Compactar no es borrar

Antes de cada llamada al modelo, si la entrada estimada (con las definiciones de tools) supera
`memory.session.compactAt` (0.70) del **presupuesto de entrada** —ventana real del modelo menos
la reserva de salida—, se toman los turnos **más antiguos** fuera de la zona protegida (los
últimos `agent.compressionKeepRounds` y la petición en curso) hasta bajar de
`memory.session.targetContext` (0.45), y:

```text
trozo antiguo ── extractor ──▶ hechos / decisiones / tareas …  ┐
             └── resumen   ──▶ continuidad narrativa            ├─▶ memoria nueva (versión + 1) ─▶ disco
memoria anterior ───────────────────────────────────────────────┘
                                         solo entonces ─▶ el trozo sale del contexto activo
```

Los mensajes compactados **siguen** en el `ConversationStore` y en la conversación que ven Dot y
la CLI: no se sustituyen por un resumen. Solo dejan de entrar literalmente en cada llamada.

- **Una compactación a la vez por sesión**, en un punto seguro del turno (antes de una petición
  al modelo), con commit atómico: la memoria nueva se escribe en disco antes de quitar nada.
- **Un fallo no rompe el turno ni pierde nada.** Si el extractor o el resumen fallan (o no hay
  JSON), la memoria anterior queda intacta, no se quita nada del contexto, se avisa
  (`warning` `session_memory_deferred: …`) y se reintenta en la siguiente ocasión. Si además ya
  no cabe, el turno termina con un error explícito (`context_full: … Nothing was deleted`) en
  vez de truncar contenido arbitrario.
- **Incremental**: memoria anterior + trozo nuevo → memoria nueva. Se puede regenerar desde el
  store porque cada compactación guarda qué entradas cubrió (`context.json`).

### 19.2 La memoria de sesión

- **Es de esa sesión.** No se promociona sola a la memoria de proyecto (`decisions.json`,
  `STRATUM.md`) ni a la global, ni la ve otra sesión. La promoción explícita queda para
  después.
- **Tiene procedencia.** Cada entrada lleva `sources`: ids (`e<n>`) de mensajes del historial
  del agente guardado, que deben estar en el trozo compactado; una sin fuentes válidas no entra.
  El resumen dice qué entradas cubre.
- **Un hecho nuevo sustituye al que contradice** (misma clase y clave, o `supersedes`
  explícito): el anterior queda `superseded` con `supersededBy`, auditable, y el modelo solo ve
  el vigente. Si el extractor no sabe cuál vale, las dos quedan `conflict` y así se le enseñan.
  Una tarea `done` cierra la abierta de su clave.
- **No es autoridad.** Se inyecta con el aviso de que es contexto derivado: nunca concede
  permisos ni aprobaciones, y ficheros, procesos, entornos, secretos o resultados de tools se
  comprueban con tools. Ningún componente que decida permisos, aprobaciones, guardas o entornos
  la lee (lo fija un test de arquitectura).
- **Salidas de tools**: el extractor ve un extracto (cabeza y cola) con el id de la entrada
  completa; la salida entera sigue en el store y a la memoria solo llega lo que se concluyó.

### 19.3 El modelo de la memoria

`memory.session.extractor` y `memory.session.summarizer` (`{ provider, model }`, `same` por
defecto) pueden ser otro modelo u otro provider de la config. Son funciones distintas (el
extractor da JSON con fuentes y tiende a la precisión; el resumen da texto narrativo) aunque
usen el mismo modelo. Un provider distinto usa **sus** credenciales: nunca recibe la clave del
provider de la sesión.

**Frontera de privacidad.** Compactar envía contenido de la conversación (mensajes y extractos
de tools) al modelo de memoria. Si es el provider de la sesión, ese contenido ya iba ahí en cada
turno. Si es **otro provider y no está en esta máquina** (su `baseUrl` no es loopback), la
config tiene que decirlo: `memory.session.allowRemote: true`. Sin ello no se compacta (se avisa
con el motivo) y nada sale hacia ese provider.

### 19.4 Persistencia y reinicio del daemon

Con `daemon.persistSessions` (por defecto `true`) cada sesión del daemon —abierta con
`sessions.open`, traspasada desde una terminal (M10) o recuperada— vive en
`~/.stratum/daemon/sessions/<id>/` (dentro de la carpeta privada del daemon): `session.json`
(cwd, alias de provider y modelo, perfil, read-only, perfil de sesión, plan, contadores),
`snapshot.json` (la última foto), `conversation.jsonl`, `memory.json` y `context.json`. Se
escriben al cerrar cada turno, al cambiar un ajuste y al apagarse; la conversación, según se
produce. **Nunca** se guardan claves (`apiKey`, el token del endpoint, la clave de aprobador),
el entorno, ni procesos, jobs o conexiones SSH/MCP.

```text
stratumd se reinicia
  → cada sesión guardada vuelve a la lista (`sessions.list`), parada y con su foto
  → Dot / `stratum attach` ven la misma conversación (foto + `sessions.history`)
  → el primer uso que necesita su runtime la monta (`runs.start`, `sessions.set*`)
  → el turno nuevo continúa con su contexto activo y su memoria de sesión
```

- **Recuperada no es montada.** Al arrancar, las guardadas se publican con su foto sin montar
  nada (ni servers MCP ni agente). `sessions.open { resume: id }`, `runs.start`,
  `sessions.setModel|setAgent|setReadOnly` y `sessions.close` la montan (una vez aunque lleguen
  dos a la vez) con el entorno del daemon,
  como una traspasada. Si ya no se puede (directorio, provider, perfil), `UNAVAILABLE` con
  `reason: 'cwd' | 'startup'` y sigue guardada. Sobre una sin montar, `runs.cancel|pause|resume`
  contestan `not-running`, `runs.steer` `not-accepting` y `jobs.cancel` `NOT_FOUND`.
- **`sessions.open { resume }`** es montarla a propósito: devuelve la misma sesión (mismo id,
  `origin` y ajustes). Ya montada, la devuelve tal cual. Es la sesión guardada, no una nueva,
  así que no admite ajustes de apertura (`INVALID_PARAMS`). Un id que no es del daemon es
  `NOT_FOUND`, y el de una sesión par, `UNAVAILABLE` (`peer-hosted`).
- **El `seq` continúa**: la foto recuperada sigue desde lo más alto que se llegó a guardar
  (también la conversación escrita a mitad de un turno). Lo que estaba en marcha cuando murió
  el daemon queda `interrupted`; sin pendientes, ni texto a medias, ni jobs vivos.
- **`sessions.close` la acaba**: se borra del disco y no vuelve. Apagar el daemon (o que muera)
  no: vuelve al arrancar.
- Sin `persistSessions` la conversación de cada sesión vive en memoria: `sessions.history` y la
  memoria de sesión funcionan igual, pero mueren con el proceso.
- Formatos versionados: `conversation.jsonl` lleva cabecera con `format` (1); los JSON llevan
  `schemaVersion`. Uno de un Stratum más nuevo no se toca ni se monta. Una última línea a medias
  del JSONL (el proceso murió escribiéndola) se descarta; una intermedia ilegible se salta.

### 19.5 Métodos (`observe`)

| Método | Parámetros | Resultado |
|---|---|---|
| `sessions.history` | `sessionId`, `before?` (id del primer mensaje que ya se tiene), `limit?` (≤ 100) | `ProtocolHistoryPage`: `messages` (los mismos `ProtocolChatMessage`, mismos ids que la foto, en orden), `hasMore`, `total`. Una página cabe en un mensaje (`HISTORY_LIMITS.pageBytes`); lo que no cabe queda para la siguiente |
| `sessions.context` | `sessionId` | `{ report: ProtocolContextReport }`: `context` (ventana, reserva, entrada usable, entrada actual y por capas —system, tools, memoria global, de proyecto, de sesión, reciente—, mensajes activos y topes; tokens **estimados**, `estimated: true`; `null` si está recuperada sin montar), `conversation` (mensajes guardados, activos, compactaciones, última, último fallo) y `memory` (versión, resumen sí/no, entradas vigentes por clase) |
| `sessions.memory` | `sessionId` | `{ memory: ProtocolSessionMemory }`: resumen (con cuántas fuentes y la primera y la última), entradas con `status`, `sources` (hasta 50), `supersedes`/`supersededBy` |

Sobre una sesión par los tres son `UNAVAILABLE` (`peer-hosted`): el daemon no guarda su
conversación. Un `before` que no es de la sesión es `INVALID_PARAMS`.

### 19.6 `chat --resume` y `stratum attach`

`stratum attach <id>` es la forma de continuar una sesión del daemon, también una recuperada
(`/history [n]` pagina lo anterior). `chat --resume <id>` **no** abre en silencio un segundo
anfitrión de una sesión que ya tiene uno: si la aloja el daemon (viva o guardada) o está abierta
en otra terminal, se niega y dice cómo seguir; `chat --resume <id> --fork` continúa una copia
local con **otro** id. Un anfitrión par desconectado (su terminal murió) no bloquea.

### 19.7 Tests

`conversation/*.test.ts` (store, memoria, agente con conversación: separación, compactación,
procedencia, fallos, conversación larga, aislamiento, modelo distinto y credenciales contra un
servidor HTTP local, egress, reconstrucción; reglas de arquitectura), `daemon/persistence.test.ts`
(reinicio de punta a punta con compactación y pregunta sobre lo antiguo, cerrar frente a morir,
sin carpeta, traspaso M10 → reinicio), `cli/resume-guard.test.ts` y `cli/attach-view.test.ts`.

### 19.8 Deshacer turnos desde un cliente (`sessions.revert`)

El deshacer por turno de la TUI (`/undo`, `/rewind`) por el protocolo, para Dot y Desktop. Usa el
mismo almacén de snapshots y la misma lógica (`StratumAgent.planRevert` / `revertTurns`).

- **Autoridad: `approve`.** Revertir pisa o borra ficheros del proyecto sin pasar por las
  aprobaciones del agente, así que exige la misma autoridad que resolverlas: la clave de
  aprobador (§15.2). `control` no basta (`FORBIDDEN`). En Dot pasaría por su conexión de
  aprobador y su confirmación nativa, como cualquier resolución (todavía no lo llama).
- **Parámetros**: `turns` (los últimos N turnos con cambios, 1 por defecto, hasta
  `REVERT_LIMITS.turns`), `dryRun` (solo el plan) y `force` (pisar los conflictos).
- **Resultado**: `{ status, plan }`. `planned` (era `dryRun`), `reverted`, `conflicts` (hay
  rutas cambiadas después del último turno y falta `force`: **no se toca nada**), `nothing`
  (no hay turnos con cambios, o la sesión no guarda copias: fuera de un repo git, o
  desactivado) y `failed` (falló a medias; `plan` dice lo que sí se deshizo, y el detalle va al
  log del daemon). Cada lista de `plan` se recorta a `REVERT_LIMITS.paths` (`truncated`).
- **Solo en reposo**: con un turno en curso, `BUSY`; mientras se revierte, `runs.start` y los
  `sessions.set*` también son `BUSY`. Una sesión guardada sin montar se monta para revertir.
- **Nunca a medias**: cerrar la sesión (o apagar el daemon) espera a que termine el revert en
  curso. Una sesión en **solo lectura** no revierte (`INVALID_PARAMS`): promete que nada cambia el
  proyecto, tampoco por esta vía.
- **Sesión par**: `UNAVAILABLE` (`peer-hosted`). Sus snapshots son del proceso que la aloja;
  ahí está `/undo`.
- **El modelo lo sabe**: el turno siguiente empieza con el aviso `<files_reverted>`, como en la
  TUI. No se publica ningún evento: no cambia el estado de la sesión, sino ficheros.
- No deshace lo que no son ficheros del proyecto (SSH, otros directorios, procesos).

## 20. Clientes hermanos: Desktop sobre `stratumd` (M12)

Decisión normativa: `docs/STRATUM_CLIENT_ARCHITECTURE.md` (§8, estado de M12). Desde M12 la CLI,
Stratum Desktop y Stratum Dot son **clientes hermanos** del mismo plano de control:

```text
cliente pide → stratumd arbitra → SessionHost ejecuta
```

Desktop ya no tiene runtime, sidecar ni protocolo propio (el v9 de D0–D7 se retiró): habla este
protocolo con el enlace nativo compartido con Dot (`dot-link`, perfil `DESKTOP`). Una sesión que
abre Desktop es una sesión Stratum normal: aparece en `sessions.list`, la publica el mismo
`SessionHost`, guarda su conversación (M11), sobrevive al cierre de Desktop y a un reinicio del
daemon, y se abre desde Dot o `stratum attach` con el mismo id.

### 20.1 Origen (`ProtocolSession.origin`)

`origin` es el `ClientKind` (`cli`, `desktop`, `dot`, `daemon`, `other`) desde el que se **inició**
la sesión: el de la conexión que llamó a `sessions.open`, o `cli` para una sesión que publica una
terminal. Se conserva al traspasarla (M10) y al recuperarla tras un reinicio (va en su foto
guardada). Ausente en sesiones de un anfitrión anterior a M12.

**Origen no es autoridad.** Nada en el servidor lo lee para decidir quién ve, conduce, aprueba o
cierra una sesión: eso siguen siendo las capacidades de la conexión (§5) y, en una sesión par,
quien la aloja (§14). No hay jerarquía entre clientes.

### 20.2 El agente embebido `assistant`

El modo Chat de Desktop (D1–D2) es ahora un agente que cualquier cliente puede abrir:

```json
{ "method": "sessions.open", "params": { "cwd": "/home/ana/.stratum/desktop/workspaces/<uuid>", "agent": "assistant" } }
```

- Lo monta `SessionHost` con el preset `assistant` (`host/assistant.ts`): su prompt, solo sus tools
  (web, `question`, `todo`, memoria de decisiones y ficheros), **nunca `exec`**, y los ficheros
  confinados al `cwd` (`inputs/` de solo lectura; escritura en `outputs/` y `scratch/`, que se
  crean si faltan). Sin MCP, skills ni perfiles. Su memoria de decisiones es suya
  (`~/.stratum/assistant/memory/`), separada de la de cualquier proyecto.
- **Necesita su propio directorio**: `cwd` es obligatorio y no puede ser el home del usuario, un
  ancestro suyo ni la raíz de una unidad (`INVALID_PARAMS`; en un traspaso, `NOT_TRANSFERABLE`
  `cwd`). El asistente lee todo lo que hay bajo su directorio, así que lo elige quien lo abre:
  Desktop crea una carpeta por conversación.
- Una conversación que no sale de eventos (la importada de Desktop) entra en la foto redactada,
  con ids `m<n>`; la numeración del publicador sigue después del mayor.
- `ProtocolSession.agent` es `assistant`. `agents.list` lo ofrece el primero (`origin: 'builtin'`,
  `mode: 'primary'`); un perfil de usuario con ese nombre no se lista.
- Se elige al abrir y no cambia: `sessions.setAgent` sobre una sesión del asistente, o pidiendo
  `assistant` en otra, contesta `INVALID_PARAMS`. `sessionProfile` no aplica.
- Se traspasa (M10: `ProtocolHandoffContext.agent = 'assistant'`) y se recupera tras un reinicio
  (M11) como asistente.
- Sin aprobadores acreditados se comporta como cualquier sesión del daemon (§13.7): lo destructivo
  se deniega y las preguntas se contestan con supuestos.

### 20.3 Estado operativo, conversación e historial

Un cliente que pinta muchas sesiones no necesita la conversación de todas (§4 de la arquitectura de
clientes):

1. **Estado operativo**: la suscripción `overview` (foto de conjunto + `OVERVIEW_EVENT_TYPES`), que
   el cliente avanza con `applyOverviewEvent` (puro, en `protocol/overview.ts`; en `overview` los
   saltos de `seq` son normales).
2. **Conversación** de la sesión que se mira: su suscripción `session` (foto + eventos), avanzada con
   `followSession` (`protocol/follow.ts`), que reduce con `applySessionEvent` y pide otra foto ante
   un hueco o un evento que no valida. Lo que llega sin tipar se clasifica antes con `classifyEvent`
   (`schemas.ts`). Dot y Desktop usan esta misma función.
3. **Historial completo**, bajo demanda: `sessions.history` hacia atrás desde el primer mensaje de la
   foto. Una página que llega cuando ya se mira otra sesión, o que ya no empalma, se descarta.

### 20.4 Lo que puede pedir cada cliente nativo

`dot-link` lleva un perfil por aplicación (`ClientProfile`). El perfil solo **resta**: lo que no está
en su lista no sale del cliente, aunque el daemon lo permitiera; lo que sí está lo sigue decidiendo
el daemon por capacidades.

| | Dot | Desktop |
|---|---|---|
| `core.hello.client.kind` | `dot` | `desktop` |
| Roles | `operator` (y `approver` por otra conexión, M8) | `operator` |
| Sigue con suscripción `session` | todas las vivas | solo la que se mira |
| `sessions.open`, `runs.start`, `runs.pause`/`resume`/`cancel`/`steer`, `agents.list`, `models.list` | sí | sí |
| `sessions.history`/`context`/`memory` | — | sí |
| `sessions.close`, `sessions.setModel` | — | sí |
| `approvals.resolve`, `questions.answer`, `plans.decide` | por el broker nativo con confirmación (M8/M9) | — (se ven; se resuelven desde Dot o `stratum approvals`) |
| `core.shutdown` | nunca | nunca |

### 20.5 Lo antiguo de Desktop: `stratum desktop import`

Las conversaciones de Desktop D1–D7 (`~/.stratum/desktop/{sessions,conversations}`) se pasan al
daemon **una vez** con `stratum desktop import [--dry-run]`, por el camino de M10: se monta cada una
como sesión del asistente en su carpeta, con su historial, se publica con su conversación visible y
origen `desktop`, y se traspasa. Lo hecho queda en `~/.stratum/desktop/imported.json` (versión 1);
un resultado desconocido se anota y **no** se reintenta. No se borra ni se modifica nada de
Desktop, y Desktop no lo vuelve a leer. No viajan el razonamiento (la conversación del protocolo no
lo lleva) ni los ficheros que D3 archivó o purgó.

### 20.6 Tests

`stratum-cli/src/daemon/sibling-clients.test.ts` (origen, asistente, cerrar Desktop durante un run,
reinicio, traspaso), `protocol/follow.test.ts`, `migrate/desktop-legacy.test.ts`;
`stratum-dot/crates/dot-link/tests/desktop.rs` (perfil, seguimiento por foco, lista blanca,
resultado desconocido); `stratum-desktop/scripts/smoke-clients.mjs` (`npm run smoke:clients`:
Desktop → Dot → `stratum attach`, `/detach` → Desktop, reinicio) y las E2E de
`stratum-desktop/e2e/`.
