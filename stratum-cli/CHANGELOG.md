# Changelog — Stratum CLI

Cambios de cada versión del paquete [`stratum-cli`](https://www.npmjs.com/package/stratum-cli), de la más reciente a la más antigua. Stratum Desktop se versiona aparte: ver [`stratum-desktop/CHANGELOG.md`](../stratum-desktop/CHANGELOG.md).

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/) (mientras la versión sea `0.x`, una minor puede traer cambios incompatibles, que se señalan en «Cambios a tener en cuenta»). Las notas de cada versión también están en su [GitHub Release](https://github.com/choruzo/CLI/releases).

> Las versiones anteriores a la 0.2.1-beta.0 solo existen como tags de git: la primera publicación en npm fue la 0.2.1-beta.0.

## [0.7.0] — 2026-10-03

Versión estable de la 0.7.0: incluye todo lo de la [0.7.0-beta.0](#070-beta0--2026-09-27) (endurecimiento de la persistencia, de la escritura de ficheros, de MCP, del cliente del LLM y de `web_fetch`) y, además, los **modelos descubiertos**: a un provider le basta la URL y la key.

### Añadido
- **Providers sin `model`**: un provider ya no necesita `model` ni `contextWindow` en la config; con `baseUrl` y `apiKey` los modelos se piden a `GET /models`. `chat` abre el selector de modelos al arrancar si el provider no tiene ninguno y guarda la primera elección como modelo por defecto.
- `stratum run` y `stratum init` aceptan `--model`. Sin modelo fijado, usan el único que exponga el provider; con varios, fallan listándolos en vez de elegir uno.
- `stratum provider add <alias> --base-url … --api-key-env VAR` da de alta un provider sin pasar por el wizard, y `stratum provider models [alias] [--set <id>]` lista los modelos y fija el de por defecto.
- `/provider remove <alias>` en el chat.
- Core de Stratum Desktop: guardado atómico de conversaciones y sesiones, guardado al cerrar y avisos cuando un guardado falla. Sin cambios de comportamiento en la CLI.

### Cambiado
- **Ventana de contexto por modelo**: `models.<id>.contextWindow` > la del provider si está escrita > la que declare `/models` > 32768. El wizard ya no escribe `contextWindow`.
- `stratum provider remove` quita el provider de todos los ficheros que lo definen (global y proyecto), no solo del primero.

### Corregido
- **Wizard de providers**: con una `apiKey` escrita como `${VAR}`, la consulta de modelos enviaba el placeholder literal y caía siempre a la entrada manual. Ahora consulta con la variable expandida y guarda el placeholder.

## [0.7.0-beta.0] — 2026-09-27

Pre-release para pruebas (`npm install -g stratum-cli@beta`); `latest` sigue en la 0.6.0.

Endurecimiento de la persistencia de sesiones, subagentes (`.stratum/subagents/`), planes (`.stratum/plans/`), decisiones (`decisions.json`), su índice semántico y host keys SSH (`known_hosts.json`), de la escritura de ficheros del usuario (`write_file` / `edit_file`), de la carpeta gestionada de MCP servers (`~/.stratum/mcp/`) y de su uso en la sesión, del cliente del LLM y de `web_fetch`.

### Corregido
- **Memoria semántica**: una respuesta del endpoint de embeddings (`memory.embeddingEndpoint`) con menos vectores que textos, índices repetidos o fuera de rango, o vectores de distinto tamaño ya no se aprovecha a medias. Antes podía guardar el vector de una decisión bajo otra (y el recall devolvía decisiones sin relación con la búsqueda); ahora se descarta y se usa el modelo local. El error del endpoint se muestra recortado y sin credenciales.
- **`web_search`**: la respuesta del buscador se lee con un tope de 2 MB. Un proxy o un portal cautivo que devolviese algo enorme ya no se acumula en memoria.
- **Seguridad (`exec` en Windows)**: borrar con PowerShell (`Remove-Item`, `del`, `erase`, `ri`, `rd`, `RM`, también dentro de `pwsh -Command` o `cmd /c`) no pedía confirmación, porque los patrones destructivos solo reconocían nombres POSIX en minúsculas. Ahora pide confirmación, igual que `rm`, también con `Clear-Content`, `Format-Volume` o `Clear-Disk`, y aunque `tools.destructivePatterns` esté personalizado. `Remove-Item -Recurse` sobre la raíz de una unidad, el home o el directorio actual se bloquea siempre, como `rm -rf /`.
- **Cancelar (Ctrl+C)**: en `stratum run` y `stratum init`, un Ctrl+C con una confirmación, una pregunta o la aprobación del plan en pantalla dejaba el proceso colgado (hacían falta tres Ctrl+C). Ahora cuenta como «no» y cancela el turno.
- **Cancelar (Ctrl+C)**: en el chat, Ctrl+C en una confirmación, una pregunta o una aprobación de plan responde «no» y además detiene el turno, como en cualquier otro momento. `Esc` sigue respondiendo «no» y dejando continuar al agente.
- **Cancelar (Ctrl+C)**: tras cancelar ya no se lanza ninguna tool que no hubiese empezado (antes, un `write_file` de la misma tanda podía llegar a escribir), no se abre la tanda de preguntas ni la aprobación del plan, y un subagente en cola no pide confirmación.
- **Cancelar (Ctrl+C)**: cancelar varias veces una tool lenta ya no la deshabilita para el resto de la sesión.
- **Cancelar (Ctrl+C)**: la conversación sigue funcionando después de cancelar. Una petición cancelada antes de que el modelo respondiese ya no deja dos mensajes de usuario seguidos (que rechazan las plantillas de chat de Mistral y otras), y ninguna llamada a una tool se queda sin respuesta en el historial.
- **`stratum init`**: cierra las conexiones SSH antes de salir.
- **`stratum run`**: un turno que termina con un error fatal (el provider caído y el fallback agotado) sale con código 1. Antes salía con 0 y un script que encadenaba `stratum run` lo daba por bueno.
- **Compresión de contexto**: en una tarea larga con muchas tool calls, la petición original del usuario ya no se pierde al comprimir: se conserva literal junto a las últimas iteraciones.
- **Compresión de contexto**: el historial comprimido ya no pone dos mensajes seguidos del asistente ni empieza por uno, algo que las plantillas de chat de algunos modelos (Mistral, Gemma) rechazan con un error que dejaba la sesión inutilizable.
- **Compresión de contexto**: el resumen ya no se cortaba a los 30 s. Un modelo local con razonamiento tarda más y siempre acababa en el truncado duro; ahora el límite es `agent.compressionTimeoutMs` (120 s) y, si el resumen falla, se avisa (`context_summary_failed`) en vez de truncar en silencio. Cancelar el turno mientras se resume no toca el historial.
- **Compresión de contexto**: el resumen ahora sabe qué ficheros se leyeron y qué comandos se ejecutaron (antes solo veía el texto de los mensajes), no incluye el razonamiento `<think>` del modelo, y un resumen vacío ya no sustituye al historial. `/compact` dice cuándo no pudo resumir.
- **`exec` en Windows**: cancelar un comando (Ctrl+C) o que venza su timeout ya no deja vivos los procesos que lanzó (`node`, los workers de un `npm test`, un servidor de desarrollo que seguía ocupando el puerto). Se termina el árbol entero, y la cancelación responde en menos de un segundo en vez de esperar ~6 s. El exit code de un comando matado ya no aparece como 1.
- **Config**: un `.stratumrc.json` guardado con BOM (el Bloc de notas de Windows lo añade) ya no falla con «Unexpected token»; se lee con normalidad, también en Ajustes de Desktop.
- **Config**: un JSON roto dice qué fichero es (el global o el del proyecto), la línea y la columna. Un valor inválido lista cada clave con su motivo y el fichero que la define, en vez de volcar el error de validación entero. Los comandos que no lo capturaban (`sessions`, `logs`) ya no enseñan una traza.
- **Config**: una variable `${VAR}` que no está definida se sigue sustituyendo por vacío, pero ahora `chat` y `run` avisan de cuál es, en qué clave y en qué fichero. Antes una `apiKey` con el nombre de variable mal escrito acababa en un 401 sin pista.
- **Config**: `stratum config set` y `/config set` validan el resultado junto con la config global, como la verá Stratum: un valor del proyecto que se apoya en la global (p. ej. un `jumpHost` definido allí) ya no se rechaza. `/config set` escribe de forma atómica, como `stratum config set`, y ninguno acepta claves como `__proto__` o `a..b`.
- **MCP**: un server que se cae durante la sesión se reconecta solo. Antes se quedaba en «reconnecting» hasta salir, y sus tools respondían que no estaban disponibles. Una llamada que estaba en curso cuando cayó avisa de que la acción pudo llegar a hacerse, para que el agente la compruebe antes de repetirla.
- **MCP**: un server colgado (que no responde ni al heartbeat) se relanza.
- **MCP**: las tools MCP ya no se cortan a los 30 s. Cada server tiene su `toolTimeout` (120 s por defecto) y, al vencer, se cancela la llamada en el server.
- **MCP**: un nombre de tool de más de 64 caracteres ya no rompe todas las peticiones al modelo (las APIs OpenAI-compatible rechazan la petición entera); se recorta con un hash.
- **MCP**: dos tools cuyos nombres coincidían al sanitizarse (`a.b` y `a_b`, o dos servers `my server` y `my_server`) se pisaban en silencio. Ahora los nombres que la sanitización altera llevan un hash del original, y un nombre que ya está en uso se omite con aviso en vez de sustituir a la otra tool.
- **MCP**: un server con muchas tools ya no pierde las que no caben en la primera página de `tools/list`.
- **MCP**: si el server añade o quita tools durante la sesión (`tools/list_changed`), el agente las ve al momento; tras una reconexión también se retiran las que desaparecieron.
- **MCP**: el contenido de un recurso embebido (p. ej. un fichero que devuelve la tool) llega al modelo; antes solo veía `[resource: unknown]`. Los binarios se describen con su tipo y tamaño, y un resultado que solo trae `structuredContent` se muestra como JSON.
- **MCP**: un server que falla al arrancar o al listar sus tools ya no deja su proceso vivo. Cerrar `chat` (o `/mcp reload`) mientras un server se reconecta ya no lo vuelve a lanzar después.
- **MCP**: que un server no esté conectado no cuenta como fallo de sus tools, así que no acaban deshabilitadas por un corte temporal.
- **Seguridad (`web_fetch`)**: ya no alcanza direcciones privadas, de loopback ni link-local (`localhost`, `10.x`, `192.168.x`, `169.254.169.254` —metadatos de la nube—, `[::ffff:127.0.0.1]`, `http://2130706433/`…), tampoco a través de una redirección ni de un nombre que resuelve a una IP privada (DNS rebinding): la IP se comprueba al conectar. Para un servidor local o interno legítimo, `tools.webFetch.allowHosts` (`["localhost:3000", "*.corp.example"]`). Un host rechazado no cuenta como fallo de la tool.
- **LLM**: un corte de conexión a mitad de respuesta ya no reinicia el stream desde el principio. Antes el texto salía duplicado y los argumentos de una tool call llegaban mezclados de dos intentos (JSON corrupto); ahora el error se muestra.
- **LLM**: los errores que no se arreglan reintentando (400 por contexto desbordado, 401, 404) fallan en el acto con el mensaje del backend. Antes se esperaban 7 s de reintentos y se reenviaba el prompt cuatro veces. Los transitorios (conexión rechazada, 429, 503 «Loading model», 502 de un proxy) se siguen reintentando, respetando `Retry-After`, y cancelar durante la espera corta en el acto.
- **LLM**: un backend colgado (sin responder o parado a mitad del stream) ya no bloquea el turno para siempre: timeouts de inactividad de 120 s hasta las cabeceras y 300 s sin recibir nada, configurables por provider con `timeouts.{headersMs,idleMs}` (`0` desactiva). Una respuesta larga que sigue llegando nunca se corta. Tras un timeout se prueba el siguiente provider si hay más.
- **LLM**: un error que el backend manda a mitad de generación (`{"error": …}` en el stream, p. ej. llama.cpp o LiteLLM) se muestra como error; antes el turno terminaba vacío sin explicación. Un fragmento del stream que no es JSON se descarta con un aviso visible en vez de en silencio.
- **LLM**: los mensajes de error son legibles y seguros: el `error.message` del backend en vez del cuerpo entero (una página HTML de un proxy ya no llega a la pantalla ni al historial), recortado, redactado y sin credenciales de la `baseUrl`.
- **Seguridad**: si el chequeo previo de una tool (`preflight`: vetos inapelables de `exec`, rutas de claves, confinamiento de Desktop) falla por un error interno, la llamada se rechaza; antes se dejaba pasar. Lo mismo con la política de entornos, y una tool cuyo chequeo de «¿es destructiva?» falla se trata como destructiva y se pregunta.
- **Tool calls**: con backends que cierran una respuesta con tool calls con `finish_reason: "stop"` (algunas versiones de Ollama y llama.cpp), o que no mandan `finish_reason`, las tool calls se perdían y el turno acababa como si el modelo no hubiese pedido nada. Ahora se ejecutan. Con `finish_reason: "length"` (argumentos cortados por el límite de salida) el modelo recibe un error recuperable.
- **Tool calls**: unos argumentos vacíos (`""`) se aceptan como `{}`, y unos que no son un objeto JSON (`null`, un array) son un error de parseo recuperable en vez de tumbar el turno.
- **Sesiones**: `chat` guarda la sesión al terminar cada turno y cada 30 s, no solo al salir. Cerrar la ventana, un `kill` o un fallo del proceso ya no pierden la conversación entera; `SIGTERM`/`SIGHUP` guardan antes de salir. El guardado final va antes del cierre de MCP y SSH, así que un fallo al cerrarlos tampoco lo impide.
- **`grep`**: nunca devuelve el contenido de claves, certificados, `.ssh/`, `.env` o `secrets/` (salvo `tools.sensitivePathAllowlist` para los de nivel confirmación), y avisa de cuántos omitió; buscar con la raíz en `~/.ssh` se veta. Antes era un rodeo para leer lo que `read_file` tiene bloqueado.
- **`ssh_upload` / `ssh_download`**: aplican las mismas rutas sensibles que `read_file`/`write_file` (subir una clave privada se veta; un `.env` pide confirmación). La descarga es atómica —un corte a mitad ya no deja el fichero local truncado—, conserva symlinks y no sobrescribe un fichero que cambió desde que el agente lo leyó. Cada transferencia cierra su canal SFTP (antes quedaban abiertos en la conexión del pool).
- **MCP**: un `npm install` cortado a mitad (Ctrl+C, cierre, corte de red) dejaba el server como «instalado» con dependencias ausentes, y fallaba en cada arranque sin repararse. La instalación se hace ahora en una carpeta temporal que solo sustituye a la definitiva cuando está completa, con un marcador `.stratum-install.json`.
- **MCP**: cambiar la versión de `package` en la config no actualizaba el server; ahora se reinstala (`stratum mcp install` lo hace sin `--force`).
- **MCP**: si reinstalar falla, la instalación anterior sigue funcionando. Una instalación hecha con versiones anteriores de Stratum se reinstala una vez; sin red o con `autoInstall: false` se sigue usando.
- **MCP**: dos `chat` arrancando a la vez ya no ejecutan `npm install` sobre la misma carpeta.
- **MCP**: `npm install` tiene un límite de 5 minutos, y tras un fallo no se relanza en cada reconexión durante un minuto.
- **MCP**: dos servers cuyos nombres coinciden al sanitizarse (`a.b` y `a_b`) dan un error claro en vez de reinstalarse el uno encima del otro.
- **`write_file` / `edit_file`**: la escritura es atómica (temporal + fsync + rename). Un cierre, un corte o un Ctrl+C a mitad ya no puede dejar el fichero del usuario truncado.
- **`edit_file`**: un `new_string` con `$&`, `$$` o `$1` (shell, PowerShell, PHP, plantillas JS) se insertaba alterado; ahora se inserta literalmente.
- **`edit_file`**: en ficheros con finales de línea CRLF, un `old_string` de varias líneas no casaba nunca porque el modelo lo escribe con `\n`. Ahora casa, y el texto nuevo se adapta a CRLF en vez de dejar líneas LF sueltas.
- **`edit_file`**: un fichero que no es UTF-8 (Latin-1, UTF-16) o que es binario se rechaza sin tocarlo. Antes se decodificaba con reemplazo y al guardar se corrompían todos sus caracteres no ASCII, no solo la línea editada.
- **`edit_file`**: si el fichero cambia en disco entre la lectura y la escritura (un editor guarda justo en ese momento), no se escribe encima.
- **`write_file`**: se niega a sobrescribir un fichero que cambió desde que el agente lo leyó (lo editó el usuario, un formateador u otro proceso) y le pide que lo relea. Un fichero que el agente nunca leyó no se comprueba.
- **`write_file` / `edit_file`**: se conservan el BOM, los finales de línea CRLF, los permisos (el bit de ejecución) y los symlinks del fichero original; con hard links se escribe en sitio para no romperlos.
- **`read_file`**: ya no muestra los `\r` de los ficheros CRLF ni el BOM.
- **Sesiones**: se guardan de forma atómica; un cierre a mitad de escritura ya no deja la conversación truncada e irrecuperable.
- **Sesiones**: con la misma sesión abierta en dos terminales, la que guarda en segundo lugar ya no pisa a la otra: su conversación se guarda como sesión nueva (`forkedFrom`) y se avisa con el id para reanudarla.
- **Sesiones**: una sesión dañada ya no rompe `sessions list`, `/sessions list` ni `sessions prune`: se omite y se dice cuál. Al cargar se valida su forma y un error lo explica («está dañada (…)»).
- **Sesiones**: `sessions prune` borra por último uso (`updatedAt`), no por fecha de creación: una sesión larga retomada ayer ya no se poda. Nunca borra una sesión que no puede leer ni una de un Stratum más nuevo.
- **Sesiones**: el id se valida antes de usarlo como ruta; `sessions delete ../x` ya no puede borrar ficheros fuera de la carpeta de sesiones.
- Si guardar la sesión al salir de `chat` falla, se dice en vez de perderla en silencio.
- Al reanudar una sesión solo se avisa de los subagentes interrumpidos **de esa sesión**. Antes se adoptaban los de cualquier sesión del proyecto, y con dos `chat` abiertos se daba por interrumpido un subagente que seguía corriendo en la otra terminal.
- Cada registro lleva el proceso dueño y un latido; un subagente solo cuenta como interrumpido si su proceso murió (o dejó de latir hace más de 3 minutos).
- `/sessions resume` dentro del chat también avisa de los subagentes interrumpidos, igual que `chat --resume`.
- El aviso ya no se pierde si el proceso muere antes de guardar la sesión: los registros se marcan después de guardarla, y un aviso que ya está en el historial no se repite.
- Los registros se validan al leerlos (`schemaVersion`); uno roto se ignora y uno de un Stratum más nuevo no se reescribe ni se borra.
- Un plan dañado ya no impide reanudar la sesión: se avisa y se reanuda sin él (antes `chat --resume` salía con error). Los planes también se validan y llevan `schemaVersion`.
- La referencia al plan guardada en la sesión se valida antes de usarla como ruta: ya no puede leer ni escribir fuera de `.stratum/plans/`.
- `/sessions resume` dentro del chat retoma también el plan a medias de la sesión cargada, igual que `chat --resume`.
- Reanudar una sesión desde otra carpeta encuentra su plan y sus subagentes: se buscan en el proyecto de la sesión, no en el directorio actual.
- **Decisiones**: un `decisions.json` dañado ya no se sobrescribe con la siguiente decisión, que borraba todas las anteriores. Se aparta a `decisions.json.corrupt-<fecha>` y se avisa.
- **Decisiones**: cada entrada se valida al leerla. Las que no validan (por ejemplo, de un Stratum más nuevo) no se muestran, pero se conservan al reescribir el fichero, y un fichero con otro formato (`schemaVersion`) no se modifica.
- **Decisiones**: cada escritura parte del contenido que hay en disco y usa un temporal único por proceso; dos procesos que guardaban a la vez podían pisarse el temporal.
- **Memoria semántica**: las decisiones que faltan en el índice se indexan al buscar y al guardar. Antes solo se reparaba un índice vacío, así que con un índice incompleto (índice dañado, decisiones guardadas con el embedder caído, dos procesos escribiendo a la vez) esas decisiones no aparecían nunca en el recall y el dedup no las veía.
- **Memoria semántica**: cambiar `memory.embeddingDimension` recrea el índice `sqlite-vec` en vez de hacer fallar todas las inserciones; el índice brute-force descarta las entradas de otra dimensión o con forma inválida.
- **Memoria semántica**: el índice brute-force relee el disco antes de escribir y cuando cambia, así que dos procesos ya no se borran las entradas entre sí; escritura con `writeFileAtomic`.
- **SSH**: un `known_hosts.json` dañado ya no se trata como vacío. Antes, todos los hosts `tofu` volvían a «primera conexión» (se aceptaba cualquier clave) y la siguiente confirmación borraba las huellas guardadas. Ahora la conexión se aborta sin preguntar, el fichero no se toca y `stratum ssh list`/`trust` explican qué pasa.

### Añadido
- `sessions delete` y `sessions prune` borran también los registros de subagente y el plan de esas sesiones (un plan que otra sesión todavía puede reanudar se conserva). `chat` poda al arrancar los registros de más de `agents.subagentRetentionDays` días y los planes de más de `session.planRetentionDays` (30 por defecto en ambos; `0` lo desactiva).

### Cambios a tener en cuenta
- Las tools MCP de un server o tool cuyo nombre tiene caracteres fuera de `[a-zA-Z0-9_-]` (espacios, puntos…) cambian de nombre: llevan un sufijo `_<hash>` (`mcp__my_server_3a158f__read_file`). Si un perfil las nombra en `allowedTools`, usa el nombre nuevo (`/tools` lo muestra) o un glob (`mcp__my_server_*`). Los nombres que ya eran válidos no cambian.
- `web_fetch` rechaza ahora `localhost` y cualquier dirección privada. Si el agente consultaba un servidor de desarrollo o un servicio interno, añade su host a `tools.webFetch.allowHosts` (por ejemplo `"localhost:3000"`).

## [0.6.0] — 2026-09-25

Centrada en el **Hito 17**: entornos con *blast radius*, modo read-only y perfil de sesión.

### Añadido
- **Entornos** (`environments` en `.stratumrc.json`): cada entorno casa por glob con `local` o `ssh:<alias>` y declara `tier`, `policy` (`allow` / `ask` / `confirm-always`), `requirePlan`, `readOnly` y `confirmation` (`typed` / `simple`). Solo afectan a lo que cambia algo: leer en producción nunca pregunta.
- `confirm-always` fuerza la confirmación aunque haya `--allow-destructive` o allow-all de sesión. Confirmación con nombre: en los entornos críticos se teclea el alias para aprobar.
- `requirePlan` escala el turno a modo plan antes de tocar ese entorno.
- **Modo read-only** (`--read-only` en `chat` y `run`, `/readonly`): inapelable, heredado por los subagentes y guardado en la sesión. Clasificador de comandos de solo lectura por lista blanca (git, kubectl, docker, systemctl, curl, sed, cmdlets `Get-*`…); la fase de exploración del modo plan admite estos comandos.
- **Perfil de sesión** `code` / `infra` / `full` / `auto` y propios en `session.profiles` (`--profile`, `--infra`, `--code`, `/profile`), combinado con el perfil de agente.
- Badges `⬢ entorno`, `RO` y `⬡ perfil` en la barra de estado y comando `/env`.
- **Razonamiento del modelo** (`reasoning_content`, `reasoning` o `<think>` inicial) plegado en una línea (`⊙ razonando…` / `⊙ razonó · N palabras`) y entero con `/debug`. Nunca entra en el historial.
- Core de Stratum Desktop D5–D7: panel de Ajustes (lectura/escritura del `.stratumrc.json` global con secretos enmascarados), notificaciones y atajo global (`desktop.notifications`, `desktop.globalHotkey`, gramática en `config/accelerator.ts`), razonamiento en el transcript y `desktop.updates.autoCheck`. Sin cambios de comportamiento en la CLI.

### Cambiado
- `stratum config set` escribe el fichero de forma atómica.

### Cambios a tener en cuenta
- Con `environments` definidos, `stratum run` sin TTY deniega los cambios en entornos `confirm-always` aunque el plan se apruebe con `--yes`.

## [0.5.0] — 2026-09-23

Centrada en el **Hito 16**: ejecución unificada, auditoría universal y redacción de salidas.

### Añadido
- Tool **`exec`** con `target` (`local` o `ssh:<alias>`) y backends con capacidades declaradas; descripción generada con los targets de la configuración.
- Cancelación estructurada y `maxBytes` en local que descarta la salida sobrante sin matar el proceso.
- Exit code real en Windows (`pwsh`), con contrato *best-effort* documentado.
- **Auditoría universal** de toda ejecución en `~/.stratum/logs/exec-audit.jsonl` (`tools.auditLog`), con el comando redactado y sin `stdin`.
- **Redacción de secretos** en las salidas (PEM, `Authorization`, `Bearer`, `sk-…`, `xox?-`, JWT, tokens de GitHub) con núcleo no desactivable y literales propios en `tools.redaction.extraPatterns`.
- Core compartido con Stratum Desktop D0–D4: `schemaVersion` en config y sesiones, preset de prompt `assistant`, confinamiento de las tools de fichero a un workspace e `importOptional()` para las dependencias nativas.

### Cambiado
- Un comando que se ejecutó y falló es un `tool_error` recuperable que no consume reintento, y el contador de reintentos pasa a ser consecutivo.

### Corregido
- Lag de la UI en streams largos.
- Los tests de guardas ya no escriben en la auditoría real del usuario.
- `tsc --noEmit` en verde.

### Cambios a tener en cuenta
- Las tools `bash` y `ssh_exec` desaparecen en favor de `exec`. Los perfiles de agente que las listen muestran un aviso en `/agents` y `stratum agents list`; hay que cambiarlas a mano.
- `ssh.auditLog` queda obsoleto y se migra solo a `tools.auditLog`.

## [0.4.0] — 2026-09-14

Hitos 11 a 15.

### Añadido
- **Disciplina operativa** (Hito 11): bloque `# Work routing` en el system prompt; guardas por capas (hard-deny no configurable, `tools.guardedCommands` y rutas sensibles) evaluadas antes de pedir confirmación; tool `todo` con panel `<TodoView>`, `/todo` y `Ctrl+T`.
- **Skills** (Hito 12): descubrimiento en `~/.stratum/skills`, `~/.claude/skills` y sus equivalentes de proyecto, con índice en el prompt y cuerpo bajo demanda. **Riesgo del cambio**: aviso `large_change` al superar las 400 líneas autoradas.
- **TDD estricto** (Hito 13) con `tools.testCommand`: tool `test_evidence` que valida el ciclo RED → GREEN → REFACTOR. **Panel de cambios** `+N/-M` en la barra de estado y `/changes`. **Contabilidad de tokens** con estado (`Σ` real, `Σ n/d` si el backend no informa).
- **Transversales de prompting** (Hito 14): saneado de `GIT_DIR`/`GIT_WORK_TREE` heredados, opciones de `question` con token opaco y dominio cerrado, contrato de identidad y guías por puntero (`prompt.guides: 'pointers'`).
- **Perfiles de agente de primera clase** (Hito 15): `description` y `mode`, `@perfil tarea` en el chat, `stratum run --delegate` y `--agent`, `/agent`, `/agents` y `stratum agents list [--json]`.

### Corregido
- La capa de rutas sensibles también se aplica a los comandos de shell (`cat`, `Get-Content`, redirecciones…).
- `/context` usaba «tokens» para dos cosas distintas.
- `token_budget_unmetered` se emite también en turnos de una sola iteración.

## [0.3.0] — 2026-09-11

Primera versión estable en npm, con el mismo contenido que la 0.2.1-beta.0. La etiqueta `latest` apunta desde aquí a versiones estables.

## [0.2.1-beta.0] — 2026-09-11

Primera publicación en npm. Hitos 7 a 10.

### Añadido
- **Plan & Execute** (Hito 7): `/plan <tarea>` y `stratum run --plan` (`--yes`); plan de solo lectura, aprobación con edición inline y ejecución con checklist, persistido en `.stratum/plans/` y reanudable con `chat --resume`.
- **Subagentes** (Hito 8): tool `delegate_task` con contexto aislado y perfiles en `.stratum/agents/`; presupuesto de tokens, persistencia y reanudación; ejecución en paralelo acotada (`agents.maxConcurrency`), árbol vivo `<AgentTree>` e inspector `/subagents`.
- **SSH nativo** (Hito 9) sobre `ssh2`: pool de conexiones, verificación de host keys (TOFU/strict), jump hosts, `ssh_exec`, `ssh_upload`/`ssh_download`, auditoría y `stratum ssh list|trust`.
- **Cierre de la UI base** (Hito 10): `/clear`, `/compact`, `/context`, `/debug`, `/mcp reload`, `/sessions`, `/config`; `Ctrl+L`, `Ctrl+U` e historial de inputs; `<FatalError>`, `<InitProgressBlock>` y `<MCPStartup>`.
- Tool **`question`** (Hito 2.5 F7): una tanda de preguntas al usuario; sin TTY el agente sigue con supuestos.

### Corregido
- La autocompactación medía mal el contexto y rompía el historial.
- Parpadeo del logo al arrancar.

## [0.2.0] — 2026-06-19

Hitos 2 a 6. Solo tag de git.

### Añadido
- **Memoria** (Hitos 2 y 5): `STRATUM.md` global y de proyecto en el system prompt, decision store `decisions.json`, índice semántico `sqlite-vec` con embeddings ONNX locales, tools `store_decision` y `recall_decisions`, extracción automática y `stratum memory list|search|forget`.
- **Init estilo opencode** (Hito 2.5): `stratum init` y `/init` con `INITIALIZE_PROMPT`, tools `glob`/`list_directory`/`grep`, `read_file` con líneas numeradas y compresión conservadora.
- **Tools completas** (Hito 3): `edit_file` con diff unificado, `web_search` (DuckDuckGo + Tavily), `web_fetch`, confirmación destructiva y timeouts con cancelación.
- **Providers** (Hitos 3.5 y 6): asistente `stratum provider add`, `/model` con descubrimiento en vivo, `/provider`, fallback automático entre providers y health check.
- **MCP** (Hitos 4 y 4.1): cliente con heartbeat y reconexión, tools `mcp__<server>__<tool>`, carpeta gestionada `~/.stratum/mcp/` y arranque `lazy`/`eager`.
- Logging estructurado con niveles, fichero JSONL rotado y `stratum logs`.

## [0.1.4] — 2026-05-29

### Cambiado
- CI: se retira el paso de publicación en npm hasta configurar `NPM_TOKEN`.

## [0.1.3] — 2026-05-29

### Corregido
- Un timeout mata el grupo de procesos entero: los huérfanos ya no bloquean los streams en Linux.
- El script de release gestiona el commit y el tag directamente (problemas de npm con git en Windows).

## [0.1.2] — 2026-05-28

Primera versión etiquetada. Hitos 0 y 1.

### Añadido
- Scaffolding: TypeScript, tsup (ESM + CJS), Vitest y Commander.js.
- **Core agent loop** (Hito 1): loop ReAct en streaming con cliente OpenAI-compatible propio, `StreamBuffer` para tool calls fragmentadas, `ToolRegistry` y tools básicas, y UI con Ink.
- `/init` para generar o actualizar `STRATUM.md`.
- Render de markdown de las respuestas.

[0.7.0-beta.0]: https://github.com/choruzo/CLI/compare/v0.6.0...v0.7.0-beta.0
[0.6.0]: https://github.com/choruzo/CLI/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/choruzo/CLI/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/choruzo/CLI/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/choruzo/CLI/compare/v0.2.1-beta.0...v0.3.0
[0.2.1-beta.0]: https://github.com/choruzo/CLI/compare/v0.2.0...v0.2.1-beta.0
[0.2.0]: https://github.com/choruzo/CLI/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/choruzo/CLI/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/choruzo/CLI/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/choruzo/CLI/releases/tag/v0.1.2
