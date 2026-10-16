# Changelog — Stratum Dot

Cambios de cada versión de Stratum Dot, el cockpit de escritorio de `stratumd`, de la más reciente a la más antigua. Los instaladores (`.exe`, `.deb`, `.AppImage`) están en las releases `dot-v*` de GitHub; mientras Dot sea 0.x, todas son **pre-releases**. La CLI se versiona aparte: ver [`stratum-cli/CHANGELOG.md`](../stratum-cli/CHANGELOG.md).

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/).

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
