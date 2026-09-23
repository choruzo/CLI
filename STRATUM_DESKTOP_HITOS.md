# Stratum Desktop — Plan de hitos de implementación

> Desglose ejecutable de Stratum Desktop a partir de
> `STRATUM_DESKTOP_PROJECT_DEFINITION.md`, con las resoluciones de sus puntos
> ciegos (sección 15) y los nuevos de este plan (sección *Puntos ciegos del modo
> Chat*, `[16.x]`). Cada hito lista objetivo, tareas, criterios de aceptación y
> dependencias.
>
> Convención de estado: ⏳ pendiente · 🔄 en curso · ✅ cerrado.
> Los puntos ciegos se referencian como `[15.x]` y `[16.x]`.

---

## Orientación: primero un asistente, después un entorno de código

La CLI es un agente de código: su prompt, su toolset y su memoria giran en torno
a un repositorio. **Stratum Desktop arranca como asistente conversacional**, al
estilo de Claude Desktop: el usuario habla con el agente, le sube ficheros y
recibe respuestas y ficheros generados. No hay un proyecto abierto ni un
repositorio de por medio.

El core es el mismo (`StratumAgent`, `ReactLoop`, providers, tools, memoria);
cambian tres cosas, todas por configuración del agente y sin ramificar el core:

1. **Prompt de asistente.** Un preset `assistant` sustituye al prompt estilo
   opencode (`default.txt`). Conserva `# Identity`, `# Language`,
   `# Asking the user` y la memoria de largo plazo; elimina todo lo que presupone
   un repositorio: `# Shell`, `# Work routing`, `# Testing discipline`, el bloque
   git del `<env>`, `STRATUM.md` de proyecto y `/init`. Añade un bloque
   `# Workspace` que describe el espacio de trabajo de la conversación.
2. **Espacio de trabajo aislado por conversación.** Cada conversación tiene su
   carpeta propia gestionada por la app. Los ficheros que sube el usuario se
   copian ahí y el agente trabaja **solo** ahí con las tools de fichero de la
   CLI. Nunca toca el disco del usuario directamente.
3. **Retención.** Un espacio de trabajo sin uso durante X días se comprime, y
   pasados Y días se elimina. La conversación (el texto) se conserva; lo que
   caduca son los ficheros.

**Modo Code, más adelante.** Un conmutador **Chat | Code** (como el de Claude
Desktop) activará el comportamiento actual de la CLI: abrir carpeta, prompt de
código, toolset completo, `STRATUM.md` de proyecto. El modo se fija **por
conversación al crearla**: cambiarlo a mitad dejaría un historial razonado con
un prompt y un toolset distintos. El conmutador decide el modo de la
*siguiente* conversación nueva. Todo lo que hoy depende del cwd (antiguo
`[15.3]`) se mueve a ese hito.

### Qué hereda cada modo del core

| Pieza del core | Chat (v1) | Code (D8) |
|---|---|---|
| Prompt | preset `assistant` | preset `coding` (el actual) |
| Raíz de trabajo | `workspaces/<conversationId>/` (gestionada) | carpeta elegida por el usuario |
| `read_file`/`write_file`/`edit_file`/`glob`/`list`/`grep` | ✅ confinadas al workspace | ✅ |
| `exec` | ❌ en v1 (ver `[16.1]`) | ✅ |
| `web_search` / `web_fetch` | ✅ | ✅ |
| `question` / `todo` | ✅ | ✅ |
| `store_decision` / `recall_decisions` | ✅ memoria **global** del asistente | ✅ memoria del proyecto |
| `present_plan`, `delegate_task`, `test_evidence`, SSH, MCP | ❌ | ✅ |
| `STRATUM.md` | solo el global | global + proyecto |

El filtrado sale de `ToolsetFilter` (Hito 15), que ya oculta tools **y** rechaza
en ejecución lo que el filtro no permite; el prompt, de `promptEnv()` como punto
único. Ningún modo añade ramas nuevas al loop.

---

## Resumen de la ruta

| Hito | Foco | Depende de | Puntos ciegos que cierra |
|------|------|-----------|--------------------------|
| **D0** 🔄 | Scaffolding + sidecar empaquetado + ping seguro | stratum-cli Hito 4 | 15.2, 15.6, 15.10, 15.11 |
| **D1** ✅ | IPC seguro + chat de asistente en una conversación | D0 | 15.1, 15.4, 15.5, 15.9, 15.13, 16.6 |
| **D2** 🔄 | Espacio de trabajo aislado + subida y descarga de ficheros | D1 | 15.8, 16.1, 16.2, 16.3, 16.4 |
| **D3** 🔄 | Retención: compresión y purga de workspaces | D2 | 16.5, 16.7 |
| **D4** 🔄 | Conversaciones múltiples + Sidebar + StatusBar + InputArea | D3 | 15.12, 15.15 |
| **D5** | Settings Panel + ProviderWizard + config compartida | D4 | 15.7 |
| **D6** | Integración con el SO + pipeline de build | D5 | — |
| **D7** | Polish: frameless, animaciones, a11y, E2E | D6 | 15.14 |
| **D8** | Modo Code: conmutador Chat \| Code | D7 | 15.3 |

Regla de oro: ningún hito se cierra sin que sus criterios de aceptación pasen y
sin que los puntos ciegos asignados estén resueltos y verificados.

---

## D0 — Scaffolding, sidecar empaquetado y arranque seguro 🔄

**Objetivo.** Una ventana Tauri vacía que arranca un sidecar `stratum-core`
empaquetado, establece un canal autenticado y responde a un `ping`. Sin chat
todavía. Aquí se cierran las decisiones de empaquetado y ciclo de vida que el
resto del proyecto asume.

**Estado (2026-09-21).** Implementado y verificado en **Windows** y en **Linux**
(WSL2 Ubuntu 24.04 con WSLg). Decisiones y cifras medidas en
`stratum-desktop/README.md`. Cambio de diseño respecto a §3: el webview no puede
abrir un pipe, así que Rust hace de relay y el handshake, y el token viaja por
entorno.

| Criterio | Windows | Linux |
|---|---|---|
| Ventana + sidecar conectado | ✅ `tauri dev` y release | ✅ release y AppImage (X11 en WSLg) |
| Cero huérfanos al cerrar la ventana | ✅ salida ordenada con código 0 en ~130 ms | ✅ `WM_DELETE_WINDOW` → salida ordenada con código 0; el socket se borra |
| Cero huérfanos si Tauri muere | ✅ `kill -Force` → Job Object | ✅ `SIGKILL` → `PDEATHSIG` → apagado ordenado |
| Sin diálogo de firewall | ✅ 0 sockets TCP/UDP en el sidecar | ✅ 0 TCP/UDP; unix socket 0600 |
| Bundle con sidecar que arranca sin Node | ✅ `.msi` 61 MB / NSIS 40 MB; release con PATH sin Node | ✅ `.deb` 65 MB (depende solo de WebKitGTK/GTK), `.AppImage` 140 MB; ambos con PATH sin Node |
| `schemaVersion` incompatible → error claro | ✅ `sidecar_error` fatal `schema_incompatible`, el sidecar sigue vivo | ✅ tests |

Pendiente para cerrar D0:
- Prueba en una máquina Windows limpia, que los criterios dan por supuesta
  (Windows 11 Home no trae Windows Sandbox: hace falta VM u otro equipo).
- Revisión visual de la ventana: la conexión se ha verificado por las trazas del
  relay y los tests del frontend, no mirando la UI.
- `dpkg -i` del `.deb` en un sistema con `sudo`: se ha revisado su contenido y
  el AppImage se monta sobre el mismo árbol, pero no se ha instalado.

### Tareas

1. **Scaffolding del workspace** `stratum-desktop/` (fuera de `stratum-cli/`).
   - `cargo tauri init` con Tauri v2; Vite + React 18 + TypeScript.
   - Estructura de carpetas según sección 2 del documento de definición.
   - `theme.ts` re-exportado de `stratum-cli/src/cli/ui/theme.ts` + `injectCssVars`.
   - CSS vars verificadas en `:root` con un render trivial.

2. **`[15.2]` Empaquetado del sidecar Node como binario autónomo.**
   - Añadir `desktop-server.ts` a `stratum-cli/src` (entry alternativo).
   - Compilar el core + dependencias nativas (`sqlite-vec`, `better-sqlite3`,
     ONNX de `@xenova/transformers`) a un binario por plataforma
     (recomendado: `pkg`/`nexe` o `node --experimental-sea`, con los `.node`
     incluidos). Documentar el método elegido.
   - Registrar el binario como `externalBin` (sidecar) en `tauri.conf.json`.
   - **Corregir la cifra de tamaño** en la definición: el shell Tauri es ~5–10 MB;
     la app instalada incluye el sidecar (decenas de MB). Anotarlo.

3. **`[15.6]` Versión pineada del core.**
   - El sidecar empaquetado es una versión fija incluida en el bundle (no la CLI
     global del usuario).
   - Versionar el schema de `.stratumrc.json` y de `SessionStore` con un campo
     `schemaVersion`; el sidecar detecta versión incompatible y lo reporta.

4. **`[15.10]` Transporte local sin parsing de stdout ni firewall.**
   - Tauri elige el puerto (o usa named pipe en Windows / unix socket en Linux) y
     lo pasa al sidecar por argumento/env. Eliminar el parsing de stdout para el
     puerto.
   - Si se usa TCP, bind explícito a `127.0.0.1` y validar que no dispara el
     diálogo de firewall en arranque limpio de Windows.

5. **`[15.11]` Ciclo de vida del sidecar.**
   - Matar el sidecar en `exit`/`window-close` de Tauri y en señales (SIGINT/SIGTERM).
   - El sidecar cierra limpiamente sus recursos; preparar el gancho para cerrar
     subprocesos MCP (que llegan en runtime con Hito 4 de la CLI).
   - Redirigir stdout/stderr del sidecar a `logs/sidecar.log`.

6. **Handshake mínimo + ping.**
   - Tauri genera un token aleatorio por arranque y lo pasa al sidecar y al
     frontend (evento `sidecar://ready`).
   - El frontend conecta, envía `ping`, recibe `pong`. Render de un indicador
     "agente conectado / desconectado".

### Criterios de aceptación

- `cargo tauri dev` levanta ventana + sidecar; el indicador muestra "conectado".
- Cerrar la ventana deja **cero procesos Node huérfanos** (verificado en Win+Linux).
- Arranque limpio en Windows **no** muestra diálogo de firewall.
- El bundle (`tauri build`) incluye el sidecar y arranca en una máquina sin Node
  instalado.
- Sidecar con `schemaVersion` incompatible reporta error claro en vez de crashear.

---

## D1 — IPC seguro y chat de asistente en una conversación ✅

**Objetivo.** Conversación completa con el asistente en una sola conversación:
streaming de `AgentEvent`s, `ToolCallBlock` con sus 4 estados, preguntas del
agente, confirmaciones y cancelación. Sin ficheros todavía: el toolset es web,
memoria, `question` y `todo`.

**Estado (2026-09-22): cerrado.** Verificado en Windows y en Linux con un
provider real (`gemma-4-12b` en llama.cpp). Plan revisado por Codex antes de
implementar e implementación revisada después (ver abajo).

- **Windows**: la ventana real, manejada por la depuración remota de WebView2
  (tabla de abajo).
- **Linux** (WSL2 Ubuntu 24.04, WSLg/X11): `cargo test` 21/21 (4 e2e contra el
  SEA de Linux), suite de la CLI (915 + 17 omitidos por ser de Windows) y del
  frontend (56). Con la app real: matar el sidecar lo relanza en ~1 s y el
  relanzado sigue vivo (el hilo dedicado mantiene `PDEATHSIG`); `SIGKILL` a
  Tauri → el sidecar recibe `SIGTERM` y se apaga, cero huérfanos. La UI se pinta
  igual en WebKitGTK, pero WSLg no deja inyectar teclado (ni `XSendEvent` ni
  XTEST llegan a la ventana), así que la conversación se probó con un cliente
  que habla el protocolo del relay por el unix socket: asistente sin tools ante
  «este proyecto», `question` con acuse `prompt_resolved`, `cancel` en 102 ms,
  `SIGKILL` + relanzar → `resumed: true` y el agente recuerda lo hablado, y
  apagado ordenado por EOF en stdin con código 0. El usuario completó la prueba
  a mano en la ventana de Linux: la app se abre y el agente se comporta igual
  que en Windows.

| Criterio | Estado |
|---|---|
| Streaming + `ToolCallBlock` en 4 estados | ✅ `web_search` real pasa por `pending → running → completed`; `error` cubierto por tests. Respuesta larga (7,3k caracteres, 4 bloques de código, tabla) en 87 s: 144 fps de media, frame p99 7,1 ms, máximo 35 ms, **cero long tasks** (15.13) |
| Se comporta como asistente | ✅ Se presenta como Stratum Desktop con su modelo; ante «qué hay en este proyecto» explica que no tiene acceso a ficheros, sin llamar a ninguna tool |
| `question` desde la UI y el turno sigue | ✅ Pregunta con 6 opciones, elegida «Fantasía» desde la UI y el turno continúa usando la respuesta |
| `cancel` aborta | ✅ «Detener» corta el stream en ~240 ms (prueba con un stream real) |
| Matar el sidecar y reconectar con contexto | ✅ `Stop-Process -Force` en plena conversación: banner «Reintentando (1/4)», relanzado en ~1 s, conversación rehidratada (`resumed=true`, 8 mensajes) y el agente recuerda lo hablado antes del reinicio |
| Conexión sin token rechazada | ✅ tests del servidor + e2e contra el SEA |
| La CLI sin cambios | ✅ suite completa verde; prompt `coding` idéntico byte a byte al de `HEAD` |

Hallazgos de la prueba real, corregidos: el bloque de `question` acababa en
error aunque la pregunta se respondiera (el loop no emite `tool_result` para
las tools de control; ahora `questions_answered` lo completa), y enviar un
mensaje con la vista desplazada hacia arriba no volvía al fondo. Anotado sin
corregir: las fórmulas LaTeX (`$O(1)$`) se muestran en crudo (sin soporte de
matemáticas en el renderer). Un servidor llama.cpp sin `--jinja` rompe modelos
como `gpt-oss` (sin rol system ni tools): no es de Stratum, pero conviene
detectarlo en el ProviderWizard de D5.

Decisiones tomadas durante la implementación:
- **`confirm_request` lleva `description`, no `params`.** Es la línea de
  `describeCall` que el dispatcher ya redacta antes de pedir confirmación; los
  parámetros crudos nunca llegan al webview.
- **`allow-all` por conversación lo recuerda el sidecar**, no el dispatcher: el
  `ToolDispatcher` vive un turno.
- **Un `ToolRegistry` y un `ProviderRouter` por conversación**: las tools
  deshabilitadas por reintentos y el fallback no se contagian entre conversaciones.
- **Supervisor en un hilo del SO dedicado**: todos los `spawn` salen de él para
  que `PDEATHSIG` (Linux) siga ligado a un hilo que vive tanto como la app.
- **Un turno cancelado se guarda tal cual** (como en la CLI); uno a medias cuando
  muere el sidecar no llega a guardarse y la UI lo ofrece para reintentar.
- **Al reanudar, el preset `assistant` recompone siempre el system prompt**: una
  sesión de otro modo o editada a mano no puede colar el prompt de código.
- **Revisión final de Codex**: un P0 y cinco P1 corregidos. (1) Una sesión cuyo
  turno no atiende el cierre a tiempo queda *retirada*: no vuelve a guardar ni a
  emitir, así que no puede pisar la conversación reabierta. (2) Las tramas llevan
  el `connectionId` del cliente y se descartan al ejecutarse si ya perdió el lease.
  (3) Validación estructural completa en el webview de lo que llega del sidecar.
  (4) Un `turn_ended` con `error` deja el turno en error. (5) Preguntas y
  confirmaciones siguen a la vista hasta el acuse `prompt_resolved`. (6)
  `describeCall` redacta también por nombre de campo (`password`, `token`,
  `apiKey`…), con efecto también en la confirmación de la CLI.
- **Enlaces sin `href`**: botón con rol de enlace que abre el navegador del sistema
  (`tauri-plugin-opener`, scope `http(s)`/`mailto`); ninguna vía del webview
  (clic central, menú contextual) puede navegar fuera de la app.

### Tareas

1. **`[15.1]` Autenticación del canal (bloqueante).** Ya resuelta en D0 para el
   pipe/socket (token en la primera trama, límite de 4 KiB antes de autenticar);
   aquí se extiende a los mensajes de chat.
   - Test: una conexión sin token es rechazada antes de poder emitir un `chat`.

2. **Protocolo IPC tipado** (ampliación de `src/desktop/protocol.ts`).
   - Entrada: `chat`, `cancel`, `new_conversation`, `close_conversation`,
     `answer_questions` (todos con `conversationId`).
   - `[15.9]` `cancel` viaja por el canal del stream, no por `invoke`. Los
     `invoke` de Tauri quedan para request-response ajeno al stream (config,
     guardar un fichero en disco).
   - Salida: los `AgentEvent`s de `agent/types.ts` con `conversationId`.

3. **Preset de prompt `assistant`** (`[16.6]`, en `stratum-cli`).
   - `StratumAgentOptions.promptPreset: 'coding' | 'assistant'` (default
     `coding`: la CLI no cambia). Se resuelve en `promptEnv()`, nunca en otro
     sitio, por la misma razón que el bloque de perfil del Hito 15.
   - Texto base propio: asistente de propósito general, tono conversacional,
     respuestas en markdown, sin supuestos de repositorio. Conserva
     `# Identity`, `# Language`, `# Asking the user` y `# Long-term memory`;
     el `<env>` se reduce a plataforma, fecha y modelo.
   - Toolset del modo vía `ToolsetFilter`: `web_search`, `web_fetch`, `question`,
     `todo`, `store_decision`, `recall_decisions`.
   - Memoria del asistente: `DecisionStore`/`VectorStore` en
     `~/.stratum/desktop/memory/`, separada de la de cualquier proyecto.
   - Tests del preset: ningún bloque de código se cuela en el prompt y una tool
     fuera del filtro se rechaza al ejecutar.

4. **`[15.4]` Confirmaciones y preguntas por el canal.**
   - `confirm_request { callId, tool, description }` / `confirm_response { callId, decision }`
     (`description` redactada; ver *Decisiones* arriba);
     el sidecar bloquea hasta la respuesta, `deny` ante timeout o cierre de la
     conversación, `allow-all` con alcance **por conversación**.
   - `question` se resuelve con `RunOptions.onAskQuestions` hacia un componente
     `QuestionPrompt` (mismas reglas de dominio cerrado que la CLI).
   - Aunque el toolset de D1 apenas tenga tools destructivas, el protocolo se
     cierra aquí: D2 lo necesita desde el primer día.

5. **`[15.5]` Estado del agente vs. reconexión.** El canal multiplexa por
   `conversationId`; tras una caída del sidecar se rehidrata el agente desde la
   sesión persistida. Banner de reconexión con backoff 1→2→5→10 s (máx. 4).

6. **Componentes de chat** (`ConversationView`, `MessageList`, `AgentMessage`,
   `UserMessage`, `ToolCallBlock`, `StreamingText`, `MarkdownRenderer`,
   `InputArea` básico). `useAgentStream.ts` trata `tool_call_start` como
   actualización del mismo tool call por `id`.

7. **`[15.13]` Render incremental de markdown**: memoizar bloques estables y
   parsear solo el delta. Medir frame rate con una respuesta larga con código.

### Criterios de aceptación

- Conversación end-to-end con streaming fluido y `ToolCallBlock` en sus 4 estados.
- El agente se presenta y se comporta como asistente: pedirle «qué hay en este
  proyecto» no le lleva a buscar un repositorio.
- Una pregunta del agente (`question`) se responde desde la UI y el turno continúa.
- `cancel` aborta la generación en curso.
- Matar el sidecar y reconectar continúa la conversación con contexto.
- Conexión sin token rechazada (test automatizado).
- La CLI sin cambios de comportamiento: la suite completa sigue verde.

---

## D2 — Espacio de trabajo aislado y ficheros 🔄

**Objetivo.** El usuario sube ficheros a la conversación, el agente trabaja con
ellos con las tools de fichero de la CLI dentro de una carpeta propia de la
conversación, y lo que produce se puede descargar.

**Estado (2026-09-22): implementado y verificado con modelo real; pendiente la
prueba a mano en la ventana.** Suites verdes: CLI 972, frontend 66, Rust 36 (5
e2e contra el SEA, ahora con un home temporal propio: ya no leen la config ni
escriben en el `~/.stratum` real).

Prueba real con `gemma-4-12b` (llama.cpp) contra el SEA, con un cliente del
protocolo que hace de Rust (copia a `inputs/` + `workspace_touch`) y de webview:
- Subido un `ventas.csv` y pedido un resumen mensual en CSV: `read_file` +
  `write_file`, importes correctos, `outputs/resumen_ventas.csv` anunciado en
  `workspace_files` antes del `turn_ended`, original intacto.
- Pedido leer `../`, una ruta absoluta de fuera y sobrescribir el original: el
  modelo se niega solo. Forzando las llamadas, las cuatro (`read_file` relativa
  y absoluta, `list_directory ..`, `write_file inputs/…`) se vetan en
  `preflight`; el contenido de fuera no aparece en ninguna trama.

Decisiones tomadas (con el usuario, antes de implementar):
- **Visión aplazada.** El core no tiene contenido multiparte ni capacidad
  `vision`; una imagen se sube como fichero más. Pendiente para un hito propio
  o D5 (ProviderWizard).
- **«Abrir» solo para tipos inertes** (documentos, datos, imágenes: `pdf`,
  `csv`, `md`, `docx`, `png`…). Fuera `html`/`svg` (ejecutan JS en el
  navegador), scripts, ejecutables y Office con macros: esos solo se guardan.
- **Límites por defecto 25 MB por fichero / 250 MB por workspace.**
- **`desktop.workspaces.root` admite cualquier ruta absoluta** (otro disco); se
  rechazan relativas, la raíz de una unidad y el home o un ancestro suyo, con
  aviso y vuelta al default.

Decisiones de diseño:
- **`ToolContext.workspace`** (`WorkspaceConfinement { root, readOnly, writable }`)
  en vez de un `workspaceRoot` suelto: hace falta expresar `inputs/` de solo
  lectura y que solo se escriba en `outputs/` y `scratch/` (ni la raíz ni
  `.workspace.json`). Veto en `tools/fs/confine.ts` por `realpath` —con
  `lstat` para que un symlink roto no se salte el control—, que **falla
  cerrado** (el dispatcher deja pasar un `preflight` que lanza) y se repite en
  `execute`. En Windows además veta UNC/dispositivos, rutas relativas a
  unidad, flujos alternativos y nombres de dispositivo. `glob`/`grep` no
  siguen enlaces con workspace y `grep` no lanza `rg`.
- **Las concesiones las hace Rust.** El diálogo (`tauri-plugin-dialog` usado
  solo desde Rust, sin permisos para el webview) y el drag & drop entregan las
  rutas a Rust, que devuelve al webview candidatos con id opaco; el webview
  adjunta nombrando ids. Un webview comprometido no puede pedir que se copie
  un fichero que el usuario no eligió.
- **Protocolo v3**: `chat.attachments` (rutas `inputs/…`, comprobadas otra vez
  en el sidecar), `workspace_files` (lo nuevo o modificado en `outputs/` por
  turno, antes del `turn_ended`), `handshake_ok.workspaces` (raíz y límites,
  solo para Rust) y `workspace_touch` (solo Rust; fuera de la lista blanca del
  webview).
- **Copia al adjuntar, no al enviar**: el error de límite o de lectura sale en
  el acto, y quitar un chip antes de enviar borra la copia (solo si ningún
  `chat` la llevó ya).

Ventana real en Windows (`tauri dev` + CDP, con `gemma-4-12b`; los diálogos
nativos se rellenaron por mensajes Win32 sin robar el foco):
- «Adjuntar» con un `.csv` y un fichero de 30 MB: el CSV queda listo y el
  grande se muestra rechazado («supera el límite de 25.0 MB por fichero») sin
  llegar a copiarse (`inputs/` solo contiene el CSV).
- El mensaje sale con su chip; el agente lee y escribe, y la tarjeta de
  `resumen_ventas.csv` se pinta con «Vista previa» (tabla), «Abrir» y
  «Guardar como…».
- «Guardar como…» copia el fichero; la prueba destapó que el diálogo arrancaba
  en el cwd del proceso (`src-tauri/` en dev), así que ahora abre en
  Descargas. El nombre personalizado no se pudo teclear desde fuera (el
  diálogo moderno no lo expone a la automatización): se guardó con el nombre
  por defecto.
- «Abrir» entrega el fichero al SO (en esta máquina `.csv` no tiene app
  asociada y Windows mostró «Abrir con»).

Linux (WSL2 Ubuntu 24.04): CLI 955 + 17 omitidos por ser de Windows (`tsc`
limpio), frontend 66 (typecheck limpio), SEA de Linux con protocolo 3 y los
tres nativos, y `cargo test` 35/35 con los 5 e2e (incluido
`workspace_de_una_conversacion`). Aquí sí corren los tests de symlink de
fichero y symlink roto del confinamiento, que en Windows sin modo desarrollador
se saltan.

Pendiente para cerrar D2:
- Drag & drop real sobre la ventana (no se puede simular por CDP) y
  «Guardar como…» eligiendo otro nombre y carpeta, a mano.

### Estructura

```
~/.stratum/desktop/workspaces/<conversationId>/
  inputs/      ← copias de lo que sube el usuario (solo lectura para el agente)
  outputs/     ← lo que el agente genera para el usuario
  scratch/     ← ficheros intermedios del agente
  .workspace.json  ← metadatos: creado, último uso, estado, tamaño, fijado
```

La raíz es configurable (`desktop.workspaces.root`) y siempre vive bajo los datos
de la app, nunca en una carpeta del usuario.

### Tareas

1. **`WorkspaceManager`** (sidecar, `src/desktop/workspace.ts`): crear, resolver,
   marcar uso (`lastUsedAt` en cada turno y en cada subida), calcular tamaño.
   Escritura atómica de `.workspace.json`, como el resto de stores.

2. **`[16.2]` Confinamiento de las tools de fichero** (en `stratum-cli`).
   - `ToolContext.workspaceRoot` opcional. Presente → un `preflight` común a
     `read_file`/`write_file`/`edit_file`/`glob`/`list`/`grep` veta toda ruta
     cuyo `realpath` quede fuera de la raíz: `..`, rutas absolutas, symlinks y
     junctions de Windows. Es un veto inapelable (mismo mecanismo que las rutas
     `blocked` del Hito 11), no una confirmación.
   - Las rutas relativas se resuelven contra la raíz del workspace.
   - `inputs/` es de solo lectura para el agente: preserva el original subido.
   - Tests con symlink y junction apuntando fuera, y con `..` encadenados.

3. **`[16.1]` Sin `exec` en el modo Chat v1.** Confinar las tools de fichero es
   un control fiable; confinar un shell por directorio no lo es (`cd ..`, rutas
   absolutas, cualquier intérprete). `exec` queda fuera del toolset del preset
   `assistant` hasta tener un aislamiento real del SO (ver *Futuro*).

4. **Subida de ficheros.**
   - Drag & drop sobre el `InputArea` y botón de adjuntar (diálogo de Tauri).
   - Rust copia al `inputs/` del workspace (el webview nunca recibe rutas del
     disco del usuario más allá de la selección). Nombres saneados y colisiones
     resueltas con sufijo.
   - `[16.3]` Límites: tamaño por fichero y por workspace
     (`desktop.workspaces.maxFileMB`, `maxWorkspaceMB`), con error claro en la UI.
   - El mensaje del usuario lleva la lista de adjuntos; el agente los ve como
     rutas del workspace (`inputs/informe.pdf`), nunca la ruta original.
   - Imágenes: si el provider declara `vision`, además se adjuntan como imagen.

5. **`[16.4]` Contenido de ficheros como dato no confiable.** El bloque
   `# Workspace` del prompt declara que el contenido de los ficheros subidos son
   datos, no instrucciones. La redacción de salidas del Hito 16 ya se aplica a
   todo `read_file`.

6. **Descarga de resultados.** Lo que el agente escribe en `outputs/` aparece en
   el mensaje como tarjeta de fichero (nombre, tamaño, tipo) con «Guardar
   como…» (diálogo de Tauri) y «Abrir». Vista previa para texto, markdown,
   imagen y CSV.

7. **`[15.8]` Scope fs de Tauri.** Con el workspace bajo los datos de la app, el
   scope se reduce a esa raíz + los diálogos de abrir/guardar. Documentarlo en
   `capabilities/default.json`.

### Criterios de aceptación

- Subir un `.csv`, pedir un resumen y un fichero derivado: el derivado aparece
  en `outputs/` y se guarda donde el usuario elija.
- Pedir al agente que lea `../` o una ruta absoluta del disco → veto, sin
  confirmación que lo levante; ídem a través de un symlink/junction.
- El original subido sigue intacto tras la conversación.
- Un fichero por encima del límite se rechaza en la UI antes de copiarse.
- Dos conversaciones no ven los ficheros de la otra.

---

## D3 — Retención: compresión y purga de workspaces 🔄

**Objetivo.** Los workspaces no crecen sin límite: tras X días sin uso se
comprimen y tras Y días se eliminan, sin perder la conversación ni sorprender al
usuario.

**Estado (2026-09-22): implementado y verificado contra el SEA con modelo real;
pendiente de revisar a mano en la ventana el aviso de purga y «Descargar todo».**
Suites verdes: CLI 1006 (`tsc` y lint limpios), frontend 75 (typecheck limpio)
y Rust 39 (5 e2e contra el SEA con protocolo 4; el de workspace fija la
conversación por la lista blanca de Rust).

| Criterio | Estado |
|---|---|
| `active → archived → purged` con plazos cortos y reloj inyectable; la conversación se abre en cada estado | ✅ tests con reloj inyectable, y contra el SEA con `gemma-4-12b` y plazos de 20 s / 60 s: archivado al arrancar, reabrir emite `restoring` antes de `conversation_opened`, historial intacto (20 → 24 mensajes), el modelo lee el fichero restaurado, y tras la purga la conversación se abre con `filesExpiredAt` |
| Reabrir una `archived` restaura byte a byte | ✅ sha256 de cada fichero (binario, unicode, nombres de 140 caracteres, carpetas vacías) en los tests y contra el SEA |
| Matar el proceso a mitad de una compresión no pierde datos | ✅ test que mata con `SIGKILL` un hijo que comprime, y contra el SEA: `taskkill /F` con el temporal a 5 MB de 200 MB → carpeta intacta y nada publicado; el siguiente arranque barre el temporal, comprime entero y restaura byte a byte |
| Una conversación fijada nunca se comprime | ✅ test (400 días sin uso) y `workspace_pin` e2e contra el SEA |
| Una conversación con turno en curso nunca se comprime | ✅ test con un provider colgado: el janitor la salta (`inUse`) y solo la toca al cerrarse y acabar el turno |

Decisiones (con el usuario, antes de implementar):
- **Abrir no es usar.** Solo un turno o una subida mueven `lastUsedAt` (en D2
  abrir también lo hacía). Restaurar al abrir tampoco reinicia el reloj: si no se
  escribe, la siguiente pasada la vuelve a comprimir. Si abrir contase, el
  webview (que abre su conversación en cada conexión) no dejaría caducar nada y
  el aviso de purga no se vería nunca.
- **«Descargar todo (.zip)» lo genera Rust** con el crate `zip` (4.6, zip64,
  backend `zlib-rs`): `inputs/` + `outputs/`, sin `scratch/` ni metadatos, sin
  seguir enlaces, a un temporal que se renombra al terminar.
- **`tar-stream` 3** (JS puro, incrustado en el bundle del SEA) + `zlib` de Node.
- **Tras la purga, workspace nuevo y vacío.** Se pueden volver a subir
  ficheros; `filesExpiredAt` marca como caducadas las tarjetas anteriores y
  añade al bloque `# Workspace` una nota para el agente.

Decisiones de diseño:
- **Estado en disco reconocible en cada paso** (`workspace.ts`):
  `active` = `<id>/` con `.workspace.json`; `archived` = `<id>.tar.gz` +
  registro `<id>.json`; `purged` = solo el registro. Compresión: temporal
  `.tmp-<id>.tar.gz` → verificación (sha256 de cada fichero contra lo leído de
  la carpeta) → rename → registro → rename de la carpeta a `.trash-*` → borrado.
  Restauración: extracción a `.restoring-<id>` → rename. Purga: primero el
  registro `purged` (desde ahí es firme) y luego el borrado. Regla de
  recuperación (`recover()` al inicio de cada pasada): **la carpeta gana** si
  tiene metadatos válidos y **`purged` es terminal**; los temporales se barren.
- **Una carpeta sin metadatos junto a un archivo no gana.** La creó alguien que
  no es el sidecar; si ganase, `recover` borraría el archivo bueno. Se aparta
  a `.orphan-*` al restaurar. Rust ya no crea `inputs/` si falta: el workspace
  solo lo crea (y lo restaura) el sidecar.
- **Concurrencia (16.5)**: `WorkspaceManager.acquire`/`release` marcan la
  conversación en uso desde que se abre en el host hasta que se cierra **y** su
  turno termina (también uno retirado por no atender el cierre), y un lock por
  conversación serializa comprimir, restaurar y abrir: abrir espera a una
  compresión en marcha y restaura.
- **Janitor** (`retention.ts`): al arrancar y cada 24 h con temporizador
  `unref`; un pase no espera al apagado (es seguro de interrumpir). Una
  carpeta sin metadatos válidos no se data y no se toca. Un workspace activo
  que ya pasó `deleteAfterDays` se purga sin comprimirlo antes.
- **Un archivo corrupto no impide abrir la conversación**: se abre sin
  ficheros, con aviso, y el archivo se queda en disco.
- **Protocolo v4**: `conversation_opened.workspace` y `workspace_status`
  (`state` `active|restoring|archived|purged`, `pinned`, `lastUsedAt`,
  `purgeAt`, `filesExpiredAt`), y `workspace_pin` del webview.
  `PURGE_WARNING_DAYS = 3` en el protocolo; el webview lo espeja (con un test
  que comprueba que coinciden) porque no importa valores de `stratum-cli`.

Hallazgo de la prueba real: tras la purga, si el usuario pide explícitamente
abrir un fichero de antes, `gemma-4-12b` lo intenta igualmente pese a la nota
del prompt; recibe el `ENOENT` y explica que caducó y que hay que volver a
subirlo. Sin la petición explícita no se ha observado.

### Política

| Estado | Cuándo | Qué queda |
|---|---|---|
| `active` | uso en los últimos `compressAfterDays` (default 7) | carpeta completa |
| `archived` | sin uso ≥ `compressAfterDays` | `<conversationId>.tar.gz`, carpeta borrada |
| `purged` | sin uso ≥ `deleteAfterDays` (default 30) | nada; la conversación sigue legible |

Config `desktop.workspaces.{compressAfterDays, deleteAfterDays}`; `0` desactiva
cada etapa. `deleteAfterDays` debe ser mayor que `compressAfterDays` (validado en
el schema).

### Tareas

1. **Janitor** en el sidecar: al arrancar y cada 24 h mientras la app esté
   abierta. Recorre los `.workspace.json` y aplica la política. Si la app estuvo
   cerrada, el janitor del siguiente arranque recupera el retraso; nunca hay un
   proceso en segundo plano con la app cerrada.
2. **Compresión** a `tar.gz` con `zlib` de Node y una librería tar en JS puro
   (debe funcionar dentro del SEA; nada nativo). Escritura atómica: se comprime a
   temporal, se verifica y solo entonces se borra la carpeta.
3. **Restauración transparente**: abrir o escribir en una conversación
   `archived` descomprime el workspace antes del primer turno (con indicador en
   la UI) y lo devuelve a `active`.
4. **`[16.5]` Concurrencia**: lock por workspace. El janitor salta cualquier
   conversación con un turno en curso o abierta en la UI, y el turno espera a
   que termine una compresión en marcha.
5. **Conversación `purged`**: el historial se conserva; las tarjetas de fichero
   se muestran como «caducado» y el prompt de esa conversación indica al agente
   que los ficheros ya no existen, para que no intente leerlos.
6. **`[16.7]` Que no pille por sorpresa.**
   - Fijar una conversación la excluye de la retención.
   - Aviso en la conversación cuando falta poco para la purga
     (p. ej. los últimos 3 días), con «Fijar» y «Descargar todo (.zip)».
   - Ajuste de los plazos en Settings (D5).

### Criterios de aceptación

- Con plazos cortos de test (y reloj inyectable), un workspace pasa
  `active → archived → purged` y la conversación sigue abriéndose en cada estado.
- Reabrir una `archived` restaura los ficheros byte a byte.
- Matar el proceso a mitad de una compresión no pierde datos: al arrancar, o la
  carpeta sigue entera o el archivo está completo.
- Una conversación fijada nunca se comprime.
- Una conversación con turno en curso nunca se comprime.

---

## D4 — Conversaciones múltiples, Sidebar, StatusBar e InputArea 🔄

**Objetivo.** Navegación entre conversaciones como en un asistente de escritorio:
lista en el sidebar como navegación principal, varias conversaciones vivas a la
vez, StatusBar e InputArea completos.

**Estado (2026-09-23): implementado y verificado en Windows (ventana real) y
en Linux (protocolo contra el SEA) con `gemma-4-12b` (llama.cpp); pendiente la
revisión a mano de la ventana en Linux.** Suites verdes: CLI 1027 (`tsc` y lint
limpios), frontend 102 (typecheck limpio) y Rust 40 (e2e contra el SEA con
protocolo 5).

Linux (WSL2 Ubuntu 24.04): CLI 1010 + 17 omitidos por ser de Windows (`tsc` y
lint limpios), frontend 102, SEA de Linux con protocolo 5 y los tres nativos, y
`cargo test` 39/39 con los e2e. Como WSLg no deja inyectar teclado, D4 se probó
con un cliente del protocolo por el unix socket contra el SEA de Linux, con un
HOME temporal y `gemma-4-12b`: 14/14 — dos conversaciones arrancan a la vez sin
cola ni mezcla de streams, listado y renombrar, `/model`, `/compact`, memoria
global aplicada por la conversación abierta y conflicto al guardar, `/clear`
(el contexto vuelve al de una conversación vacía, ~3,8k con los esquemas de las
tools), `SIGKILL` a mitad de turno → al relanzar, la conversación vuelve con el
turno interrumpido, eliminar borra el workspace, cola con límite 1 y apagado
ordenado por EOF en stdin. Con este llama.cpp (un slot) las dos generaciones
simultáneas se sirven en serie: Stratum las lanza a la vez, pero los tokens de
la segunda empiezan cuando termina la primera — el motivo del límite de 15.15.

| Criterio | Estado |
|---|---|
| Dos conversaciones generan en paralelo sin mezclar streams ni workspaces | ✅ En la ventana: dos poemas a la vez («2 generando», dos indicadores en la lista), cada conversación con el suyo y su carpeta. Con `maxConcurrentTurns: 1`, la segunda muestra «En cola» y arranca al terminar la primera. Tests con providers bloqueados: eventos etiquetados por turno, cola FIFO y cancelar en cola sin llamar al modelo |
| Eliminar una conversación borra su workspace (o su archivo) | ✅ Desde el sidebar (con confirmación en línea) se van sesión, transcript y carpeta; test con una archivada (`.tar.gz` y registro) y con una abierta |
| Cierre forzado deja recuperable la conversación activa | ✅ `taskkill /F` a la app a mitad de generación: al relanzar, la conversación sigue activa con su historial y el turno «a medias» con «Reintentar», que funciona. Tests: primer turno sin checkpoint todavía y turno con una tool ya terminada |
| La memoria global se ve y se edita desde el sidebar | ✅ Creado el `STRATUM.md` global desde el panel y aplicado por la conversación abierta sin reiniciarla; editarlo mientras cambiaba en disco da el conflicto sin pisarlo (el fichero de prueba se borró al terminar). Decisiones: búsqueda y borrado con test |

También probado en la ventana: `/model` (selector con los modelos de
llama.cpp), `/compact`, `/clear` y `Ctrl+L` con confirmación, renombrar, índice
de mensajes, panel de ficheros sobre una conversación de D2, `Ctrl+N`, `Ctrl+B`,
`Ctrl+K` y `Escape`.

Hallazgos de la prueba real, corregidos: una conversación vaciada con `/clear`
no se podía eliminar (las acciones dependían de que tuviera turnos), el
textarea mostraba barra de scroll (la altura no contaba el borde), `/model` sin
argumento necesitaba dos Enter, el % de contexto no bajaba tras `/clear`, y cada
conversación nueva abandonada dejaba una carpeta vacía.

Decisiones (con el usuario, antes de implementar):
- **Sin pestañas.** El sidebar es la navegación; las conversaciones que generan
  siguen vivas en segundo plano con un indicador en la lista (y un punto en el
  icono si alguna espera una respuesta del usuario).
- **Transcript de UI guardado por el sidecar** (`~/.stratum/desktop/conversations/<id>.json`),
  aparte del historial del agente: sobrevive a la compresión de contexto y
  conserva tool calls (salida recortada a 8k), avisos y tarjetas de fichero.
  Las conversaciones de D1–D3 se leen derivando el transcript del historial
  (sin avisos ni tarjetas, y sin lo que ya se comprimió).
- **Límite de generaciones simultáneas** `desktop.maxConcurrentTurns` (default
  2, 1–8): con un llama.cpp de un slot, dos a la vez van a la mitad de
  velocidad cada una, y un provider remoto puede responder con rate limit
  (15.15). Las de más esperan «En cola» (FIFO) y se pueden cancelar sin llegar
  a llamar al modelo.
- **Memoria global editable en el sidebar** con concurrencia optimista: se
  guarda sobre el `mtime` leído y, si el `STRATUM.md` cambió en disco (la CLI,
  otro editor), no se pisa: «Cargar la versión del disco» o «Sobrescribir con
  la mía». Las conversaciones abiertas recomponen el prompt (o lo harán antes
  de su siguiente turno).

Decisiones de diseño:
- **Protocolo v5**: `list_conversations`/`conversations`, `conversation_updated`,
  `rename_conversation`, `delete_conversation`/`conversation_deleted`,
  `clear_conversation`/`conversation_cleared`, `compact_conversation`,
  `list_models`/`models`, `set_model`, `conversation_stats`,
  `conversation_notice`, `turn_queued`/`turn_started` y `memory_*`.
  `conversation_opened` trae el transcript (con el turno en marcha, si lo hay),
  el título, las tareas y las estadísticas; `WorkspaceStatus.sizeBytes` para la
  StatusBar.
- **Una conversación que deja de ser la activa se cierra en el sidecar** en
  cuanto no tiene turno ni pregunta pendiente (la retención puede volver a
  tocarla); si genera, sigue abierta hasta terminar. Un borrador abandonado
  (sin mensajes ni ficheros) no deja carpeta de workspace.
- **Checkpoints (15.12)**: el transcript se guarda al aceptar el mensaje; sesión
  y transcript, tras cada tool terminada y cada 60 s. El checkpoint quita del
  historial un `assistant` con `tool_calls` sin respuesta y el `user` final sin
  respuesta; al reabrir, el turno aparece «interrumpido» con «Reintentar».
- **`/model` es por conversación** y se guarda con su sesión; al reabrir se
  reaplica si el provider sigue siendo el mismo. `/clear` vacía el historial del
  agente y el visible, conserva los ficheros y pide confirmación en la propia
  conversación (también con `Ctrl+L`). `/settings` avisa de que llega en D5.
- **Eliminar** cierra la sesión, espera a que su turno termine y borra sesión,
  transcript y workspace (carpeta o archivo); no se ofrece mientras genera.
  Fijar desde el sidebar funciona también con la conversación cerrada o
  archivada (sin restaurarla).
- **Panel de ficheros**: Rust lista `inputs/` y `outputs/` (`workspace_files`)
  y «Guardar»/«Abrir» aceptan ahora también `inputs/`; nunca `scratch/`.
- **Tras `/clear`, el % de contexto** deja de contar el último `prompt_tokens`
  real (`ContextManager.forgetLastUsage`); arregla también la barra de la CLI.

### Tareas

1. **Store de conversaciones.** `conversationId` UUID, título derivado del primer
   mensaje, indicador idle/generando/error. `[15.15]` Cada conversación con su
   `StratumAgent` independiente; documentar el comportamiento con varias
   generando a la vez (rate limits del provider) y evaluar un límite de
   generaciones simultáneas. Pestañas: opcionales, decidir aquí si aportan algo
   sobre la lista del sidebar.
2. **Sidebar.**
   - **Conversaciones (7.1):** agrupación por fecha, búsqueda, renombrar,
     eliminar (borra también su workspace), fijar, estado del workspace
     (`archived`/`purged`), empty state.
   - **Outline (7.2):** anchors a mensajes del usuario, scroll suave.
   - **Memoria (7.3):** solo lo global en modo Chat — `~/.stratum/STRATUM.md` y
     las decisiones del asistente con búsqueda y borrado. La pestaña Proyecto
     llega con el modo Code.
   - **Ficheros de la conversación:** `inputs/` y `outputs/` de la conversación
     activa, con guardar y abrir.
3. **`[15.12]` Persistencia incremental** de la sesión (checkpoint periódico, no
   solo al cerrar).
4. **StatusBar**: provider, modelo, contexto %, tamaño del workspace.
5. **InputArea + slash-commands**: textarea autoexpandible, adjuntar, catálogo de
   comandos reducido al modo Chat (`/new`, `/clear`, `/compact`, `/model`,
   `/memory`, `/settings`); los de código (`/init`, `/changes`, `/plan`,
   `/agent`) quedan para el modo Code.
6. **Atajos de teclado** con `react-hotkeys-hook`: `Ctrl+N` nueva conversación,
   `Ctrl+B` sidebar, `Ctrl+K` buscar, `Ctrl+L` limpiar, `Escape` cancelar.

### Criterios de aceptación

- Dos conversaciones generan en paralelo sin mezclar streams ni workspaces.
- Eliminar una conversación borra su workspace (o su archivo).
- Cierre forzado deja recuperable la conversación activa al reabrir.
- La memoria global se ve y se edita desde el sidebar.

---

## D5 — Settings Panel, ProviderWizard y config compartida

**Objetivo.** Configuración visual sin editar JSON y escritura segura compartida
con la CLI.

### Tareas

1. **Settings Panel** (overlay, `Ctrl+,` / `/settings`): Providers, Modelo
   activo, Web Search, Memoria, **Espacios de trabajo** (raíz, límites, plazos de
   retención, uso de disco total, «Purgar ahora»), Avanzado (JSON raw con
   validación en vivo contra el schema Zod).
2. **ProviderWizard** portado de la CLI a modal.
3. **Selector de modelo activo** (misma lógica que `/model`).
4. **`useConfig.ts`** vía `invoke` `read_config`/`write_config` (Rust).
5. **`[15.7]` Config compartida segura**: escritura atómica, comparación de
   mtime/hash antes de escribir con aviso de conflicto, `watch_config` con
   debounce y flag de auto-write.

### Criterios de aceptación

- Un provider añadido en el wizard aparece en la terminal y viceversa.
- Editar la config en la CLI con Settings abierto avisa del conflicto.
- El watcher no entra en bucle tras una escritura propia.
- JSON inválido en Avanzado se marca antes de guardar.

---

## D6 — Integración con el SO e infraestructura de build

### Tareas

1. **Notificaciones OS** para respuestas largas (>10 s) con la app en segundo
   plano; toggle en Settings.
2. **Global hotkey** `Ctrl+Shift+Space` para enfocar/restaurar; configurable.
3. **Onboarding de primer arranque**: splash → ProviderWizard → primera
   conversación.
4. **Errores del sidecar**: pantalla de fallo de inicio (Reintentar / Ver logs) y
   banner no bloqueante en runtime.
5. **Pipeline de build** (GitHub Actions): `.msi` en Windows, `.deb` +
   `.AppImage` en Linux, con el sidecar SEA por plataforma.
6. **Firma de código**: Windows con `TAURI_SIGNING_*`; GPG opcional en Linux.

### Criterios de aceptación

- Notificación nativa al terminar una respuesta larga en background.
- CI produce `.msi`, `.deb` y `.AppImage` instalables desde cero.
- Onboarding completo en una máquina sin `.stratumrc.json`.

---

## D7 — Polish: frameless, animaciones, accesibilidad y E2E

### Tareas

1. **Ventana frameless** con TitleBar custom de 32 px y controles ─ □ ×.
2. **`[15.14]`** Accesibilidad de los controles custom y clamping de la posición
   restaurada al área visible (multi-monitor). La TitleBar deja hueco para el
   conmutador Chat | Code de D8.
3. **Animaciones** de streaming, expansión de `ToolCallBlock` y sidebar.
4. **Accesibilidad general**: foco visible, teclado completo, contraste, `aria-*`.
5. **Tests E2E** con Tauri WebDriver: chat, subida/descarga, retención,
   conversaciones, settings, onboarding.
6. **Auto-update** (`tauri-plugin-updater`) contra GitHub Releases.

### Criterios de aceptación

- Mover/maximizar/cerrar la ventana frameless funciona en Windows y Linux.
- Restaurar tras desconectar un monitor deja la ventana visible.
- Suite E2E verde en CI.
- Una release nueva dispara el auto-update.

---

## D8 — Modo Code: conmutador Chat | Code

**Objetivo.** Recuperar dentro de Desktop el comportamiento de la CLI para
trabajar sobre un proyecto real.

### Tareas

1. **Conmutador Chat | Code** en la TitleBar. Fija el modo de las conversaciones
   **nuevas**; el de una conversación existente no cambia (se muestra como
   insignia). `SessionContext.mode` persiste el modo en la sesión.
2. **`[15.3]` Directorio de trabajo**: «Abrir carpeta» fija el cwd de la
   conversación Code; `read_file` y `/init` resuelven contra él; el último cwd se
   persiste en la sesión.
3. **Preset `coding`** + toolset completo (`exec`, plan, delegación, perfiles,
   TDD, SSH, MCP), confirmaciones destructivas por conversación.
4. **Sidebar en modo Code**: pestaña Proyecto de Memoria (`STRATUM.md` de
   proyecto con refresco por `fs.watch`, «Abrir en editor»), panel de cambios
   del working tree (`/changes`), comandos de código en el InputArea.
5. **Sin retención** en modo Code: la carpeta es del usuario, nunca se comprime
   ni se borra.

### Criterios de aceptación

- Una conversación Code sobre una carpeta hace lo mismo que `stratum chat` ahí.
- Cambiar el conmutador no altera conversaciones ya creadas.
- El janitor nunca toca una carpeta de una conversación Code.

---

## Futuro (fuera de la ruta D0–D8)

- **Ejecución aislada en el modo Chat** (`[16.1]`): `exec` dentro del workspace
  con aislamiento real del SO — contenedor, `bubblewrap` en Linux, AppContainer
  o una VM ligera en Windows — para que el asistente pueda procesar datos con
  Python o convertir ficheros. Encaja con los targets `container:` que `exec`
  ya reserva (Hito 16).
- Proyectos/colecciones: agrupar conversaciones con ficheros compartidos.
- Exportar una conversación completa (texto + ficheros).

---

## Puntos ciegos del modo Chat

| Id | Severidad | Problema | Resolución | Hito |
|----|-----------|----------|------------|------|
| 16.1 | 🔴 | Un directorio no aísla un shell: `exec` con cwd en el workspace puede leer y escribir cualquier parte del disco | Sin `exec` en el modo Chat v1; aislamiento del SO como trabajo futuro | D2 |
| 16.2 | 🔴 | Escapar del workspace con `..`, rutas absolutas, symlinks o junctions | Veto en `preflight` por `realpath` contra `workspaceRoot`, inapelable | D2 |
| 16.3 | 🟠 | Subidas enormes llenan el disco o revientan el contexto | Límites por fichero y por workspace; `read_file` ya pagina | D2 |
| 16.4 | 🟠 | Un fichero subido contiene instrucciones (prompt injection) | Contenido declarado como dato en el prompt; `inputs/` de solo lectura; sin `exec` limita el daño | D2 |
| 16.5 | 🟠 | El janitor comprime un workspace en uso | Lock por workspace; salta conversaciones abiertas o con turno en curso | D3 |
| 16.6 | 🟠 | El prompt de código se filtra al asistente (o al revés) y rompe la CLI | Preset resuelto solo en `promptEnv()`, default `coding`, tests de ambos presets | D1 |
| 16.7 | 🟡 | La purga borra ficheros que el usuario daba por guardados | Fijar, aviso previo, «Descargar todo», plazos configurables; el texto nunca se purga | D3 |

## Trazabilidad de puntos ciegos de la definición → hito

| Punto ciego | Severidad | Hito |
|-------------|-----------|------|
| 15.1 Canal sin autenticar | 🔴 | D0 (transporte) / D1 (chat) |
| 15.2 Empaquetado del sidecar / tamaño real | 🔴 | D0 |
| 15.3 Modelo de cwd / abrir proyecto | 🔴 | D8 (solo modo Code) |
| 15.4 Protocolo de confirmación destructiva | 🟠 | D1 |
| 15.5 Estado del agente vs. reconexión | 🟠 | D1 |
| 15.6 Versión core bundle vs. CLI global | 🟠 | D0 |
| 15.7 Lost updates en config concurrente | 🟠 | D5 |
| 15.8 Scope fs de Tauri | 🟠 | D2 |
| 15.9 Cancel en transporte separado | 🟠 | D1 |
| 15.10 Puerto por stdout + firewall | 🟠 | D0 |
| 15.11 Ciclo de vida del sidecar / MCP | 🟠 | D0 |
| 15.12 Persistencia de sesión solo al cerrar | 🟡 | D4 |
| 15.13 Rendimiento markdown en streaming | 🟡 | D1 |
| 15.14 Frameless rompe SO + multi-monitor | 🟡 | D7 |
| 15.15 Concurrencia entre conversaciones | 🟡 | D4 |

---

## Dependencias externas y supuestos

- **stratum-cli Hito 4 (MCP Client) cerrado** antes de D0; MCP solo se expone en
  el modo Code (D8).
- **Cambios en `stratum-cli`** que pide este plan, todos opt-in y sin cambiar la
  CLI por defecto: `promptPreset` (D1), `ToolContext.workspaceRoot` con su
  `preflight` (D2) y `SessionContext.mode` (D8).
- **Sin macOS en v1**: el pipeline cubre Windows + Linux.
- **Sin sincronización en tiempo real** entre instancias: solo estado en disco.
- `STRATUM_DESKTOP_PROJECT_DEFINITION.md` sigue describiendo la app centrada en
  código (§1, §3 cwd por pestaña, §7.3 Memoria de proyecto); hay que alinearlo
  con esta orientación.
