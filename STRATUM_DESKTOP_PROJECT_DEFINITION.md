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
| Shell nativo | **Tauri v2** (Rust) | Webview nativo, binario ligero, IPC tipado |
| Frontend | **React 18 + Vite** | Mismo modelo de componentes que la UI Ink existente |
| Estilos | **CSS variables + módulos** | Sin framework de CSS; colores desde `theme.ts` |
| Tipado IPC | **@tauri-apps/api v2** | `invoke`, `listen`, `emit` tipados en TS |
| Markdown | **react-markdown + rehype-highlight** | Equivalente a `marked` + `cli-highlight` de la CLI |
| Build frontend | **Vite** (bundler por Tauri) | Sin configuración adicional |
| Empaquetado | **tauri build** | Genera `.msi` (Windows) y `.deb` / `.AppImage` (Linux) |

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

### Patrón: Node.js sidecar + WebSocket local

El frontend **no** llama directamente al core de stratum por comandos Tauri. En su lugar:

1. Tauri arranca `stratum-core` como proceso sidecar Node.js al iniciar la app.
2. El sidecar abre un WebSocket en `ws://127.0.0.1:<puerto-aleatorio>`.
3. Tauri escucha el stdout del sidecar para capturar el puerto y lo pasa al frontend
   via un Tauri event (`sidecar://ready`).
4. El frontend conecta al WebSocket directamente y recibe `AgentEvent`s en streaming.

```
Frontend (React) ──WebSocket──► stratum-core (Node.js sidecar)
       │                               │
       └──Tauri invoke──► Rust ────────┘  (comandos no-streaming: config read/write,
                                           session list, cancel, etc.)
```

### Por qué WebSocket en lugar de Tauri IPC para streaming

Tauri IPC (`invoke`) es request-response. Los `AgentEvent`s son un stream async
continuo. WebSocket permite backpressure natural y es más simple de implementar en
el lado Node sin añadir dependencias a `stratum-cli`.

### Modificación mínima en stratum-cli

Añadir en `stratum-cli/src` un nuevo entry point `desktop-server.ts`:

```ts
// Arrancado solo cuando STRATUM_DESKTOP=1
// Abre un WS server, acepta una conexión, y expone el mismo StratumAgent
// que usa `stratum chat`, emitiendo AgentEvents como mensajes JSON.
```

El servidor acepta mensajes de entrada:
```ts
{ type: 'chat', tabId: string, message: string }
{ type: 'cancel', tabId: string }
{ type: 'new_tab' }
{ type: 'close_tab', tabId: string }
```

Y emite los `AgentEvent`s ya definidos en `agent/types.ts`, con `tabId` añadido.

---

## 4. Aislamiento de instancias y config compartida

### Config compartida

`useConfig.ts` invoca un Tauri command `read_config` / `write_config` que en Rust
lee y escribe `~/.stratum/.stratumrc.json` (o el path del proyecto activo).

**Conflictos de escritura concurrente:** se resuelve con escritura atómica
(write-to-temp + rename) — el mismo patrón que `atomic_io.py` de Odysseus. Rust tiene
soporte nativo para esto con `tempfile` crate.

El frontend suscribe un `watch_config` (Tauri fs watcher) para recargar la config
cuando la CLI la modifica desde la terminal mientras la app está abierta.

### Historial de sesiones compartido

`SessionStore` persiste en disco. Tanto la CLI como el desktop pueden listar y
resumir sesiones pasadas. No hay bloqueo de archivo — las sesiones se escriben al
cerrarse, no durante la conversación activa.

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

```yaml
# GitHub Actions (cuando exista repo desktop)
jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - build stratum-cli (npm run build)
      - cargo tauri build --target x86_64-pc-windows-msvc
  build-linux:
    runs-on: ubuntu-latest
    steps:
      - build stratum-cli
      - cargo tauri build   # genera .deb + .AppImage automáticamente
```

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
    "global-shortcut:default"
  ],
  "scope": {
    "fs": {
      "allow": [
        "$HOME/.stratum/**",
        "$APPDATA/stratum/**"
      ]
    }
  }
}
```

El sidecar Node.js tiene sus propios permisos de OS (acceso completo al fs, red, etc.)
porque es un proceso hijo, no una capacidad Tauri. Esto es correcto: el mismo
aislamiento que tiene la CLI cuando se ejecuta en terminal.

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
| Streaming | WebSocket local desde sidecar; no Tauri IPC para AgentEvents |
| Config | Escritura atómica (write-to-temp + rename); no escritura directa |
| Estilos | CSS variables desde `theme.ts`; no Tailwind ni styled-components |
| Estado de pestañas | Zustand o `useContext` + `useReducer`; no Redux |
| Sidecar | `stratum-core` es el mismo binario que la CLI con `STRATUM_DESKTOP=1`; no hay fork del core |

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

**Recomendación:** Tauri genera un token aleatorio al arrancar, lo pasa al sidecar
por argumento/env y al frontend por el evento `sidecar://ready`. El sidecar exige
ese token en el handshake (primer mensaje o header) y valida el header `Origin`,
rechazando cualquier conexión sin token válido. Considerar un named pipe / unix
socket en lugar de TCP, que no es alcanzable desde el navegador.

### 15.2 🔴 Empaquetado del sidecar Node — contradice el binario de 5–10 MB

El plan vende "binario de ~5–10 MB frente a 150 MB de Electron", pero el sidecar
es Node.js con dependencias nativas pesadas: `sqlite-vec`, `better-sqlite3` y
`@xenova/transformers` (ONNX runtime trae binarios por plataforma de decenas de
MB). No se decide **cómo se distribuye**: ¿se asume Node del sistema (frágil, y el
propio doc lo lista como causa de fallo "Node no instalado"), se empaqueta con
`pkg`/`nexe`, o se incluye `node_modules` + runtime? Cualquiera de las opciones
realistas dispara el tamaño muy por encima de 10 MB y exige builds por plataforma
de los módulos nativos.

**Recomendación:** decidir y documentar la estrategia (recomendado: sidecar
empaquetado como binario autónomo por plataforma con los `.node` nativos
incluidos), y corregir la cifra de tamaño esperada. El "5–10 MB" solo aplica al
shell Tauri, no a la app instalada.

### 15.3 🔴 No hay modelo de directorio de trabajo (cwd) / abrir proyecto

La CLI opera relativa a un cwd: `STRATUM.md` de proyecto, rutas relativas en las
tools, `/init`. Una app lanzada desde el menú del SO tiene cwd = home o el dir de
la app, **no un proyecto**. El doc menciona "directorio de trabajo activo del
sidecar" (sección 7.3) en singular, pero no existe ninguna UI para **elegir o
cambiar la carpeta de trabajo**, ni se resuelve si cada pestaña puede apuntar a un
proyecto distinto (un sidecar único ⇒ un solo cwd, pero las pestañas sugieren
proyectos independientes). Para un agente de código de escritorio esto es
fundamental.

**Recomendación:** añadir un selector "Abrir carpeta/proyecto" (por ventana o por
pestaña) y definir si el cwd es global al sidecar o por pestaña. Si es por
pestaña, cada `StratumAgent` necesita su propio cwd y el panel Memory/Proyecto
debe seguir a la pestaña activa.

### 15.4 🟠 Confirmación destructiva sobre WebSocket — protocolo sin definir

La CLI resuelve `onConfirmDestructive` con un callback síncrono-async local. Sobre
WS hace falta un **request/response con id de correlación**: el sidecar emite
`confirm_request` y bloquea la ejecución hasta recibir `confirm_response`. El doc
muestra el componente `DestructiveConfirm` pero no el protocolo ni los casos
límite: ¿qué pasa si el usuario cierra la pestaña/app con una confirmación
pendiente? ¿Dónde vive el estado `allow-all` (`!`) — por pestaña o por sidecar?
¿Un timeout convierte la espera en deny?

**Recomendación:** especificar mensajes `confirm_request`/`confirm_response` con
`callId`, default a `deny` si la pestaña se cierra o hay timeout, y `allow-all`
con alcance por pestaña (coherente con "instancias aisladas").

### 15.5 🟠 Estado del agente vs. reconexión — contradicción

La sección 9 dice que al crashear el sidecar "el historial se preserva en el
estado React, no se pierde al reconectar". Pero el `StratumAgent` y su contexto
**viven en memoria del sidecar**: si el sidecar cae, el contexto del LLM, el
historial comprimido y el estado de tools se pierden. Reconectar da un agente
nuevo sin memoria de la conversación. El frontend mostraría los mensajes pero el
agente no tendría el contexto para continuar. Además, "acepta una conexión"
(sección 3) choca con multiplexar varias pestañas y con reconexión.

**Recomendación:** al reconectar, rehidratar el agente del sidecar reenviando el
historial que conserva el frontend (o persistiendo el estado de sesión de cada
tab para recargarlo). Aclarar que el WS acepta multiplexado por `tabId`, no una
única conexión.

### 15.6 🟠 Versión del core: bundle vs. CLI global — promesa de "config compartida"

La decisión dice "el sidecar es el mismo binario que la CLI". Pero no se aclara si
es la **CLI instalada globalmente por npm** o una **copia empaquetada** con la
app. Si va empaquetada, su versión puede divergir de la CLI del usuario; si el
schema de `.stratumrc.json` o el formato de `SessionStore`/`STRATUM.md` cambia
entre versiones, la promesa de "config y memoria compartidas sin fricción" se
rompe silenciosamente. El auto-updater de Tauri (sección 10) actualiza el shell,
no necesariamente el core.

**Recomendación:** empaquetar una versión pineada del core con la app (para no
depender de instalación previa) y versionar el schema de config/sesiones con
migración hacia adelante y detección de versión incompatible.

### 15.7 🟠 Escritura concurrente de config — pérdida de updates, no solo torn reads

La escritura atómica (temp + rename) evita lecturas a medias, pero **no evita
lost updates**: si CLI y desktop editan config casi a la vez, el último en escribir
pisa al otro sin aviso. Peor: el `watch_config` puede entrar en bucle (desktop
escribe → watcher dispara → recarga → re-render) y si hay ediciones sin guardar en
el Settings Panel abierto, una escritura de la CLI las descarta.

**Recomendación:** comparar mtime/hash antes de escribir y avisar si cambió bajo
los pies del usuario; ignorar en el watcher los eventos generados por la propia
escritura (debounce + flag de auto-write).

### 15.8 🟠 Alcance de permisos fs de Tauri demasiado estrecho

`capabilities/default.json` solo permite `$HOME/.stratum/**` y `$APPDATA/stratum/**`.
Pero "Abrir en editor" (`shell.open`) sobre el `STRATUM.md` de un proyecto
arbitrario, y la resolución de rutas del drag & drop, caen fuera de ese scope. El
trabajo de archivos lo hace el sidecar (acceso OS completo), pero las acciones que
sí pasan por Tauri necesitan un scope más amplio o un patrón distinto.

**Recomendación:** ampliar el scope de `shell:open`/`fs` a las rutas de proyecto, o
enrutar esas acciones por el sidecar en lugar de por capacidades Tauri.

### 15.9 🟠 Plano de control partido en dos transportes (cancel)

El streaming va por WS pero `cancel` va por Tauri `invoke` → Rust → sidecar
(sección 3). Dividir control y datos en dos canales introduce **carreras de
orden**: el `cancel` puede llegar antes/después de chunks en vuelo y debe alcanzar
el `AbortSignal` correcto del agente. Mantener cancel/new_tab/close_tab por el
mismo WS (ya están en el protocolo de entrada) es más simple y ordenado.

**Recomendación:** enviar también `cancel` por WS (ya está tipado en la sección 3),
reservando los `invoke` de Tauri solo para operaciones realmente request-response
sin relación con el stream (leer/escribir config, abrir editor).

### 15.10 🟠 Captura de puerto por stdout + firewall

Parsear el puerto del stdout del sidecar es frágil: logs y el mensaje de puerto
pueden intercalarse. Además, abrir un servidor TCP en localhost puede **disparar el
diálogo del Firewall de Windows** en el primer arranque, una mala primera
impresión.

**Recomendación:** que Tauri elija el puerto (o use named pipe/unix socket) y lo
pase al sidecar por argumento, eliminando el parsing de stdout y, con socket
local, el aviso de firewall.

### 15.11 🟠 Ciclo de vida del sidecar — procesos huérfanos y MCP

No se especifica el **kill del sidecar** cuando Tauri se cierra o crashea: Node
puede quedar huérfano reteniendo el puerto. Con MCP (Hito 4 de la CLI) el sidecar
arranca subprocesos de servidores MCP — su arranque eager, su coste en el inicio de
la app y su cierre al salir tampoco están contemplados en el contexto desktop.

**Recomendación:** matar el sidecar en el `exit`/`window-close` de Tauri y en
señales; el sidecar a su vez debe cerrar sus subprocesos MCP. Documentar el arranque
de MCP como parte del flujo de inicio (impacta el tiempo a "primera pestaña lista").

### 15.12 🟡 Persistencia de sesión solo al cerrar — pérdida en crash

"Las sesiones se escriben al cerrarse, no durante la conversación activa"
(sección 4). Un crash del sidecar o de la app **pierde la conversación activa** que
no se llegó a guardar. La reconexión preserva el estado React, pero un crash total
del proceso del webview no.

**Recomendación:** checkpoint periódico / autosave incremental de la sesión activa.

### 15.13 🟡 Rendimiento del markdown en streaming

`react-markdown + rehype-highlight` re-parsea el mensaje completo en cada chunk SSE.
En respuestas largas con bloques de código esto degrada el frame rate. La CLI no
sufre esto igual por su modelo de render.

**Recomendación:** render incremental (parsear solo el delta o memoizar bloques
estables) y/o virtualización de la lista de mensajes para conversaciones largas.

### 15.14 🟡 Ventana frameless rompe features del SO + restauración multi-monitor

`decorations: false` con barra propia pierde Aero Snap, alto contraste y la
exposición de controles a lectores de pantalla; hay que reimplementar snapping y
accesibilidad de los botones ─ □ ×. Además, restaurar posición desde
`window-state` puede dejar la ventana **fuera de pantalla** si el monitor ya no está
conectado.

**Recomendación:** validar accesibilidad de los controles custom (sección 9 ya lo
deja "a validar en D2") y clamping de la posición restaurada al área visible actual.

### 15.15 🟡 Concurrencia entre pestañas en un único sidecar

Varias pestañas generando a la vez comparten proceso: compresión de contexto (LLM
call), límites de conexión/rate del provider y el `serialized` de `bash` que es por
agente, no global. No es bloqueante para v1 pero conviene anotar el comportamiento
esperado bajo carga.

**Recomendación:** documentar que cada tab tiene su `StratumAgent` independiente y
evaluar un límite de generaciones concurrentes si el provider lo requiere.

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
