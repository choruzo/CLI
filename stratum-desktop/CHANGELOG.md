# Changelog — Stratum Desktop

Cambios de cada versión de la app de escritorio, de la más reciente a la más antigua. Los instaladores (`.msi`, `.exe`, `.deb`, `.AppImage`) están en las releases `desktop-v*` de GitHub, y la app instalada se actualiza sola desde la 0.2.0. La CLI se versiona aparte: ver [`stratum-cli/CHANGELOG.md`](../stratum-cli/CHANGELOG.md).

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/).

## [0.3.0] — 2026-09-25

Pulido visual. Detalle y criterios en [`MEJORAS_VISUALES.md`](MEJORAS_VISUALES.md).

### Añadido
- Bloques de código con cabecera (lenguaje) y botón **Copiar**.
- Botón flotante **Ir al final** cuando subes a leer, con un punto ámbar si llegó contenido nuevo.
- **Icono por tipo de tool** (fichero, búsqueda, web, memoria, lista, pregunta, MCP…).
- **Acciones por respuesta** al pasar el ratón: copiar el texto, copiar como markdown y reintentar.
- Logo de estratos en la conversación vacía.

### Cambiado
- **Tipografía IBM Plex Sans + IBM Plex Mono**, empaquetada en local (woff2 latino, OFL): mismo aspecto en Windows y Linux y sin descargas.
- **Composer rediseñado**: una sola tarjeta con `+`, texto y enviar; «Detener» como botón circular; anillo de foco suave.
- Pulido general: scrollbars finas, selección en ámbar, cifras tabulares en la barra de estado y duraciones, burbuja del usuario con tinte cálido, markdown más legible y hover fundido en botones y listas.

## [0.2.0] — 2026-09-25

Primera versión con instaladores. Reúne los hitos D0 a D7.

### Añadido
- **Arquitectura** (D0): app Tauri con el core de Stratum como sidecar Node SEA, canal local autenticado por token.
- **Chat de asistente** (D1): IPC validado, streaming, confirmaciones y preguntas del agente.
- **Espacio de trabajo por conversación** (D2): adjuntar ficheros (diálogo o arrastrar y soltar), tarjetas de los ficheros generados, «Guardar como…», «Abrir» y vista previa. Las tools de fichero quedan confinadas al workspace y no hay `exec`.
- **Retención** (D3): los workspaces sin uso se comprimen y se purgan según `desktop.workspaces.{compressAfterDays,deleteAfterDays}`; fijar una conversación la protege. «Descargar todo (.zip)».
- **Varias conversaciones** (D4): sidebar con búsqueda (`Ctrl+K`), índice de la conversación, panel de memoria y de ficheros, cola de turnos (`desktop.maxConcurrentTurns`), `/clear`, `/compact` y `/model` por conversación.
- **Ajustes** (D5): providers, modelo, búsqueda web, memoria, espacios de trabajo y opciones avanzadas sin tocar el `.stratumrc.json` a mano; asistente para añadir providers.
- **Integración con el sistema** (D6): notificaciones al terminar una respuesta larga, atajo global para traer la ventana (`Ctrl+Shift+Space` por defecto), onboarding cuando no hay provider y pantalla de fallo de arranque con acceso a los logs.
- **Pulido** (D7): ventana sin marco con barra de título propia que recuerda posición y tamaño, razonamiento del modelo visible y plegable, indicador de espera animado, contraste AA, `prefers-reduced-motion` y **auto-update** (nunca instala sin que lo pidas).

[0.3.0]: https://github.com/choruzo/CLI/releases/tag/desktop-v0.3.0
[0.2.0]: https://github.com/choruzo/CLI/releases/tag/desktop-v0.2.0
