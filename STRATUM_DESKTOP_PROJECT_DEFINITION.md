# Stratum Desktop — Project Definition

> Aplicación de escritorio para Stratum CLI. Envuelve el core del agente en una
> ventana nativa con UI web, manteniendo total compatibilidad con la instalación
> CLI existente. Comparte configuración y memoria con la terminal — son instancias
> independientes del mismo agente.

---

## 1. Visión general

Stratum Desktop **no es una reescritura**. Es una capa de presentación sobre el mismo
`stratum-cli` core: los mismos providers, las mismas tools, la misma memoria, el mismo
`.stratumrc.json`. Lo que cambia es el renderer — de Ink (terminal) a React en webview.

### Principios

- **Config y memoria compartidas.** Desktop y CLI leen y escriben el mismo
  `.stratumrc.json` y los mismos archivos `STRATUM.md`. Cambiar un provider en la
  app lo refleja inmediatamente en la terminal y viceversa.
- **Instancias aisladas.** Cada instancia (desktop, terminal) gestiona su propia
  sesión activa y su propio historial de conversación en curso. No hay sesión
  compartida entre procesos.
- **Sin Electron.** Tauri v2 usa el webview nativo del sistema operativo. El binario
  final pesa ~5–10 MB frente a los ~150 MB de Electron.
- **Self-hosted first.** El mismo espíritu que la CLI: funciona 100% offline con
  Ollama/llama.cpp. No hay telemetría, no hay servidor de cloud obligatorio.

---

## 2. Stack técnico

| Capa | Tecnología | Justificación |
|------|-----------|---------------|
| Shell nativo | **Tauri v2** (Rust) | Webview nativo del SO, IPC tipado |
| Frontend | **React 18 + Vite** | Mismo modelo de componentes que la UI Ink existente |
| Estilos | **CSS variables + módulos** | Sin framework de CSS; colores desde `theme.ts` |
| Tipado IPC | **@tauri-apps/api v2** | `invoke`, `listen`, `emit` tipados en TS |
| Markdown | **react-markdown + rehype-highlight** | Equivalente a `marked` + `cli-highlight` de la CLI |
| Build frontend | **Vite** (bundler por Tauri) | Sin configuración adicional |
| Sidecar | **Node.js SEA** (Single Executable App, Node 21+) | Binario autónomo por plataforma, sin dep. de Node del sistema |
| Empaquetado | **tauri build** | Genera `.msi` (Windows) y `.deb` / `.AppImage` (Linux) |

> **Tamaño instalado real:** el shell Rust de Tauri pesa ~5–10 MB, pero el sidecar
> SEA con `sqlite-vec`, `better-sqlite3` y `@xenova/transformers` (ONNX runtime)
> añade ~50–100 MB de binarios nativos por plataforma. El instalador completo se
> estima en **60–120 MB** según plataforma. No hay dependencia de Node.js instalado
> en el sistema del usuario.

### Estructura de repositorio

```
stratum-desktop/           ← nuevo workspace (fuera de stratum-cli/)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs        ← entry point Tauri
│   │   ├── ipc.rs         ← commands Tauri expuestos al frontend
│   │   ├── sidecar.rs     ← gestión del proceso Node.js sidecar
│   │   └── config.rs      ← lectura de .stratumrc.json desde Rust
│   ├── capabilities/
│   │   └── default.json   ← permisos Tauri v2 (fs, shell, window)
│   └── tauri.conf.json
├── src/                   ← frontend React
│   ├── theme.ts           ← copia/re-export de stratum-cli/src/cli/ui/theme.ts
│   ├── ipc/
│   │   ├── types.ts       ← AgentEvent, IPC command schemas
│   │   └── bridge.ts      ← wrappers sobre @tauri-apps/api invoke/listen
│   ├── components/
│   │   ├── layout/
│   │   │   ├── TabBar.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── StatusBar.tsx
│   │   ├── chat/
│   │   │   ├── ConversationView.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── AgentMessage.tsx
│   │   │   ├── UserMessage.tsx
│   │   │   ├── ToolCallBlock.tsx
│   │   │   ├── StreamingText.tsx
│   │   │   └── DestructiveConfirm.tsx
│   │   ├── markdown/
│   │   │   └── MarkdownRenderer.tsx
│   │   └── settings/
│   │       ├── SettingsPanel.tsx
│   │       ├── ProviderList.tsx
│   │       └── ProviderWizard.tsx
│   ├── hooks/
│   │   ├── useAgentStream.ts  ← consume AgentEvents del sidecar
│   │   └── useConfig.ts       ← lee/escribe .stratumrc.json via Tauri command
│   ├── store/
│   │   └── tabs.ts            ← estado global de pestañas (Zustand o useContext)
│   └── App.tsx
└── package.json
```

---

## 3. Integración con Stratum Core (IPC protocol)

### Patrón: Node.js sidecar + canal local autenticado

El frontend **no** llama directamente al core de stratum por comandos Tauri. En su lugar:

1. Tauri genera un **token aleatorio** de 32 bytes al arrancar (`crypto.getRandomValues`
   en Rust) y lo pasa al sidecar como argumento: `stratum-core --desktop-token <TOKEN>
   --ipc-path <PATH>`.
2. Tauri emite el token y la ruta IPC al frontend via el evento `sidecar://ready`
   (canal Tauri interno, no accesible desde fuera).
3. El sidecar abre el servidor IPC en la ruta recibida:
   - **Windows:** Named Pipe `\\.\pipe\stratum-desktop-<PID>`
   - **Linux:** Unix socket `$XDG_RUNTIME_DIR/stratum-desktop-<PID>.sock`
4. El frontend conecta al socket via `WebSocket` usando el path recibido.
   El primer mensaje **debe** ser el handshake con el token; sin él la conexión
   se cierra inmediatamente.

```
Rust (Tauri)
  │  genera TOKEN + PATH
  │  spawn sidecar con --desktop-token TOKEN --ipc-path PATH
  │  emite sidecar://ready {token, path} al frontend
  │
Frontend (React) ──WS(socket local)──► stratum-core (Node sidecar)
                                               │
                                   valida token en handshake
                                   rechaza Origin ≠ tauri://localhost
```

Los `invoke` Tauri quedan **exclusivamente** para operaciones sin relación con el
stream: leer/escribir config, abrir archivos con el editor del sistema, listar
sesiones en disco. Todo lo demás — chat, cancel, gestión de tabs — viaja por WS.

### Por qué socket local en lugar de TCP

Un socket Unix / Named Pipe **no es alcanzable desde el navegador** (los
navegadores bloquean `ws://` a unix sockets). Elimina el vector de ataque de la
15.1 y evita el diálogo del Firewall de Windows que dispara cualquier servidor TCP.

### Protocolo de mensajes (entrada → sidecar)

```ts
// Handshake — primer mensaje obligatorio
{ type: 'handshake', token: string }

// Chat — envía mensaje del usuario a la pestaña activa
{ type: 'chat', tabId: string, message: string, cwd: string }

// Rehidratación — restaura contexto tras reconexión (ver §Reconexión)
{ type: 'rehydrate', tabId: string, history: Message[] }

// Control de tabs
{ type: 'new_tab',   tabId: string, cwd: string }
{ type: 'close_tab', tabId: string }

// Cancelación — mismo canal que el stream, sin carreras de orden
{ type: 'cancel', tabId: string }

// Confirmación destructiva — respuesta al confirm_request del sidecar
{ type: 'confirm_response', callId: string, decision: 'approve' | 'deny' | 'allow_all' }
```

### Protocolo de mensajes (salida ← sidecar)

```ts
// AgentEvents normales con tabId añadido
{ tabId: string, event: AgentEvent }

// Solicitud de confirmación destructiva
{
  type: 'confirm_request',
  tabId: string,
  callId: string,         // UUID que debe volver en confirm_response
  toolName: string,
  params: unknown,
  timeoutMs: 30000        // deny automático si no hay respuesta
}

// Error de sidecar
{ type: 'sidecar_error', fatal: boolean, message: string }
```

### Confirmación destructiva (15.4)

El sidecar **bloquea la ejecución del tool** hasta recibir `confirm_response`.
Reglas:

- Si no llega respuesta en **30 s** → `deny` automático.
- Si la pestaña se cierra con una confirmación pendiente → `deny` automático.
- `allow_all` tiene alcance **por pestaña**: suprime confirmaciones solo para esa
  instancia `StratumAgent`, equivalente al `!` de la CLI.

### Reconexión y rehidratación del agente (15.5)

Si el sidecar cae y reconecta:

1. El frontend detecta el cierre del WS y muestra el banner de reconexión.
2. Al reconectar (nueva conexión, nuevo handshake con el mismo token), el frontend
   envía inmediatamente un mensaje `rehydrate` con el array de mensajes que tiene
   en su estado React para cada pestaña afectada.
3. El sidecar crea un nuevo `StratumAgent` e inyecta el historial como contexto
   inicial antes de aceptar nuevos mensajes de esa pestaña.
4. El usuario puede continuar la conversación desde donde estaba; el agente tiene
   el historial pero no el estado en memoria de iteraciones anteriores (tool outputs
   de la sesión interrumpida no se re-ejecutan).

### Ciclo de vida del sidecar (15.11)

| Evento Tauri | Acción |
|---|---|
| App arranca | `Command::new("stratum-core").args([...]).spawn()` |
| `window-close-requested` | `sidecar.kill()` → SIGTERM en Linux, `TerminateProcess` en Windows |
| `exit` | Igual + espera hasta 2s para que el proceso termine limpiamente |
| Crash de Tauri | Job Object (Windows) / proceso hijo huérfano adoptado por init (Linux) se limpia por OS |

El sidecar recibe SIGTERM y propaga la señal a sus subprocesos MCP antes de salir.
En Windows se usa **Job Object** (`CREATE_NEW_PROCESS_GROUP` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
para garantizar la terminación en cascada aunque Tauri crashee sin poder enviar la señal.

---

## 4. Aislamiento de instancias y config compartida

### Config compartida

`useConfig.ts` invoca un Tauri command `read_config` / `write_config` que en Rust
lee y escribe `~/.stratum/.stratumrc.json` (o el path del proyecto activo).

**Conflictos de escritura concurrente (15.7):** la escritura atómica
(write-to-temp + rename, `tempfile` crate en Rust) evita torn reads pero no lost
updates entre procesos. Se aplican tres defensas adicionales:

1. **Comparación de mtime antes de escribir:** `write_config` en Rust lee el mtime
   actual y lo compara con el mtime leído al cargar la config. Si difieren, el
   usuario ve un aviso: "La configuración fue modificada externamente. ¿Sobreescribir?"
2. **Debounce + flag `_selfWrite` en el watcher:** el `watch_config` usa un debounce
   de 300ms. Cuando la app escribe, activa `_selfWrite = true` durante 500ms;
   los eventos del watcher en ese periodo se ignoran para no generar un bucle.
3. **Settings Panel con ediciones sin guardar:** si el Settings Panel tiene cambios
   sin guardar y llega un evento del watcher externo, se muestra un banner:
   "Configuración actualizada externamente. [Descartar cambios] [Mantener mis cambios]"

El frontend suscribe un `watch_config` (Tauri fs watcher) para recargar la config
cuando la CLI la modifica desde la terminal mientras la app está abierta.

### Historial de sesiones compartido

`SessionStore` persiste en disco. Tanto la CLI como el desktop pueden listar y
resumir sesiones pasadas.

**Checkpoint incremental (15.12):** la sesión activa de cada pestaña se guarda
automáticamente al recibir cada mensaje del agente y también cada 60s si hay
actividad. Un crash del proceso no pierde más de 60s de conversación.

### Instancias activas independientes

Cada proceso (desktop, terminal) tiene su propia instancia `StratumAgent` en memoria.
No hay sincronización de estado en tiempo real entre procesos — solo comparten
el estado en disco (config, memoria, sesiones guardadas).

---

## 5. Sistema de colores

Herencia directa de `stratum-cli/src/cli/ui/theme.ts`. El mismo objeto se convierte
en variables CSS inyectadas en `:root`:

```ts
// src/theme.ts (re-export + CSS injection)
export const theme = {
  accent:         '#F59E0B',
  accentBright:   '#FBBF24',
  success:        '#22C55E',
  error:          '#EF4444',
  errorMuted:     '#FCA5A5',
  warning:        '#F97316',
  code:           '#6EE7B7',

  textPrimary:    '#F3F4F6',
  textResponse:   '#D1D5DB',
  textMuted:      '#9CA3AF',
  textFaint:      '#6B7280',
  textDisabled:   '#4B5563',
  textInvisible:  '#374151',

  bgApp:          '#0D0D0D',   // nuevo: fondo de la ventana
  bgPanel:        '#111111',   // nuevo: panel lateral / tab bar
  bgStatusbar:    '#1A1A1A',
  bgDropdown:     '#1C1C1C',

  borderSubtle:   '#2A2A2A',
  borderMedium:   '#374151',
  borderAccent:   '#92400E',
} as const;

// Inyección al arrancar
export function injectCssVars(t: typeof theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t)) {
    root.style.setProperty(`--color-${k}`, v);
  }
}
```

Todos los componentes usan `var(--color-accent)`, `var(--color-textMuted)`, etc.
Esto permite un futuro sistema de temas sin cambiar componentes.

### Fuentes

- UI general: system-ui (no se descarga nada extra)
- Código / tool outputs / bloques markdown: `ui-monospace, 'Cascadia Code', 'JetBrains Mono', monospace`

---

## 6. Modelo de ventanas — Pestañas

Una sola ventana OS con múltiples conversaciones en paralelo.

Dimensiones de ventana:

- **Ancho mínimo: 900px.** Sidebar colapsado (40px) + chat area (860px). Con sidebar
  abierto (260px) quedan 640px para el chat — suficiente para código de 80 columnas
  sin scroll horizontal.
- **Alto mínimo: 620px.** TitleBar 32px + TabBar 40px + ConversationView ~450px +
  InputArea 60px + StatusBar 38px.

```
┌─────────────────────────────────────────────────────────────┐  ← frameless
│  ◈ Stratum  [Chat 1 ×] [Chat 2 ×] [+]          ─  □  ×    │  ← TitleBar (32px)
├──┬──────────────────────────────────────────────────────────┤
│  │                                                           │
│🗂│   ConversationView (pestaña activa)                      │
│⏱│                                                           │
│🧠│                                                           │
│  ├───────────────────────────────────────────────────────────┤
│  │  InputArea                                                │
├──┴───────────────────────────────────────────────────────────┤
│  ● ollama / llama3.2  │  ctx 12%  │  3 tools disponibles    │  ← StatusBar
└─────────────────────────────────────────────────────────────┘
   ↑
   Sidebar colapsado (40px, solo iconos) por defecto.
   Expande a 260px con click o hover en el icono activo.
   Estado abierto/cerrado persiste en localStorage.
```

### TabBar

- Cada pestaña tiene un `tabId` UUID, un título (primeras palabras del primer mensaje)
  y un indicador de estado (idle / generando / error).
- `[+]` abre una nueva pestaña con nueva sesión.
- `[×]` cierra la pestaña; si hay generación activa, pide confirmación inline.
- Máximo recomendado: 8 pestañas simultáneas (no hay límite técnico duro).
- Las pestañas persisten mientras la app está abierta. Al cerrar la app, la sesión
  activa de cada pestaña se guarda en `SessionStore`.

**cwd por pestaña.** Cada pestaña tiene su propio directorio de trabajo
independiente. El `StratumAgent` de esa pestaña opera relativo a ese cwd:
rutas de tools, `STRATUM.md` de proyecto y `/init` usan ese directorio.
El panel Memory/Proyecto del sidebar refleja el cwd de la pestaña activa.

Al crear una nueva pestaña, el cwd inicial es el último cwd usado (persiste en
`localStorage`). El usuario puede cambiarlo via:

- **Botón de carpeta en la TitleBar** (junto al título de pestaña): abre el
  diálogo nativo de selección de carpeta via Tauri `dialog.open({ directory: true })`.
- **Comando `/open-folder`** en el InputArea: equivalente al botón.

El cwd activo se muestra abreviado en la TitleBar (solo el nombre del directorio
final, p.ej. `~/proyectos/stratum-cli` → `stratum-cli`) con tooltip de ruta
completa al hacer hover.

```
┌──────────────────────────────────────────────────────────────┐
│  ◈  [Chat 1 ×] [Chat 2 ×] [+]   📁 stratum-cli   ─  □  ×  │
└──────────────────────────────────────────────────────────────┘
         pestañas                    cwd pestaña activa
```

**Título de ventana en la taskbar — dinámico.** Se sincroniza con la pestaña
activa via `appWindow.setTitle()`:

| Estado | Título |
|--------|--------|
| Pestaña con título | `Stratum — Refactor auth module` |
| Pestaña sin título aún | `Stratum — Nueva conversación` |
| Generando respuesta | `Stratum — ⠸ Refactor auth module` |
| Error en sidecar | `Stratum — ⚠ Sin conexión` |

**Persistencia de posición y tamaño.** El Tauri `window-state` plugin guarda
posición, tamaño y estado maximizado al cerrar la ventana, y los restaura al
reabrir. Archivo: `%APPDATA%\stratum-desktop\window-state.json` (Windows) /
`~/.config/stratum-desktop/window-state.json` (Linux).

### Sidebar

- **Colapsado por defecto** (40px, solo iconos con tooltip al hacer hover).
- **Expandido:** 260px, animación CSS `width` de 150ms ease-out.
- El estado se persiste en `localStorage` (`sidebar_open: boolean`).
- Estructura vertical:

```
┌────┐
│ 🗂 │  ← Sessions   (panel activo: fondo accent tenue, borde izquierdo accent)
│ 📋 │  ← Outline
│ 🧠 │  ← Memory
│    │
│    │  (espacio flexible)
│    │
│ ⚙  │  ← Settings   (parte inferior, siempre visible)
└────┘
```

Solo un panel está activo a la vez. Click en el icono activo colapsa el sidebar.

---

## 7. Sidebar — Especificación detallada

### 7.1 Panel Sessions (🗂)

**Estructura:**

```
┌─────────────────────────┐
│ 🔍  Buscar sesiones...  │  ← search input, filtra en tiempo real
├─────────────────────────┤
│ HOY                     │
│ ▌ Refactor auth module  │  ← sesión activa (borde accent izquierdo)
│   llama3.2 · hace 5min  │
│                         │
│   Análisis de logs      │
│   mistral · hace 2h     │
├─────────────────────────┤
│ AYER                    │
│   Setup VMware vSAN     │
│   llama3.2 · 12 mar     │
├─────────────────────────┤
│ ÚLTIMOS 7 DÍAS          │
│   ...                   │
├─────────────────────────┤
│ ANTERIORES              │
│   ...                   │
└─────────────────────────┘
```

**Agrupación por fecha:** Hoy / Ayer / Últimos 7 días / Anteriores. Los grupos
vacíos no se renderizan.

**Metadatos por item:**
- Título: primeras ~45 chars del primer mensaje del usuario. Si aún no hay mensaje,
  "Nueva conversación".
- Segunda línea: nombre del modelo + fecha relativa (`hace 5min`, `12 mar`,
  `3 feb 2025`).

**Acciones:**

| Trigger | Acción |
|---------|--------|
| Click | Abre la sesión en la pestaña activa (o en una nueva si la activa tiene cambios sin guardar) |
| Hover | Aparecen iconos ✏ (renombrar) y 🗑 (eliminar) al extremo derecho del item |
| Click 🗑 | Diálogo de confirmación inline (no modal): "¿Eliminar esta sesión? [Cancelar] [Eliminar]" |
| Click ✏ | El título se convierte en `<input>` editable in-place; Enter guarda, Escape cancela |
| Clic derecho | Context menu: Abrir en nueva pestaña / Renombrar / Eliminar |

**Búsqueda:** el campo filtra por título de sesión (case-insensitive, substring).
Si no hay resultados: "No se encontraron sesiones para «término»".

**Empty state (sin sesiones):**
```
  Sin sesiones guardadas.
  Inicia una conversación
  para verla aquí.
```

---

### 7.2 Panel Outline (📋)

Lista los mensajes del usuario de la conversación activa como anchors de
navegación. Permite saltar a cualquier punto sin hacer scroll manual.

**Estructura:**

```
┌─────────────────────────┐
│ CONVERSACIÓN ACTIVA     │
├─────────────────────────┤
│ ▌ Explícame cómo fun... │  ← mensaje visible actualmente (accent)
│   Ahora muéstrame el... │
│   ¿Puedes refactorizar  │
│   ¿Qué hace exactame... │
│   Ok, y si cambiamos... │
└─────────────────────────┘
```

**Comportamiento:**
- Cada item muestra los primeros ~50 chars del mensaje del usuario.
- Click → scroll suave (`behavior: 'smooth'`) hasta ese mensaje en `ConversationView`.
- El item correspondiente al mensaje más cercano a la vista se marca como activo
  (borde izquierdo accent, texto `textPrimary`).
- Se actualiza en tiempo real al recibir nuevos mensajes del usuario.
- Los mensajes del agente y tool calls no aparecen — solo los del usuario.

**Empty state:**
```
  La conversación está vacía.
  Escribe un mensaje para
  empezar.
```

---

### 7.3 Panel Memory (🧠)

Muestra el contenido de los archivos `STRATUM.md` activos, con dos tabs.

**Estructura:**

```
┌─────────────────────────┐
│ [Global] [Proyecto]     │  ← tabs
├─────────────────────────┤
│                         │
│  # Mi contexto          │
│                         │
│  Soy administrador de   │
│  plataformas VMware...  │
│                         │
│  ## Preferencias        │
│  ...                    │
│                         │
├─────────────────────────┤
│ [↗ Abrir en editor]     │  ← abre el archivo con el editor de sistema
└─────────────────────────┘
```

**Tab Global** — `~/.stratum/STRATUM.md`
**Tab Proyecto** — `.stratum/STRATUM.md` del directorio de trabajo activo del sidecar.

Si el tab activo no tiene archivo:
```
  No hay STRATUM.md global.
  Ejecuta: stratum init
  [Ejecutar ahora]          ← lanza stratum init via sidecar
```

**Comportamiento:**
- Solo lectura. El contenido se renderiza como markdown (mismo `MarkdownRenderer`
  que el chat) pero sin interactividad.
- Se refresca automáticamente via Tauri `fs.watch` cuando el archivo cambia
  (p.ej., porque la CLI ejecutó `stratum init` en la terminal).
- El botón "Abrir en editor" invoca `shell.open(filePath)` de Tauri, que abre
  el archivo con el editor predeterminado del sistema.
- La tab "Proyecto" está deshabilitada (gris, tooltip "No hay proyecto activo")
  si el sidecar no tiene cwd con `.stratum/` detectado.

---

### 7.4 Icono inferior — Settings (⚙)

Siempre visible en la parte inferior del rail de iconos, independientemente del
panel activo.

- Click → abre el Settings Panel como overlay a pantalla completa sobre la ventana
  (no reemplaza la vista, se superpone con backdrop oscuro semitransparente).
- No tiene panel propio en el sidebar — Settings es una vista separada.
- Atajo de teclado: `Ctrl+,`

---

### 7.5 Comportamiento de colapso/expansión

| Acción | Resultado |
|--------|-----------|
| Click en icono de panel no activo | Expande sidebar + activa ese panel |
| Click en icono de panel activo | Colapsa sidebar |
| Click fuera del sidebar (en ConversationView) | Colapsa sidebar |
| `Ctrl+B` | Toggle expand/collapse |
| Resize manual | No soportado en v1; ancho fijo 260px expandido |

El estado del panel activo se persiste en `localStorage` (`sidebar_panel:
'sessions' | 'outline' | 'memory' | null`).

---

## 8. Componentes del frontend (chat)

Todos son equivalentes funcionales de los componentes Ink, pero en HTML/CSS.

| Componente Ink | Equivalente Desktop | Diferencias |
|---------------|--------------------|----|
| `AgentMessage.tsx` | `AgentMessage.tsx` | `StreamingText` usa CSS animation en lugar de setInterval |
| `ToolCallBlock.tsx` | `ToolCallBlock.tsx` | Expansión con CSS transition; mismos 4 estados |
| `DestructiveConfirm.tsx` | `DestructiveConfirm.tsx` | Modal dialog nativo con `<dialog>` HTML |
| `InputArea.tsx` | `InputArea.tsx` | `<textarea>` autoexpandible; slash-commands via dropdown |
| `StatusBar.tsx` | `StatusBar.tsx` | Barra fija en bottom; mismo color de contexto por umbral |
| `MarkdownText.tsx` | `MarkdownRenderer.tsx` | react-markdown + rehype-highlight |
| `CommandPalette.tsx` | `CommandPalette.tsx` | Dropdown sobre el InputArea; mismo catálogo de `/comandos` |
| `Banner.tsx` | — | No aplica en desktop (la ventana ya tiene título) |

### Rendimiento del markdown en streaming (15.13)

`react-markdown` re-parsea el mensaje completo en cada chunk SSE. En respuestas
largas con bloques de código esto degrada el frame rate. Se aplican dos mitigaciones:

- **Memoización de bloques estabilizados:** cada `AgentMessage` divide su contenido
  en dos partes: el texto anterior al chunk actual (estable, memoizado con
  `React.memo` + `useMemo`) y el fragmento en curso (re-renderizado en cada chunk).
  Solo el tail activo re-parsea en cada frame.
- **Virtualización de la lista de mensajes:** para conversaciones con más de 50
  mensajes, `MessageList` usa `react-window` (`VariableSizeList`) para renderizar
  solo los mensajes visibles en el viewport. Los mensajes off-screen no se montan.

### ToolCallBlock — estados visuales

```
pending   →  ○ nombre_tool │ en cola...           (textFaint)
running   →  ⠸ nombre_tool │ 1.2s │ params...     (accent, spinner CSS)
completed →  ✓ nombre_tool │ 1.2s │ output...     (success)
error     →  ✗ nombre_tool │ mensaje de error     (error)
```

El bloque es expandible (click) para ver input/output completo.

---

## 9. Features desktop-específicas

### Drag & drop de archivos

El usuario puede arrastrar uno o varios archivos sobre el `InputArea`. La app:
1. Resuelve la ruta absoluta (Tauri `drag-drop` event).
2. Inserta en el input: `[adjunto: /ruta/al/archivo.txt]` como texto.
3. El core recibe la ruta y puede usar `read_file` normalmente.

Archivos de imagen: si el provider activo tiene `vision: true` en config, se adjuntan
como `content: [{type: "image_url", ...}]` al mensaje.

### Notificaciones OS

Cuando la app está en segundo plano y el agente completa una tarea larga (> 10s),
se dispara una notificación nativa via Tauri `notification` plugin.

Configurable en Settings → Notifications.

### Global hotkey

`Ctrl+Shift+Space` (Windows/Linux) enfoca la ventana o la restaura si estaba
minimizada. Registro via Tauri `global-shortcut` plugin.

Configurable o desactivable en Settings.

### Settings Panel

Panel visual que expone las secciones más usadas de `.stratumrc.json` sin editar JSON
a mano:

- **Providers:** lista de providers configurados; botón "Añadir" lanza el mismo
  `ProviderWizard` que existe en la CLI (portado a modal).
- **Modelo activo:** selector con los modelos disponibles del provider activo
  (misma lógica que `/model` en la CLI).
- **Web Search:** backend, API keys, `maxResults`.
- **Memory:** paths de `STRATUM.md` global y de proyecto; botón "Abrir en editor".
- **Apariencia:** (v2) selector de tema si se implementan temas alternativos.

El JSON raw de `.stratumrc.json` también es accesible en una pestaña "Avanzado"
con editor con syntax highlighting y validación en tiempo real contra el schema Zod.

### Ventana frameless con barra de título personalizada

`decorations: false` en `tauri.conf.json`. La barra de título es un componente React
de 32px de alto con `data-tauri-drag-region` que permite mover la ventana. Usa
`bgPanel (#111111)` y se fusiona visualmente con el TabBar.

```
┌─────────────────────────────────────────────────────────────┐
│  ◈ Stratum  [Chat 1 ×] [Chat 2 ×] [+]          ─  □  ×    │  ← TitleBar (32px)
├─────────────────────────────────────────────────────────────┤
```

Los botones de control (─ □ ×) se renderizan manualmente en el extremo derecho de
la barra con los colores del tema. Comportamiento: hover → `borderMedium`, click ×
cierra la ventana via `appWindow.close()`.

El TitleBar y el TabBar pueden coexistir en la misma fila horizontal si el ancho
lo permite, o en filas separadas (decisión de maquetación a validar en D2).

### Onboarding — primer arranque

Se activa cuando el sidecar no encuentra `.stratumrc.json` al iniciar.

**Flujo:**

```
1. Splash de bienvenida (pantalla completa, fondo bgApp)
      ◈  Stratum
      Tu agente de línea de comandos, ahora en escritorio.
      Funciona con cualquier API OpenAI-compatible:
      Ollama · llama.cpp · vLLM · OpenAI · LiteLLM

      [Configurar provider →]

2. ProviderWizard (modal fullscreen, mismo flujo que la CLI)
      → Alias del provider
      → Base URL
      → API key (opcional)
      → Selección de modelo
      → Test de conexión
      → [Guardar y empezar]

3. Primera pestaña abierta con empty state de bienvenida
```

La pantalla de bienvenida no tiene botón de "saltar" — sin un provider configurado
la app no puede hacer nada útil. Si el usuario cierra la ventana durante el wizard,
al reabrir vuelve al paso 1.

Si `.stratumrc.json` existe pero no tiene providers configurados (archivo vacío o
creado manualmente), se aplica el mismo flujo desde el paso 2.

### Manejo de errores del sidecar

El sidecar Node.js puede fallar al arrancar (Node no instalado, puerto ocupado,
error de config) o caerse durante el uso.

**Al arrancar — fallo de inicio:**

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│              ⚠  No se pudo iniciar Stratum              │
│                                                         │
│  El proceso interno encontró un error al arrancar.      │
│                                                         │
│  Error: Cannot find module 'stratum-core'               │
│  (detalle técnico, plegable)                            │
│                                                         │
│  Posibles causas:                                       │
│  · Node.js no está instalado (requiere v18+)            │
│  · La instalación está dañada                           │
│                                                         │
│       [Reintentar]      [Ver logs]                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Durante el uso — sidecar crashea:**

- Se muestra un banner no bloqueante en la parte superior de la
  `ConversationView` activa:

```
⚠  Conexión con el agente perdida.  [Reconectar]
```

- La app intenta reconexión automática con backoff: 1s → 2s → 5s → 10s
  (máximo 4 reintentos). Si todos fallan, el banner pasa a estado de error
  permanente con botón manual.
- El historial de la conversación activa se preserva en el estado React — no
  se pierde al reconectar.
- Si el sidecar no responde en 5s al arrancar una pestaña nueva, se muestra
  el spinner con "Iniciando agente..." antes de pasar al error.

**Logs:** `[Ver logs]` abre `%APPDATA%\stratum-desktop\logs\sidecar.log`
con el editor de sistema. El sidecar redirige stdout/stderr a ese archivo.

### Atajos de teclado

Todos los atajos operan sobre la ventana en foco y no interfieren con los
atajos globales del OS.

| Atajo | Acción |
|-------|--------|
| `Ctrl+T` | Nueva pestaña |
| `Ctrl+W` | Cerrar pestaña activa |
| `Ctrl+Tab` | Siguiente pestaña |
| `Ctrl+Shift+Tab` | Pestaña anterior |
| `Ctrl+1` … `Ctrl+8` | Ir a pestaña N |
| `Ctrl+,` | Abrir Settings Panel |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+L` | Enfocar InputArea (limpiar selección y poner cursor) |
| `Ctrl+K` | Abrir command palette de slash-commands |
| `Escape` | Cerrar modal activo / colapsar sidebar / cancelar generación |
| `Ctrl+Enter` | Enviar mensaje (alternativa a Enter) |
| `Ctrl+Shift+Space` | Global: enfocar/restaurar ventana desde cualquier app |

`Ctrl+W` sobre la última pestaña cierra la ventana (con confirmación si hay
generación activa). No cierra la app si hay más pestañas abiertas.

Los atajos se registran con el hook `useHotkeys` (librería `react-hotkeys-hook`,
sin dependencias nativas). El global hotkey sigue usando el plugin Tauri.

### Slash commands

Hereda el catálogo completo de la CLI y añade tres comandos específicos del
desktop. Se activan escribiendo `/` en el `InputArea`, que muestra un dropdown
con filtrado en tiempo real.

**Heredados de la CLI:**

| Comando | Descripción |
|---------|-------------|
| `/model` | Cambia el modelo activo |
| `/memory show` | Muestra el contenido de STRATUM.md en el chat |
| `/memory forget <texto>` | Elimina una entrada de memoria |
| `/init` | Escanea el proyecto y actualiza STRATUM.md |
| `/config_provider` | Edita la config del provider activo |
| `/clear` | Limpia el historial visible de la conversación |

**Exclusivos del desktop:**

| Comando | Descripción |
|---------|-------------|
| `/settings` | Abre el Settings Panel (equivalente a `Ctrl+,`) |
| `/new-tab` | Abre una nueva pestaña (equivalente a `Ctrl+T`) |
| `/open <ruta>` | Adjunta un archivo al mensaje por ruta absoluta o relativa al cwd |

El dropdown de slash-commands muestra: icono · nombre · descripción corta.
Navegación con ↑↓, selección con Enter o Tab, cierre con Escape.

### Empty states

**Nueva pestaña (sin mensajes):**

```
         ◈

   ¿En qué trabajamos hoy?

   Algunos ejemplos:
   · "Explícame este error de logs de vCenter"
   · "Refactoriza src/auth/middleware.ts"
   · "Busca documentación sobre Tauri IPC"

   Escribe /help para ver todos los comandos.
```

El texto de ejemplos rota aleatoriamente entre un conjunto de 12 sugerencias
relevantes para el perfil del proyecto. No es interactivo (no son botones).

**Sessions vacío** — ya definido en sección 7.1.
**Memory sin archivo** — ya definido en sección 7.3.

---

## 10. Build y distribución

### Targets

| Plataforma | Formato | Notas |
|-----------|---------|-------|
| Windows 10+ | `.msi` | Instalador NSIS via Tauri; requiere firma de código para evitar SmartScreen warning |
| Linux | `.deb` | Para distribuciones Debian/Ubuntu |
| Linux | `.AppImage` | Portable, funciona en cualquier distro |

### Pipeline de build

Cada plataforma produce su propio binario SEA con los módulos nativos compilados
para esa arquitectura. Los pasos de CI son:

```yaml
# GitHub Actions
jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - npm run build               # compila stratum-cli a dist/
      - node scripts/build-sea.mjs  # genera stratum-core.exe (SEA)
      - cargo tauri build --target x86_64-pc-windows-msvc
      # output: src-tauri/target/release/bundle/msi/Stratum_x.y.z_x64.msi

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - npm run build
      - node scripts/build-sea.mjs  # genera stratum-core (ELF)
      - cargo tauri build
      # outputs: .deb + .AppImage
```

`build-sea.mjs` compila el sidecar con Node SEA:
1. `node --experimental-sea-config sea-config.json` genera el blob.
2. `postject stratum-core NODE_SEA_BLOB sea.blob` lo inyecta en el binario Node
   base descargado de nodejs.org (firmado, correcto para la plataforma de CI).
3. Los módulos nativos (`.node`) se copian al directorio `resources/` de Tauri
   para que el sidecar los localice en runtime via `process.resourcesPath`.

### Firma de código

- **Windows:** certificado auto-firmado en builds locales; certificado EV para
  distribución pública (si aplica en el futuro). Tauri soporta `TAURI_SIGNING_*`
  env vars.
- **Linux:** sin firma obligatoria; `.AppImage` puede firmarse con GPG.

### Auto-update

Tauri v2 incluye `tauri-plugin-updater`. El endpoint de actualización apunta a
GitHub Releases (JSON con url + signature). Activado en Hito D3.

---

## 11. Gestión de permisos Tauri v2

`capabilities/default.json` define los permisos mínimos necesarios:

```json
{
  "permissions": [
    "core:default",
    "core:window:default",
    "fs:read-files",
    "fs:write-files",
    "shell:execute",
    "notification:default",
    "global-shortcut:default",
    "dialog:default",
    "window-state:default"
  ],
  "scope": {
    "fs": {
      "allow": [
        "$HOME/.stratum/**",
        "$APPDATA/stratum-desktop/**",
        "$APPDATA/stratum-desktop/logs/**"
      ]
    }
  }
}
```

**Acciones de fs que NO pasan por capacidades Tauri (15.8):** "Abrir en editor"
(`shell.open`) sobre archivos de proyecto arbitrarios, resolución de rutas de
drag & drop y apertura del diálogo de carpeta se enrutan **por el sidecar**
(que tiene acceso OS completo), no como capacidades Tauri directas. Tauri solo
gestiona los archivos de la propia app (config, logs, window-state). Esto mantiene
el scope de Tauri mínimo y consistente con el modelo de seguridad de Tauri v2.

El sidecar Node.js tiene acceso completo al OS porque es un proceso hijo normal,
con el mismo aislamiento que la CLI cuando se ejecuta en la terminal.

---

## 12. Lo que NO está en scope de v1

- **macOS** — prioridad baja; requiere firma + notarización de Apple. Se añade en v2.
- **Múltiples ventanas OS** — el modelo de pestañas cubre el caso de uso.
- **Sincronización de sesión en tiempo real entre instancias** — arquitectura
  significativamente más compleja; no es necesaria si cada instancia es independiente.
- **Modo offline de la UI** (Service Worker / PWA) — no aplica para app de escritorio.
- **Plugin marketplace visual** — se gestiona desde la CLI en v1.
- **Temas de color alternativos** — la arquitectura de CSS vars lo soporta, pero el
  diseño de temas adicionales no está en scope.
- **Soporte de imágenes inline en chat** — los proveedores vision mandan URLs; el
  renderizado inline de imágenes adjuntas se pospone a v2.

---

## 13. Hitos

| Hito | Contenido | Dependencia |
|------|-----------|-------------|
| **D0** | Scaffolding: `cargo tauri init`, Vite + React, CSS vars, sidecar arranca y hace ping | stratum-cli Hito 4 cerrado |
| **D1** | IPC protocol + chat funcional: una pestaña, streaming completo de AgentEvents, ToolCallBlock con 4 estados | D0 |
| **D2** | Modelo de pestañas completo, Sidebar (sessions + memory), StatusBar, InputArea con slash-commands | D1 |
| **D3** | Settings Panel (providers + model + web search), ProviderWizard portado, auto-update | D2 |
| **D4** | Drag & drop, notificaciones OS, global hotkey, build pipeline Windows + Linux | D3 |
| **D5** | Polish: frameless opcional, animaciones, accesibilidad, tests E2E con Tauri WebDriver | D4 |

---

## 14. Decisiones técnicas que no deben revertirse

| Área | Decisión |
|------|----------|
| Shell nativo | Tauri v2; no Electron |
| IPC streaming | Socket local (named pipe / unix socket); no TCP abierto en red |
| IPC auth | Token aleatorio 32 bytes en handshake; sin token → conexión rechazada inmediatamente |
| Config | Escritura atómica + comparación mtime + debounce 300ms en watcher; no escritura directa sin guard |
| Estilos | CSS variables desde `theme.ts`; no Tailwind ni styled-components |
| Estado de pestañas | Zustand o `useContext` + `useReducer`; no Redux |
| Sidecar core | Misma codebase que la CLI (`STRATUM_DESKTOP=1`); no fork |
| Sidecar distribución | Node.js SEA por plataforma; no depende de Node del sistema |
| Versión core | Pineada con la app; schema de config/sesiones versionado con migración forward |
| cwd | Un `StratumAgent` por pestaña con su propio cwd; no cwd global del sidecar |
| Cancel | Por WS (mismo canal que el stream); los `invoke` Tauri solo para config/fs |
| Acceso fs desde UI | Enrutado por sidecar; el scope Tauri fs solo cubre logs y config de la app |
| Frameless | Botones ─ □ × con `role="button"` + `aria-label`; posición restaurada con clamping al área visible |
| Concurrencia | Cada pestaña tiene su `StratumAgent` independiente; límite configurable `desktop.maxConcurrentGenerations` (default 3) |

---

## 15. Puntos ciegos detectados (revisión de diseño)

Revisión crítica del plan. Cada punto indica severidad, el hueco concreto y una
recomendación. Los **🔴 críticos** deben resolverse antes de D1; los **🟠
importantes** antes del hito donde aparecen; los **🟡 menores** son deuda
asumible para v1 pero conviene anotarlos.

### 15.1 🔴 El WebSocket local no está autenticado — riesgo de RCE

`ws://127.0.0.1:<puerto>` sin autenticación es accesible por **cualquier proceso
local y por cualquier página web abierta en un navegador** (los navegadores
permiten conexiones a WebSockets de localhost desde cualquier origen). Como el
canal acepta mensajes `{ type: 'chat' }` que disparan `bash`, `write_file` y
`edit_file`, una web maliciosa podría escanear puertos locales y ejecutar tools
arbitrarias en la máquina del usuario. Es el agujero más serio del diseño.

**Resolución aplicada en sección 3:** Tauri genera un token aleatorio al arrancar,
lo pasa al sidecar por argumento y al frontend por el evento `sidecar://ready`.
El sidecar exige ese token en el primer mensaje del handshake y valida el header
`Origin`, rechazando cualquier conexión sin token válido. Se usa named pipe /
unix socket en lugar de TCP siempre que el SO lo permita.

### 15.2 🔴 Empaquetado del sidecar Node — contradice el binario de 5–10 MB

El plan vendía "binario de ~5–10 MB frente a 150 MB de Electron", pero el sidecar
incluye `sqlite-vec`, `better-sqlite3` y `@xenova/transformers` (ONNX runtime,
binarios nativos por plataforma de decenas de MB). Asumir Node del sistema es
frágil; es además la primera causa de fallo documentada.

**Resolución aplicada en secciones 2 y 10:** el sidecar se distribuye como
binario autónomo via **Node.js SEA** (Single Executable Application, estable desde
Node 21) o `pkg` como fallback. Cada plataforma tiene su propio build que incluye
el runtime y los `.node` nativos compilados. El tamaño instalado estimado es
**60–120 MB total** (shell Tauri + sidecar + webview del sistema). La promesa
"5–10 MB" se restringe al shell Rust de Tauri.

### 15.3 🔴 No hay modelo de directorio de trabajo (cwd) / abrir proyecto

La CLI opera relativa a un cwd. Una app lanzada desde el menú del SO tiene
cwd = home. Sin UI para elegir carpeta de trabajo, `STRATUM.md` de proyecto,
rutas relativas y `/init` no funcionan.

**Resolución aplicada en sección 6:** cada pestaña tiene su propio cwd
seleccionable. La TitleBar muestra la carpeta activa. El panel Memory/Proyecto
sigue a la pestaña activa.

### 15.4 🟠 Confirmación destructiva sobre WebSocket — protocolo sin definir

La CLI resuelve `onConfirmDestructive` con un callback síncrono-async local. Sobre
WS hace falta un request/response con id de correlación.

**Resolución aplicada en sección 3:** mensajes `confirm_request` / `confirm_response`
con `callId`. Default `deny` si la pestaña se cierra o hay timeout de 30s.
`allow-all` con alcance por pestaña.

### 15.5 🟠 Estado del agente vs. reconexión — contradicción

Si el sidecar cae, el `StratumAgent` en memoria se pierde. Reconectar da un agente
nuevo sin contexto de la conversación.

**Resolución aplicada en sección 3:** al reconectar, el frontend envía el historial
completo de la pestaña (array de mensajes) como mensaje `rehydrate`. El sidecar
crea un nuevo `StratumAgent` e inyecta ese historial como contexto inicial.

### 15.6 🟠 Versión del core: bundle vs. CLI global

Si el schema de `.stratumrc.json` o `SessionStore` cambia entre versiones, la
promesa de "config compartida sin fricción" se rompe silenciosamente.

**Resolución aplicada en sección 14:** el core va pineado con la app. El schema
de config y sesiones se versiona con campo `schemaVersion` y migración hacia
adelante. Si la versión es incompatible, se muestra aviso y se ofrece migración.

### 15.7 🟠 Escritura concurrente de config — lost updates

La escritura atómica evita torn reads pero no lost updates entre procesos.

**Resolución aplicada en sección 4:** comparación de mtime antes de escribir,
debounce de 300ms en el watcher y flag `_selfWrite` para ignorar eventos propios.

### 15.8 🟠 Alcance de permisos fs de Tauri demasiado estrecho

`shell.open` sobre rutas de proyecto arbitrarias y drag & drop caen fuera del
scope `$HOME/.stratum/**`.

**Resolución aplicada en sección 11:** `shell:open` se enruta por el sidecar
(que tiene acceso OS completo), no como capacidad Tauri directa. El scope fs de
Tauri se amplía solo para los paths de config/log de la app.

### 15.9 🟠 Plano de control partido en dos transportes

Cancel por `invoke` Tauri introduce carreras de orden con chunks en vuelo por WS.

**Resolución aplicada en sección 3:** `cancel`, `new_tab` y `close_tab` viajan
por el mismo WS. Los `invoke` Tauri quedan reservados para config/fs.

### 15.10 🟠 Captura de puerto por stdout + Firewall de Windows

Parsear el puerto del stdout es frágil (logs intercalados). Un servidor TCP
en localhost puede disparar el diálogo del Firewall en el primer arranque.

**Resolución aplicada en sección 3:** Tauri elige el puerto (o socket local) y
lo pasa al sidecar por argumento. En Windows se usa named pipe para evitar el
diálogo de firewall.

### 15.11 🟠 Ciclo de vida del sidecar — procesos huérfanos y MCP

El sidecar puede quedar huérfano si Tauri se cierra o crashea. Los servidores MCP
que arranque tampoco tienen cleanup definido.

**Resolución aplicada en sección 3:** el sidecar es hijo de Tauri; se mata
con `SIGTERM` en el evento `exit`/`window-close`. El sidecar propaga la señal
a sus hijos MCP antes de salir. En Windows se usa Job Object para garantizar
la terminación en cascada.

### 15.12 🟡 Persistencia de sesión solo al cerrar

Un crash del proceso pierde la conversación activa.

**Resolución aplicada en sección 4:** checkpoint incremental cada 60s y al
recibir cada mensaje del agente.

### 15.13 🟡 Rendimiento del markdown en streaming

`react-markdown` re-parsea el mensaje completo en cada chunk SSE.

**Resolución aplicada en sección 8:** los bloques de texto estabilizados
(anteriores al chunk actual) se memoizan con `React.memo`. La lista de mensajes
se virtualiza con `react-window` para conversaciones largas (> 50 mensajes).

### 15.14 🟡 Ventana frameless rompe features del SO + multi-monitor

`decorations: false` pierde Aero Snap y accesibilidad de controles nativos.
La posición restaurada puede caer fuera de pantalla si el monitor ya no está.

**Resolución aplicada en sección 14:** los botones ─ □ × llevan `role="button"`
y `aria-label`. La posición restaurada se clampa al área visible del monitor
actual antes de aplicarse.

### 15.15 🟡 Concurrencia entre pestañas en un único sidecar

Múltiples pestañas generando a la vez comparten proceso Node y límites del provider.

**Resolución aplicada en sección 14:** cada pestaña tiene su `StratumAgent`
independiente. El `ProviderRouter` del sidecar puede aplicar un límite configurable
de generaciones concurrentes (`desktop.maxConcurrentGenerations`, default 3).

### Resumen de prioridades

| # | Punto ciego | Severidad | Resolver antes de |
|---|-------------|-----------|-------------------|
| 15.1 | WebSocket sin autenticar (RCE) | 🔴 | D1 |
| 15.2 | Empaquetado del sidecar Node / tamaño real | 🔴 | D0 |
| 15.3 | Sin modelo de cwd / abrir proyecto | 🔴 | D1 |
| 15.4 | Protocolo de confirmación destructiva | 🟠 | D1 |
| 15.5 | Estado del agente vs. reconexión | 🟠 | D1 |
| 15.6 | Versión core bundle vs. CLI global | 🟠 | D0 |
| 15.7 | Lost updates en config concurrente | 🟠 | D3 |
| 15.8 | Scope fs de Tauri demasiado estrecho | 🟠 | D2 |
| 15.9 | Cancel en transporte separado | 🟠 | D1 |
| 15.10 | Captura de puerto por stdout + firewall | 🟠 | D0 |
| 15.11 | Ciclo de vida del sidecar / MCP huérfanos | 🟠 | D0 |
| 15.12 | Persistencia de sesión solo al cerrar | 🟡 | D2 |
| 15.13 | Rendimiento markdown en streaming | 🟡 | D1 |
| 15.14 | Frameless rompe SO + multi-monitor | 🟡 | D5 |
| 15.15 | Concurrencia entre pestañas | 🟡 | D2 |

