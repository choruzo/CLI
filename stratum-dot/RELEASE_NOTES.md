> [!WARNING]
> **Pre-release experimental.** Stratum Dot todavía puede hacer cosas raras: estados que tardan en reflejarse, sesiones que se quedan en la lista, ventanas que no aparecen donde esperas o errores de conexión con el daemon. El Stratum Protocol v1 todavía no está congelado, así que una versión de Dot puede no entenderse con otra de la CLI. Úsala para probar, no como la única forma de vigilar un agente que toca algo importante, y [abre una incidencia](https://github.com/choruzo/CLI/issues) con lo que veas.

Stratum Dot es el cockpit de escritorio de `stratumd` y, desde la 0.2.0, también tu **asistente**: una ventana pequeña y un icono en la bandeja para ver las sesiones vivas de Stratum —las que aloja el daemon y las que publican `stratum chat` y `stratum run` desde una terminal—, conversar con el agente, contestar lo que te pide y dejarle tareas a su asistente, que trabaja en una caja aislada.

## Novedades de la 0.4.1

- **Notas de voz**: mantén **`Ctrl+Alt+D`** (o el botón de micro junto a *Send*) para hablar y suelta para que el daemon lo transcriba en local. El texto va al campo para que lo revises antes de enviarlo. Hace falta activarlas en la CLI (`"voice": { "enabled": true }` en la config global) y descargar el modelo una vez con `stratum voice download` (~4 GB).
- El atajo del Dot compacto pasa a **`Ctrl+Alt+D`** (`Ctrl+Alt+Space` lo usa también la app de Claude de escritorio), y el compacto se ha rediseñado.

Desde la 0.4.0, Dot se actualiza solo: *Install and restart* en el aviso.

## Requisitos

- **Stratum CLI 0.17.0 o posterior**, instalada aparte y con `stratum` en el `PATH`: `npm install -g stratum-cli` (Node.js 22 o posterior). Dot no la lleva dentro: arranca el daemon con `stratum daemon start` si no hay uno en marcha, y sin la CLI solo puede observar un daemon que arranque otro.
- Un provider configurado en la CLI (`stratum provider add …`): Dot no tiene ajustes propios.
- Para la caja del asistente: **Podman** o Docker instalado y `"box": { "enabled": true }` en la config global de la CLI. La primera vez, arrancarla construye la imagen (tarda unos minutos). Sin caja, el asistente conversa pero no ejecuta nada.
- Para que use la pantalla de la caja: un modelo con visión declarada en `provider.providers.<alias>.models.<id>.vision` de la config de la CLI.
- Para Telegram: un bot de BotFather, `stratum channels telegram setup` y emparejar desde el panel *Telegram*.
- Para aprobar desde Dot, una clave de aprobador: `stratum approvals set-key`.
- Para que las rutinas venzan sin abrir nada: `stratum daemon autostart on`.

## Qué puede hacer

- **Ver todas tus sesiones vivas** con su estado, perfil, modelo, anfitrión (`daemon` o `cli (peer)`), duración del run y lo que tienen pendiente.
- **Conversar**: *New chat* abre una sesión alojada en el daemon, que sigue viva aunque cierres Dot y vuelve tras un reinicio del daemon.
- **Conducir un run**: pausar (en el siguiente punto seguro), reanudar, cancelar y redirigirlo con steering mientras trabaja.
- **Activity**: contexto, tokens (sin estimar: `n/a` si el backend no los da), jobs, tools y actividad reciente de cada sesión.
- **Approval Center**: aprobar o denegar comandos, contestar preguntas y decidir planes de cualquier sesión, también de una terminal (gana la primera respuesta). Se desbloquea con la clave de aprobador en una ventana nativa aparte —la clave nunca llega a la interfaz web— y cada resolución sensible se confirma en otra ventana nativa.
- **Continuidad**: una sesión de `chat` que pasas al daemon (`/detach`) sigue en la misma fila, con su conversación, y desde ahí ya se le puede escribir.
- Bandeja con lo que te espera, una sola instancia y atajos (`Ctrl+N`, `Ctrl+K`, `Esc`).

## Limitaciones conocidas

- **El instalador de Windows no lleva firma Authenticode**: SmartScreen avisará al abrir el `.exe` («Más información → Ejecutar de todas formas»). Los paquetes del auto-update sí van firmados (minisign) y Dot comprueba esa firma antes de instalar nada.
- Probada sobre todo en **Windows 11**. En Linux compila y pasa sus tests en CI, pero la bandeja, las ventanas nativas y las notificaciones faltan por probar en un escritorio real; en GNOME sin la extensión AppIndicator el icono de la bandeja no aparece (*Quit Dot* está también en la ventana). macOS no está soportado.
- Si lanzas Dot desde el menú de aplicaciones de Linux, puede no ver `stratum` si lo instalaste con nvm u otra ruta que solo añade tu shell al `PATH`: arranca el daemon tú con `stratum daemon start`.
- Computer use solo es fiable con modelos medidos (`glm5.3-flash` acierta las tareas de prueba; los de coordenadas `norm1000` fallan bastante más).
- Dot no cierra sesiones, no lista sesiones guardadas, no cambia de modelo en una sesión viva y no elige carpeta con un diálogo (el directorio se escribe). Los chats abiertos cuentan para `daemon.maxSessions` (16) hasta `stratum daemon stop`.
- Algunas tools se ven con un estado engañoso por deuda del protocolo: `question` aparece como *Interrupted* aunque se contestara, y una tool descartada por steering como *Failed*.
- Un proceso que corre con tu mismo usuario sigue dentro de tu dominio de confianza: puede conectarse al daemon como cualquier cliente. Modelo de amenaza en [`docs/dot.md`](https://github.com/choruzo/CLI/blob/main/docs/dot.md) §14.3.

Arquitectura y detalle: [`docs/dot.md`](https://github.com/choruzo/CLI/blob/main/docs/dot.md). Verifica las descargas con `SHA256SUMS.txt`.
