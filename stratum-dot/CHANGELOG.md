# Changelog — Stratum Dot

Cambios de cada versión de Stratum Dot, el cockpit de escritorio de `stratumd`, de la más reciente a la más antigua. Los instaladores (`.exe`, `.deb`, `.AppImage`) están en las releases `dot-v*` de GitHub; mientras Dot sea 0.x, todas son **pre-releases**. La CLI se versiona aparte: ver [`stratum-cli/CHANGELOG.md`](../stratum-cli/CHANGELOG.md).

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/).

## [0.3.0] — 2026-11-05

Pre-release, sigue siendo experimental. Necesita **Stratum CLI 0.13.0** o posterior. Instaladores sin firmar y sin auto-update.

### Añadido
- **Dot compacto**: `Ctrl+Alt+Space` o la bandeja abren una ventana flotante, sin marco y siempre encima, para escribirle al asistente (un turno, o steering si está trabajando). Se cierra con `Esc`, con el atajo o al perder el foco.
- **Conversación nueva** del asistente (*New conversation*, confirmada): la actual se compacta entera a su memoria de sesión, se archiva y la nueva la hereda en solo lectura. Si algo falla, la actual se queda como estaba.
- **Panel *Memory***: lo que recuerda el asistente, con procedencia (*Open* lleva a la conversación donde se guardó), búsqueda y *Forget* con confirmación; aparte, lo heredado de la conversación anterior.
- **Concesiones de aprobación** de 10, 30 o 60 minutos para una tool y un target («Allow for…»), con la duración en la confirmación nativa y un panel para revocarlas. Nunca en lo forzado, con frase ni en una rutina.
- **Conectores MCP del asistente**, solo de `companion.mcp.servers` en la config global de la CLI.
- **Panel *Telegram***: el bot y su estado, emparejar un chat (código y enlace, confirmado en la ventana nativa) y desemparejar. Los mensajes y resoluciones que llegan desde Telegram se marcan «From Telegram».
- **Imágenes del asistente** en la conversación (`send_image`), traídas del daemon por trozos.

### Cambiado
- Dot abre en la vista *Asistente*; la cabina de sesiones pasa a *Sessions* (`Esc` vuelve al asistente). Por debajo de 720 px los paneles del asistente van en pestañas.

## [0.2.0] — 2026-11-03

Pre-release, sigue siendo experimental. Necesita **Stratum CLI 0.12.0** o posterior (`npm install -g stratum-cli`). Instaladores sin firmar y sin auto-update.

### Añadido
- **Vista *Asistente***: Dot tiene su propio asistente, el agente `companion`, con su memoria y una sola conversación de larga vida en el daemon que sigue ahí tras cerrar Dot o reiniciar el daemon.
- **Panel de la caja**: estado, runtime, imagen, red y carpeta compartida de la caja del asistente, con arrancar, parar y recrear. El asistente solo ejecuta dentro de ella.
- **La pantalla de la caja en vivo** (solo lectura), con el indicador «using the screen» y Stop mientras el asistente la maneja. Avisa si el modelo no está declarado con visión, y el selector de *New chat* marca los que la tienen.
- **Rutinas**: panel para crear, editar, ejecutar ya, activar, desactivar y borrar tareas programadas del asistente, con su sesión propia («Routine · nombre» en la lista) y la marca «Proposed by the assistant» en las que propuso él. Al terminar una rutina, una notificación del sistema que, al pulsarla, abre su sesión.

### Cambiado
- Las sesiones del daemon y su conversación vuelven tras un reinicio del daemon (con Stratum CLI 0.9.0 o posterior).

## [0.1.0] — 2026-10-16

Primera pre-release pública, experimental: puede hacer cosas raras. Necesita **Stratum CLI 0.9.0-beta.0** o posterior (`npm install -g stratum-cli@beta`). Instaladores sin firmar y sin auto-update.

### Añadido
- Lista de las sesiones vivas de `stratumd` —alojadas en el daemon o publicadas por `stratum chat`/`run` desde una terminal— con estado, perfil, modelo, anfitrión, duración y pendientes.
- Detalle de una sesión con dos pestañas: **Chat** (la conversación, sacada de los eventos del protocolo) y **Activity** (run, contexto, tokens, jobs, tools y actividad reciente).
- **New chat**: abre una sesión alojada en el daemon, que sobrevive a Dot.
- Pausar, reanudar, cancelar (con confirmación) y redirigir (steering) un run, sin actualización optimista: la interfaz cambia cuando lo confirma el daemon.
- **Approval Center**: aprobaciones, preguntas y planes de cualquier sesión. La autoridad de aprobar va por una conexión nativa aparte, desbloqueada con la clave de aprobador en una ventana propia; la clave nunca llega al webview y cada resolución sensible se confirma en una ventana nativa.
- Antes de enviar credenciales, Dot comprueba con el sistema quién atiende el canal del daemon.
- Una sesión traspasada de una terminal al daemon (`/detach`) sigue en su sitio, con su conversación, y pasa a aceptar mensajes.
- Bandeja (sesiones, lo que te espera, abrir el Approval Center, salir), instancia única y atajos de teclado.
- Arranca el daemon con `stratum daemon start` si no hay ninguno; nunca lo apaga.
