# Changelog — Stratum Desktop

Cambios de cada versión de la app de escritorio, de la más reciente a la más antigua. Los instaladores (`.msi`, `.exe`, `.deb`, `.AppImage`) están en las releases `desktop-v*` de GitHub, y la app instalada se actualiza sola desde la 0.2.0. La CLI se versiona aparte: ver [`stratum-cli/CHANGELOG.md`](../stratum-cli/CHANGELOG.md).

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/).

## [0.10.0] — 2026-11-06

Acompaña a **Stratum CLI 0.14.0**, que es la que conviene tener instalada. Ajustes necesita su `stratum config set --global`: con una CLI más vieja, Ajustes se queda en solo lectura y avisa de que hay que actualizarla.

### Añadido
- **Aprobar, contestar y decidir desde Desktop**: las aprobaciones, las preguntas del agente y los planes se resuelven en tarjetas del chat, con la misma autoridad separada que Dot (desbloqueo y confirmación nativa de lo sensible).
- **Memoria global del asistente**: sección «Memoria del asistente» en el panel *Contexto y memoria*, con sus decisiones y su procedencia, y la opción de olvidarlas.
- **Retención de las carpetas de conversación**: los ficheros de una conversación sin uso se archivan (`.tar.gz`) a los 7 días y se eliminan a los 5 meses (la conversación sigue legible). Escribir o adjuntar restaura los ficheros archivados solos, y el panel de ficheros avisa de «archivados» / «eliminados por antigüedad» con un botón «Restaurar». Se ajusta con `desktop.workspaces.compressAfterDays` y `deleteAfterDays` (`0` desactiva cada etapa).
- **Panel de trayectoria** (botón del raíl o `Ctrl+J`): la línea de tiempo de la sesión que miras —llamadas al modelo con su origen, tokens y latencia; herramientas con su duración, bloqueos y concesiones; y las decisiones del runtime— a partir de la traza que escribe la CLI y retransmite `stratumd`. Solo enseña lo que la traza trae (lo que falta, «n/d»); las sesiones que corren en su propia terminal no tienen traza que retransmitir. Necesita un `stratumd` que sirva `trace.subscribe`.
- **Ajustes editables**: Ajustes edita el `.stratumrc.json` global como `stratum config`, por secciones (providers, memoria, contexto, herramientas, agente, registro, entornos, daemon, Desktop…), con campos tipados, el valor por defecto frente al fijado, un guardado por campo con su estado y el aviso de qué cambio necesita una sesión nueva, reiniciar el daemon o volver a abrir Desktop. Editor de providers (alias, dirección, clave de API o `${VARIABLE}`, modelo) y «Usar por defecto».
- **Tres niveles**: lo inocuo se guarda al momento; lo que cambia lo que el agente puede hacer (candado: confirmaciones, permisos, providers y claves, memoria remota, capturas en la traza…) abre una ventana nativa aparte con la clave y el valor viejo y nuevo, y no se escribe si la cierras o caduca; lo que ejecuta código o abre acceso (plugins, MCP, SSH, la caja, canales, comandos, listas) es «solo CLI» y Desktop ni muestra su contenido.
- Las claves de API no llegan nunca a la interfaz (solo «guardada» o el nombre de su variable de entorno), y la nueva viaja por la entrada estándar de la CLI, no por la línea de comandos.

### Cambiado
- `desktop.workspaces.deleteAfterDays` pasa de 30 a 150 días por defecto (hasta ahora no tenía efecto).
- Ajustes ya no es de solo lectura: lo escribe la CLI instalada (validación y escritura atómica de `stratum config`), no Desktop.

## [0.9.0] — 2026-11-05

Acompaña a **Stratum CLI 0.13.0**, que es la que conviene tener instalada.

### Cambiado
- Usa el Stratum Protocol de la CLI 0.13.0 (concesiones de aprobación, procedencia `via` de los mensajes, mensajes de imagen y la memoria por agente), para entenderse con su `stratumd`.

## [0.8.0] — 2026-11-03

Acompaña a **Stratum CLI 0.12.0**, que es la que conviene tener instalada (las imágenes pegadas y `/imagen` la necesitan).

### Añadido
- **Visuales en el chat**: el asistente puede acompañar una explicación con un gráfico, fichas de métricas o un diagrama, pintados en un marco aislado sin scripts ni nada externo («Ver HTML» enseña el código).
- **Pegar imágenes**: `Ctrl+V` adjunta una imagen del portapapeles y los adjuntos de imagen llegan al modelo, si tiene visión declarada en la config de la CLI.
- **`/imagen <descripción>`**: el asistente convierte tu descripción en una petición al modelo de imágenes de tu provider y la imagen aparece en el chat, con «Abrir» y «Guardar como…» (también en los turnos antiguos). Necesita `imageGeneration` en la config global de la CLI.

## [0.7.0] — 2026-10-29

Acompaña a **Stratum CLI 0.11.0**, que es la que conviene tener instalada.

### Cambiado
- El indicador de espera usa las mismas frases de estratos que la CLI (ahora compartidas).
- Reconoce las llamadas vetadas por un **plugin** de la CLI (fuente `plugin` de `tool.blocked`).

## [0.6.0] — 2026-10-23

### Cambios a tener en cuenta
- **Necesita Stratum CLI 0.10.0 o más reciente** para cambiar de provider (con la 0.9.0 solo se puede cambiar el modelo).

### Añadido
- **Elegir provider y modelo desde el cuadro de mensaje**: el botón «provider · modelo» abre un selector que pide primero el provider y después uno de sus modelos (o uno escrito a mano si el provider no los lista). En una conversación abierta cambia los suyos; en una nueva, los de la conversación que se abrirá al enviar.

### Corregido
- `/model` no hacía nada en una conversación nueva; ahora abre el selector.

## [0.5.0] — 2026-10-23

Stratum Desktop pasa a ser un **cliente de `stratumd`**, hermano de la CLI y de Stratum Dot (M12).

### Cambios a tener en cuenta
- **Necesita Stratum CLI 0.9.0 o más reciente instalado** (`npm i -g stratum-cli`, Node 22 o más reciente): Desktop ya no lleva el core empaquetado. Si no hay daemon, lo arranca con `stratum daemon start`; cerrarlo no lo para.
- Las conversaciones de versiones anteriores no se abren solas: impórtalas una vez con `stratum desktop import` (Desktop avisa si quedan). No se borra nada.
- Retirados por ahora: aprobar o contestar preguntas desde Desktop (se ven; se resuelven desde Stratum Dot o `stratum approvals`), el editor de Ajustes (ahora de solo lectura, con «Abrir la configuración»), la retención de ficheros, el panel de memoria global, la trayectoria y `/clear` y `/compact`. El razonamiento se ve mientras se genera, pero no queda en la conversación.

### Añadido
- Cada conversación es una sesión normal de Stratum: sigue trabajando al cerrar Desktop, sobrevive a un reinicio del daemon, y se abre desde Stratum Dot o con `stratum attach <id>`.
- La lista enseña **todas** las sesiones del daemon —también las de la terminal y de Dot— con su procedencia; Desktop puede continuar las del daemon y redirigir las de una terminal.
- Controles del trabajo en marcha (pausar, reanudar, cancelar) y escribir con un run en marcha lo redirige.
- Panel de **contexto y memoria de la sesión** (`/context`) y «Ver mensajes anteriores» para el historial completo.
- El asistente tiene las skills de serie de Stratum que lo declaran.

### Cambiado
- Retoque visual: el ámbar queda para la acción principal; botones, listas y cabeceras de panel más sobrios y Ajustes en tarjetas por sección.

### Eliminado
- El sidecar (`stratum-core`), su supervisor y su protocolo propio.

## [0.4.0] — 2026-10-12

Versión estable de la 0.4.0: incluye todo lo de la [0.4.0-beta.0](#040-beta0--2026-10-12) (panel de trayectoria, alta de providers con solo URL y key, conversaciones ilegibles que ya no se pierden) y se anuncia por el auto-update a las 0.2.0 y 0.3.0 instaladas.

### Cambiado
- El core es el de la CLI 0.8.0, con los arreglos de sus pre-releases posteriores a la beta de Desktop.

## [0.4.0-beta.0] — 2026-10-12

Pre-release para pruebas: los instaladores están en la release `desktop-v0.4.0-beta.0`, que no se anuncia por el auto-update. Una 0.3.0 instalada no la recibe sola.

### Añadido
- **Panel de trayectoria**: anclado a la derecha del chat, muestra lo que hizo el agente en la conversación —lo que entró al modelo, cada llamada al LLM, cada tool con su entrada y su salida— como timeline y lista de pasos con detalle. Se abre con el botón «Trayectoria» de la barra de estado o `Ctrl+J`, y se recuerda entre arranques. La traza se guarda por conversación, pasa por la redacción de secretos y se borra al eliminar la conversación.
- El panel muestra el acierto de la caché de prompt del backend y las llamadas al LLM por origen (agente, extracción de memoria, compresión, resumen de sesión).
- Alta de providers con solo URL y key: los modelos se piden al servidor.

### Corregido
- **Una conversación ilegible ya no se pierde**: abrir una con la sesión dañada la abría vacía y el primer mensaje la sobrescribía. Ahora lo dañado se aparta a `.corrupt-<fecha>` con aviso, lo que es de un Stratum más nuevo no se toca, y el listado avisa de las que no pudo leer en vez de omitirlas.
- Si la instalación de una actualización falla (UAC rechazado, AppImage sin permiso de escritura), el agente vuelve a arrancar; antes la app quedaba abierta sin él.
- El sidebar refleja el estado real de una conversación al abrirla (fijada, restaurada de archivo, purgada).
- Los avisos de fallo al guardar cuentan el problema en una frase, con el código del sistema entre paréntesis, en lugar del error en crudo.
- Guardado al cerrar la app y checkpoints más ligeros durante el turno.

### Seguridad
- Las guardas de comandos y de rutas sensibles del core llegan con las correcciones de la CLI 0.8.0.

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

[0.4.0-beta.0]: https://github.com/choruzo/CLI/releases/tag/desktop-v0.4.0-beta.0
[0.3.0]: https://github.com/choruzo/CLI/releases/tag/desktop-v0.3.0
[0.2.0]: https://github.com/choruzo/CLI/releases/tag/desktop-v0.2.0
