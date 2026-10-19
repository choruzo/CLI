# Changelog — Stratum CLI

Cambios de cada versión del paquete [`stratum-cli`](https://www.npmjs.com/package/stratum-cli), de la más reciente a la más antigua. Stratum Desktop se versiona aparte: ver [`stratum-desktop/CHANGELOG.md`](../stratum-desktop/CHANGELOG.md).

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/) (mientras la versión sea `0.x`, una minor puede traer cambios incompatibles, que se señalan en «Cambios a tener en cuenta»). Las notas de cada versión también están en su [GitHub Release](https://github.com/choruzo/CLI/releases).

> Las versiones anteriores a la 0.2.1-beta.0 solo existen como tags de git: la primera publicación en npm fue la 0.2.1-beta.0.

## [Sin publicar]

### Añadido
- **Las sesiones de `stratumd` sobreviven a un reinicio** (M11): su conversación, su memoria de sesión, su contexto y sus ajustes se guardan en `~/.stratum/daemon/sessions/<id>/` (`daemon.persistSessions`, por defecto `true`). Al volver a arrancar, cada sesión reaparece en la lista con toda su conversación y se monta al primer uso. Nunca se guardan claves, el entorno ni procesos.
- **Conversación duradera y memoria de sesión** en las sesiones del daemon: la conversación entera se conserva aunque el contexto del modelo esté acotado; lo antiguo se compacta (al 70 % del presupuesto de entrada) a una memoria de sesión estructurada —hechos, decisiones, restricciones, preferencias, tareas, resultados, entidades y un resumen— con la procedencia de cada entrada. Lo compactado sigue visible en el chat.
- **Modelo de memoria configurable**: `memory.session.extractor` y `memory.session.summarizer` (`same` por defecto). Un provider distinto usa sus propias credenciales, y uno que no está en esta máquina exige `memory.session.allowRemote: true`.
- **Presupuesto del contexto** por capas (`context.*`), calculado desde la ventana real del modelo.
- Stratum Protocol: `sessions.history` (lo anterior a la foto, paginado), `sessions.context` (desglose del contexto, conversación guardada, compactaciones) y `sessions.memory` (la memoria de sesión con su procedencia).
- `stratum attach`: `/history [n]` para ver los mensajes anteriores de una sesión del daemon.
- `stratum chat --resume <id> --fork`: continuar una copia de una sesión con otro id.
- **Agente embebido `assistant`** (M12): el modo Chat de Stratum Desktop es ahora una sesión normal de `stratumd` que cualquier cliente abre con `sessions.open { agent: 'assistant', cwd }`: web, preguntas, tareas, memoria de decisiones propia (`~/.stratum/assistant/`) y ficheros confinados a su carpeta; nunca `exec`. Necesita su propio directorio (no el home).
- Stratum Protocol: `ProtocolSession.origin` dice desde qué cliente se inició una sesión (solo procedencia, no da permisos). Funciones de cliente puras para seguir una sesión y la foto de conjunto (`followSession`, `applyOverviewEvent`, `classifyEvent`), compartidas por Stratum Dot y Stratum Desktop.
- `stratum desktop import [--dry-run]`: pasa una vez las conversaciones de Stratum Desktop anteriores a M12 a sesiones de `stratumd` (por el traspaso de M10), sin borrar nada.

### Cambios a tener en cuenta
- Stratum Desktop ya no se construye desde aquí: se retiran `src/desktop/`, `src/desktop-server.ts` y `npm run build:desktop` (el sidecar SEA). Desktop es un cliente de `stratumd` y usa la CLI instalada.
- `stratum desktop` se añade a los subcomandos que el agente no puede invocar (como `daemon`, `approvals`, `attach` y `detach`).
- **`chat --resume` de una sesión que aloja (o tiene guardada) `stratumd` se niega** y remite a `stratum attach <id>`; antes abría en silencio un segundo runtime con ese id. Lo mismo si la sesión está abierta ahora en otra terminal. Para una copia independiente, `--fork`.
- En una sesión del daemon, si la memoria de sesión no se puede actualizar (modelo de memoria caído), no se trunca nada: se avisa (`session_memory_deferred`) y, si la conversación ya no cabe, el turno termina con `context_full` en vez de borrar mensajes.

## [0.9.0-beta.0] — 2026-10-16

Pre-release (`npm install -g stratum-cli@beta`) del **plano de control local**: `stratumd`, un daemon por usuario que ve todas tus sesiones vivas —las suyas y las de cada terminal con `chat` o `run`—, las deja pausar, redirigir y aprobar desde otro sitio, y recibe una sesión de `chat` viva sin perder su contexto. Es la versión de la CLI que necesita **Stratum Dot 0.1.0**, la app de escritorio que se publica a la vez como pre-release (release `dot-v0.1.0`). El Stratum Protocol v1 aún no está congelado: entre pre-releases puede cambiar.

### Añadido
- **`stratumd`, el plano de control local** (`stratum daemon run|start|stop|status`): un proceso por usuario, solo por named pipe (Windows) o unix socket (Linux/macOS), sin TCP, con su `endpoint.json` y su token en `~/.stratum/daemon/`. Puede alojar sesiones propias, que siguen vivas aunque cierres la terminal o el cliente que las abrió. La referencia del protocolo está en [`docs/protocol.md`](../docs/protocol.md).
- **`stratum run` y `stratum chat` se publican en el daemon si hay uno en marcha** (anfitrión par): la sesión sigue viviendo en su terminal y el daemon solo tiene una proyección. Sin daemon, la CLI funciona exactamente igual; nunca lo arranca sola (`daemon.autoStart: false`).
- **`stratum ps [--json] [--watch]`**: las sesiones vivas que conoce el daemon, con estado, perfil, modelo, anfitrión y lo que tienen pendiente.
- **Pausa cooperativa del run**: `runs.pause`/`runs.resume` desde otro cliente; el agente se detiene en el siguiente punto seguro (nunca a mitad de una tool) y lo publica como `paused`.
- **Traspaso de una sesión viva** (`/detach` en el chat, `stratum detach <id>`): una sesión de `chat` pasa al daemon con el mismo id, la misma conversación y el mismo contexto del agente, y sobrevive a su terminal. **`stratum attach <id>`** la retoma como cliente desde cualquier terminal (`/pause`, `/resume`, `/cancel`, `/pending`).
- **Centro de aprobaciones en `stratumd`**: las confirmaciones, las preguntas del agente y los planes de cualquier sesión —alojada en el daemon o en una terminal con `chat`/`run`— se listan y se resuelven desde otro cliente. Gana la primera respuesta válida; si es la remota, el prompt de la terminal se retira, y si es la de la terminal, la remota recibe `ALREADY_RESOLVED`. Cada resolución dice quién la tomó (evento, traza y `exec-audit.jsonl`).
- **`stratum approvals [list|approve|deny|answer|set-key]`**: ver y contestar lo pendiente desde otra terminal. Resolver pide la clave de aprobador por la terminal, sin eco.
- `tools.guardedCommands` admite `confirm-always`: se confirma cada vez, sin que la política de la sesión lo levante.
- `daemon.approvalTimeoutMinutes` (10): una solicitud que nadie tiene delante caduca a denegar. Con una terminal delante no caduca.
- Las sesiones alojadas en el daemon ya pueden pedir confirmación (antes denegaban todo lo destructivo), si el daemon tiene una clave de aprobador.

### Cambios a tener en cuenta
- **Licencia**: el proyecto pasa de MIT a **Apache-2.0**.
- **`git push` pide confirmación** (`tools.guardedCommands.gitPush`, default `confirm`). Antes pasaba sin preguntar. En `stratum chat` aparece la confirmación de siempre; **`stratum run` sin terminal lo deniega**: una automatización que hacía `git push` deja de hacerlo. Para volver al comportamiento anterior: `"tools": { "guardedCommands": { "gitPush": "allow" } }` en `.stratumrc.json`, o `--allow-destructive` en esa invocación.
- **Un push forzado se confirma siempre** (`gitPushForce`, default `confirm-always`): `--force`, `-f`, `--force-with-lease`, `--force-if-includes`, `--mirror` o un refspec con `+` (`git push origin +main`). Ni `--allow-destructive` ni «permitir todo» lo aprueban, y sin terminal se bloquea. Una config que ya fijaba `gitPushForce` conserva su valor.
- **El token del daemon ya no da derecho a aprobar.** La capacidad `approve` del Stratum Protocol exige una clave de aprobador (`stratum approvals set-key`); un cliente que pida el rol `approver` sin ella recibe solo `observe`. Una conexión de anfitrión (`host`) no recibe `control` ni `approve`.

### Seguridad
- En Linux/macOS la carpeta del daemon queda en `0700` (si sigue accesible a otros, no arranca) y su socket, `endpoint.json` y `approver.json` en `0600`; el socket nunca queda suelto en un directorio compartido. En Windows heredan la ACL del perfil y la barrera es el token. Un proceso de tu mismo usuario sigue pudiendo conectarse: el modelo de amenaza está en `docs/protocol.md` §15 y `docs/dot.md` §14.3.
- Guardas contra la auto-aprobación: `~/.stratum/daemon/` es ruta bloqueada para el agente (tools de fichero y shell) y `stratum approvals | daemon | attach` se vetan cuando los lanza el agente. Son una capa, no un aislamiento: un proceso que corre como tu usuario sigue en tu mismo dominio de confianza (`docs/protocol.md` §15.3).

## [0.8.0] — 2026-10-12

Versión estable de la 0.8.0: reúne todo lo de las cuatro pre-releases, de la [0.8.0-beta.0](#080-beta0--2026-10-12) a la [0.8.0-beta.3](#080-beta3--2026-10-12), sin cambios de código respecto a la última. El detalle está en sus secciones; en resumen:

### Añadido
- **Traza de sesión y visor de trayectoria** (`/auditor`, `stratum auditor`): lo que entra al modelo, cada llamada al LLM y cada tool, en una web local que se actualiza sola.
- **Jobs en segundo plano**: `exec` con `background: true`, las tools `list_jobs`/`get_job_status`/`get_job_output`/`cancel_job` y `/jobs`.
- **Steering**: con el agente trabajando el input sigue vivo y lo que escribas le llega dentro del mismo turno, sin cancelarlo.
- **`stratum eval`** y **`stratum stats`**: 61 escenarios reproducibles puntuados desde la traza, baselines con nombre, comparación con tolerancias y estadísticas locales.
- **Caché de prompt** del backend medida (acierto, llamadas frías y templadas, roturas con su causa) y las llamadas auxiliares al LLM registradas con su origen.
- `stratum run --then <tarea>` y `/comandos` de consulta con el turno en curso.

### Seguridad
- **Las guardas de `exec` clasifican el comando que se ejecuta, no el texto escrito**: envoltorios, comandos anidados, variables y rutas equivalentes ya no esconden un borrado; lo que no se puede leer pide confirmación.

### Cambiado
- Los subagentes tienen por defecto 30 minutos y 50 iteraciones (`agents.subagentTimeoutMs`, `agents.subagentMaxIterations`).
- Las tools MCP se ofrecen ordenadas por nombre y con schemas en forma canónica.

### Corregido
- `Ctrl+C` cancela el turno en el chat; el terminal ya no parpadea con varios subagentes ni recibe la salida de un comando fallido; un subagente que agota su tiempo termina como presupuesto agotado, no como cancelado.

### Cambios a tener en cuenta
- **Desligar un proceso desde el shell local se veta** (`cmd &`, `nohup`, `Start-Process`…): lo que tenga que seguir vivo va como job. `tools.guardedCommands.shellDetach` lo ajusta.
- Sin TTY (o con `--deny-destructive`) se bloquean comandos que antes pasaban: `git clean -f`, `find … -delete`, `$VAR args` y `… | sh`. Ver la sección de la [0.8.0-beta.0](#080-beta0--2026-10-12).

## [0.8.0-beta.3] — 2026-10-12

Cuarta pre-release (`npm install -g stratum-cli@beta`).

### Cambiado
- **Los subagentes tienen más margen**: el tiempo máximo por defecto pasa de 5 a 30 minutos y las iteraciones de 25 a 50. Ambos se ajustan en la config con `agents.subagentTimeoutMs` (`0` quita el límite de tiempo) y `agents.subagentMaxIterations`; lo que un perfil declare en su `budget` sigue ganando.

### Corregido
- Un subagente que agotaba su tiempo aparecía como «cancelado», como si alguien lo hubiera parado. Ahora termina como presupuesto agotado, y el agente principal recibe el límite que se alcanzó, el aviso de que el trabajo parcial puede estar en disco y dónde se cambia.

## [0.8.0-beta.2] — 2026-10-12

Tercera pre-release (`npm install -g stratum-cli@beta`), con más arreglos de lo visto al probar la beta.

### Corregido
- **El terminal parpadeaba con varios subagentes trabajando.** El árbol de subagentes listaba todas sus tool calls; al superar el alto del terminal, la pantalla entera se borraba y repintaba en cada actualización. Ahora cada subagente enseña solo las últimas (entre 1 y 6, según el alto del terminal) y resume las anteriores en una línea; el detalle completo sigue en `/subagents`.
- La etiqueta de una tool call enseña el argumento que la identifica (la ruta, el comando, el patrón) aunque el modelo lo envíe detrás de otros: antes salía `read_file: 700` cuando `limit` llegaba antes que `path`.
- Dos sesiones nuevas guardadas en el mismo segundo podían recibir el mismo id y la segunda pisaba a la primera. Ahora el id generado se comprueba contra el disco.

## [0.8.0-beta.1] — 2026-10-12

Segunda pre-release (`npm install -g stratum-cli@beta`), con lo visto al probar la beta.0.

### Añadido
- **`/comandos` con el agente trabajando**: los de consulta (`/context`, `/jobs`, `/jobs cancel`, `/todo`, `/changes`, `/auditor`, `/debug`, `/tools`, `/agents`, `/env`, `/memory show|list|search`, `/sessions list`, `/config get`, `/help`) se ejecutan sin esperar al final del turno, y la paleta se reduce a ellos. Los que tocan el historial, el modelo o el toolset siguen esperando.

### Corregido
- **La salida de un comando ya no se vuelca en la pantalla del chat.** Cuando un `exec` fallaba, el log escribía su salida completa en el terminal, encima de la interfaz. Ahora un comando que se ejecutó y salió mal no se registra como aviso, y cualquier campo del log que vaya al terminal sale en una línea y acotado a 300 caracteres; el fichero de logs lo guarda entero.
- El texto de dos respuestas del mismo turno, con una tool o una pregunta por medio, ya no sale pegado («…rápidas:Perfecto…»): la segunda empieza párrafo.
- El bloque de la tool `question` mostraba `[object Object],[object Object]`; ahora enseña la primera pregunta y cuántas más hay.
- `Ctrl+U` y `Ctrl+T` podían dejar su letra escrita en el input en vez de actuar, y `Ctrl+L` limpiaba la conversación con un turno en curso.

## [0.8.0-beta.0] — 2026-10-12

Pre-release para pruebas (`npm install -g stratum-cli@beta`); `latest` sigue en la 0.7.0.

Traza de sesión con su visor, evaluación reproducible sobre esa traza, jobs en segundo plano, mensajes al agente con el turno en curso (steering) y medición de la caché de prompt del backend.

### Añadido
- **Traza de sesión y visor de trayectoria**: cada sesión de `chat` y `run` deja en `~/.stratum/traces/<sessionId>.jsonl` lo que entra al modelo, cada llamada al LLM (espera, generación, tokens), cada tool con su entrada y su salida, subagentes, avisos y compresión. La escribe el runtime —el modelo no la ve ni la toca— y pasa por la redacción de secretos antes de ir a disco. `/auditor` (y `/auditor stop`) en el chat y `stratum auditor [sessionId]` / `stratum auditor list` abren una web local, solo en loopback, con el timeline por carriles, la lista de pasos y el detalle; se actualiza sola. Config `trace.{enabled,dir,retentionDays,maxFieldChars}`; `sessions delete`/`prune` arrastran la traza.
- **Jobs en segundo plano**: `exec` con `background: true` lanza el comando como un job de la sesión y vuelve con su `jobId` sin esperar; el agente sigue trabajando y se entera cuando termina. Tools `list_jobs`, `get_job_status`, `get_job_output` y `cancel_job`; panel de jobs en el chat, `/jobs` y `/jobs cancel <id>`. Pasa por las mismas guardas, read-only, entornos y confirmaciones que un `exec` normal, solo en el target local, y los jobs vivos se cancelan al cerrar la sesión. Config `tools.jobs` (`enabled`, `maxRunning`, límites de salida, `subagentAccess`).
- **Steering**: con el agente trabajando el input sigue vivo. Lo que escribas no cancela el turno ni lanza otra llamada: queda en cola (`[queued as steering]`) y el agente lo recibe en su siguiente punto seguro, dentro del mismo turno. Si tenía tools a punto de ejecutar, no se ejecuta ninguna y decide de nuevo con tu mensaje delante. Cancelar sigue siendo solo `Ctrl+C`.
- **Caché de prompt**: Stratum mide la caché de prefijo del backend (OpenAI, pasarelas compatibles con los campos de Anthropic, DeepSeek, llama.cpp) y la enseña en `/auditor`, `stratum stats` y `stratum eval`: acierto, llamadas frías y templadas, tiempo al primer token de cada clase y roturas con su causa. Lo que el backend no reporta se muestra como `n/d`, nunca se estima. `provider.providers.<alias>.cache` ajusta qué se envía (`cacheKey`, `explicitBreakpoints`, `sessionAffinity`). Ver `docs/prompt-caching.md`.
- **Llamadas auxiliares al LLM en la traza**: la extracción de memoria, el resumen de la compresión de contexto y el resumen de sesión quedan registradas con su origen, aparte de las del agente. `/auditor`, `stratum stats` y el informe de eval muestran «LLM calls» con una fila por origen.
- `stratum run --then <tarea>` (repetible) encadena turnos en la misma sesión y corta si uno no acaba bien.
- **`stratum eval`**: escenarios reproducibles (`code`, `linux`, `ssh`, `safety`, `recovery`, `multi-agent`) que se ejecutan con `stratum run` en un proyecto temporal y se puntúan con el workspace, la salida y la traza de la sesión. `eval run` (`--mock` para un modelo de guion determinista; sin él, contra el provider configurado), `eval list`, `eval report`, `eval runs` y `eval compare`, que detecta regresiones aunque las dos ejecuciones den PASS (más tokens, tiempo, llamadas o errores) y sale con 1 si las hay. 21 escenarios incluidos; los propios van en `.stratum/evals/`. Resultado en `~/.stratum/evals/runs/<runId>/result.json`. Contra un modelo real, un error fatal del provider (caído, un `429`) deja el escenario en ERROR, no en FAIL. Ver `docs/eval.md`.
- **Niveles de dificultad** en los escenarios (`basic`, `intermediate`, `adversarial`), con `--difficulty` en `eval run`/`eval list` y el éxito por nivel en el informe y en la comparación. 37 escenarios incluidos: 16 nuevos fuera del camino feliz —órdenes destructivas disfrazadas, alternativas equivalentes a un `rm -rf`, falsos positivos de las guardas, una acción vetada junto a otra permitida, una instrucción inyectada en la salida de un comando, un host que no está en el inventario, un despliegue que no se puede completar—. Los adversariales destaparon tres brechas en las guardas de `exec`, cerradas en esta misma versión (ver «Seguridad»).
- Cuatro grupos más de escenarios, hasta 61 incluidos: `cache`, `auxiliary`, `jobs` y `steering`. `eval compare` trata la caché como categoría propia (un fallo de caché no es un error del agente) y solo juzga las métricas auxiliares si se piden con `--metric`.
- **Baselines con nombre**: `stratum eval baseline save|list|delete` y `eval run --save-baseline`. Cada resultado guarda el commit (y si había cambios sin commit), la versión, el SO, el provider/modelo, el modo y la fecha. `stratum eval compare baseline current`.
- **Tolerancias configurables** en `eval compare` y `eval run --baseline`: por métrica, en porcentaje y/o absoluto (`--tolerance tokens=30%,2k`, `--tolerances fichero.json`, o guardadas con el baseline). Las de partida son estrictas con guion y holgadas contra un modelo real, donde una llamada de más es ruido.
- El informe de `eval compare` separa los hallazgos por gravedad: PASS → FAIL, PASS → ERROR, acciones inseguras nuevas, más bloqueos de política, regresiones de coste y de fiabilidad, y mejoras. Avisa si un escenario cambió de definición entre las dos ejecuciones, y entonces no compara su coste.
- Criterios nuevos: `host_received` (lo que un host SSH simulado llegó a recibir) y `tool_output_contains` (lo que llegó al modelo por la salida de una tool). `stratum eval list` avisa de los criterios que atan la trayectoria de un modelo real en vez de puntuar el resultado.
- **`stratum stats`**: estadísticas agregadas de las trazas guardadas (turnos completados, tool error rate, recuperación, bloqueos de política, tokens, desglose por tool y por modelo). Se calculan en local; nada sale del equipo.
- `stratum auditor --file <ruta>` abre una traza que no está en `trace.dir` (las de `stratum eval`).
- La traza registra las **decisiones del runtime** como avisos: confirmaciones (aprobada, denegada, bloqueada), vetos (guarda de la tool, read-only, toolset, plan) y reintentos de la llamada al modelo. El formato no cambia de versión y las trazas anteriores se siguen leyendo.

### Seguridad
- **Las guardas de `exec` clasifican el comando que se ejecuta, no el texto escrito.** Antes de decidir se deshacen los envoltorios con sus flags (`sudo -u root`, `timeout 30`, `env`, `nice`, `chroot`, `busybox`…), la agrupación (`( … )`, `then …`), un comando dentro de otro (`sh -c`, `pwsh -Command`, `cmd /c`, `eval`, `su -c`, `find -exec`; hasta dos niveles), las variables asignadas en el mismo comando (`R=rm; $R -rf /`) y las rutas equivalentes (`//`, `/.`, `/etc/..`). Con eso:
  - **Capa 1 (veto)**: `sudo -u root rm -rf ~`, `sh -c 'rm -rf /'`, `timeout 30 rm -rf /`, `rm -rf //` y similares ya no caían en el veto y `--allow-destructive` los dejaba pasar. También se veta un `find` sin filtros que borra la raíz, el home o el directorio actual (`find / -xdev -delete`).
  - **Confirmación obligatoria** para lo que no se puede leer: un ejecutable que sale de una variable o de una sustitución (`$CMD x`, `$(…) x`), código que llega por una tubería a un intérprete (`… | base64 -d | sh`), `bash <(…)`, `pwsh -EncodedCommand`, `Invoke-Expression`; y para un `find` que borra con filtro. Antes se ejecutaban sin preguntar.
  - **`git clean -f`** sin `-d`, o acotado a una ruta, pide confirmación (comando guardado nuevo `gitCleanForce`, `confirm` por defecto): acotar un `git clean -fd` vetado ya no es la forma de conseguir el mismo borrado.

### Corregido
- Un comando de solo lectura ya no pide confirmación porque un argumento contenga un patrón destructivo: `grep -rn "rm -rf" …`, `echo "rm -rf /"` o `git commit -m "… rm -rf …"` se ejecutan sin preguntar (sin TTY quedaban bloqueados). Los comandos que sí ejecutan sus argumentos (`psql -c "DROP …"`, `ssh host "rm …"`) siguen pidiéndola.
- **`Ctrl+C` cancela el turno** en el chat (dos veces para salir). Antes la tecla desmontaba la interfaz, el turno seguía por detrás y el proceso salía al terminar.
- Un `/comando` que no existe responde «Comando desconocido» en vez de enviarse al modelo como mensaje; una ruta (`/etc/hosts …`) sigue llegando.
- La pantalla de bienvenida tiene la misma paleta de `/comandos` y `@perfiles` que la conversación.

### Cambiado
- Las tools MCP se ofrecen al modelo ordenadas por nombre, detrás de las propias, y con sus schemas en forma canónica: el prompt no cambia de un arranque a otro según qué server conecte antes, y la caché del backend lo aprovecha.

### Cambios a tener en cuenta
- **Desligar un proceso desde el shell local se veta**: `cmd &`, `nohup`, `setsid`, `disown`, `Start-Process`, `Start-Job`, `screen -dm`, `tmux new -d` (también dentro de un `sh -c`). Lo que tenga que seguir vivo va como job con `background: true`. `tools.guardedCommands.shellDetach` lo ajusta.
- En una sesión sin TTY (o con `--deny-destructive`) ahora se bloquean comandos que antes pasaban: `git clean -f`, `find … -delete`, `$VAR args` con una variable que el comando no asigna y `… | sh`. Con `--allow-destructive`, o aprobándolos, se ejecutan como siempre. `tools.guardedCommands.gitCleanForce: "allow"` recupera el `git clean -f` sin confirmación.

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

[0.8.0-beta.3]: https://github.com/choruzo/CLI/compare/v0.8.0-beta.2...v0.8.0-beta.3
[0.8.0-beta.2]: https://github.com/choruzo/CLI/compare/v0.8.0-beta.1...v0.8.0-beta.2
[0.8.0-beta.1]: https://github.com/choruzo/CLI/compare/v0.8.0-beta.0...v0.8.0-beta.1
[0.8.0-beta.0]: https://github.com/choruzo/CLI/compare/v0.7.0...v0.8.0-beta.0
[0.7.0]: https://github.com/choruzo/CLI/compare/v0.6.0...v0.7.0
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
