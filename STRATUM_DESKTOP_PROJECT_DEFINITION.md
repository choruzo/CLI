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

```
┌─────────────────────────────────────────────────────────────┐
│  ◈ Stratum                                    _ □ ×         │  ← chrome nativo
├──────────────┬──────────────────────────────────────────────┤
│  [Chat 1 ×] [Chat 2 ×] [+]                                  │  ← TabBar
├──────┬───────────────────────────────────────────────────────┤
│      │                                                       │
│ [S]  │   ConversationView (pestaña activa)                  │
│ [H]  │                                                       │
│ [M]  │                                                       │
│      │                                                       │
│      ├───────────────────────────────────────────────────────┤
│      │  InputArea                                            │
├──────┴───────────────────────────────────────────────────────┤
│  ● ollama / llama3.2  │  ctx 12%  │  3 tools disponibles    │  ← StatusBar
└─────────────────────────────────────────────────────────────┘
   ↑
   Sidebar (colapsable): Sessions [S], History [H], Memory [M]
```

### TabBar

- Cada pestaña tiene un `tabId` UUID, un título (primeras palabras del primer mensaje)
  y un indicador de estado (idle / generando / error).
- `[+]` abre una nueva pestaña con nueva sesión.
- `[×]` cierra la pestaña; si hay generación activa, pide confirmación.
- Máximo recomendado: 8 pestañas simultáneas (no hay límite técnico duro).
- Las pestañas persisten mientras la app está abierta. Al cerrar la app, la sesión
  activa de cada pestaña se guarda en `SessionStore`.

### Sidebar (colapsable, ancho 260px)

- **Sessions:** lista de sesiones pasadas (resume con click).
- **History:** historial de la conversación activa en formato compacto.
- **Memory:** vista de `STRATUM.md` activo (global + proyecto), solo lectura.

---

## 7. Componentes del frontend

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

## 8. Features desktop-específicas

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

### Ventana sin frame (frameless opcional)

Opcionalmente: `decorations: false` en `tauri.conf.json` + drag area CSS para
implementar una barra de título personalizada con los mismos colores del tema.
Decisión de diseño a tomar en Hito D2.

---

## 9. Build y distribución

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

## 10. Gestión de permisos Tauri v2

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

## 11. Lo que NO está en scope de v1

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

## 12. Hitos

| Hito | Contenido | Dependencia |
|------|-----------|-------------|
| **D0** | Scaffolding: `cargo tauri init`, Vite + React, CSS vars, sidecar arranca y hace ping | stratum-cli Hito 4 cerrado |
| **D1** | IPC protocol + chat funcional: una pestaña, streaming completo de AgentEvents, ToolCallBlock con 4 estados | D0 |
| **D2** | Modelo de pestañas completo, Sidebar (sessions + memory), StatusBar, InputArea con slash-commands | D1 |
| **D3** | Settings Panel (providers + model + web search), ProviderWizard portado, auto-update | D2 |
| **D4** | Drag & drop, notificaciones OS, global hotkey, build pipeline Windows + Linux | D3 |
| **D5** | Polish: frameless opcional, animaciones, accesibilidad, tests E2E con Tauri WebDriver | D4 |

---

## 13. Decisiones técnicas que no deben revertirse

| Área | Decisión |
|------|----------|
| Shell nativo | Tauri v2; no Electron |
| Streaming | WebSocket local desde sidecar; no Tauri IPC para AgentEvents |
| Config | Escritura atómica (write-to-temp + rename); no escritura directa |
| Estilos | CSS variables desde `theme.ts`; no Tailwind ni styled-components |
| Estado de pestañas | Zustand o `useContext` + `useReducer`; no Redux |
| Sidecar | `stratum-core` es el mismo binario que la CLI con `STRATUM_DESKTOP=1`; no hay fork del core |
