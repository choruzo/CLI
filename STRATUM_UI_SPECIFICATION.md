# Stratum CLI — Especificación de Interfaz (UI)

> Documento de referencia para la implementación de la Terminal UI con Ink (React for CLIs).
> Documento relacionado: [STRATUM_PROJECT_DEFINITION.md](./STRATUM_PROJECT_DEFINITION.md)

---

## 1. Visión General

La interfaz de Stratum CLI es una **Terminal UI reactiva** construida con [Ink](https://github.com/vadimdemedes/ink), que renderiza componentes React en el terminal. El diseño tiene dos estados claramente diferenciados:

- **Estado A — Banner**: pantalla de bienvenida al arrancar `stratum chat`. Ocupa el terminal completo con el ASCII art del nombre y quick tips. Desaparece completamente al enviar el primer mensaje.
- **Estado B — Conversación**: vista de trabajo activo. Status bar arriba, conversación en el centro (scrollable), input fijo abajo.

La transición entre estados es la única animación de "pantalla completa". El resto de animaciones son inline: spinners, streaming de texto, aparición de tool call blocks.

---

## 2. Layout y Zonas

### Estado A — Banner (arranque)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   ███████╗████████╗██████╗  █████╗ ████████╗██╗   ██╗███╗   ███╗       │
│   ██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚══██╔══╝██║   ██║████╗ ████║       │
│   ╚█████╗    ██║   ██████╔╝███████║   ██║   ██║   ██║██╔████╔██║       │
│    ╚═══██╗   ██║   ██╔══██╗██╔══██║   ██║   ██║   ██║██║╚██╔╝██║       │
│   ██████╔╝   ██║   ██║  ██║██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║       │
│   ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═╝    ╚═════╝ ╚═╝     ╚═╝       │
│                                                                          │
│           v0.1.0  ·  extensible · local-first · provider-agnostic        │
│                                                                          │
│   ── quick start ───────────────────────────────────────────────────    │
│   ❯  stratum chat            iniciar conversación interactiva            │
│   ❯  stratum run "tarea"     ejecutar tarea one-shot                     │
│   /  /help                   ver todos los comandos disponibles          │
│   /  /memory list            gestionar memoria persistente               │
│   ─────────────────────────────────────────────────────────────────    │
│                                                                          │
│   ❯❯ _                                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Proporciones**: el banner ocupa el 100% del terminal al arrancar. No hay header ni status bar en este estado. Solo el bloque de arte + metadata + tips + prompt de entrada.

---

### Estado B — Conversación

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● ollama │ qwen2.5-coder:32b                       ctx 4.2k / 32k │ 13% │  ← STATUS BAR (1 línea, fija)
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  You                                                                     │
│  ▏ Analiza src/agent/core.ts y dime si hay posibles memory leaks         │
│                                                                          │
│  Stratum                                                                 │
│  Voy a leer el archivo primero.                                          │
│                                                                          │
│  ✓ read_file  │ 0.4s │ src/agent/core.ts                          ▸     │  ← TOOL CALL BLOCK (colapsado)
│  ✓ grep       │ 0.2s │ removeListener|cleanup — 0 matches         ▸     │
│  ◌ bash       │ 1.2s │ grep -c "\.on(" src/agent/core.ts               │  ← TOOL CALL (running)
│                                                                          │
│  Stratum                                                                 │
│  He identificado 2 posibles memory leaks:                                │
│                                                                          │
│  1. EventEmitter sin cleanup (líneas 43, 89) — Los listeners...█         │  ← streaming cursor
│                                                                          │  ← ÁREA SCROLLABLE
├──────────────────────────────────────────────────────────────────────────┤
│ ❯❯ /                                                                     │  ← INPUT (1-2 líneas, fija)
└──────────────────────────────────────────────────────────────────────────┘
```

**Zonas:**
- **Status bar**: 1 línea, fija arriba. Siempre visible.
- **Área de conversación**: flexible, scrollable, ocupa el resto del espacio entre status bar e input.
- **Input**: 1 línea en reposo, se expande a 2 si el texto hace wrap. Fija abajo.

---

## 3. Estado A — Banner de Arranque

### 3.1 Composición

| Elemento | Contenido | Color |
|---|---|---|
| ASCII art | `STRATUM` en letras block (6 líneas × ~64 chars) | Ámbar `#F59E0B` |
| Versión y tagline | `v0.1.0 · extensible · local-first · provider-agnostic` | Gris muted `#6B7280` |
| Separador superior | `── quick start ──────...` | Gris oscuro `#374151` |
| Tips | 4 líneas: `❯ comando  descripción` | Blanco `#F3F4F6` + gris `#9CA3AF` |
| Separador inferior | `────────────────────...` | Gris oscuro `#374151` |
| Prompt de entrada | `❯❯ _` con cursor parpadeante | Ámbar `#F59E0B` |

### 3.2 Efecto de aparición del ASCII art (typewriter)

El texto del banner aparece **carácter a carácter de izquierda a derecha, línea por línea**, emulando una impresora de alta velocidad. El ritmo es rápido (~3-4 chars por frame a 60fps) para que la animación dure ~400ms sin sentirse lenta.

**Secuencia:**
```
t=0ms     → Pantalla en negro, cursor parpadeando
t=0ms     → Inicia el typewriter del ASCII art (carácter a carácter, 3-4 por frame)
t=~400ms  → ASCII art completo
t=~600ms  → Fade in suave de versión + tagline (opacity 0→1, 200ms)
t=~800ms  → Fade in suave de la sección de tips (opacity 0→1, 200ms)
t=~1000ms → Fade in del prompt ❯❯ con cursor parpadeante
t=~1200ms → Simulación de typing del placeholder si el usuario no interactúa (opcional)
```

**Implementación Ink aproximada:**
```tsx
// src/cli/ui/Banner.tsx
const [phase, setPhase] = useState<'typing' | 'tips' | 'ready'>('typing');
const [artText, setArtText] = useState('');

useEffect(() => {
  let i = 0;
  const chars = ASCII_ART.split('');
  const iv = setInterval(() => {
    setArtText(prev => prev + chars[i++] + (chars[i] ?? '') + (chars[i+1] ?? ''));
    i += 2;
    if (i >= chars.length) { clearInterval(iv); setPhase('tips'); }
  }, 16); // ~60fps
  return () => clearInterval(iv);
}, []);
```

### 3.3 Transición al Estado B

Al enviar el primer mensaje (`Enter` en el prompt):

1. El componente `<Banner />` se **desmonta** (sin fade, sin animación de salida — desaparece limpiamente).
2. El componente `<ConversationView />` se **monta** inmediatamente, comenzando desde la parte superior con el status bar.
3. El mensaje del usuario aparece en el área de conversación.
4. El agente comienza su respuesta en streaming.

**No hay animación de transición entre estados** — el cambio es instantáneo, deliberadamente, para no entorpecer el flujo de trabajo.

---

## 4. Estado B — Vista de Conversación

### 4.1 Status Bar

Una sola línea fija en la parte superior, con fondo ligeramente más claro que el terminal (`#1A1A1A`).

```
 ● ollama │ qwen2.5-coder:32b                          ctx 4.2k / 32k │ 13%
```

| Elemento | Descripción | Color |
|---|---|---|
| `●` | Indicador de conexión (verde = conectado, rojo = error, gris = desconectado) | Variable: `#22C55E` / `#EF4444` / `#6B7280` |
| Provider name | Nombre del proveedor activo (`ollama`, `openai`, `litellm`) | Gris muted `#9CA3AF` |
| `│` | Separador vertical | Gris oscuro `#374151` |
| Model name | Nombre del modelo activo | Blanco `#F3F4F6` |
| (espacio flexible) | Empuja los elementos de contexto a la derecha | — |
| `ctx N.Nk / NNk` | Estimación de tokens usados / máximo del modelo | Gris `#9CA3AF` |
| `│` | Separador vertical | Gris oscuro `#374151` |
| `NN%` | Porcentaje de contexto usado. Verde < 60%, ámbar 60-85%, rojo > 85% | Variable |

### 4.2 Área de Conversación

Scrollable verticalmente. Ink no tiene scroll nativo — se implementa con `ink-scroll-component` o capturando `scrollDown`/`scrollUp` del proceso.

#### Mensaje del usuario
```
  You
  ▏ texto del mensaje aquí
```
- Label `You`: gris muted `#6B7280`, 11px
- Barra vertical `▏`: gris `#374151` (indica inicio del mensaje)
- Texto: blanco `#E5E5E5`, 12px

#### Respuesta del agente
```
  Stratum
  Texto de la respuesta que aparece en streaming...█
```
- Label `Stratum`: ámbar `#F59E0B`, 11px
- Texto: gris claro `#D1D5DB`, 12px
- Cursor de streaming `█`: ámbar parpadeante, desaparece al completar

#### Separación entre turnos
Un espacio en blanco de 1 línea entre cada turno de usuario/agente. No hay líneas divisorias horizontales.

---

## 5. Componentes Detallados

### 5.1 Tool Call Block — Estados

Cada tool call pasa por una secuencia de estados visuales:

#### Estado: `pending` (en cola, esperando dispatch)
```
  ○ tool_name  │ en cola...
```
- Icono `○`: gris `#4B5563`
- Texto: gris muted `#6B7280`
- Sin duración (aún no ha empezado)

#### Estado: `running` (ejecutándose)
```
  ◌ bash  │ 1.2s  │ grep -c "\.on(" src/agent/core.ts
```
- Icono `◌` → animado con frames: `◌ ◎ ● ◉ ○` cada 150ms
- Color ámbar `#F59E0B`
- Timer incrementando cada 100ms (formato `0.0s`)
- Comando visible en gris `#6B7280`

#### Estado: `completed` (terminado con éxito)
```
  ✓ read_file  │ 0.4s  │ src/agent/core.ts                          ▸
```
- Icono `✓`: verde `#22C55E`
- Tool name: ámbar `#F59E0B`
- Duración: gris `#6B7280`
- Descripción del input: gris `#6B7280`
- Chevron `▸` / `▾`: indica colapsado / expandido, clic para toggle
- Fondo del bloque: `#161616`
- Borde: `0.5px solid #2A2A2A`

#### Estado: `error` (error recuperable)
```
  ✗ bash  │ 0.8s  │ permission denied                              ▸
```
- Icono `✗`: rojo `#EF4444`
- Tool name: rojo atenuado `#FCA5A5`
- Descripción del error: rojo muted

#### Estado expandido (toggle con tecla `Space` o clic)
```
  ✓ read_file  │ 0.4s  │ src/agent/core.ts                          ▾
  ┌────────────────────────────────────────────────────────────┐
  │ → 284 lines read                                           │
  │ → EventEmitter instances at lines 43, 89, 156             │
  │ → setInterval at line 201 (no clearInterval found)        │
  └────────────────────────────────────────────────────────────┘
```
- Borde interno: `#2A2A2A`
- Texto de output: gris `#6B7280`, 11px, monospace
- Máximo 10 líneas visibles. Si hay más, truncar con `[+N more lines]`

#### Múltiples tool calls paralelas
Cuando el modelo emite varias tool calls en un turno, se muestran en stack vertical sin indentación especial. Si se ejecutan en paralelo, el timer de cada una corre de forma independiente.

### 5.2 Input Area — /comandos y autocompletado

```
  ❯❯ /mem|
         ┌──────────────────────────────┐
         │ /memory list                 │
         │ /memory search <query>       │
         │ /memory forget <id>          │
         │ /memory show                 │
         └──────────────────────────────┘
```

El área de input tiene tres modos:

**Modo normal:**
- Prompt `❯❯` en ámbar `#F59E0B`
- Texto de entrada: blanco `#F3F4F6`
- Placeholder: `Type a message or / for commands...` en gris `#4B5563`

**Modo /comando:**
- Al escribir `/`, aparece inmediatamente el dropdown de autocompletado
- Dropdown: fondo `#1C1C1C`, borde `#2A2A2A`, radio 6px
- Ítem activo: fondo `#2A2A2A`, texto ámbar `#F59E0B`
- Navegación: flechas `↑↓`, selección `Enter`, cancelar `Esc`

**Modo waiting (agente procesando):**
- Prompt `❯❯` en gris `#4B5563` (deshabilitado)
- Placeholder: `Stratum is thinking...` en gris oscuro
- Input bloqueado hasta que el agente emita `done`

#### Lista completa de /comandos

| Comando | Descripción |
|---|---|
| `/help` | Lista todos los comandos disponibles con descripción |
| `/clear` | Limpia el área de conversación (mantiene la sesión activa) |
| `/quit` o `/exit` | Termina la sesión, guarda el historial |
| `/memory list` | Lista las decisiones almacenadas |
| `/memory search <query>` | Búsqueda semántica en decisiones |
| `/memory forget <id>` | Elimina una decisión por ID |
| `/memory show` | Muestra el contenido del STRATUM.md activo |
| `/sessions list` | Lista sesiones guardadas |
| `/sessions resume <id>` | Carga una sesión anterior |
| `/plan` | Activa modo plan-and-execute para el próximo mensaje |
| `/provider <name>` | Cambia el proveedor activo en caliente |
| `/model <name>` | Cambia el modelo activo en caliente |
| `/tools` | Lista las tools disponibles (built-in + MCP) |
| `/context` | Muestra estadísticas de uso del contexto actual |
| `/debug` | Toggle del modo debug (muestra chunks SSE raw) |

---

## 6. Paleta de Colores

La paleta es **fija** (no adapta light/dark mode — es una terminal UI, siempre oscura).

### Fondos

| Token | Hex | Uso |
|---|---|---|
| `bg-terminal` | `#0D0D0D` | Fondo del terminal principal |
| `bg-elevated` | `#161616` | Tool call blocks, áreas secundarias |
| `bg-statusbar` | `#1A1A1A` | Status bar |
| `bg-dropdown` | `#1C1C1C` | Dropdown de /comandos |
| `bg-item-active` | `#2A2A2A` | Ítem activo en dropdown |

### Texto

| Token | Hex | Uso |
|---|---|---|
| `text-primary` | `#F3F4F6` | Texto principal, mensajes usuario |
| `text-response` | `#D1D5DB` | Respuesta del agente |
| `text-muted` | `#9CA3AF` | Labels, metadata, descripciones |
| `text-faint` | `#6B7280` | Timestamps, output de tools, hints |
| `text-disabled` | `#4B5563` | Separadores, texto deshabilitado |
| `text-invisible` | `#374151` | Separadores de línea decorativos |

### Acento y Estado

| Token | Hex | Uso |
|---|---|---|
| `accent` | `#F59E0B` | Color principal: logo, prompts `❯❯`, tool names, labels Stratum |
| `accent-bright` | `#FBBF24` | Highlights en respuestas del agente |
| `accent-highlight` | `#FCD34D` | Términos importantes en respuestas |
| `success` | `#22C55E` | Tool completada `✓`, conexión activa `●` |
| `error` | `#EF4444` | Tool con error `✗`, desconexión `●` |
| `warning` | `#F97316` | Contexto alto (>85%), alertas |
| `code` | `#6EE7B7` | Inline code en respuestas del agente |

### Bordes

| Token | Hex | Uso |
|---|---|---|
| `border-subtle` | `#2A2A2A` | Tool call blocks, separadores |
| `border-medium` | `#374151` | Bordes de zona de input |
| `border-accent` | `#92400E` | Borde del ítem activo en dropdown |

---

## 7. Tipografía

**Fuente principal:** `monospace` del sistema. Ink renderiza en el terminal del usuario, por lo que la fuente depende de su configuración (Fira Code, JetBrains Mono, Cascadia Code, Menlo, Consolas...).

**Tamaños de texto** (en Ink, los tamaños son relativos y se expresan como número de caracteres o con `ink-text`):

| Elemento | Tamaño equivalente | Bold |
|---|---|---|
| ASCII art | 11px (pequeño para caber en 80 cols) | No |
| Label usuario/agente | 11px | No |
| Texto conversacional | 12px | No |
| Tool name en bloque | 11px | Sí |
| Output de tool | 11px | No |
| Status bar | 11px | No |

**Longitud de línea:** el contenido de la conversación se limita a `min(cols - 4, 100)` caracteres de ancho para mantener legibilidad. Las respuestas más largas hacen word-wrap automático de Ink.

---

## 8. Animaciones y Transiciones

| Animación | Elemento | Implementación | Duración |
|---|---|---|---|
| Typewriter ASCII art | Banner arranque | `setInterval` incrementando string | ~400ms total |
| Fade in tips/meta | Banner arranque | `opacity` 0→1 via estado React | 200ms |
| Cursor parpadeante | Input prompt `❯❯ _` | `setInterval` toggle visibility | 500ms on/off |
| Spinner tool running | Icono `◌` | Frames `◌◎●◉○`, `setInterval` | 150ms/frame |
| Timer tool running | Duración `Ns` | `setInterval` +0.1s | 100ms tick |
| Streaming text cursor | Respuesta agente | Carácter `█` al final | 500ms on/off |
| Toggle tool block | Expandir/colapsar | Sin animación, toggle inmediato | Instantáneo |
| Transición banner→chat | Estado completo | Desmontaje/montaje de componentes | Instantáneo |

**Principio:** las animaciones de "estado de carga" (spinner, streaming cursor, timer) son continuas mientras dura el estado. Las animaciones de "aparición de contenido" (typewriter, fade) ocurren una sola vez.

---

## 9. Comportamiento Responsive

El terminal puede tener distintos tamaños. Ink expone `useStdout()` con `columns` y `rows`.

### Ancho mínimo: 80 columnas

- ASCII art de 6 líneas × ~64 chars: cabe en 80 cols con padding mínimo.
- Si `columns < 72`: mostrar versión reducida del ASCII art (solo texto `STRATUM` sin box drawing).
- Si `columns < 60`: mostrar solo el texto `Stratum CLI v0.1.0` en lugar del ASCII art.

### Ancho estándar: 100-120 columnas

- Layout por defecto. Todo el contenido cabe sin truncar.

### Ancho amplio: >120 columnas

- El contenido de conversación sigue limitado a 100 chars de ancho.
- Los tool call blocks añaden más espacio para el input visible.

### Alto mínimo: 24 líneas

- Si `rows < 24`: reducir el banner (ocultar tips, mostrar solo ASCII + prompt).
- El área de conversación scrollable siempre mantiene al menos 10 líneas visibles.

### Redimensionado en caliente

Ink detecta `SIGWINCH` y re-renderiza. Los componentes deben usar `useStdout().columns` reactivamente y no hardcodear anchos.

---

## 10. Atajos de Teclado

| Atajo | Acción |
|---|---|
| `Enter` | Enviar mensaje / seleccionar en dropdown |
| `↑ / ↓` | Navegar historial de mensajes en input (igual que shell) / navegar dropdown |
| `Esc` | Cerrar dropdown de /comandos / cancelar input |
| `Ctrl+C` | Interrumpir respuesta del agente en curso (graceful cancel) |
| `Ctrl+C` × 2 | Salir del CLI (si no hay respuesta en curso: salir directamente) |
| `Ctrl+L` | Clear screen (equivalente a `/clear`) |
| `Ctrl+U` | Borrar línea de input actual |
| `Tab` | Autocompletar /comando actual |
| `Space` | En un tool call block seleccionado: expandir/colapsar |
| `PgUp / PgDn` | Scroll en el historial de conversación |

---

## 11. Mapeo a Componentes Ink

```
<App>                           → Root. Gestiona el estado global (banner vs conversación)
  <Banner>                      → Estado A. Typewriter + tips + prompt inicial
    <ASCIIArt text={ART} />     → Renderiza el arte carácter a carácter
    <QuickStart />              → Sección de tips
    <BannerInput onSend={...}/> → Input inicial que dispara transición
  </Banner>

  <ConversationView>            → Estado B. Layout flex column full-height
    <StatusBar                  → 1 línea fija arriba
      provider={...}
      model={...}
      contextUsed={...}
      contextMax={...}
    />
    <MessageList>               → Área scrollable. Mapea AgentEvent[] a componentes
      <UserMessage text={...}/> → Mensaje del usuario
      <AgentMessage>            → Turno del agente (puede tener tools + texto)
        <ToolCallBlock          → Bloque de tool call con estado
          id={...}
          name={...}
          status={'running'|'completed'|'error'}
          input={...}
          output={...}
          duration={...}
        />
        <StreamingText          → Texto del agente, cursor parpadeante al final
          text={...}
          streaming={boolean}
        />
      </AgentMessage>
    </MessageList>
    <InputArea                  → Input fijo abajo
      onSend={...}
      disabled={agentThinking}
      commands={COMMAND_LIST}
    />
  </ConversationView>
</App>
```

**Gestión de estado:** `useReducer` en `<App>` con un estado global que incluye:
- `phase: 'banner' | 'conversation'`
- `messages: Message[]`
- `events: AgentEvent[]`
- `sessionId: string`
- `provider: string`, `model: string`
- `contextTokens: number`, `contextMax: number`

**AgentEvent → Componente:** el `<MessageList>` consume el stream de `AgentEvent` y los reduce a la representación visual:
- `text_delta` → actualiza el último `<StreamingText>`
- `tool_call_start` → crea `<ToolCallBlock status="running">`
- `tool_call_ready` → actualiza el bloque con input completo
- `tool_result` → actualiza bloque a `status="completed"` con output y duración
- `tool_error` → actualiza bloque a `status="error"`
- `done` → quita cursor de streaming, habilita input

---

## 12. Consideraciones Windows vs Linux

| Aspecto | Linux / macOS | Windows (PowerShell / CMD) |
|---|---|---|
| Box drawing chars (╗ ║ ╔ etc.) | Soporte pleno en terminales modernas | Funciona en Windows Terminal y PowerShell 7+. En CMD antiguo puede no renderizar |
| Colores ANSI | Soporte nativo | Requiere Windows 10 1511+ (VT100 mode). `ink` lo habilita automáticamente |
| Cursor parpadeante | Soporte nativo | Funciona en Windows Terminal, puede variar en CMD |
| `SIGWINCH` (resize) | Nativo | Ink lo emula en Windows con polling de `process.stdout` |
| Clear screen (`\x1b[2J`) | Nativo | Funciona en Windows Terminal, no en CMD legacy |
| Fuente monospace | Depende del terminal del usuario | Recomendado: Cascadia Code (incluido en Windows Terminal) |

**Recomendación para usuarios Windows:** usar **Windows Terminal** (instalable desde la Microsoft Store) con perfil PowerShell 7+. El README del proyecto debe documentar esto como prerequisito recomendado.

**Fallback para terminales sin soporte de color**: Ink detecta automáticamente si el terminal soporta colores via `chalk`'s `supportsColor`. Si no hay soporte, la UI cae a modo texto plano sin colores pero manteniendo el layout.

---

*Documento generado: 2026-05-27 | Versión: 0.1.0-draft*
*Documento relacionado: [Definición del Proyecto](./STRATUM_PROJECT_DEFINITION.md)*
