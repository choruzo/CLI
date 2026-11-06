# Arquitectura de clientes de Stratum

> Decisión arquitectónica previa a M12. Este documento fija las fronteras entre CLI, Desktop,
> Dot y futuros clientes sin ampliar el alcance funcional de M12.

## 1. Principio

**Stratum es el harness. `stratumd` es el único plano de control compartido. CLI, Desktop y
Dot son clientes hermanos.** Ningún cliente es el plano de control de otro ni obtiene autoridad
sobre otro por el hecho de poder observar su actividad.

```text
                    Stratum
                       │
                   stratumd
                       │
        ┌──────────────┼──────────────┐
        │              │              │
       CLI          Desktop          Dot
        │              │              │
        └──────────────┼──────────────┘
                 Stratum Protocol
```

M12 debe llevar Desktop a esta arquitectura: Desktop deja de mantener un plano de control
aislado y pasa a consumir el mismo Stratum Protocol y el mismo estado vivo que CLI y Dot.
Esto no convierte Dot en Desktop ni Desktop en Dot; la posible convergencia de superficies
puede decidirse después de completar la convergencia del plano de control.

## 2. Observabilidad no implica autoridad

**Ver una sesión no concede permiso para modificarla.** La observación y el control son
capacidades independientes.

Un cliente puede conocer que existe una sesión, su origen, objetivo, estado y actividad
relevante sin adquirir por ello capacidad para pausar, cancelar, redirigir, aprobar o enviar
mensajes a esa sesión.

Las capacidades siguen siendo explícitas y separables, como mínimo:

```text
observe   leer estado y actividad
chat      conversar con sesiones para las que se haya concedido esa capacidad
control   pause / resume / cancel / steer
approve   resolver gates humanos
host      alojar una sesión
broker    mediar capacidades sensibles
```

Una futura superficie orquestadora debe funcionar **read-only por defecto** sobre sesiones
ajenas. Cualquier intervención debe requerir una capacidad ya concedida o una elevación
explícita y acotada por el usuario. La elevación puede ser por acción o por sesión; no debe
convertir al orquestador en propietario global de las demás sesiones.

## 3. Origen de sesión

El protocolo y las proyecciones de actividad deben poder distinguir el origen de una sesión
sin convertir ese origen en una jerarquía de autoridad.

Conceptualmente:

```text
origin = cli | desktop | dot | daemon | future-client
```

`origin` describe dónde nació o desde qué superficie se inició la sesión. No decide quién
puede observarla o controlarla. Esas decisiones pertenecen a las capacidades y al plano de
control.

No es requisito de M12 introducir exactamente este enum si el protocolo actual ya expresa la
procedencia de forma suficiente. Sí es requisito no diseñar Desktop de forma que vuelva a
crear estado vivo privado que `stratumd` no pueda representar.

## 4. Continuidad de contexto entre clientes

La dirección posterior a M12 es que un cliente pueda mantener el hilo de lo que ocurre en los
otros sin consumir necesariamente sus transcripts completos.

Para ello debe distinguirse entre:

1. **Estado operativo:** sesión, run, cliente de origen, proyecto/cwd, perfil, modelo, estado,
   espera actual y timestamps.
2. **Contexto de trabajo:** objetivo actual, tarea en curso, decisiones relevantes y resumen
   de progreso.
3. **Transcript completo:** contenido de conversación y tool calls, recuperable solo cuando
   sea necesario y esté autorizado.

La futura vista/orquestador debería consumir principalmente 1 y 2. No debe depender de
inyectar continuamente todos los transcripts de todas las CLIs o aplicaciones: produciría
ruido, coste de contexto y una frontera de privacidad innecesariamente amplia.

Un ejemplo conceptual de presencia/actividad futura:

```json
{
  "client": "cli",
  "sessionId": "abc123",
  "project": "stratum",
  "goal": "Implement M12",
  "state": "working",
  "currentTask": "migrating Desktop IPC",
  "lastDecision": "reuse Stratum Protocol schemas",
  "waitingFor": null
}
```

Este contrato de presencia resumida **no forma parte de M12** salvo lo mínimo necesario para
que Desktop sea un cliente completo del protocolo. Debe diseñarse en un hito posterior.

## 5. Implicaciones para M12

M12 conserva un alcance estrecho:

- Desktop se conecta a `stratumd` mediante Stratum Protocol.
- Se retira progresivamente el sidecar/runtime aislado y el estado vivo duplicado de Desktop.
- Las sesiones de Desktop pasan a usar el mismo `SessionHost`, protocolo, memoria y modelo de
  eventos que el resto del harness.
- Se migra el estado persistido que corresponda sin crear una segunda fuente de verdad.
- Se preservan las capacidades y fronteras de autoridad del protocolo.
- CLI, Desktop y Dot quedan como clientes hermanos.

**M12 no incluye:** un Dot orquestador, mini-dots/agentes especializados, un scheduler
proactivo, una jerarquía de agentes, ingestión global de transcripts ni nuevas capacidades de
control implícitas.

## 6. Dirección posterior a M12

El roadmap posterior puede evolucionar por capas, sin bloquear M12:

1. **Unified Activity / Presence:** representación compacta del trabajo vivo y su contexto.
2. **Client capabilities / authority:** hacer explícita la relación entre observación,
   propiedad, control y elevación temporal.
3. **Assistant/Dot profiles:** perfiles especializados con herramientas, memoria y políticas.
4. **Orchestrator Dot:** superficie que mantiene continuidad global y delega en perfiles o
   agentes especializados; observa por defecto y solo interviene con autoridad explícita.
5. **Specialist Dots:** variantes enfocadas (desarrollo, infraestructura, música, etc.) sin
   duplicar el runtime; son perfiles/superficies sobre `stratumd` + `SessionHost`.
6. **Triggers / proactividad:** eventos y tareas programadas que puedan iniciar trabajo bajo
   políticas y permisos definidos.

La regla se mantiene en todas estas fases:

```text
interfaz ≠ runtime ≠ autoridad

cliente pide → stratumd arbitra → SessionHost ejecuta
```

## 7. Invariantes

- Un runtime de agente: `SessionHost`/StratumAgent.
- Un plano de control compartido: `stratumd`.
- Varias superficies independientes: CLI, Desktop, Dot y futuros clientes.
- Cerrar una superficie no debe detener trabajo alojado en otro anfitrión.
- Observar no equivale a controlar.
- La autoridad se concede explícitamente y con el menor alcance necesario.
- Los clientes no necesitan ingerir transcripts completos para mantener continuidad de trabajo.
- Los dots especializados no deben introducir implementaciones paralelas del runtime.

Esta decisión complementa `PRD_STRATUM_DOT.md`, `dot.md` y `protocol.md`. Si durante M12 se
descubre que alguno de esos documentos presupone que Desktop/Dot poseen el plano de control,
prevalece la regla de este documento y el descubrimiento debe anotarse en el hito correspondiente.

## 8. M12 — Desktop, cliente hermano (estado)

Implementado en M12. Desktop ya no tiene runtime ni plano de control propios: es un cliente de
`stratumd` como la CLI y Dot.

```text
CLI      ┐
Desktop  ├─ clientes hermanos → Stratum Protocol → stratumd → SessionHost
Dot      ┘
```

### 8.1 Auditoría y mapa

| Pieza de Desktop D0–D7 | Clasificación | Qué es ahora |
|---|---|---|
| Sidecar Node SEA (`stratum-cli/src/desktop/`, `desktop-server.ts`), supervisor, relé IPC y protocolo propio v9 (`sidecar_send`) | DELETE DUPLICATE | Nada: retirado. Desktop habla el Stratum Protocol con el enlace nativo compartido |
| `ConversationHost`/`ConversationSession` (un `StratumAgent` por conversación, sin `SessionHost`), `TurnScheduler` | DELETE DUPLICATE → `SessionHost` en `stratumd` | Cada conversación es una sesión del daemon; un run a la vez por sesión |
| Modo asistente (preset `assistant`, 12 tools, sin `exec`, ficheros confinados, memoria propia) | MOVE TO STRATUMD | Agente embebido `assistant`: `sessions.open { agent: 'assistant', cwd }`; lo monta `SessionHost` (`host/assistant.ts`). Lo puede abrir cualquier cliente |
| `DesktopSessionStore`, `DesktopConversationStore`, `transcript.ts`, reductor del webview | DELETE DUPLICATE → M11 + contrato | Conversación de la sesión: `ConversationStore` del daemon, foto + `sessions.history`; el webview reduce con `followSession`/`applyOverviewEvent` del contrato |
| Confirmaciones y preguntas propias | MIGRATE (tras M12) → broker nativo de Dot | Tarjetas en el chat de la sesión que se mira (`PendingRequests`). Resolver usa las mismas piezas que Dot: `dot_link::approver` (otra conexión, `roles: ['approver']`, `client.kind: 'desktop'`), clave en una ventana nativa aparte (`desktop-unlock`) y lo sensible confirmado en otra (`desktop-confirm`, `dot_link::ConfirmGate`). Sin concesiones con caducidad (revocarlas es de Dot) |
| Carpetas de conversación (D2): subidas, descargas, vista previa, exportar | KEEP UI (Rust) | La carpeta es el `cwd` de la sesión; Desktop la crea al abrir la conversación y Rust solo toca carpetas de su raíz (`folder_of`) |
| Retención y archivo de carpetas (D3) | MIGRATE → hecho en Rust (`retention.rs`) | Sin uso `compressAfterDays` (7) → `<id>.tar.gz`; `deleteAfterDays` (150) → eliminada (queda la marca `<id>.purged`); `0` desactiva cada etapa. Se reconoce por lo que hay en disco, sin registro. Barrido al arrancar y cada 6 h, con cerrojo frente a restaurar. Escribir o adjuntar restaura (`workspace_restore`); extracción confinada (sin `..`, rutas absolutas ni enlaces). Es política de ficheros de Desktop: el daemon no interviene |
| Ajustes (editor del `.stratumrc.json` global, asistente de providers) | MIGRATE → CLI instalada | Editor equivalente a `stratum config` (`settings.rs`): el lado nativo lee y escribe el fichero global llamando a `stratum config list\|set --global` (valores por la entrada estándar; no duplica el esquema Zod). Niveles A/B/C por clave (tabla en §8.4); el B pide la ventana de confirmación nativa. El protocolo sigue sin exponer la configuración (lleva credenciales) |
| Panel de memoria global (`STRATUM.md`, decisiones) | MIGRATE (tras M12) → `memory.*` | Las decisiones del asistente: sección «Memoria del asistente» del panel *Contexto y memoria* (`memory.decisions`/`memory.forget`, como el inspector de Dot M17). De quién es la memoria lo fija el perfil del enlace (`ClientProfile::memory_agent`: Desktop → `assistant`, Dot → `companion`), nunca el webview. El `STRATUM.md` global no se expone: el protocolo no lo sirve |
| Panel de trayectoria | MIGRATE (tras M12) → `trace.subscribe` | Panel anclado a la derecha del chat (raíl o `Ctrl+J`): el daemon retransmite la traza que escribe el runtime de la sesión que se mira (`trace.records`, solo `observe`); el enlace compartido la sigue por `LinkHandle::trace` (solo el perfil `DESKTOP` lo tiene, Dot no) y el webview valida y reduce con `trace/model.ts` del core. La de una sesión de terminal (par) no está: la escribe su proceso |
| `/clear`, `/compact` | DELETE | Eran del runtime propio; la compactación la decide la sesión (M11) |
| Ventana, tema, atajo, notificaciones, logs, actualizaciones, componentes de chat y Markdown | KEEP UI | Igual; las notificaciones salen de la foto de conjunto |

### 8.2 Decisiones

- **Un enlace nativo para los dos escritorios.** `stratum-dot/crates/dot-link` es el cliente nativo
  compartido; cada app usa su `ClientProfile` (`DOT`, `DESKTOP`): tipo y nombre en `core.hello`, qué
  sesiones sigue y qué métodos puede pedir. El perfil solo **resta**: la autorización sigue siendo
  del daemon. Dot sigue sin poder cerrar ni reconfigurar sesiones; Desktop sí (`sessions.close`,
  `sessions.setModel`) y además lee `sessions.history|context|memory`.
- **Estado operativo, contexto y transcript, por capas (§4).** Desktop sigue la foto de conjunto
  (`overview`) para la lista y **solo** la sesión que se mira para su conversación
  (`FollowPolicy::Focused`); lo anterior a la foto se pide bajo demanda (`sessions.history`).
- **Origen sin autoridad (§3).** `ProtocolSession.origin` (el `ClientKind` de quien la abrió o la
  aloja como par; se conserva al traspasar y al reiniciar el daemon). No se introdujo un enum nuevo:
  reutiliza `CLIENT_KINDS`. Nada lo lee para decidir permisos.
- **Daemon.** Desktop usa el Stratum instalado y el mecanismo oficial: descubre
  `~/.stratum/daemon/endpoint.json` y, si no hay daemon, `stratum daemon start` (una vez por
  intento). Cerrar Desktop suelta la conexión y nada más.
- **Lo antiguo, una vez.** `stratum desktop import` traspasa las conversaciones de Desktop D1–D7 al
  daemon por el camino de M10 (registro `~/.stratum/desktop/imported.json`, versión 1). Desktop no
  vuelve a leer `~/.stratum/desktop/{sessions,conversations}`; la memoria de decisiones del
  asistente se copia una vez a `~/.stratum/assistant/memory/`.

### 8.3 Lo que M12 deja fuera

Aprobar desde Desktop (hecho después de M12 con la autoridad separada de M8/M9, ver §8.1), retención
de carpetas (hecha después, §8.1), memoria global (sus decisiones, hechas después: §8.1), trayectoria (hecha después: §8.1), Unified Presence, Dot orquestador y cualquier convergencia de
producto entre Dot y Desktop.

### 8.4 Ajustes editables: niveles A, B y C

Desktop edita el `.stratumrc.json` **global** (nunca uno de proyecto) con la misma validación que
`stratum config`, sin duplicar el esquema:

```
webview ─ desktop_settings_set(ruta, valor) ─► settings.rs ─ clasifica la ruta (lista cerrada, en Rust)
                                                  │ nivel B: ventana nativa (settings_gate.rs, la de confirm.rs)
                                                  ▼
                       stratum config set --global --json --stdin <ruta>   (settings_cli.rs; el valor por stdin)
```

- **Lo escribe la CLI instalada** (`STRATUM_DESKTOP_CLI` o `stratum` del `PATH`, como el arranque del
  daemon): valida con su Zod y escribe de forma atómica; un fichero de un `schemaVersion` más nuevo no se
  toca. `stratum config list --global --json` da el JSON crudo (con `${VAR}` sin expandir) y los defaults.
  Por el protocolo no pasa nada: el daemon no expone la configuración.
- **El nivel lo decide Rust** sobre la ruta normalizada (sin `..`, vacíos, corchetes, barras, prototipos,
  solo `[A-Za-z0-9_-]` por tramo). Solo se escribe lo que está en la lista cerrada `SPECS`; **lo no
  clasificado es C**. El webview solo pinta lo que Rust le manda.
- **Secretos**: el webview no recibe ninguno (llegan como «hay una» o el nombre de su `${VAR}`); la clave
  nueva sale por stdin, no vuelve, no va a la ventana de confirmación («se cambiará la clave de API de
  X») ni a los logs. Un valor con `${VAR}` se conserva literal.
- **Confirmación (B)**: la lee el lado nativo (clave, valor viejo → nuevo), ventana aparte con espera
  mínima, una a la vez, caduca; ventana cerrada o fallo = no se escribe. Antes de escribir se relee y, si
  el valor cambió mientras se confirmaba, se aborta. No reutiliza `ConfirmedAction` porque `ConfirmGate`
  está atado a las solicitudes del daemon (broker de aprobar); es la misma ventana y las mismas reglas.
- **Fallos**: CLI ausente, sin `--global` o con una salida que no se entiende → editor en solo lectura con
  «actualiza la CLI»; el error de `config set` se enseña tal cual y el fichero no queda a medias.
- **Reinicio** (por prefijo): `desktop.*` → volver a abrir Desktop; `daemon.*`, `logging.*`, `trace.*` →
  reiniciar el daemon; el resto → sesión nueva.

| Nivel | Claves (prefijo de la ruta) | Cómo |
|---|---|---|
| **A** (libre) | `provider.default`, `provider.providers.<alias>.model\|contextWindow`; `memory.retrievalTopK\|similarityThreshold\|autoExtract\|embeddingWarmup`, `memory.session.enabled\|compactAt\|targetContext\|timeoutMs`; `context.*`; `tools.bashTimeout\|execMaxBytes`, `tools.webSearch.maxResults`, `tools.jobs.*` (límites); `agent.*`; `agents.*`; `logging.level\|stderr`, `logging.file.enabled\|maxBytes\|maxFiles`; `trace.enabled\|retentionDays\|maxFieldChars`; `skills.enabled`; `prompt.guides`; `snapshots.*`; `tui.*`; `session.planRetentionDays`; `daemon.idleExitMinutes\|eventBuffer\|maxSessions\|detachedTtlMinutes`; `desktop.*` salvo `workspaces.root` | Se guarda al momento |
| **B** (confirmación nativa) | `provider.providers.<alias>.baseUrl\|apiKey` y alta de un provider; `memory.embeddingModel\|embeddingDimension\|extractionModel`, `memory.embeddingEndpoint.*`, `memory.session.allowRemote\|extractor.*\|summarizer.*`; `tools.confirmDestructive\|auditLog`, `tools.webSearch.backend\|apiKey\|tavilyApiKey`, `tools.jobs.enabled\|subagentAccess`; `logging.redact`; `trace.screenshots`; `environments.<nombre>.tier\|policy\|requirePlan\|readOnly\|confirmation`; `session.profile`; `daemon.autoStart\|approvalTimeoutMinutes\|persistSessions`; `desktop.workspaces.root` | Ventana aparte con clave, valor viejo → nuevo |
| **C** (solo CLI) | `plugins`, `mcp`, `companion`, `ssh`, `box`, `channels`, `imageGeneration`, `lsp`, `schemaVersion` (cualquier cosa que ejecuta código o abre acceso); `tools.testCommand\|guardedCommands\|destructivePatterns\|sensitivePathAllowlist\|webFetch\|redaction`; `session.profiles`; rutas (`memory.projectFile\|globalFile\|decisionsFile\|vectorDb`, `logging.file.dir`, `trace.dir`, `prompt.guidesDir`, `skills.registryFile\|builtin`); `provider.providers.<alias>.models\|timeouts\|cache\|pricing\|type`; `environments.<nombre>.match`; **toda clave desconocida o no clasificada** | Solo lectura («edítalo con `stratum config`»); Desktop dice si hay algo definido, nunca qué |

Por qué sube de nivel lo dudoso: `desktop.workspaces.root` es B (decide dónde escribe Desktop);
`memory.extractionModel`, `memory.embeddingModel` y `daemon.persistSessions` son B (mandan texto fuera o
guardan conversaciones en disco); las listas y los mapas (reglas de guardas, patrones, hosts) son C porque
`set` por ruta solo escribe valores sueltos, y los ids de modelo llevan puntos (`models.<id>`), que la ruta
no puede direccionar.
