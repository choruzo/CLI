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

El texto del banner aparece **carácter a carácter de izquierda a derecha, línea por línea**, emulando una impresora de alta velocidad. El ritmo es rápido (~4 chars por frame a 60fps) para que la animación dure ~400ms sin sentirse lenta.

**Importante:** Ink renderiza en terminal — no existe CSS ni `opacity`. Las "apariciones suaves" posteriores al typewriter se implementan con **color stepping**: el texto pasa de `text-invisible` (`#374151`) a su color final en 3-4 pasos de 50ms, cambiando el color vía `chalk`. No hay fade real, pero el efecto visual es suficientemente suave.

**Secuencia:**
```
t=0ms     → Pantalla en negro, cursor parpadeando
t=0ms     → Inicia el typewriter del ASCII art (4 chars por tick, ~60fps)
t=~400ms  → ASCII art completo en color accent (#F59E0B)
t=~400ms  → Versión + tagline aparece: #374151 → #4B5563 → #6B7280 (3 pasos × 50ms)
t=~550ms  → Sección de tips aparece: mismo color stepping
t=~700ms  → Prompt ❯❯ aparece con cursor parpadeante
```

**Implementación Ink — corrección de anti-patterns:**

El índice `i` debe vivir en un `useRef`, no en el closure de `setArtText`. Mutar una variable capturada dentro del actualizador de estado es un anti-pattern en React: `setState` puede ejecutarse de forma diferida y el closure captura el valor de `i` en el momento del `setInterval`, no en el momento de la ejecución.

```tsx
// src/cli/ui/Banner.tsx
type Phase = 'typing' | 'appearing' | 'ready';
const [phase, setPhase] = useState<Phase>('typing');
const [artText, setArtText] = useState('');
const indexRef = useRef(0);           // ← índice en useRef, no en closure

useEffect(() => {
  const chars = ASCII_ART.split('');
  const iv = setInterval(() => {
    const i = indexRef.current;
    if (i >= chars.length) {
      clearInterval(iv);
      setPhase('appearing');
      return;
    }
    // Avanza 4 caracteres por tick
    const chunk = chars.slice(i, i + 4).join('');
    setArtText(prev => prev + chunk);
    indexRef.current = i + 4;
  }, 16);
  return () => clearInterval(iv);
}, []);

// Color stepping para la aparición de tips/meta
useEffect(() => {
  if (phase !== 'appearing') return;
  const steps = ['#374151', '#4B5563', '#6B7280'];
  let step = 0;
  const iv = setInterval(() => {
    setSubtitleColor(steps[step]);
    if (++step >= steps.length) { clearInterval(iv); setPhase('ready'); }
  }, 50);
  return () => clearInterval(iv);
}, [phase]);
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

Scrollable verticalmente. Esta sección especifica la estrategia concreta de scroll, que es el punto más frágil de la UI dado que Ink no tiene scroll real de viewport.

#### Estrategia: ventana virtual de N líneas

`<MessageList>` no renderiza todos los mensajes del historial — mantiene una **ventana deslizante** de `viewportLines = terminalHeight × 3` líneas como máximo. Esto acota el trabajo de Ink independientemente del tamaño del historial.

**Anclaje al fondo (streaming):**
- Mientras `streaming = true`, la ventana se ancla automáticamente al último mensaje. Cualquier nuevo `text_delta` empuja la vista hacia abajo.
- El usuario no puede hacer scroll hacia arriba durante el streaming (PgUp se ignora). Cuando el streaming termina (`done`), el scroll se habilita.

**Navegación manual (post-streaming):**
- `PgUp` / `PgDn`: desplazan la ventana en incrementos de `terminalHeight - 2` líneas.
- `↓` hasta el final: re-ancla la vista al fondo.
- Un indicador discreto `↓ N líneas más` aparece en la esquina inferior derecha del área de conversación cuando hay contenido por debajo de la vista.

**Implementación:**
```typescript
// En <MessageList>:
const [scrollOffset, setScrollOffset] = useState(0);
const [anchored, setAnchored] = useState(true);

useInput((input, key) => {
  if (streaming) return;          // ignorar scroll durante streaming
  if (key.pageDown) setScrollOffset(o => Math.max(0, o - pageSize));
  if (key.pageUp)   setScrollOffset(o => o + pageSize);
});

// Al recibir text_delta mientras anchored === true:
// scrollOffset = 0 (siempre fondo)
```

Los mensajes fuera de la ventana no se desmontan — se excluyen del render calculando qué slice del array de líneas está dentro del offset visible.

#### Mensaje del usuario
```
  You
  ▏ texto del mensaje aquí
```
- Label `You`: `chalk.hex('#6B7280')` — texto atenuado (`dim`)
- Barra vertical `▏`: `chalk.hex('#374151')` — casi invisible, indica inicio del mensaje
- Texto: `chalk.hex('#E5E5E5')` — texto normal sin modificador

#### Respuesta del agente
```
  Stratum
  Texto de la respuesta que aparece en streaming...█
```
- Label `Stratum`: `chalk.hex('#F59E0B').bold` — acento en negrita
- Texto: `chalk.hex('#D1D5DB')` — texto normal sin modificador
- Cursor de streaming `█`: `chalk.hex('#F59E0B')`, toggle visible/invisible cada 500ms, desaparece al completar

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
- Icono `✓`: `chalk.hex('#22C55E')`
- Tool name: `chalk.hex('#F59E0B').bold`
- Duración: `chalk.hex('#6B7280')`
- Descripción del input: `chalk.hex('#6B7280')`
- Chevron `▸` / `▾`: indica colapsado / expandido
- **Borde en Ink:** usar la prop `borderStyle="single"` del componente `<Box>` de Ink con `borderColor="#2A2A2A"`. Ink renderiza box-drawing characters (`┌─┐│└┘`), no CSS. No hay fracciones de píxel.

#### Estado: `focused` (bloque seleccionado para toggle)
```
  ▶ ✓ read_file  │ 0.4s  │ src/agent/core.ts                        ▸
```
- Indicador `▶` a la izquierda: `chalk.hex('#F59E0B')` — muestra qué bloque tiene foco
- El bloque seleccionado cambia el borde a `borderColor="#F59E0B"` (ámbar)
- Ver §10 para los atajos de navegación entre bloques

#### Estado: `error` (error recuperable)
```
  ✗ bash  │ 0.8s  │ permission denied                              ▸
```
- Icono `✗`: `chalk.hex('#EF4444')`
- Tool name: `chalk.hex('#FCA5A5')` — rojo atenuado
- Descripción del error: `chalk.hex('#FCA5A5').dim`

#### Estado expandido (toggle con `Space` sobre el bloque enfocado)
```
  ✓ read_file  │ 0.4s  │ src/agent/core.ts                          ▾
  ┌────────────────────────────────────────────────────────────┐
  │ → 284 lines read                                           │
  │ → EventEmitter instances at lines 43, 89, 156             │
  │ → setInterval at line 201 (no clearInterval found)        │
  └────────────────────────────────────────────────────────────┘
```
- Borde del área expandida: `borderStyle="single"`, `borderColor="#2A2A2A"` — Ink box-drawing characters
- Texto de output: `chalk.hex('#6B7280').dim` — atenuado, monospace del terminal
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
- El dropdown se renderiza como un bloque `<Box>` con `borderStyle="single"` y `borderColor="#2A2A2A"` — box-drawing characters (`┌─┐│└┘`). No hay `border-radius` en terminal.
- Ítem activo: texto en `chalk.hex('#F59E0B').bold`, prefijado con `▶`
- Ítem inactivo: `chalk.hex('#9CA3AF')`
- Navegación: flechas `↑↓`, selección `Enter`, cancelar `Esc`

**Modo waiting (agente procesando):**
- Prompt `❯❯` en gris `#4B5563` (deshabilitado)
- Placeholder: `Stratum is thinking...` en gris oscuro
- Input bloqueado hasta que el agente emita `done`

#### Lista completa de /comandos

| Comando | Descripción |
|---|---|
| `/help` | Lista todos los comandos disponibles con descripción |
| `/clear` | Purga el área de conversación **y** el historial de mensajes enviado al LLM. El agente pierde todo el contexto previo. La sesión sigue activa (mismo `sessionId`) pero arranca con contexto vacío. Equivalente a empezar un chat nuevo sin salir del proceso. |
| `/quit` o `/exit` | Termina la sesión, guarda el historial |
| `/memory list` | Lista las decisiones almacenadas |
| `/memory search <query>` | Búsqueda semántica en decisiones |
| `/memory forget <id>` | Elimina una decisión por ID |
| `/memory show` | Muestra el contenido del STRATUM.md activo |
| `/sessions list` | Lista sesiones guardadas |
| `/sessions resume <id>` | Carga una sesión anterior y la continúa en el chat actual. Equivalente a salir y ejecutar `stratum sessions resume <id>` desde la terminal — las tres formas hacen exactamente lo mismo. |
| `/plan` | Activa modo plan-and-execute para el próximo mensaje |
| `/provider <name>` | Cambia el proveedor activo en caliente |
| `/model <name>` | Cambia el modelo activo en caliente |
| `/tools` | Lista las tools disponibles (built-in + MCP) |
| `/context` | Muestra estadísticas de uso del contexto actual |
| `/debug` | Toggle del modo debug (muestra chunks SSE raw) |

### 5.3 Renderizado de Markdown en Respuestas del Agente

Las respuestas del agente contienen markdown (encabezados, código, listas, negritas…). Renderizarlas como texto plano degrada la legibilidad. Esta sección define el sistema de renderizado.

#### Estrategia: Dual-mode

| Fase | Componente | Comportamiento |
|---|---|---|
| `streaming = true` | `<StreamingText>` | Texto plano + cursor `█`. Sin parseo. El LLM puede emitir tokens de markdown incompletos (un ` ``` ` sin cerrar rompe cualquier parser). |
| `streaming = false` | `<MarkdownText>` | Re-render completo con markdown parseado. El salto visual coincide exactamente con la desaparición del cursor — el usuario no lo percibe como un flash. |

La transición es el propio evento `done` del `AgentEvent`: cuando `streaming` pasa a `false`, `<AgentMessage>` desmonta `<StreamingText>` y monta `<MarkdownText>` con el mismo `text`. Ambos componentes reciben la misma prop — el intercambio es transparente.

**Nota de rendimiento:** el swap es síncrono (ocurre en el mismo tick que el evento `done`). En la práctica, `marked.lexer()` sobre textos de hasta ~5 000 caracteres es imperceptible en Node.js. Si durante el desarrollo se observa un flash visible en respuestas más largas, diferir el swap con `setImmediate(() => setStreaming(false))` es suficiente — no se define un umbral fijo en v1.

#### Librería: `marked` + renderizado manual a componentes Ink

**No** se usa `marked-terminal` (inserta ANSI strings raw que colisionan con el layout de Ink v4+). **No** se usa `ink-markdown` (abandonado desde 2019).

El enfoque es: `marked.lexer(text)` produce el token tree; un renderer propio mapea cada token a componentes `<Text>` y `<Box>` de Ink con los props correctos.

```
src/cli/ui/
├── MarkdownText.tsx          ← componente raíz, recibe `text: string`
└── markdown/
    ├── renderTokens.tsx      ← función recursiva: Token[] → JSX.Element[]
    ├── CodeBlock.tsx         ← bloque de código con highlight + box bordeado
    └── InlineCode.tsx        ← código inline con color `code` (#6EE7B7)
```

#### Elementos soportados (v1)

| Elemento Markdown | Renderizado Ink |
|---|---|
| `# H1` | `<Text bold color={accent}>` + separador `─────` debajo |
| `## H2` | `<Text bold color={accent}>` (sin separador) |
| `### H3` | `<Text bold color={textMuted}>` |
| `**negrita**` | `<Text bold>` |
| `*cursiva*` | `<Text italic>` |
| `` `inline code` `` | `<InlineCode>` → `<Text color="#6EE7B7">` (token `code` de la paleta) |
| ` ```lang\n...\n``` ` | `<CodeBlock>` → box bordeado + `cli-highlight` para sintaxis |
| `- item` / `* item` | `<Text>• item</Text>` con `marginLeft={2}` |
| `1. item` | `<Text>N. item</Text>` con `marginLeft={2}` |
| `> blockquote` | `<Box borderLeft>` con borde `│` en `textDisabled` + texto en `textFaint` |
| `---` | Línea de `─` hasta `min(cols - 4, 100)` chars, color `textDisabled` |
| Párrafos | `<Text wrap="wrap" color={textResponse}>` con `marginBottom={1}` |

**Elementos no soportados en v1** (se renderizan como texto plano sin parsear): tablas, imágenes, HTML inline, footnotes, task lists. Se añadirán en iteraciones posteriores si el uso lo justifica.

#### Especificación de `<CodeBlock>`

```
  ┌─ typescript ────────────────────────────────────────────────────┐
  │ const agent = new StratumAgent(config);                         │
  │ await agent.run('analiza este repo');                            │
  └─────────────────────────────────────────────────────────────────┘
```

- Borde: `borderStyle="single"`, `borderColor="#2A2A2A"` (`border-subtle`)
- Header de lenguaje: ` typescript ` en `chalk.hex('#6B7280').dim` — solo si el bloque especifica lenguaje. Si no hay lenguaje, no se muestra header.
- Contenido: procesado con `cli-highlight` (paquete `cli-highlight`). Si el lenguaje no es reconocido por `cli-highlight`, se muestra texto plano sin color.
- Padding: `paddingLeft={1}` y `paddingRight={1}` en el `<Box>` interno.
- Ancho máximo: el mismo límite global de `min(cols - 4, 100)` chars. El código no hace word-wrap — si una línea supera el ancho, se trunca con `…` al final.
- Máximo de líneas visibles: sin límite (a diferencia del output de tools, el código del agente se muestra completo).

#### Especificación de `<InlineCode>`

```tsx
// InlineCode.tsx
<Text color={theme.code}>{children}</Text>   // theme.code = '#6EE7B7'
```

Sin caja, sin borde — solo un cambio de color que distingue visualmente el token del texto circundante. Compatible con el flow de `<Text wrap="wrap">` del párrafo padre.

#### Nota de implementación — renderTokens.tsx

`marked.lexer()` devuelve tokens de tipo `Token[]`. Algunos tokens tienen hijos (`tokens` anidados para inline content dentro de un párrafo o list item). La función `renderTokens` es recursiva:

```tsx
function renderTokens(tokens: marked.Token[], key = 0): JSX.Element[] {
  return tokens.map((token, i) => {
    const k = `${key}-${i}`;
    switch (token.type) {
      case 'heading':   return <HeadingBlock key={k} depth={token.depth} tokens={token.tokens} />;
      case 'paragraph': return <ParagraphBlock key={k} tokens={token.tokens} />;
      case 'code':      return <CodeBlock key={k} lang={token.lang} text={token.text} />;
      case 'list':      return <ListBlock key={k} ordered={token.ordered} items={token.items} />;
      case 'blockquote':return <QuoteBlock key={k} tokens={token.tokens} />;
      case 'hr':        return <HRBlock key={k} />;
      case 'strong':    return <Text key={k} bold>{renderInline(token.tokens)}</Text>;
      case 'em':        return <Text key={k} italic>{renderInline(token.tokens)}</Text>;
      case 'codespan':  return <InlineCode key={k}>{token.text}</InlineCode>;
      case 'text':      return <Text key={k}>{token.text}</Text>;
      default:          return <Text key={k}>{token.raw}</Text>; // fallback plano
    }
  });
}
```

El `default` como fallback garantiza que ningún elemento no soportado rompa el render — simplemente se muestra el markdown raw.

#### Dependencias añadidas

```json
{
  "marked": "^12.0.0",       // parser markdown → token tree
  "cli-highlight": "^2.1.11" // syntax highlighting ANSI para code blocks
}
```

`marked` es zero-dependency y esm-compatible. `cli-highlight` produce strings ANSI que Ink renderiza correctamente dentro de un `<Text>` (a diferencia de `marked-terminal`, que toca el layout de Ink al envolver párrafos completos).

---

## 6. Paleta de Colores

La paleta es **fija** (no adapta light/dark mode — es una terminal UI, siempre oscura).

### Compatibilidad de colores y niveles de degradación

Todos los colores se especifican en hex (truecolor, 24-bit). Chalk detecta automáticamente el nivel de soporte del terminal con `chalk.level`:

| `chalk.level` | Soporte | Comportamiento |
|---|---|---|
| `3` (truecolor) | Windows Terminal, iTerm2, VS Code, Warp | Colores hex exactos — paleta completa |
| `2` (256 colores) | Terminales modernas sin truecolor | Chalk degrada automáticamente al color ANSI-256 más cercano |
| `1` (16 colores básicos) | Terminales legacy, SSH básico | Chalk mapea al color básico más cercano. El ámbar se convierte en `yellow`, el verde en `green`, etc. |
| `0` (sin color) | TTY no interactivo, `NO_COLOR=1` | Sin colores, solo texto plano. Layout sigue siendo correcto. |

**No se definen paletas de fallback manuales.** Chalk gestiona la degradación automáticamente. El objetivo son terminales de nivel 2 o superior. Nivel 1 es aceptable pero la experiencia visual es limitada — documentarlo en el README como advertencia, no como bloqueo.

**Detección en código:**
```tsx
import chalk from 'chalk';
// chalk.level se establece automáticamente al importar
// Si se necesita override: new Chalk({ level: 3 })
```

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

**Fuente principal:** la del terminal del usuario (Fira Code, JetBrains Mono, Cascadia Code, Menlo, Consolas...). Ink no controla la fuente — renderiza caracteres normales a stdout.

**Importante:** en Ink no existe el concepto de "tamaño de fuente en px". Todos los caracteres tienen el mismo tamaño. Los únicos modificadores tipográficos disponibles son los que proporciona `chalk`: `bold`, `dim`, `italic`, `underline`, `strikethrough`. No hay `font-size`.

**Modificadores por elemento:**

| Elemento | Modificador chalk | Equivalente visual |
|---|---|---|
| ASCII art | ninguno | Normal, color ámbar |
| Label `You` | `.dim` | Más apagado que el texto |
| Label `Stratum` | `.bold` | Más prominente que el texto |
| Texto conversacional | ninguno | Normal |
| Tool name en bloque | `.bold` | Prominente |
| Output de tool | `.dim` | Apagado, secundario |
| Status bar | `.dim` en labels, ninguno en valores | Contraste bajo/alto |
| Separadores de línea | `.dim` | Casi invisibles |
| Texto deshabilitado | `.dim` | Atenuado |

**Longitud de línea:** el contenido de la conversación se limita a `min(cols - 4, 100)` caracteres de ancho para mantener legibilidad. Las respuestas más largas hacen word-wrap automático de Ink.

---

## 8. Animaciones y Transiciones

| Animación | Elemento | Implementación | Duración |
|---|---|---|---|
| Typewriter ASCII art | Banner arranque | `setInterval` + `useRef` para índice, 4 chars/tick | ~400ms total |
| Aparición tips/meta | Banner arranque | Color stepping: `#374151 → #4B5563 → #6B7280`, 3 pasos × 50ms | ~150ms |
| Cursor parpadeante | Input prompt `❯❯ _` | `setInterval` toggle visible/invisible | 500ms on/off |
| Spinner tool running | Icono `◌` | Frames `◌◎●◉○`, `setInterval` | 150ms/frame |
| Timer tool running | Duración `Ns` | `setInterval` +0.1s | 100ms tick |
| Streaming text cursor | Respuesta agente | Carácter `█` al final | 500ms on/off |
| Toggle tool block | Expandir/colapsar | Sin animación, toggle inmediato | Instantáneo |
| Transición banner→chat | Estado completo | Desmontaje/montaje de componentes | Instantáneo |
| StreamingText → MarkdownText | Respuesta completada | Desmontaje de `<StreamingText>` + montaje de `<MarkdownText>` al recibir evento `done`. Sin delay adicional — la transición ocurre en el mismo tick que la desaparición del cursor. | Instantáneo |

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
| `↑ / ↓` | Navegar historial de inputs enviados en la sesión actual (igual que shell) / navegar dropdown. El historial vive en memoria (`string[]` en el estado de `<InputArea>`); no persiste entre sesiones. |
| `Esc` | Cerrar dropdown de /comandos / cancelar input |
| `Ctrl+C` | Interrumpir respuesta del agente en curso (graceful cancel) |
| `Ctrl+C` × 2 | Salir del CLI (si no hay respuesta en curso: salir directamente) |
| `Ctrl+L` | Clear screen (equivalente a `/clear`) |
| `Ctrl+U` | Borrar línea de input actual |
| `Tab` | Autocompletar /comando actual / mover foco al siguiente tool call block |
| `Shift+Tab` | Mover foco al tool call block anterior |
| `Space` | En un tool call block enfocado: expandir/colapsar output |
| `Esc` (fuera de input) | Quitar foco del tool call block seleccionado |
| `PgUp / PgDn` | Scroll en el historial de conversación |

**Máquina de estados de foco** (resuelve la ambigüedad de `Tab` y `Esc`):

```
        ┌─────────────────────────────────────────────────────────┐
        │                       input                             │
        │  Tab (con texto /) → dropdown                           │
        │  Tab (sin / activo) → block-focus (si hay bloques)      │
        └────────────┬────────────────────────────────────────────┘
                     │
         ┌───────────┴────────────┐
         ▼                        ▼
    dropdown                 block-focus
  Tab / Enter: selecciona   Tab / Shift+Tab: mueve entre bloques
  Esc: → input              Space: expande/colapsa
                            Esc: → input
```

| Estado actual | Tecla | Acción |
|---|---|---|
| `input` | `Tab` (con `/` en input) | → `dropdown` |
| `input` | `Tab` (sin `/` activo) | → `block-focus` (si hay bloques en pantalla) |
| `input` | `Esc` | Sin efecto |
| `dropdown` | `Tab` / `Enter` | Selecciona opción, → `input` |
| `dropdown` | `Esc` | Cierra dropdown, → `input` |
| `block-focus` | `Tab` / `Shift+Tab` | Mueve foco entre bloques |
| `block-focus` | `Space` | Expande/colapsa bloque enfocado |
| `block-focus` | `Esc` | Quita foco, → `input` |

El estado de foco vive en el `useReducer` global como `focusState: 'input' | 'dropdown' | 'block-focus'`. **Nunca hay ambigüedad**: `Esc` con dropdown abierto cierra el dropdown (→ `input`); `Esc` con bloque enfocado quita el foco (→ `input`); los dos casos son mutuamente excluyentes porque `dropdown` y `block-focus` no pueden estar activos simultáneamente.

**Navegación de tool call blocks:** `Tab` / `Shift+Tab` mueven el foco (indicado con `▶` y borde ámbar) entre los bloques del turno actual. `Space` expande/colapsa el bloque enfocado. `Esc` devuelve el foco al input. Si no hay ningún bloque enfocado, `Tab` autocompleta el /comando en el input (comportamiento por defecto).

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
        {streaming
          ? <StreamingText      → Durante streaming: texto plano + cursor parpadeante
              text={...}
              streaming={true}
            />
          : <MarkdownText       → Tras evento `done`: texto parseado con marked + Ink components
              text={...}
            />
        }
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
- `messages: Message[]` — historial enviado al LLM en cada request
- `events: AgentEvent[]` — eventos del turno actual para renderizado
- `sessionId: string`
- `provider: string`, `model: string`
- `contextTokens: number`, `contextMax: number`
- `focusState: 'input' | 'dropdown' | 'block-focus'` — ver §10

**Acción `/clear` en el reducer:** despacha `{ type: 'CLEAR' }`, que reinicia tanto `messages: []` como `events: []`. El `sessionId` se mantiene; el agente pierde todo el contexto conversacional anterior. `Ctrl+L` despacha la misma acción.

**AgentEvent → Componente:** el `<MessageList>` consume el stream de `AgentEvent` y los reduce a la representación visual:

| Evento | Componente / Acción |
|---|---|
| `text_delta` | Actualiza el último `<StreamingText>` con el delta acumulado |
| `tool_call_start` | Crea `<ToolCallBlock status="running">` con spinner activo |
| `tool_call_ready` | Actualiza el bloque con input parseado completo |
| `tool_result` | Actualiza bloque a `status="completed"` con output y duración |
| `tool_error` | Actualiza bloque a `status="error"` con mensaje |
| `memory_retrieved` | Renderiza una línea dim `↺ N decisiones recuperadas de memoria` justo antes del siguiente `<AgentMessage>`. Si `decisions.length === 0`, no se renderiza nada. |
| `thinking` | **No se renderiza por defecto.** Solo visible en modo `--debug`: se muestra como un bloque `<Box>` colapsado con borde dim y prefijo `⊙ thinking`. |
| `error { fatal: false }` | Igual que `tool_error` — el loop continúa, el error es parte del flujo normal. |
| `error { fatal: true }` | Renderiza `<FatalError>`: bloque con borde rojo, icono `✗`, mensaje de error y sugerencia de acción. El input queda permanentemente bloqueado. Se emite el evento `done` con `stopReason: 'error'` (valor incluido en el enum de `AgentEvent.done` — ver §12.1 de `STRATUM_PROJECT_DEFINITION.md`). |
| `done` | Quita el cursor de streaming del último `<StreamingText>` y lo reemplaza con `<MarkdownText>` (re-render con markdown formateado). Habilita el input. Actualiza la sesión guardada. Ver [§5.3 — Renderizado de Markdown](./STRATUM_UI_SPECIFICATION.md#53-renderizado-de-markdown-en-respuestas-del-agente). |

**Componente `<FatalError>`:**
```
  ┌─────────────────────────────────────────────────────────────┐
  │ ✗  Error fatal — el agente no puede continuar               │
  │                                                             │
  │  LLM connection lost: ECONNREFUSED localhost:11434          │
  │  Verifica que Ollama esté en ejecución: ollama serve        │
  └─────────────────────────────────────────────────────────────┘
```
- Borde: `borderStyle="single"`, `borderColor="#EF4444"`
- Título: `chalk.hex('#EF4444').bold`
- Mensaje: `chalk.hex('#FCA5A5')`
- Sugerencia: `chalk.hex('#6B7280').dim`

---

## 12. Componente de Confirmación Destructiva

Cuando el `ToolDispatcher` detecta que una tool tiene `destructive: true`, pausa la ejecución y renderiza un bloque de confirmación **entre el área de conversación y el input**. El input queda bloqueado hasta que el usuario responda.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⚠  Operación destructiva                                             │
│                                                                      │
│  bash: rm -rf /var/log/app/*.log                                     │
│                                                                      │
│  ¿Continuar? [ S ] continuar  [ N ] cancelar  [ ! ] permitir todo   │
└──────────────────────────────────────────────────────────────────────┘
  ❯❯ _  (bloqueado)
```

- Borde: `borderStyle="single"`, `borderColor="#F59E0B"` — ámbar de advertencia
- Icono `⚠`: `chalk.hex('#F59E0B').bold`
- Título: `chalk.hex('#F59E0B').bold`
- Comando: `chalk.hex('#F3F4F6')` — visible claramente para que el usuario sepa qué va a ejecutarse
- Opciones: `[ S ]` en ámbar, `[ N ]` en rojo, `[ ! ]` en naranja

### Opciones disponibles

| Tecla | Acción |
|---|---|
| `S` / `Y` / `Enter` | Aprobar esta tool y continuar |
| `N` / `Esc` | Cancelar esta tool (se inyecta como `tool_error` recuperable) |
| `!` | Activar modo `--allow-destructive` para el resto de la sesión (sin más confirmaciones) |

### Posicionamiento

El componente `<DestructiveConfirm>` se renderiza como un hijo de `<ConversationView>`, entre `<MessageList>` y `<InputArea>`. Su altura es fija (4 líneas + bordes = 6 líneas). Cuando está visible, el área scrollable de conversación se reduce en esas 6 líneas. Cuando se responde, el componente se desmonta y el espacio se libera.

El bloque **no desplaza** el historial de mensajes — el scroll permanece donde estaba.

### Componente Ink

```tsx
<ConversationView>
  <StatusBar ... />
  <MessageList ... />              ← altura = rows - statusBar - confirmHeight - inputHeight
  {pendingConfirm && (
    <DestructiveConfirm           ← aparece entre MessageList e InputArea
      command={pendingConfirm.command}
      toolName={pendingConfirm.name}
      onApprove={() => dispatch({ type: 'CONFIRM_TOOL' })}
      onDeny={() => dispatch({ type: 'DENY_TOOL' })}
      onAllowAll={() => dispatch({ type: 'ALLOW_ALL_DESTRUCTIVE' })}
    />
  )}
  <InputArea disabled={!!pendingConfirm} ... />
</ConversationView>
```

---

## 13. Modo `stratum run` — Salida Plain Text

`stratum run "tarea"` es modo **one-shot no interactivo**. No usa Ink. La salida va directamente a `stdout` como texto plano, haciendo el comando compatible con pipes, redirecciones y entornos CI.

**Principio:** `stratum chat` es para humanos. `stratum run` es para máquinas.

### Formato de salida

```bash
$ stratum run "lista los archivos TypeScript en src/ y cuenta cuántos hay"

[tool] read_file: src/
[tool] bash: find src/ -name "*.ts" | wc -l  (0.3s)
[result] Hay 24 archivos TypeScript en src/.
```

| Elemento | Formato | Canal |
|---|---|---|
| Tool call ejecutada | `[tool] nombre: input_resumido` | `stderr` |
| Tool completada con duración | `[tool] nombre: input  (Xs)` | `stderr` |
| Tool con error | `[error] nombre: mensaje de error` | `stderr` |
| Respuesta final del agente | Texto plano sin prefijo | `stdout` |
| Error fatal | `[fatal] mensaje` seguido de `exit 1` | `stderr` |

**Las tool calls van a `stderr`** para que la respuesta final del agente sea la única salida en `stdout`. Esto permite:
```bash
stratum run "genera un resumen del repo" > resumen.md
stratum run "extrae los imports de main.ts" | jq .
```

### Colores en `stratum run`

- Si `stdout` es un TTY (uso directo en terminal): los prefijos `[tool]`, `[error]`, `[fatal]` se colorean con chalk si el nivel lo permite.
- Si `stdout` no es TTY (pipe, redirección): chalk desactiva los colores automáticamente (`chalk.level = 0`). La salida es texto limpio.

### Confirmación destructiva en `stratum run`

Según lo definido en `§12.5` de `STRATUM_PROJECT_DEFINITION.md`:
- Sin flags: pausa y muestra prompt `¿Continuar? (S/N)` en `stderr`
- `--allow-destructive`: aprueba todas sin prompt
- `--deny-destructive`: rechaza todas, el agente recibe el error y busca alternativa
- Si no hay TTY disponible (CI/pipe): se comporta como `--deny-destructive` automáticamente

---

## 14. Estado de Arranque — Conexión MCP Servers

Al iniciar `stratum chat`, los MCP servers se conectan de forma eager (§12.8 de `STRATUM_PROJECT_DEFINITION.md`). Si hay servers configurados, esta fase puede durar varios segundos. Se renderiza en el banner, antes de que el prompt `❯❯` aparezca.

### Layout durante el arranque

```
   ╔═══════════════════════════════════════╗
   ║           (ASCII art STRATUM)         ║
   ╚═══════════════════════════════════════╝

   Conectando servicios...
   ✓ filesystem  (120ms)
   ◌ github      (conectando...)
   ○ docker      (en cola)
```

- Título `Conectando servicios...`: `chalk.hex('#6B7280').dim`
- Server completado `✓`: `chalk.hex('#22C55E')` + nombre + duración en dim
- Server conectando `◌`: spinner animado en ámbar + nombre
- Server en cola `○`: `chalk.hex('#4B5563')` + nombre
- Server con error `✗`: `chalk.hex('#EF4444')` + nombre + `(no disponible)`

### Comportamiento

- La sección de MCP startup aparece **debajo del ASCII art**, en el mismo estado A (banner), antes de mostrar los tips y el prompt.
- El prompt `❯❯` y los tips solo aparecen una vez que **todos los servers han terminado** (conectado o fallado).
- Si no hay servers configurados, esta sección no se renderiza (el banner va directo a los tips).
- Si un server tarda más de 5 segundos, se marca como `(timeout)` en rojo y se continúa.

### Componente Ink

```tsx
// Fase de arranque: antes del phase 'ready' del banner
{mcpServers.length > 0 && phase === 'connecting' && (
  <MCPStartup servers={mcpServers} onAllSettled={() => setPhase('typing')} />
)}
```

---

## 15. Consideraciones Windows vs Linux

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

*Documento generado: 2026-05-27 | Versión: 0.3.0-draft | Revisión: correcciones de compatibilidad Ink/terminal, nuevas secciones §12–§14; §5.3 Renderizado de Markdown (dual-mode, marked + Ink components, CodeBlock, InlineCode)*
*Documento relacionado: [Definición del Proyecto](./STRATUM_PROJECT_DEFINITION.md)*
