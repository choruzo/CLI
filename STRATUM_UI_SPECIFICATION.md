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
│  ◌ exec       │ 1.2s │ grep -c "\.on(" src/agent/core.ts               │  ← TOOL CALL (running)
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
| `+N/-M` | Cambios del working tree acumulados (Hito 13). Solo con árbol sucio, repo git y ancho >= 80 columnas | Ámbar `#F59E0B` |
| (espacio flexible) | Empuja los elementos de contexto a la derecha | — |
| `Σ N.Nk` | Tokens consumidos en la sesión (Hito 13). Solo con ancho >= 100 columnas y dato **reportado** por el backend; si el backend no devuelve `usage` se pinta `Σ n/d`, y mientras no haya dato todavía no se pinta nada. Nunca se estima | Gris `#9CA3AF` |
| `ctx N.Nk / NNk` | Estimación de tokens usados / máximo del modelo | Gris `#9CA3AF` |
| `│` | Separador vertical | Gris oscuro `#374151` |
| `NN%` | Porcentaje de contexto usado. Verde < 60%, ámbar 60-85%, rojo > 85% | Variable |
| `⬢ entorno target` | Contexto activo (Hito 17, §5.10): entorno del último target donde se ejecutó algo. Con ancho < 100 solo el entorno. Sin entorno que case, no se pinta | Rojo `#EF4444` en `production`, ámbar en `staging`, gris en `development` |
| `RO` | Sesión read-only (Hito 17) | Ámbar `#F59E0B`, negrita |
| `⬡ perfil` | Perfil de sesión cuando no es `code` (Hito 17) | Gris `#9CA3AF` |

### 4.2 Área de Conversación

Scrollable verticalmente. Esta sección especifica la estrategia concreta de scroll, que es el punto más frágil de la UI dado que Ink no tiene scroll real de viewport.

#### Estrategia: `<Static>` + scrollback nativo del terminal

**El scroll del historial lo hace el terminal, no la aplicación.** `<MessageList>` reparte los turnos en tres zonas:

```
<Static items={completados.slice(0, -1)}>   ← impresos una sola vez, salen del árbol de render
{ultimoCompletado}                          ← dinámico: Tab/Space siguen funcionando tras `done`
{itemActual}                                ← turno en streaming
```

- Los turnos cerrados se emiten con `<Static>` de Ink: se escriben una única vez al stdout y pasan al **scrollback nativo** del terminal. Ink deja de repintarlos, así que el coste de render es constante por muy larga que sea la conversación.
- El **último turno completado** se mantiene fuera de `<Static>` a propósito: es el que el usuario navega con `Tab` y expande con `Space` (§5.1) justo después de recibir `done`. Cuando llega un turno nuevo, el anterior pasa a `<Static>` de forma natural.
- El turno en curso se repinta con cada `text_delta`.

**Consecuencias deliberadas:**
- No hay ventana virtual, ni `scrollOffset`, ni manejo de `PgUp`/`PgDn` en la aplicación: esas teclas las gobierna el terminal, junto con la rueda del ratón y la barra de scroll.
- El historial completo se puede **seleccionar y copiar** con el ratón, porque es texto real del terminal y no un viewport redibujado.
- No existe el indicador `↓ N líneas más`: la aplicación no conoce ni controla la posición del scroll.
- `/clear` y `Ctrl+L` no pueden "desimprimir" lo ya volcado al scrollback, así que además de vaciar el estado emiten la secuencia de borrado de pantalla (`\x1b[2J\x1b[3J\x1b[H`) — ver §5.2.

**Ancho del contenido** (§9): el área se limita a 100 columnas en terminales más anchas (`resolveLayout` en `cli/ui/layout.ts`).

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
  ◌ exec  │ 1.2s  │ grep -c "\.on(" src/agent/core.ts
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
  ✗ exec  │ 0.8s  │ permission denied                              ▸
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

El área de input tiene tres modos:

**Modo normal:**
- Prompt `❯❯` en ámbar `#F59E0B`
- Texto de entrada: blanco `#F3F4F6`
- Placeholder: `Type a message or / for commands...` en gris `#4B5563`

**Modo /comando:**

Al escribir `/` aparece inmediatamente un panel de autocompletado **encima** del input. El panel ocupa el ancho completo del terminal y muestra hasta 8 ítems antes de hacer scroll. Se filtra en tiempo real conforme el usuario sigue escribiendo (ej. `/mem` filtra a los cuatro comandos `/memory *`).

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │ ▶ /clear          Purga la conversación y el contexto del LLM       │
  │   /compact        Fuerza la compresión de contexto ahora            │
  │   /config get     Muestra el valor de una clave de configuración    │
  │   /config set     Cambia una clave de configuración en caliente     │
  │   /context        Estadísticas de uso del contexto actual           │
  └─────────────────────────────────────────────────────────────────────┘
  ❯❯ /c|
```

**Layout del panel:**
- El panel se renderiza como `<Box flexDirection="column">` posicionado con `marginBottom={1}` respecto al input — siempre visible encima, nunca solapa el texto del historial.
- Borde: `borderStyle="single"`, `borderColor="#2A2A2A"`.
- Dos columnas fijas separadas por dos espacios: comando (ancho fijo al comando más largo del set filtrado) + descripción (resto del ancho disponible, truncada con `…` si no cabe).
- Ítem activo: nombre del comando en `chalk.hex('#F59E0B').bold`, prefijado con `▶`, descripción en `chalk.hex('#D1D5DB')`.
- Ítem inactivo: nombre en `chalk.hex('#9CA3AF')`, descripción en `chalk.hex('#4B5563')`.
- Si los ítems filtrados superan 8, se muestra un indicador de scroll `↑↓ para navegar` en la última línea del panel en gris `#4B5563`.

**Filtrado:**
- La búsqueda coincide con cualquier parte del nombre del comando (substring match), no solo el prefijo. Ej. `/mem` filtra `/memory *`, pero `/show` también muestra `/memory show`.
- Si el input no coincide con ningún comando (ej. `/xyzxyz`), el panel se oculta — no se muestra vacío.
- Al seleccionar un comando con subcomandos (`/memory`, `/sessions`, `/config`), el texto del input se reemplaza por el prefijo elegido y el panel se actualiza al siguiente nivel (ej. seleccionar `/memory` → input muestra `/memory `, panel filtra a `list`, `search`, `forget`, `show`).

**Navegación:**
- `↑↓` — mueve la selección; al llegar al extremo, hace wrap.
- `Enter` — completa el comando en el input. Si el comando no tiene argumentos, lo ejecuta directamente.
- `Tab` — igual que `Enter` para completar (consistente con el modelo mental de shell).
- `Esc` — cierra el panel, el texto escrito permanece en el input.

**Modo waiting (agente procesando):**
- Prompt `❯❯` en gris `#4B5563` (deshabilitado)
- Placeholder: `Stratum is thinking...` en gris oscuro
- Input bloqueado hasta que el agente emita `done`

#### Lista completa de /comandos

| Comando | Descripción |
|---|---|
| `/help` | Lista todos los comandos disponibles con descripción |
| `/init` | Escanea el proyecto y genera o actualiza `STRATUM.md`. Ver [§12.13 de STRATUM_PROJECT_DEFINITION.md](./STRATUM_PROJECT_DEFINITION.md#1213----comando-init-y-stratum-init). |
| `/clear` | Purga el área de conversación **y** el historial de mensajes enviado al LLM. El agente pierde todo el contexto previo. La sesión sigue activa (mismo `sessionId`) pero arranca con contexto vacío. Equivalente a empezar un chat nuevo sin salir del proceso. |
| `/quit` o `/exit` | Termina la sesión, guarda el historial |
| `/memory list` | Lista las decisiones almacenadas |
| `/memory search <query>` | Búsqueda semántica en decisiones |
| `/memory forget <id>` | Elimina una decisión por ID |
| `/memory show` | Muestra el contenido del STRATUM.md activo |
| `/sessions list` | Lista sesiones guardadas |
| `/sessions resume <id>` | Carga una sesión anterior y la continúa en el chat actual. Equivalente a salir y ejecutar `stratum sessions resume <id>` desde la terminal — las tres formas hacen exactamente lo mismo. |
| `/sessions delete <id>` | Elimina una sesión guardada por ID |
| `/plan` | Activa modo plan-and-execute para el próximo mensaje |
| `/subagents` | Abre un desplegable para inspeccionar el transcript de un subagente de la sesión (Hito 8C, §5.7). Dentro de esa vista, `/quit`/`Esc` vuelve al agente principal (ahí `/quit` **no** cierra Stratum). |
| `/compact` | Fuerza la compresión del contexto actual sin esperar al umbral automático del 80% |
| `/provider <name>` | Cambia el proveedor activo en caliente |
| `/model` | Abre selector interactivo de modelos del provider activo (fetch de `/models` + menú navegable con `↑↓`). El cambio aplica a la sesión actual sin reiniciar; no persiste en `.stratumrc.json`. |
| `/config_provider` | Abre el wizard de configuración de provider pre-rellenado con el provider activo. Permite editar URL, API key y modelo por defecto. Los cambios se guardan en `.stratumrc.json` (con backup automático). |
| `/tools` | Lista las tools disponibles (built-in + MCP) |
| `/mcp reload` | Reinicia todos los MCP servers sin salir del proceso (útil tras cambiar la config) |
| `/context` | Muestra estadísticas de uso del contexto actual |
| `/config get <key>` | Muestra el valor actual de una clave de configuración |
| `/config set <key> <value>` | Cambia una clave de configuración en caliente (persiste en `.stratumrc.json`) |
| `/changes` | Muestra los cambios del working tree con desglose por fichero (`M/A/D/R/?` + `+N/-M`). El total vive permanentemente en la status bar; este comando da el detalle (Hito 13) |
| `/debug` | Toggle del modo debug (muestra chunks SSE raw) |

#### Flujo visual de `/init` en el chat

`/init` no tiene agente ni pipeline propios: es un **comando-plantilla** que ejecuta el agente general con `INITIALIZE_PROMPT` (§12.13 de la definición del proyecto, decidido en el Hito 2.5). No existen `InitAgent` ni `InitEvent` — la UI se construye sobre los `AgentEvent` normales del turno.

`<AgentMessage>` detecta que el turno es un `/init` (trae `initSteps`) y, en lugar de pintar sus tool calls como `<ToolCallBlock>` sueltos, los agrupa en un `<InitProgressBlock>` con borde tenue. Cada tool call del agente es un paso: `tool_call_start` lo abre en `running`, `tool_result` lo cierra en `completed`.

```
  Stratum
  ┌────────────────────────────────────────────────────────────────┐
  │ Escaneando proyecto                                            │
  │ ✓ list                                                         │
  │ ✓ glob                                                         │
  │ ✓ read_file                                                    │
  │ ◌ write_file                                                   │
  └────────────────────────────────────────────────────────────────┘
```

- Borde: `borderStyle="single"`, `borderColor="#2A2A2A"` — discreto, igual que el dropdown
- Icono de paso completado `✓`: `chalk.hex('#22C55E')` — verde
- Icono de paso en curso `◌` → animado con los frames de §5.1: `chalk.hex('#F59E0B')` — ámbar
- Icono de paso fallido `✗`: `chalk.hex('#EF4444')`
- Texto de paso: `chalk.hex('#9CA3AF')` — gris secundario

**No hay sub-prompt de conflicto de merge.** El agente escribe `STRATUM.md` con `write_file`/`edit_file`, que ya pasan por el gate de confirmación destructiva de §12: es ahí donde el usuario aprueba o rechaza sobrescribir contenido existente, con el mismo componente que cualquier otra escritura.

**Al terminar**, el bloque de progreso colapsa a una línea de resumen y el input se reactiva. Las secciones se cuentan sobre el fichero recién escrito:

```
  Stratum
  ✓ STRATUM.md actualizado — 5 secciones · 47 archivos inspeccionados
    Tip: edita STRATUM.md para añadir instrucciones permanentes al agente.
```

- El nuevo `STRATUM.md` se recarga en el system prompt automáticamente, efectivo desde la siguiente iteración del agente.

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

### 5.4 Modo Plan & Execute

Activado con `/plan <tarea>` en el chat o `stratum run --plan "tarea"`. Implementa el flujo plan-and-execute del Hito 7 en **tres fases secuenciales dentro de la misma sesión**. La filosofía es la misma que cerró el Hito 2.5 para `/init`: no hay un pipeline determinista ni un agente especializado; es el loop ReAct con el toolset restringido y un tool de cierre (`present_plan`), análogo a `ExitPlanMode` de Claude Code.

```
  Fase 1                  Fase 2                    Fase 3
  ───────────             ───────────               ───────────
  Planificación     →     Gate de aprobación   →    Ejecución
  (ReAct read-only)       (PlanView + prompt)       (ReAct full, estados vivos)
  emite present_plan      A / E / R                 update_plan por paso
```

Mecánica del agente (eventos, tools, `RunOptions`): ver [§12.15 de STRATUM_PROJECT_DEFINITION.md](./STRATUM_PROJECT_DEFINITION.md#1215----modo-plan--execute).

#### Fase 1 — Planificación (exploración read-only)

`RunOptions.mode = 'plan'` filtra el `ToolRegistry` a un allowlist read-only (`read_file`, `glob`, `list`, `grep`, `web_search`, `web_fetch`, `recall_decisions`). Cualquier tool mutante (`write_file`, `edit_file`, `exec`, `store_decision`, MCP de escritura) se rechaza con un `tool_error` recuperable inyectado: *"Plan mode: tool '<name>' deshabilitada hasta aprobar el plan"*.

Visualmente la Fase 1 es idéntica a un turno normal del agente — `<ToolCallBlock>`s de exploración con su spinner — pero con un **badge de modo** en la `<StatusBar>` para que quede claro que nada se va a modificar todavía:

```
  stratum · ollama · qwen2.5-coder:14c · ctx 12%              ◑ PLAN
```

- Segmento `◑ PLAN`: `chalk.hex('#F59E0B').bold` — ámbar, alineado a la derecha de la status bar. Solo visible mientras `mode !== 'normal'`.
- En Fase 1 el badge es `◑ PLAN`; en Fase 3 cambia a `▸ EXEC` (`chalk.hex('#34D399')`).

La fase termina cuando el modelo llama a `present_plan(steps[], summary)` → se emite `plan_proposed` y la UI monta `<PlanView>`.

#### Fase 2 — Gate de aprobación

`<PlanView>` renderiza la lista numerada (todos los pasos en `pending`) seguida del sub-prompt de aprobación. Bloquea el input hasta que el usuario decida, igual que `<DestructiveConfirm>`.

```
  Stratum
  ┌─ Plan propuesto ─────────────────────────────────────────────────────┐
  │  Refactor del ProviderRouter para soportar fallback ponderado        │
  │                                                                      │
  │  ○ 1. Extraer la selección de provider a un método weightedPick()    │
  │  ○ 2. Añadir campo `weight` al schema Zod de provider (config)       │
  │  ○ 3. Cablear weightedPick() en advanceProvider()                    │
  │  ○ 4. Tests en router.test.ts para el reparto ponderado              │
  │                                                                      │
  │  [ A ] aprobar   [ E ] editar   [ R ] rechazar                       │
  └──────────────────────────────────────────────────────────────────────┘
  ❯❯ _  (bloqueado)
```

- Borde del bloque: `borderStyle="single"`, `borderColor="#2A2A2A"` — neutro, igual que el dropdown e `<InitProgressBlock>`.
- Título `Plan propuesto`: `chalk.hex('#F59E0B').bold`.
- Resumen (1ª línea): `chalk.hex('#F3F4F6')`.
- Pasos en `pending`: icono `○` en `chalk.hex('#4B5563')` + texto en `chalk.hex('#9CA3AF')`.
- Línea de opciones: `[ A ]` ámbar, `[ E ]` cian `#22D3EE`, `[ R ]` rojo `#EF4444`.

Acciones del gate:

| Tecla | Acción |
|---|---|
| `A` / `Enter` | Aprueba el plan → transición a Fase 3 (resuelve `onApprovePlan` con `{ decision: 'approve' }`). |
| `E` | Editar: abre el plan en modo edición (ver abajo). |
| `R` / `Esc` | Rechaza: descarta el plan, `<PlanView>` se desmonta y vuelve el chat normal (`mode='normal'`). En `run`, termina con `exit 0` sin ejecutar. |

**Edición del plan (`E`):** se abre `$EDITOR` (fallback `$VISUAL`, luego `nano`/`notepad`) con el plan serializado como markdown — una línea por paso, editable, reordenable, borrable; añadir un paso es añadir una línea. Al cerrar el editor, el texto se re-parsea a `Step[]` y `<PlanView>` se re-renderiza con el plan editado y vuelve a pedir aprobación. Si el repo no tiene `$EDITOR` o el terminal no lo permite, se cae a edición inline: cada paso pasa a ser editable con `↑↓` para navegar, `Enter` para editar el texto del paso enfocado, `d` para borrarlo, `a` para añadir uno nuevo, y `A` para volver a aprobar.

> El plan editado **no** vuelve a la Fase 1: el usuario es la fuente de verdad del plan aprobado. No se re-explora salvo que el usuario rechace (`R`) y reformule la tarea.

#### Fase 3 — Ejecución (estados vivos)

Al aprobar, `RunOptions.mode = 'execute'`, se restaura el toolset completo (la política destructiva normal vuelve a aplicar — un paso que ejecute un `rm` con `exec` dispara `<DestructiveConfirm>` como siempre) y el plan se inyecta en el contexto como checklist de trabajo. `<PlanView>` **no se desmonta**: se ancla de forma compacta encima del flujo de conversación y actualiza el estado de cada paso conforme el modelo llama a `update_plan(stepId, status)`.

```
  ┌─ Plan · 2/4 ─────────────────────────────────────────────────────────┐
  │  ✓ 1. Extraer la selección de provider a weightedPick()              │
  │  ✓ 2. Añadir campo `weight` al schema Zod de provider               │
  │  ◐ 3. Cablear weightedPick() en advanceProvider()                   │
  │  ○ 4. Tests en router.test.ts para el reparto ponderado             │
  └──────────────────────────────────────────────────────────────────────┘

  Stratum
  ⟳ edit_file: src/providers/router.ts
  ...la conversación normal del agente fluye debajo...
```

- Cabecera `Plan · N/total`: contador de pasos `done` sobre el total, en `chalk.hex('#6B7280')`.
- El bloque queda **pinned** justo debajo de la `<StatusBar>` y encima de `<MessageList>`; el área scrollable se reduce en su altura. Los `<ToolCallBlock>` de cada paso aparecen en el flujo normal de conversación debajo.

**Iconos de estado de paso** (compartidos entre Fase 2 y Fase 3):

| Estado | Icono | Color |
|---|---|---|
| `pending` | `○` | `chalk.hex('#4B5563')` |
| `in_progress` | `◐` (spinner) | `chalk.hex('#F59E0B')` — ámbar |
| `done` | `✓` | `chalk.hex('#34D399')` — verde |
| `skipped` | `⊘` | `chalk.hex('#6B7280').dim` |

**Cierre:** al emitirse `done`, si todos los pasos están `done`/`skipped`, `<PlanView>` colapsa a una línea de resumen (igual que `<InitProgressBlock>`):

```
  ✓ Plan completado — 4 pasos · 3 ejecutados · 1 omitido
```

Si el loop termina con pasos aún `pending` (max-iterations, cancelación, error), el resumen lo refleja en ámbar: `⚠ Plan incompleto — 2/4 pasos · interrumpido`.

#### Componentes Ink

```tsx
<ConversationView>
  <StatusBar ... mode={planMode} />        ← badge ◑ PLAN / ▸ EXEC
  {plan && planMode === 'execute' && (
    <PlanView plan={plan} compact />       ← pinned bajo la StatusBar durante la ejecución
  )}
  <MessageList ... />
  {plan && pendingApproval && (
    <PlanApproval                          ← gate Fase 2, entre MessageList e InputArea
      plan={plan}
      onApprove={() => dispatch({ type: 'APPROVE_PLAN' })}
      onEdit={(edited) => dispatch({ type: 'EDIT_PLAN', plan: edited })}
      onReject={() => dispatch({ type: 'REJECT_PLAN' })}
    />
  )}
  <InputArea disabled={!!pendingApproval} ... />
</ConversationView>
```

- `<PlanView compact>` y `<PlanApproval>` comparten el render de la lista de pasos (`<PlanSteps>`); difieren en el borde, la cabecera y si muestran el sub-prompt de teclas.
- Estado nuevo en el `useReducer` global de `<App>`:
  - `planMode: 'normal' | 'plan' | 'execute'`
  - `plan: Plan | null` — el plan propuesto/aprobado con sus pasos y estados
  - `pendingApproval: boolean` — gate de Fase 2 activo

**Mapeo `AgentEvent` → componente** (eventos nuevos, ver §11 y §12.1 de STRATUM_PROJECT_DEFINITION.md):

| Evento | Componente / Acción |
|---|---|
| `plan_proposed { plan }` | Monta `<PlanApproval>`, `pendingApproval = true`, bloquea input. |
| `plan_step_update { stepId, status }` | Actualiza el icono/estado del paso en `<PlanView>` in-place. No re-scrollea. |
| `done` (con `plan` activo) | Colapsa `<PlanView>` a línea de resumen; `planMode = 'normal'`. |

#### Atajos de teclado (añadidos a §10)

| Estado | Tecla | Acción |
|---|---|---|
| `plan-approval` | `A` / `Enter` | Aprueba el plan |
| `plan-approval` | `E` | Editar plan |
| `plan-approval` | `R` / `Esc` | Rechaza plan |

`plan-approval` es un cuarto valor de `focusState`, mutuamente excluyente con `input`/`dropdown`/`block-focus` (igual que el gate destructivo se modela como estado bloqueante).

#### Modo `stratum run --plan` (añadido a §13)

`run` es no interactivo. El plan se imprime en `stderr` como lista numerada y la aprobación se resuelve por flags (sin TTY no hay prompt):

```bash
$ stratum run --plan "refactor del provider router"

[plan] 1. Extraer weightedPick()
[plan] 2. Añadir campo weight al schema
[plan] 3. Cablear weightedPick() en advanceProvider()
[plan] 4. Tests del reparto ponderado
[plan] ¿Ejecutar? (S/N)        ← solo si stdout es TTY
```

| Flag | Comportamiento |
|---|---|
| (sin flag, TTY) | Imprime el plan y pide `¿Ejecutar? (S/N)` por `stderr`. |
| `--yes` / `--approve-plan` | Aprueba el plan automáticamente y ejecuta. |
| sin TTY (CI/pipe) y sin `--yes` | Imprime el plan y termina con `exit 0` **sin ejecutar** (el plan se considera el entregable). |

Durante la ejecución, cada cambio de estado de paso se emite como `[plan] N. <título>  (done)` en `stderr`, manteniendo `stdout` reservado para la respuesta final del agente (consistente con §13).

---

### 5.5 Subagentes — `<SubagentBlock>` (Hito 8A)

Cuando el agente delega una subtarea con `delegate_task`, el loop la intercepta, lanza un subagente aislado y emite `subagent_started`/`subagent_completed` (§12.16). La UI representa cada subagente como un **bloque colapsable** estilo `<ToolCallBlock>` (`cli/ui/SubagentBlock.tsx`), no como un tool call crudo: la llamada `delegate_task` se **filtra** del render de tool calls (en el handler de `tool_call_start`) para que el subagente tenga una sola representación.

```
⊳ subagent (research) │ 4.1s │ Investiga cómo se cablea el router…        ← running (spinner)
✓ ⊳ subagent (research) │ 12.3s · 7 it │ Encontré 3 puntos de cableado…  ▸  ← completed (colapsado)
✗ ⊳ subagent (code) │ fallido · 2.0s  ▸                                       ← failed
⏱ ⊳ subagent (code) │ presupuesto agotado · 40 it  ▸                         ← budget_exceeded
⊘ ⊳ subagent (shell) │ cancelado  ▸                                          ← cancelled
```

Estados del bloque: `running` (spinner + perfil + task truncada + cronómetro), y los terminales `completed`/`failed`/`cancelled`/`budget_exceeded` (mapeados desde `SubagentResult.status`). Al expandir (Space) muestra el `summary`, el `error` (si lo hay) y la lista de `filesChanged`.

| Evento | Efecto en la UI |
|---|---|
| `subagent_started { subagentId, profile, task }` | Añade un `SubagentBlockState` en `running` al `AgentConvItem` en curso (campo `subagents?`). |
| `subagent_completed { subagentId, result }` | Fija el estado final + `summary`/`filesChanged`/`iterations`/`durationMs` del bloque por `subagentId`. |

**Navegación:** los bloques de subagente participan en el foco Tab y la expansión Space igual que los tool calls — `getActiveBlocks` une `toolCalls` + `subagents` (ambos con `.id`) y comparten el `expandedBlockIds` set. La ejecución de 8A es estrictamente secuencial (un subagente a la vez), por lo que **no** hay árbol vivo (`<AgentTree>`): eso se difiere a 8C junto con el paralelismo y el evento `subagent_event` que anida los tool calls internos del hijo.

---

### 5.6 Multi-agente paralelo — `<AgentTree>` (Hito 8C)

En 8C el padre puede lanzar **varios subagentes en paralelo** acotados por un semáforo que respeta `agents.maxConcurrency` (§12.16). Un único `<SubagentBlock>` plano deja de bastar: los hijos emiten eventos **entrelazados** y cada uno tiene sus propios tool calls internos. La UI los representa como un **árbol vivo** (`cli/ui/AgentTree.tsx`) que sustituye al grupo de `<SubagentBlock>` cuando en un mismo turno se delega más de una subtarea. Con **un solo** subagente se conserva el `<SubagentBlock>` de §5.5 (no se monta el árbol) — el árbol es la representación del paralelismo.

> **Requisito de datos: el evento `subagent_event`.** `subagent_started/completed` bastan para el bloque plano, pero no para mostrar los tool calls internos del hijo. 8C añade `{ type: 'subagent_event'; subagentId: string; event: AgentEvent }` (§12.16 y §12.1), que **envuelve cada `AgentEvent` del loop hijo** etiquetado con su `subagentId`. El reducer lo desanida bajo el nodo del subagente correspondiente. Ver "Mapeo de eventos" abajo.

#### Layout del árbol

El árbol se ancla **inline** en el flujo de conversación, en el punto donde el padre delegó (no pinned como `<PlanView>`: un plan es único por turno, pero puede haber varios grupos de delegación a lo largo de una sesión). Un nodo raíz agrupa a los hijos; cada hijo es un `<SubagentNode>` con sus tool calls internos indentados:

```
  ◮ delegando 3 subagentes · 2/3 activos (maxConcurrency 2)
  │
  ├─▶ ⊳ research#1  │ 6.2s · 4 it │ Mapear el cableado del router…
  │     ⟳ grep: "advanceProvider"
  │     ✓ read_file: src/providers/router.ts
  │
  ├─  ⊳ code#2  │ 8.1s · 6 it │ Extraer weightedPick()…
  │     ✓ edit_file: src/providers/utils.ts
  │     ⟳ exec: npm test -- router
  │
  └─  ⋯ code#3  │ en cola │ Añadir tests del reparto ponderado…
```

- **Nodo raíz** `◮ delegando N subagentes · A/N activos (maxConcurrency M)` en `accent` (`#F59E0B`). `A` = hijos actualmente en ejecución (nunca supera `M`); el resto están `en cola` o ya terminados.
- **`▶` (marcador de "quién habla")**: prefija al nodo que emitió el evento más reciente (`subagent_event`), en `accent-bright` (`#FBBF24`). Solo un nodo lo lleva a la vez; da sensación de foco pese al entrelazado. Cuando todos terminan y el **padre** retoma la palabra, ningún nodo lo lleva.
- **Etiqueta de nodo** `⊳ <perfil>#<n>`: `n` es el índice de admisión (1-based) dentro del grupo, estable durante todo el turno. `perfil` en `accent`.
- **Tool calls internos**: se renderizan indentados bajo el nodo, en forma compacta (una línea: icono de estado + `name`: + primer argumento truncado), reusando los iconos de `<ToolCallBlock>` (`⟳` running, `✓` ok, `✗` error). **No** se muestra el `text_delta` del hijo en el árbol (sería ruido de varios flujos a la vez): el resumen del hijo aparece al completarse, en su línea de nodo.

#### Estados de nodo

| Estado | Icono | Significado |
|---|---|---|
| `queued` | `⋯` (`#6B7280`) | Admitido pero esperando hueco del semáforo. Muestra `en cola`. |
| `running` | `⊳` (`accent`) | En ejecución; cronómetro + `it` vivos. `▶` si es el que acaba de emitir. |
| `completed` | `✓ ⊳` (`success`) | Terminado con éxito; muestra `summary` truncado. |
| `failed` | `✗ ⊳` (`error`) | Falló; muestra `error` truncado. |
| `budget_exceeded` | `⏱ ⊳` (`warning`) | Agotó presupuesto (iteraciones/tiempo/tokens). |
| `cancelled` | `⊘ ⊳` (`#6B7280` dim) | Cancelado (Ctrl+C del padre propagó por el signal encadenado). |
| `interrupted` | `⚠ ⊳` (`warning`) | Quedó a medias (persistido `running`, §12.16 8B); solo visible al reanudar. |

Los estados terminales mapean 1:1 desde `SubagentResult.status`. Al expandir un nodo (Space con el nodo enfocado) se muestran su `summary`, `error` y `filesChanged` completos (igual que `<SubagentBlock>` expandido).

#### Cierre y resultados agregados

Cuando **todos** los hijos del grupo alcanzan un estado terminal, `<AgentTree>` colapsa a una línea de resumen agregada (patrón de `<PlanView>`/`<InitProgressBlock>`), expandible para volver a ver el árbol:

```
  ✓ 3 subagentes · 2 completados · 1 fallido · 6 ficheros tocados  ▸
```

Si hubo conflictos de fichero (ver abajo), el resumen lo señala en `warning`: `⚠ 3 subagentes · 1 conflicto de fichero · revisar`.

#### Confirmaciones destructivas en paralelo (mutex sobre la TTY)

El subagente nunca posee la TTY: su gate destructivo burbujea al `<DestructiveConfirm>` **único** del padre (§12 de esta spec, §12.16). Con paralelismo, varios hijos pueden pedir confirmación a la vez; un **mutex** serializa esos prompts —igual que el `ToolDispatcher` nunca muestra dos gates a la vez—: se muestra **un** `<DestructiveConfirm>` cada vez, etiquetado con el subagente que lo solicita, y los demás hijos quedan bloqueados en su `exec` hasta que se resuelve el suyo:

```
  ⚠ subagent (code#2) solicita ejecutar un comando destructivo
  rm -rf dist/
  [Enter] aprobar · [n] denegar · [!] aprobar todo (sesión) · [Esc] denegar
```

`allow-all` (`!`) aplica a **toda la sesión** (padre e hijos), consistente con el modo normal. Mientras el gate está activo, `focusState = 'destructive-confirm'` bloquea el input y la navegación del árbol.

#### Conflictos de fichero (best-effort)

La detección de conflictos (§12.16 8C) es *best-effort* vía intersección de write-logs por subagente, no una garantía. Cuando dos hijos escriben el mismo path, el orquestador emite un `warning` y la UI:

1. Marca el fichero en conflicto con `⚠` en la vista expandida de los nodos implicados (`… edit_file: src/foo.ts ⚠ también tocado por code#3`).
2. Refleja el conflicto en la línea de resumen agregada (`⚠ N conflicto(s) de fichero`).
3. Emite además una línea de `warning` normal en el flujo (`chalk.hex('#F97316')`), como cualquier otro `warning` (§ mapeo de eventos). **No** se intenta fusionar; la resolución la decide el usuario/padre.

#### Componentes Ink

```tsx
<AgentTree group={agentGroup}>          ← inline en el AgentConvItem, sustituye al grupo de SubagentBlock
  {group.nodes.map((n) => (
    <SubagentNode
      key={n.id}
      node={n}                            ← estado + toolCalls internos + summary/error/filesChanged
      speaking={n.id === group.speakingId} ← marcador ▶
      expanded={expandedBlockIds.has(n.id)}
    />
  ))}
</AgentTree>
```

- Un **solo** subagente ⇒ no se monta `<AgentTree>`; se usa `<SubagentBlock>` (§5.5). El umbral es `group.nodes.length > 1`.
- Estado nuevo en el `useReducer` global de `<App>` (dentro del `AgentConvItem` en curso):
  - `agentGroup: { nodes: SubagentNodeState[]; speakingId: string | null; maxConcurrency: number } | null`
  - `SubagentNodeState`: `{ id, profile, n, task, status, toolCalls: ToolCallState[], summary?, error?, filesChanged?, iterations?, durationMs? }`
  - Reutiliza `expandedBlockIds` y el foco Tab existentes (los nodos y sus tool calls entran en `getActiveBlocks`).

**Mapeo `AgentEvent` → componente** (eventos nuevos y modificados; ver §11 y §12.1 de STRATUM_PROJECT_DEFINITION.md):

| Evento | Efecto en la UI |
|---|---|
| `subagent_started { subagentId, profile, task }` | Añade/actualiza un `SubagentNodeState`. Si es el 2.º del turno, promueve el `<SubagentBlock>` previo a `<AgentTree>`. Estado inicial `running` o `queued` según el semáforo. |
| `subagent_progress { subagentId, note }` | Actualiza la línea de actividad del nodo (opcional; p.ej. "leyendo 3 ficheros"). |
| `subagent_event { subagentId, event }` | Enruta `event` al nodo por `subagentId`: `tool_call_start`/`tool_result`/`tool_error` alimentan `node.toolCalls`; marca `speakingId = subagentId`. `text_delta` del hijo se **ignora** en el árbol. |
| `subagent_completed { subagentId, result }` | Fija el estado terminal del nodo + `summary`/`error`/`filesChanged`/`iterations`/`durationMs`. Si todos terminan, colapsa a resumen agregado y limpia `speakingId`. |
| `warning` (conflicto de fichero) | Marca el fichero con `⚠` en los nodos implicados + línea de warning en el flujo. |

#### Atajos de teclado (añadidos a §10)

| Estado | Tecla | Acción |
|---|---|---|
| `block-focus` (nodo de árbol) | `Space` | Expande/colapsa los `toolCalls` + `summary`/`error`/`filesChanged` del nodo. |
| `block-focus` (nodo de árbol) | `Tab` / `Shift+Tab` | Cicla entre nodos y sus tool calls internos expandidos (orden de admisión). |

El árbol no introduce un `focusState` nuevo: sus nodos son bloques enfocables como los tool calls (`block-focus`). El gate destructivo sigue siendo el `focusState` bloqueante `destructive-confirm`.

#### Modo `stratum run` (añadido a §13)

`run` es no interactivo y el paralelismo entrelaza la salida. Cada línea de un subagente se **prefija** con `[sub <perfil>#<n>]` para que el flujo entrelazado sea atribuible, manteniendo `stdout` reservado para la respuesta final del padre (los prefijos van a `stderr`):

```bash
$ stratum run "audita los 3 módulos en paralelo" --allow-destructive

[sub research#1] grep: "advanceProvider"
[sub code#2]     edit_file: src/providers/utils.ts
[sub research#1] ✓ done · 4 it · 0 ficheros
[sub code#2]     exec [local]: npm test -- router
[sub code#3]     ⋯ en cola
[warn] conflicto: src/providers/utils.ts tocado por code#2 y code#3
[sub code#2]     ✓ done · 6 it · 1 fichero
[sub code#3]     ✓ done · 3 it · 1 fichero (⚠ conflicto)
```

Sin TTY, las confirmaciones destructivas de los hijos siguen la política del `run` (`--allow-destructive`/`--deny-destructive`; sin flag y sin TTY → deny), serializadas por el mismo mutex.

#### Responsive (añadido a §9)

- **<100 columnas**: la indentación del árbol se reduce a 2 espacios por nivel; las tasks/summaries se truncan más agresivamente.
- **Profundidad**: el árbol es de **profundidad 1** por construcción (los subagentes no delegan, §12.16), así que nunca hay sub-sub-nodos; la indentación máxima es padre → nodo → tool call (3 niveles).
- **Muchos nodos** (> `maxConcurrency` + varios en cola): los nodos `queued` se colapsan a una línea `⋯ +K en cola` cuando el alto disponible aprieta.

---

### 5.7 Inspector de subagentes — `/subagents` (Hito 8C)

El árbol (§5.6) muestra *qué* hace cada subagente (sus tool calls y su resultado), pero **no** su conversación interna completa (el `text_delta` del hijo se omite del árbol para no entrelazar varios flujos). El inspector `/subagents` cubre ese hueco: permite **entrar** al transcript de un subagente concreto y leerlo aislado, como si abrieras su chat.

> **Fuente de datos: transcript en memoria de la sesión actual.** El inspector se construye sobre el evento `subagent_event` (§5.6): además de alimentar el árbol, el reducer **acumula** cada `AgentEvent` del hijo, en orden, en un `subagentTranscripts: Map<subagentId, SubagentTranscript>`. No se persiste en disco (consistente con §12.16: el store guarda el resultado, no el transcript) — el inspector cubre los subagentes **de la sesión viva**; tras cerrar la sesión o hacer `/clear` deja de estar disponible (un `/clear` vacía también `subagentTranscripts`). Inspeccionar subagentes de sesiones pasadas queda como extensión futura (requeriría persistir transcripts + política de retención).

#### Comando y desplegable de selección

`/subagents` (autocompletado en §5.2) abre un **desplegable de selección** —misma mecánica visual que el dropdown de `/comandos`, pero listando subagentes en vez de comandos— con los subagentes de la sesión, del más reciente al más antiguo:

```
  /subagents
  ┌───────────────────────────────────────────────────────────┐
  │ ▸ ⊳ research#1  ✓ completed · 4 it · 6.2s                 │
  │   ⊳ code#2      ✗ failed · 2 it · 2.0s                    │
  │   ⊳ code#3      ⊳ running · 3 it…                          │
  └───────────────────────────────────────────────────────────┘
    ↑↓ seleccionar · Enter abrir · Esc cerrar
```

- Cada fila: icono de estado (§5.6) + `⊳ <perfil>#<n>` + estado + `it`/cronómetro. Perfil en `accent`.
- `↑↓` navega, `Enter` abre la Vista de Subagente del seleccionado, `Esc` cierra el desplegable sin entrar.
- Si no hay subagentes en la sesión, el desplegable muestra una única línea dim `— ningún subagente en esta sesión —` y `Enter` no hace nada.

#### Vista de Subagente (modal read-only)

Al elegir uno se entra a la **Vista de Subagente**: ocupa el área de conversación (sustituye a `<MessageList>`) y renderiza el transcript del hijo **en solo lectura**, reutilizando los mismos componentes que la conversación principal (`<UserMessage>` para la task inyectada, `<AgentMessage>`/`<ToolCallBlock>`/`<MarkdownText>` para su salida). Es scrollable con las mismas teclas que la conversación normal.

```
  ┌─ 👁 Subagente · research#1 · ✓ completed · 4 it · 7122 tok · 6.2s ──────┐
  │                                                                          │
  │  ❯❯ [task]  Investiga cómo se cablea el router y resume los puntos…      │
  │                                                                          │
  │  Stratum (research#1)                                                    │
  │  ✓ grep: "advanceProvider"  ▸                                            │
  │  ✓ read_file: src/providers/router.ts  ▸                                │
  │  He encontrado 3 puntos de cableado: …                                   │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘
   Solo lectura · /quit (o Esc) para volver al agente principal
```

- **Cabecera** `👁 Subagente · <perfil>#<n> · <estado> · <it> · <tokens> · <duración>`, borde en `accent`.
- El **badge de la `<StatusBar>`** cambia a `👁 SUBAGENT research#1` mientras estás dentro, para dejar claro que es una vista anidada (no el agente principal).
- **En vivo:** si el subagente sigue `running` (paralelo, 8C), la vista se actualiza conforme llegan sus `subagent_event` (el mismo Map que alimenta el árbol). Al terminar, la cabecera pasa al estado terminal sin salir de la vista.
- Los tool calls del hijo son expandibles (Space) igual que en la conversación normal; el foco Tab opera **dentro** del transcript del subagente.

#### Input restringido — solo `/quit`

Mientras la Vista de Subagente está activa, `focusState = 'subagent-view'` (estado bloqueante nuevo, mutuamente excluyente con los demás). La línea de entrada **no** manda mensajes al agente: es una vista de inspección. El único comando aceptado es **`/quit`** (con `Esc` como alias), que cierra la vista y **vuelve exactamente al punto de la conversación principal** donde estabas. Cualquier otra entrada se rechaza con un hint inline:

```
  ❯❯ arregla el bug
  ⚠ Aquí solo está disponible /quit (vuelve al agente principal). Esc también cierra.
```

> **`/quit` aquí ≠ cerrar Stratum.** Dentro de esta vista, `/quit` significa *volver al agente principal*, no salir de la aplicación. El cierre real de Stratum (doble `Ctrl+C`) no se ve afectado y sigue disponible.

No se puede enviar input **al** subagente: ya se ejecutó (o corre de forma autónoma); el inspector es un lector, no un chat interactivo con el hijo. Delegar de nuevo se hace desde el agente principal con `delegate_task`, no desde aquí.

#### Componentes Ink y estado

```tsx
{focusState === 'subagent-view' && (
  <SubagentView                         ← sustituye a <MessageList> mientras está activo
    transcript={subagentTranscripts.get(viewingSubagentId)}
    onQuit={() => dispatch({ type: 'EXIT_SUBAGENT_VIEW' })}
  />
)}
```

- Estado nuevo en el `useReducer` de `<App>`:
  - `subagentTranscripts: Map<string, SubagentTranscript>` — `{ meta: { profile, n, task, status, iterations, tokens, durationMs }, events: AgentEvent[] }`, alimentado por `subagent_started`/`subagent_event`/`subagent_completed`.
  - `viewingSubagentId: string | null` — subagente abierto; `null` fuera de la vista.
  - `subagentPicker: boolean` — desplegable de selección abierto.
- `<SubagentView>` reutiliza el pipeline de render de `<MessageList>` (los `events` del hijo son `AgentEvent[]` normales), solo cambia la cabecera y el input restringido.

**Acciones del reducer:**

| Acción | Efecto |
|---|---|
| `OPEN_SUBAGENT_PICKER` (`/subagents`) | `subagentPicker = true`; lista `subagentTranscripts`. |
| `ENTER_SUBAGENT_VIEW { id }` | `viewingSubagentId = id`, `focusState = 'subagent-view'`, cierra el picker. |
| `EXIT_SUBAGENT_VIEW` (`/quit`, `Esc`) | `viewingSubagentId = null`, restaura `focusState = 'input'`. |
| `CLEAR` | vacía `subagentTranscripts` (además de messages/events). |

#### Atajos de teclado (añadidos a §10)

| Estado | Tecla | Acción |
|---|---|---|
| `subagent-view` | `/quit` + Enter, o `Esc` | Cierra la vista y vuelve al agente principal. |
| `subagent-view` | `↑↓` / scroll | Desplaza el transcript del subagente. |
| `subagent-view` | `Tab` / `Space` | Foco/expansión de los tool calls **dentro** del transcript. |
| `subagent-picker` | `↑↓` / `Enter` / `Esc` | Seleccionar / abrir / cerrar el desplegable. |

#### Modo `stratum run`

No aplica: `run` es no interactivo, sin desplegables ni vistas modales. La atribución del transcript de cada hijo en `run` se cubre con los prefijos `[sub perfil#n]` de §5.6.

---

### 5.8 Tool calls SSH — contexto de host remoto (Hito 9)

`exec` sobre un target `ssh:<alias>` y las tools `ssh_upload` y `ssh_download` operan sobre **una máquina que no es la del usuario**. Un `rm -rf /var/cache` renderizado igual que un `exec` local es un fallo de diseño: el bloque debe decir *dónde* se ejecutó antes de decir *qué* se ejecutó. §5.8 extiende `<ToolCallBlock>` (§5.1) sin crear un componente nuevo.

> **Hito 16:** la ejecución remota es `exec` con `target: "ssh:<alias>"` (`ssh_exec` se retiró). El prefijo `⌗ alias` se toma de ese target —un `exec` en `local` no lleva prefijo— y la etiqueta de la línea es su `command`.

#### Prefijo de host

El alias del inventario (`.stratumrc.json` → `ssh.hosts.<alias>`) se pinta con el icono de servidor `⌗` inmediatamente después del nombre de la tool, en `accent`, y está presente en **los cuatro estados**:

```
○ exec ⌗ prod-web │ en cola...
◉ exec ⌗ prod-web │ 0.8s │ systemctl restart nginx
✓ exec ⌗ prod-web │ 1.2s │ systemctl restart nginx ▸
✗ exec ⌗ prod-web │ Permission denied (publickey) ▸
```

El alias se toma de `state.input.host`. Mientras la tool call se está parseando (`pending`/`running` con solo `inputSoFar`), el alias puede no estar disponible todavía: en ese caso el bloque se renderiza sin prefijo, sin hueco reservado.

#### Indicador de latencia

Una operación remota lenta es información operativa, no ruido. En estado `completed`, cuando `durationMs > 1000` la duración se pinta en `warning` en lugar de `textFaint`:

| Duración | Color | Lectura |
|---|---|---|
| ≤ 1000 ms | `textFaint` | Latencia normal; no llama la atención. |
| > 1000 ms | `warning` | Comando lento o enlace con latencia alta. |

El umbral es el mismo para `exec` en un target remoto y para las transferencias SFTP, que se miden en su totalidad (conexión reutilizada + transferencia).

#### Etiqueta de la línea

`formatInput` (§5.1) muestra la **primera** clave del input, que en todas las tools SSH es `host` — duplicaría el alias que ya lleva el prefijo. Las tools SSH usan una clave preferente:

| Tool | Clave mostrada |
|---|---|
| `exec` (target `ssh:<alias>`) | `command` |
| `ssh_upload` | `localPath → remotePath` |
| `ssh_download` | `remotePath → localPath` |

#### Confirmación

Las confirmaciones SSH reutilizan `<DestructiveConfirm>` (§12) sin cambios de layout; solo cambia la `description`:

```
⚠  El agente quiere ejecutar un comando en prod-web [confirmAll: true]:
   exec [ssh:prod-web]: ls -la /var/www/html

   [Enter] Aprobar   [n] Denegar   [!] Aprobar todo
```

Se dispara en dos casos (§12.14): el comando encaja con `tools.destructivePatterns`, o el host lleva `confirmAll: true` — y entonces **cualquier** comando pide confirmación, incluido un `ls`.

El mismo componente sirve para el gate **TOFU** de la primera conexión a un host, con la `description` en formato de fingerprint:

```
⚠  Host SSH nuevo: prod-web (192.168.1.10)
   Fingerprint: SHA256:xK3m... (ssh-ed25519)
   ¿Confiar y añadir a known_hosts?

   [Enter] Confiar   [n] Abortar
```

`allow-all` (`!`) equivale aquí a **aprobar solo este host**: confiar en un fingerprint nunca implica confiar en los siguientes. Sin TTY (CI, salida a pipe) la respuesta es deny automático y la conexión aborta, igual que el resto de confirmaciones.

Un **mismatch** de host key no es un gate: no se pregunta, se aborta con `tool_error` `recoverable: false`, y el mensaje de error instruye a usar `stratum ssh trust <alias> --force`.

#### `stratum ssh list`

Sin UI Ink, plain text a stdout, igual que `stratum init` (§12.13 del documento principal). Mismos iconos `●`/`○` que `stratum mcp list`:

```
SSH hosts: 2 connected, 1 unreachable

● bastion     javi@bastion.example.com:22   [connected, 42ms]
● prod-web    javi@192.168.1.10:22          [connected, 118ms] (via bastion)
○ dev-server  javi@10.0.0.5:22              [error: connect ETIMEDOUT]
```

Un host aún no presente en `~/.stratum/known_hosts.json` se marca con `(host key sin confiar — usa: stratum ssh trust <alias>)`.

### 5.9 Perfiles de agente — `@perfil`, `/agents`, `/agent` (Hito 15)

**Invocación directa.** Un input que empieza por `@` abre la paleta con los perfiles delegables (nombre + descripción); filtra por subcadena mientras se escribe el nombre y se cierra al teclear el espacio que empieza la tarea. `Tab`/`Enter` completan `@nombre `. Al enviar `@research busca X`:

- perfil delegable → el turno muestra `@research busca X` como mensaje de usuario y un `<SubagentBlock>` (o el `<AgentTree>`, §5.5/§5.6) sin pasar por el agente principal;
- perfil `primary` → línea de sistema: `'x' es un perfil principal (mode: primary): actívalo con /agent x.`;
- `@perfil` sin tarea → línea de uso;
- `@algo` que no es un perfil → se envía como mensaje normal.

**`/agents`** pinta como mensaje de sistema el mismo informe que `stratum agents list`:

```
Perfiles de agente (3):

  ◆ reviewer  [primary · proyecto]
      Reviews diffs for correctness
      tools: read_file, grep
      fichero: /repo/.stratum/agents/reviewer.md

  • research  [subagent · proyecto]
      ...

Perfiles inválidos (1) — no se cargaron:

  ✗ broken
      mode: Invalid enum value ...
      fichero: /repo/.stratum/agents/broken.md
```

**`/agent`** sin argumentos lista los perfiles activables y el activo; `/agent <perfil>` lo activa y `/agent off` vuelve al agente por defecto. La confirmación dice que el historial se conserva y que prompt y tools cambian desde el siguiente mensaje, más un aviso si el perfil declara `provider`/`model` (se ignoran). Se rechaza con un plan en curso.

**Status bar.** Con un perfil principal activo aparece `◆ <perfil>` (color de acento, negrita) tras el porcentaje de contexto y antes del badge de plan: el perfil dura la sesión, el modo plan una tarea.

### 5.10 Entornos, read-only y perfil de sesión (Hito 17)

**Status bar.** Tras el porcentaje de contexto, en este orden: entorno del contexto activo, `RO`, perfil de sesión, perfil principal (`◆`) y modo plan. Lo que dura la sesión va antes que lo que dura una tarea, y el entorno el primero porque es lo que más importa ver de un vistazo:

```
 ● local │ gemma-4-12b              ctx 4.2k / 43k │ 10%  ⬢ prod ssh:prod-db  RO  ⬡ infra
```

- *Contexto activo* = último target (`exec`, `ssh_upload`, `ssh_download`) donde algo **se ejecutó** — un rechazo no cuenta, también dentro de subagentes. Al arrancar es `local`. Se refresca al terminar cada turno y tras `/readonly`, `/profile` y `/sessions resume`.
- El badge solo aparece si el target casa con un entorno de `environments`: sin entornos definidos la barra no cambia.

**Comandos.**

| Comando | Efecto |
|---|---|
| `/readonly [on\|off]` | Sin argumento alterna. Mensaje de sistema con el nuevo estado; el system prompt y el toolset cambian desde el próximo mensaje. `/init` se rechaza en read-only |
| `/profile [nombre]` | Sin argumento, informe: perfil activo (con el motivo si es `auto`), disponibles con su origen y sus tools. Con argumento lo cambia; se rechaza con un plan en curso |
| `/env` | Contexto activo, entornos definidos con sus patrones y sus reglas en una línea |

**Escalada a plan.** Si un entorno con `requirePlan` rechaza un cambio y el turno escala a modo plan (evento `warning` `plan_required:<entorno>`), la UI entra en modo plan como con `/plan`: badge `◑ PLAN` y, al llegar `present_plan`, el gate de aprobación de §5.4.

**Confirmación.** Ver §12 (variante con entorno y confirmación tecleada).

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

- El contenido de conversación sigue limitado a 100 chars de ancho (`MAX_CONTENT_WIDTH`).
- Los tool call blocks añaden más espacio para el input visible.

### Alto mínimo: 24 líneas

- Si `rows < 24`: el banner se reduce — oculta los tips, el tagline y el separador, y deja solo el ASCII art y el prompt.
- No hay altura mínima que reservar para el área de conversación: el terminal es dueño del scroll (§4.2).

### Implementación

Los cortes horizontales del ASCII art viven en `getAsciiArt(columns)` (`cli/ui/ascii-art.ts`). El resto de breakpoints están en `resolveLayout(columns, rows)` (`cli/ui/layout.ts`), que devuelve `{ showTips, contentWidth }` — lógica pura, testeable sin renderizar Ink.

### Redimensionado en caliente

Ink detecta `SIGWINCH` y re-renderiza. Los componentes deben usar `useStdout().columns` / `.rows` reactivamente y no hardcodear anchos.

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

**Scroll del historial:** no lo gestiona la aplicación. `PgUp`/`PgDn`, la rueda del ratón y la barra de scroll pertenecen al terminal, porque los turnos cerrados viven en su scrollback nativo (§4.2).

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
        <SubagentBlock          → Hito 8A: 1 subagente, bloque colapsable (§5.5)
          id={...}
          profile={...}
          status={...}
        />
        <AgentTree              → Hito 8C: >1 subagente en paralelo, árbol vivo (§5.6)
          group={agentGroup}    → nodos + speakingId + maxConcurrency
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
- `focusState: 'input' | 'dropdown' | 'block-focus' | 'plan-approval' | 'destructive-confirm' | 'subagent-view'` — ver §10. `plan-approval` (§5.4), `destructive-confirm` (§12) y `subagent-view` (§5.7) son estados bloqueantes mutuamente excluyentes con los demás; los nodos de `<AgentTree>` (§5.6) son bloques `block-focus` normales, no un estado nuevo.
- `agentGroup: AgentGroupState | null` — grupo de subagentes paralelos del turno en curso (§5.6, Hito 8C); `null` fuera de una delegación múltiple.
- `subagentTranscripts: Map<string, SubagentTranscript>` + `viewingSubagentId: string | null` — inspector de subagentes de la sesión (§5.7, Hito 8C); en memoria, se vacía con `/clear`.
- `fatalError: { message: string } | null` — error fatal del agente (§11, Hito 10); mientras no sea `null`, el input queda bloqueado.
- `debug: boolean` — `/debug` (Hito 10); con `true` se pintan los bloques `⊙ thinking`.

**Acción `/clear` en el reducer:** despacha `{ type: 'CLEAR' }`, que reinicia `completedItems: []`, `currentItem: null`, `subagentTranscripts` (§5.7), el plan en curso y `fatalError`. El `sessionId` se mantiene; el agente pierde todo el contexto conversacional anterior vía `agent.clearHistory()`. `Ctrl+L` despacha la misma acción.

Como los turnos cerrados ya están en el scrollback nativo del terminal (§4.2), el handler emite además `\x1b[2J\x1b[3J\x1b[H` antes de despachar: `<Static>` no puede retirar lo que ya imprimió.

**AgentEvent → Componente:** el `<MessageList>` consume el stream de `AgentEvent` y los reduce a la representación visual:

| Evento | Componente / Acción |
|---|---|
| `text_delta` | Actualiza el último `<StreamingText>` con el delta acumulado |
| `tool_call_start` | Crea `<ToolCallBlock status="running">` con spinner activo |
| `tool_call_ready` | Actualiza el bloque con input parseado completo |
| `tool_result` | Actualiza bloque a `status="completed"` con output y duración |
| `tool_error` | Actualiza bloque a `status="error"` con mensaje |
| `memory_retrieved` | Renderiza una línea dim `↺ N decisiones recuperadas de memoria` justo antes del siguiente `<AgentMessage>`. Si `decisions.length === 0`, no se renderiza nada. |
| `subagent_started` (8A/8C) | 1.º del turno → `<SubagentBlock>` (§5.5); 2.º → promueve a `<AgentTree>` (§5.6) y añade nodo. |
| `subagent_progress` (8B+) | Actualiza la línea de actividad del bloque/nodo del subagente. |
| `subagent_event` (8C) | Enruta el `AgentEvent` envuelto al nodo por `subagentId`; alimenta sus tool calls y marca `speakingId`. Ver §5.6. |
| `subagent_completed` (8A/8C) | Fija estado terminal + `summary`/`error`/`filesChanged` del bloque/nodo. Colapsa el árbol al agregado si todos terminaron. |
| `thinking` | **No se renderiza por defecto.** Solo visible con `/debug` activo (o `--debug`): una línea dim truncada con prefijo `⊙ thinking`. Sin `debug`, el reducer descarta el evento sin tocar el estado. |
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

Se renderiza en `<ConversationView>`, entre `<MessageList>` e `<InputArea>` — el mismo hueco que `<DestructiveConfirm>` (§12). La sugerencia la deriva `suggestForError(message)`, un mapa de patrones conocidos (`ECONNREFUSED`, `ENOTFOUND`, `401`, `404`, `429`, desbordamiento de contexto…); si el error no encaja con ninguno, la línea se omite en lugar de inventarse una recomendación.

---

## 12. Componente de Confirmación Destructiva

Cuando el `ToolDispatcher` detecta que una tool tiene `destructive: true`, pausa la ejecución y renderiza un bloque de confirmación **entre el área de conversación y el input**. El input queda bloqueado hasta que el usuario responda.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⚠  Operación destructiva                                             │
│                                                                      │
│  exec: rm -rf /var/log/app/*.log                                     │
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

### Variante de entorno (Hito 17)

Cuando la llamada cambia algo en un target que pertenece a un entorno, el título nombra el entorno y el borde toma el color de su tier (rojo `production`, ámbar `staging`):

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⚠ Cambio en prod (production)                                        │
│                                                                      │
│  exec [ssh:prod-db]: systemctl restart api                           │
│                                                                      │
│  Escribe prod-db para confirmar (Esc cancela): prod-d_               │
└──────────────────────────────────────────────────────────────────────┘
```

- Con `confirmation: typed` (default en `confirm-always`) no hay atajos: se teclea el alias del target y `Enter`. Si no coincide exactamente, línea roja `No coincide…` y el bloque sigue abierto; `Esc` o `Ctrl+C` deniegan.
- Con `policy: confirm-always` no se ofrece `[ ! ] permitir todo`, y un allow-all nunca convierte la sesión en `allow`.
- En `stratum run` la confirmación tecleada es una línea de readline (`Escribe "prod-db" para confirmar`); cualquier otra respuesta deniega. Stratum Desktop deniega estas confirmaciones: su ventana no sabe pedirlas.

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
[tool] exec [local]: find src/ -name "*.ts" | wc -l  (0.3s)
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

> **Solo aplica con `mcp.startup: 'eager'`.** El Hito 4.1 introdujo el modo `lazy` — hoy el **default** — en el que los servers conectan en background (`startBackground`) y el banner **no espera a nada**: el prompt aparece de inmediato y el estado de conectividad se sigue en el segmento `mcp ●` del status bar (§4.1). Esta sección describe el arranque bloqueante, que solo se activa cuando la config pide `eager` explícitamente.

Con `mcp.startup: 'eager'`, los MCP servers se conectan antes de aceptar entrada (§12.8 de `STRATUM_PROJECT_DEFINITION.md`). Si hay servers configurados, esta fase puede durar varios segundos. Se renderiza en el banner, antes de que el prompt `❯❯` aparezca.

**Nota de implementación:** la conexión se lanza en `chat.ts` pero **no se espera ahí** — si se hiciera, la fase de conexión habría terminado antes de que Ink pintara nada y el panel nunca sería visible. `<MCPStartup>` sondea el estado de los clientes del `McpManager` y avisa con `onAllSettled`. Por el mismo motivo, los fallos de conexión se muestran en el propio panel en lugar de escribirse a `stderr`, que corrompería el render de Ink.

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
- Si no hay servers configurados —o si `mcp.startup` es `lazy`— esta sección no se renderiza y el banner va directo a los tips.
- El corte por tiempo lo aplica el propio `McpServerClient` con el `startupTimeout` de cada server (15 s por defecto, §12.8.1). El panel solo etiqueta el resultado: si el server terminó desconectado habiendo agotado su `startupTimeout`, se marca `(timeout)`; si falló antes, `(no disponible)`.

### Componente Ink

```tsx
// En <Banner>, entre el ASCII art y los tips. `mcpStartup` solo llega con
// `mcp.startup: 'eager'`; con `lazy` es undefined y mcpSettled arranca en true.
{mcpStartup && !mcpSettled && (
  <MCPStartup
    manager={mcpStartup.manager}
    timeouts={mcpStartup.timeouts}
    onAllSettled={handleMcpSettled}
  />
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

*Documento generado: 2026-05-27 | Versión: 0.4.0 | Revisión (Hito 10, 2026-08-27): cierre de la UI base y sincronización con la implementación — §4.2 reescrita a la estrategia `<Static>` + scrollback nativo (se retira la ventana virtual y `PgUp`/`PgDn` de §10); §5.2 completa la tabla de /comandos y sustituye el flujo `InitAgent`/`InitEvent` de `/init` por el comando-plantilla del Hito 2.5; §9 añade el eje vertical y el ancho máximo de contenido; §11 detalla `<FatalError>` y el gate de `/debug` para los eventos `thinking`; §14 se condiciona a `mcp.startup: 'eager'`*
*Documento relacionado: [Definición del Proyecto](./STRATUM_PROJECT_DEFINITION.md)*
