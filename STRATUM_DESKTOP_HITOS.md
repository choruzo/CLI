# Stratum Desktop — Plan de hitos de implementación

> Desglose ejecutable de los hitos D0–D5 definidos en
> `STRATUM_DESKTOP_PROJECT_DEFINITION.md` (sección 13), ampliado con las
> resoluciones de los puntos ciegos de la sección 15. Cada hito lista objetivo,
> tareas concretas, criterios de aceptación y dependencias.
>
> Convención de estado: ⏳ pendiente · 🔄 en curso · ✅ cerrado.
> Los puntos ciegos se referencian como `[15.x]`.

---

## Resumen de la ruta

| Hito | Foco | Depende de | Puntos ciegos que cierra |
|------|------|-----------|--------------------------|
| **D0** | Scaffolding + sidecar empaquetado + ping seguro | stratum-cli Hito 4 | 15.2, 15.6, 15.10, 15.11 |
| **D1** | IPC seguro + chat de una pestaña + cwd | D0 | 15.1, 15.3, 15.4, 15.5, 15.9, 15.13 |
| **D2** | Pestañas + Sidebar + StatusBar + InputArea | D1 | 15.8, 15.12, 15.15 |
| **D3** | Settings Panel + ProviderWizard + config compartida | D2 | 15.7 |
| **D4** | Drag&drop + notificaciones + hotkey + build pipeline | D3 | — |
| **D5** | Polish: frameless, animaciones, a11y, E2E | D4 | 15.14 |

Regla de oro: ningún hito se cierra sin que sus criterios de aceptación pasen y
sin que los puntos ciegos asignados estén resueltos y verificados.

---

## D0 — Scaffolding, sidecar empaquetado y arranque seguro

**Objetivo.** Una ventana Tauri vacía que arranca un sidecar `stratum-core`
empaquetado, establece un canal autenticado y responde a un `ping`. Sin chat
todavía. Aquí se cierran las decisiones de empaquetado y ciclo de vida que el
resto del proyecto asume.

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

## D1 — IPC seguro, chat de una pestaña y directorio de trabajo

**Objetivo.** Conversación completa en una sola pestaña: streaming de
`AgentEvent`s, `ToolCallBlock` con sus 4 estados, confirmación destructiva y
cancelación. Canal autenticado y modelo de cwd resuelto.

### Tareas

1. **`[15.1]` Autenticación del WebSocket (bloqueante).**
   - El sidecar exige el token del handshake en la primera trama; rechaza
     conexiones sin token o con `Origin` no permitido.
   - Test: una conexión desde otro origen / sin token es rechazada antes de poder
     emitir un `chat`.

2. **Protocolo IPC tipado** (`src/ipc/types.ts` + `bridge.ts`).
   - Mensajes de entrada: `chat`, `cancel`, `new_tab`, `close_tab` (todos con
     `tabId`).
   - `[15.9]` `cancel` viaja **por el WS**, no por `invoke`. Los `invoke` de Tauri
     se reservan para operaciones request-response sin relación con el stream
     (config read/write, abrir editor).
   - Salida: los `AgentEvent`s de `agent/types.ts` con `tabId` añadido.

3. **`[15.4]` Protocolo de confirmación destructiva.**
   - Mensajes `confirm_request { callId, tool, params }` /
     `confirm_response { callId, decision }`.
   - El sidecar bloquea la ejecución hasta la respuesta.
   - Default `deny` ante timeout o cierre de la pestaña con confirmación pendiente.
   - `allow-all` (`!`) con alcance **por pestaña** (coherente con "instancias aisladas").
   - Componente `DestructiveConfirm.tsx` con `<dialog>` HTML.

4. **`[15.3]` Modelo de directorio de trabajo / abrir proyecto.**
   - UI "Abrir carpeta" (Tauri dialog) que fija el cwd.
   - Decisión: cwd **por pestaña** → cada `StratumAgent` recibe su cwd. El panel
     Memory/Proyecto y `/init` se resuelven contra el cwd de la pestaña activa.
   - Persistir el último cwd por pestaña en la sesión.

5. **`[15.5]` Estado del agente vs. reconexión.**
   - El WS multiplexa por `tabId` (aclarar que no es "una sola conexión").
   - Al reconectar tras caída del sidecar, **rehidratar** el agente reenviando el
     historial conservado en el frontend (o recargando la sesión persistida).
   - Banner de reconexión con backoff 1→2→5→10s (máx 4) como en la definición.

6. **Componentes de chat** (`ConversationView`, `MessageList`, `AgentMessage`,
   `UserMessage`, `ToolCallBlock`, `StreamingText`, `MarkdownRenderer`,
   `InputArea` básico).
   - `useAgentStream.ts`: trata `tool_call_start` como actualización del mismo
     tool call por `id` (mismo invariante que la CLI).
   - `ToolCallBlock` con estados pending/running/completed/error + expansión.

7. **`[15.13]` Render incremental de markdown.**
   - Memoizar bloques estables / parsear solo el delta para no re-parsear el
     mensaje completo en cada chunk SSE. Medir frame rate con una respuesta larga
     con bloques de código.

### Criterios de aceptación

- Conversación end-to-end con streaming fluido y `ToolCallBlock` en sus 4 estados.
- Una herramienta destructiva (`bash rm`, `write_file`) **pide confirmación** y
  respeta approve/deny/allow-all por pestaña.
- `cancel` aborta la generación en curso vía el `AbortSignal` correcto del agente.
- Matar el sidecar a mano y reconectar **continúa la conversación con contexto**.
- Conexión sin token rechazada (test automatizado).
- `/init` y `read_file` con ruta relativa resuelven contra el cwd elegido.

---

## D2 — Pestañas, Sidebar, StatusBar e InputArea completo

**Objetivo.** Modelo multi-pestaña completo y los tres paneles del sidebar
(Sessions, Outline, Memory), StatusBar e InputArea con slash-commands.

### Tareas

1. **TabBar y store de pestañas** (`store/tabs.ts`, Zustand o `useContext`+`useReducer`).
   - `tabId` UUID, título derivado del primer mensaje, indicador idle/generando/error.
   - `[+]` nueva pestaña, `[×]` cierra (confirmación inline si hay generación).
   - `[15.15]` Cada pestaña con su `StratumAgent` independiente en el sidecar;
     documentar comportamiento bajo generación concurrente (rate limits del
     provider, `serialized` de `bash` por agente). Evaluar límite de generaciones
     simultáneas si el provider lo exige.
   - Título de ventana dinámico vía `appWindow.setTitle()` (tabla sección 6).
   - Plugin `window-state` para posición/tamaño.

2. **Sidebar (rail de iconos + paneles).**
   - Colapsado 40px por defecto; expandido 260px con animación 150ms.
   - Estado `sidebar_open` y `sidebar_panel` en `localStorage`.
   - **Panel Sessions (7.1):** agrupación por fecha, búsqueda, renombrar/eliminar
     in-place, context menu, empty state.
   - **Panel Outline (7.2):** anchors a mensajes del usuario, scroll suave,
     resaltado del mensaje en vista, actualización en vivo.
   - **Panel Memory (7.3):** tabs Global/Proyecto, render markdown read-only,
     "Abrir en editor", refresco por `fs.watch`, tab Proyecto deshabilitada sin cwd.

3. **`[15.8]` Scope fs de Tauri.**
   - Ampliar el scope para que "Abrir en editor" (`shell.open`) y la resolución de
     rutas funcionen sobre proyectos arbitrarios, **o** enrutar esas acciones por
     el sidecar. Documentar la opción elegida en `capabilities/default.json`.

4. **`[15.12]` Persistencia incremental de sesión.**
   - Autosave/checkpoint periódico de la sesión activa (no solo al cerrar), para
     no perder la conversación ante crash del proceso.

5. **StatusBar** (provider, modelo, ctx %, nº tools) con umbrales de color iguales
   a la CLI.

6. **InputArea + slash-commands.**
   - `<textarea>` autoexpandible; dropdown de `/comandos` con filtrado, navegación
     ↑↓, Enter/Tab/Escape.
   - Catálogo heredado de la CLI + exclusivos desktop (`/settings`, `/new-tab`,
     `/open`).

7. **Atajos de teclado** (sección 9) con `react-hotkeys-hook`: `Ctrl+T/W/Tab/1..8/B/L/K`,
   `Escape`, `Ctrl+Enter`.

### Criterios de aceptación

- Abrir/cerrar/cambiar pestañas con teclado y ratón; título de ventana sigue a la
  activa.
- Dos pestañas generan en paralelo sin corromper estado ni mezclar streams.
- Los tres paneles del sidebar funcionan con sus empty states; Memory refresca al
  editar el `STRATUM.md` desde la terminal.
- "Abrir en editor" abre un `STRATUM.md` de proyecto fuera de `~/.stratum`.
- Cierre forzado (kill) deja recuperable la conversación activa al reabrir.

---

## D3 — Settings Panel, ProviderWizard y config compartida

**Objetivo.** Configuración visual sin editar JSON a mano y escritura segura
compartida con la CLI.

### Tareas

1. **Settings Panel** (overlay fullscreen, `Ctrl+,` / `/settings`).
   - Secciones: Providers, Modelo activo, Web Search, Memory, (Apariencia v2).
   - Pestaña "Avanzado" con editor del JSON raw + validación en vivo contra el
     schema Zod.

2. **ProviderWizard portado** desde la CLI a modal: alias, base URL, API key,
   selección de modelo, test de conexión, guardar.

3. **Selector de modelo activo** (misma lógica que `/model`).

4. **`useConfig.ts`** vía `invoke` `read_config`/`write_config` (Rust).

5. **`[15.7]` Config compartida segura.**
   - Escritura atómica (temp + rename) en Rust (`tempfile`).
   - Antes de escribir, comparar mtime/hash; si cambió bajo los pies, avisar al
     usuario en vez de pisar (evitar lost updates frente a la CLI).
   - `watch_config` con debounce + flag de auto-write para **no** entrar en bucle
     ni descartar ediciones abiertas en el Settings Panel.

### Criterios de aceptación

- Añadir un provider por el wizard y verlo reflejado en la terminal (y viceversa).
- Editar config en CLI con el Settings abierto **no** pierde cambios silenciosamente:
  se avisa del conflicto.
- El watcher no genera bucle de recarga tras una escritura propia.
- JSON inválido en "Avanzado" se marca antes de guardar.

---

## D4 — Features desktop e infraestructura de build

**Objetivo.** Integración con el SO y pipeline reproducible para Windows y Linux.

### Tareas

1. **Drag & drop de archivos** sobre `InputArea`: resolución de ruta absoluta
   (Tauri `drag-drop`), inserción `[adjunto: ...]`, soporte vision si el provider
   tiene `vision: true`.
2. **Notificaciones OS** (plugin `notification`) para tareas largas (>10s) en
   segundo plano; toggle en Settings.
3. **Global hotkey** `Ctrl+Shift+Space` (plugin `global-shortcut`) para enfocar/
   restaurar; configurable/desactivable.
4. **Onboarding de primer arranque** (sección 9): splash → ProviderWizard →
   primera pestaña; sin botón "saltar".
5. **Manejo de errores del sidecar** (pantalla de fallo de inicio con Reintentar/Ver
   logs; banner no bloqueante en runtime).
6. **Pipeline de build** (GitHub Actions): `build-windows` (`.msi`) y `build-linux`
   (`.deb` + `.AppImage`), incluyendo build del sidecar empaquetado por plataforma.
7. **Firma de código:** Windows con `TAURI_SIGNING_*` (auto-firmado en local; EV a
   futuro); Linux GPG opcional para `.AppImage`.

### Criterios de aceptación

- Drag&drop de un `.txt` y de una imagen (con provider vision) funcionan.
- Notificación nativa al terminar una tarea larga con la app en background.
- CI produce `.msi`, `.deb` y `.AppImage` instalables desde cero.
- Onboarding completo en una máquina sin `.stratumrc.json`.

---

## D5 — Polish: frameless, animaciones, accesibilidad y E2E

**Objetivo.** Acabado visual y robustez de la UI.

### Tareas

1. **Ventana frameless** (`decorations: false`) con TitleBar custom de 32px,
   `data-tauri-drag-region`, controles ─ □ ×.
2. **`[15.14]` Mitigar lo que rompe el frameless.**
   - Accesibilidad de los controles custom (roles/labels para lectores de pantalla).
   - Clamping de la posición restaurada por `window-state` al área visible actual
     (evitar ventana fuera de pantalla en setups multi-monitor cambiados).
   - Validar/decidir maquetación TitleBar + TabBar (misma fila vs. separadas) que
     quedó "a validar en D2".
3. **Animaciones** de streaming (CSS), expansión de `ToolCallBlock`, transiciones
   del sidebar.
4. **Accesibilidad general:** foco visible, navegación por teclado completa,
   contraste, `aria-*` en componentes interactivos.
5. **Tests E2E** con Tauri WebDriver: flujo de chat, pestañas, settings, onboarding.
6. **Auto-update** (`tauri-plugin-updater`) apuntando a GitHub Releases.

### Criterios de aceptación

- Mover/maximizar/cerrar la ventana frameless funciona en Win y Linux.
- Restaurar tras desconectar un monitor deja la ventana visible.
- Suite E2E verde en CI.
- Una release nueva en GitHub dispara el flujo de auto-update.

---

## Trazabilidad de puntos ciegos → hito

| Punto ciego | Severidad | Hito |
|-------------|-----------|------|
| 15.1 WebSocket sin autenticar | 🔴 | D1 |
| 15.2 Empaquetado del sidecar / tamaño real | 🔴 | D0 |
| 15.3 Modelo de cwd / abrir proyecto | 🔴 | D1 |
| 15.4 Protocolo de confirmación destructiva | 🟠 | D1 |
| 15.5 Estado del agente vs. reconexión | 🟠 | D1 |
| 15.6 Versión core bundle vs. CLI global | 🟠 | D0 |
| 15.7 Lost updates en config concurrente | 🟠 | D3 |
| 15.8 Scope fs de Tauri | 🟠 | D2 |
| 15.9 Cancel en transporte separado | 🟠 | D1 |
| 15.10 Puerto por stdout + firewall | 🟠 | D0 |
| 15.11 Ciclo de vida del sidecar / MCP | 🟠 | D0 |
| 15.12 Persistencia de sesión solo al cerrar | 🟡 | D2 |
| 15.13 Rendimiento markdown en streaming | 🟡 | D1 |
| 15.14 Frameless rompe SO + multi-monitor | 🟡 | D5 |
| 15.15 Concurrencia entre pestañas | 🟡 | D2 |

---

## Dependencias externas y supuestos

- **stratum-cli Hito 4 (MCP Client) cerrado** antes de D0: el sidecar reutiliza el
  core completo; el ciclo de vida MCP se contempla desde D0 aunque su uso pleno
  llegue después.
- **Sin macOS en v1** (sección 12): el pipeline cubre Windows + Linux.
- **Sin sincronización de sesión en tiempo real** entre instancias: solo se
  comparte estado en disco (config, memoria, sesiones guardadas).
