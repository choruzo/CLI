> [!WARNING]
> **Pre-release experimental.** Stratum Dot es la primera versión pública de la app y puede hacer cosas raras: estados que tardan en reflejarse, sesiones que se quedan en la lista, ventanas que no aparecen donde esperas o errores de conexión con el daemon. El Stratum Protocol v1 todavía no está congelado, así que una versión de Dot puede no entenderse con otra de la CLI. Úsala para probar, no como la única forma de vigilar un agente que toca algo importante, y [abre una incidencia](https://github.com/choruzo/CLI/issues) con lo que veas.

Stratum Dot es el cockpit de escritorio de `stratumd`: una ventana pequeña y un icono en la bandeja para ver las sesiones vivas de Stratum —las que aloja el daemon y las que publican `stratum chat` y `stratum run` desde una terminal—, conversar con el agente y contestar lo que te pide.

## Requisitos

- **Stratum CLI 0.9.0-beta.0 o posterior**, con `stratum` en el `PATH`: `npm install -g stratum-cli@beta`. Dot arranca el daemon con `stratum daemon start` si no hay uno en marcha; sin la CLI solo puede observar un daemon que arranque otro.
- Un provider configurado en la CLI (`stratum provider add …`): Dot no tiene ajustes propios.
- Para aprobar desde Dot, una clave de aprobador: `stratum approvals set-key`.

## Qué puede hacer

- **Ver todas tus sesiones vivas** con su estado, perfil, modelo, anfitrión (`daemon` o `cli (peer)`), duración del run y lo que tienen pendiente.
- **Conversar**: *New chat* abre una sesión alojada en el daemon, que sigue viva aunque cierres Dot.
- **Conducir un run**: pausar (en el siguiente punto seguro), reanudar, cancelar y redirigirlo con steering mientras trabaja.
- **Activity**: contexto, tokens (sin estimar: `n/a` si el backend no los da), jobs, tools y actividad reciente de cada sesión.
- **Approval Center**: aprobar o denegar comandos, contestar preguntas y decidir planes de cualquier sesión, también de una terminal (gana la primera respuesta). Se desbloquea con la clave de aprobador en una ventana nativa aparte —la clave nunca llega a la interfaz web— y cada resolución sensible se confirma en otra ventana nativa.
- **Continuidad**: una sesión de `chat` que pasas al daemon (`/detach`) sigue en la misma fila, con su conversación, y desde ahí ya se le puede escribir.
- Bandeja con lo que te espera, una sola instancia y atajos (`Ctrl+N`, `Ctrl+K`, `Esc`).

## Limitaciones conocidas

- **Instaladores sin firmar** y **sin auto-update**: Windows SmartScreen avisará al abrir el `.exe` («Más información → Ejecutar de todas formas»). Las versiones nuevas se instalan a mano.
- Probada sobre todo en **Windows 11**. En Linux compila y pasa sus tests en CI, pero la bandeja, la ventana de desbloqueo y la de confirmación faltan por probar en un escritorio real; en GNOME sin la extensión AppIndicator el icono de la bandeja no aparece (*Quit Dot* está también en la ventana). macOS no está soportado.
- Si lanzas Dot desde el menú de aplicaciones de Linux, puede no ver `stratum` si lo instalaste con nvm u otra ruta que solo añade tu shell al `PATH`: arranca el daemon tú con `stratum daemon start`.
- Dot no cierra sesiones, no lista sesiones guardadas, no cambia de modelo en una sesión viva y no elige carpeta con un diálogo (el directorio se escribe). Los chats abiertos cuentan para `daemon.maxSessions` (16) hasta `stratum daemon stop`.
- Algunas tools se ven con un estado engañoso por deuda del protocolo: `question` aparece como *Interrupted* aunque se contestara, y una tool descartada por steering como *Failed*.
- La conversación no sobrevive a un reinicio del daemon.
- Un proceso que corre con tu mismo usuario sigue dentro de tu dominio de confianza: puede conectarse al daemon como cualquier cliente. Modelo de amenaza en [`docs/dot.md`](https://github.com/choruzo/CLI/blob/main/docs/dot.md) §14.3.

Arquitectura y detalle: [`docs/dot.md`](https://github.com/choruzo/CLI/blob/main/docs/dot.md). Verifica las descargas con `SHA256SUMS.txt`.
