---
date: 2026-08-27
tags: [diario, hito-10, ui, ink, comandos, spec, stratum-cli]
hito: 10
commit: (sin commitear)
---

# Diario — Hito 10: Cierre de la UI base

## Resumen

Los Hitos 7, 8C y 9 fueron añadiendo secciones nuevas a `STRATUM_UI_SPECIFICATION.md` (plan &
execute, subagentes, SSH) y cerrándolas bien. Mientras tanto, las **secciones base** — escritas en
el Hito 1 — llevaban desde entonces a medias: 8 de los 23 `/comandos` de §5.2 no existían, faltaban
cuatro atajos de §10, y §4.2, §9, §11 y §14 describían cosas que nadie había construido.

Este hito cierra ese hueco y, donde la spec había quedado desfasada respecto a decisiones
posteriores, sincroniza el documento en vez de implementar a ciegas. 48 tests nuevos (438 → 486).

---

## Qué se implementó

### Los 8 `/comandos` que faltaban (§5.2)

`/clear`, `/compact`, `/context`, `/debug`, `/mcp reload`, `/sessions list|resume|delete` y
`/config get|set` — 12 entradas nuevas en `session-commands.ts` para el autocompletado y sus
handlers en `executeCommand`.

Tres necesitaron API nueva en `StratumAgent`, que hasta ahora solo exponía lectura del historial:

- `clearHistory()` — deja `messages` con el system prompt y nada más.
- `replaceHistory(messages)` — `/sessions resume` **en caliente**, sin recrear el agente.
- `compactNow()` — compresión forzada.

### Separar `compress()` del guard de umbral

`ContextManager.maybeCompress()` abría con un early-return si el contexto no superaba el 80%. Eso es
exactamente lo contrario de lo que `/compact` necesita: el usuario lo invoca *porque* quiere
comprimir antes de llegar al umbral.

El cuerpo se extrajo a `compress(messages)` y `maybeCompress` quedó como su guard. Un cambio de tres
líneas que no altera el comportamiento automático.

### `<FatalError>` (§11)

Un `error { fatal: true }` se concatenaba como texto plano `[Error: …]` dentro del mensaje del
agente. Ahora pinta el bloque de borde rojo que pedía la spec, con una sugerencia derivada por
patrón (`suggestForError`: `ECONNREFUSED`, `ENOTFOUND`, `401`, `404`, `429`, desbordamiento de
contexto…), y **bloquea el input de forma permanente**.

Si el error no encaja con ningún patrón, la línea de sugerencia se omite. Inventarse una
recomendación plausible para un error desconocido es peor que no dar ninguna.

### `<InitProgressBlock>` (§5.2)

`/init` ya despachaba progreso, pero como líneas de texto sueltas (`[3] read_file OK`) que se
pisaban entre sí. Ahora sus tool calls se agrupan como pasos `✓`/`◌`/`✗` dentro de una caja, y al
terminar colapsa a `✓ STRATUM.md actualizado — N secciones · M operaciones` (las secciones se
cuentan sobre el fichero recién escrito, no sobre lo que el modelo dijo haber hecho).

### `<MCPStartup>` (§14) y `resolveLayout` (§9)

Panel de arranque MCP para el modo `eager`, y los breakpoints que faltaban: `rows < 24` reduce el
banner, y el contenido de conversación se limita a 100 columnas en terminales anchas.

---

## Decisiones técnicas clave

### `<Static>` gana a la ventana virtual de §4.2

§4.2 especificaba una ventana virtual (`viewportLines = terminalHeight × 3`), anclaje al fondo
durante streaming, `PgUp`/`PgDn` y un indicador `↓ N líneas más`. La implementación había tomado
otro camino: `<Static>` de Ink, que imprime los turnos cerrados al **scrollback nativo** del
terminal y los saca del árbol de render.

Las dos estrategias son incompatibles y la implementada es mejor:

- El scroll lo hace el terminal — rueda del ratón, `PgUp` nativo, barra de scroll.
- El historial completo se puede **seleccionar y copiar** con el ratón, porque es texto real y no un
  viewport redibujado.
- El coste de render es constante por muy larga que sea la conversación.
- Implementar la ventana virtual habría exigido medir la altura renderizada de cada item, algo que
  Ink no expone, con riesgo de parpadeo en Windows.

Así que se reescribió §4.2 y se retiró la fila `PgUp`/`PgDn` de §10.

**Corolario que no era obvio:** `<Static>` no puede *desimprimir* lo que ya volcó. `/clear` y
`Ctrl+L` tienen que emitir `\x1b[2J\x1b[3J\x1b[H` además de vaciar el estado, o el historial
"borrado" sigue ahí al hacer scroll hacia arriba.

### §14 se condiciona a `mcp.startup: 'eager'`

§14 pedía un panel que bloquease el prompt hasta que todos los MCP servers conectaran. El Hito 4.1
introdujo `mcp.startup: 'lazy'` — hoy el default — precisamente **para no bloquear**.

Implementarlo tal cual habría revertido de facto esa mejora. Se implementó solo para `eager`: con
`lazy` el banner queda exactamente como estaba.

Al cablearlo apareció el detalle que hacía la spec irrealizable tal como estaba escrita: `chat.ts`
hacía `await mcpManager.connectAll()` **antes** de `render()`. La fase de conexión terminaba antes de
que Ink pintase un solo carácter, así que el panel nunca habría sido visible. Ahora la conexión se
lanza sin esperarla y `<MCPStartup>` sondea el manager hasta `onAllSettled`. Por el mismo motivo los
fallos se muestran en el panel: escribir a `stderr` con Ink montado corrompe el render.

### `/init` no tiene un `InitAgent` — y no lo va a tener

§5.2 describía un `InitAgent` emitiendo `InitEvent`s, con un sub-prompt de conflicto de merge
`[S] sí / [N] preservar`. Esa arquitectura se descartó deliberadamente en el Hito 2.5: `/init` es un
comando-plantilla que ejecuta el agente general (§12.13).

Se implementó la presentación visual sobre los eventos reales y se reescribió el trozo de spec. El
sub-prompt de merge tampoco hace falta: el agente escribe `STRATUM.md` con `write_file`/`edit_file`,
que ya pasan por el gate destructivo de §12 — es ahí donde el usuario aprueba sobrescribir.

### El historial de inputs vive en `<App>`, no en `<InputArea>`

§10 lo situaba en `<InputArea>`, pero ese componente es un `TextInput` sin estado propio: el valor
del input vive en el reducer de `<App>`. Meter ahí un historial habría creado dos fuentes de verdad
para el mismo string.

El estado se quedó en `<App>` y la lógica pura se extrajo a `input-history.ts`. La precedencia sale
gratis del orden de guardas del `useInput` existente: con la paleta de `/comandos` abierta, `↑↓` le
pertenecen a ella y el bloque del historial ni se evalúa.

---

## Un fichero binario escondido

`App.tsx` contenía **dos bytes NUL literales**: el centinela `'\u0000manual'` del selector de `/model`
y su comparación. La intención era buena — un valor que ningún modelo real puede colisionar — pero
la ejecución dejaba el fichero clasificado como binario, y `grep`, `Read` y media herramienta de
búsqueda se negaban a abrirlo.

Reescritos como escapes `\u0000` en el fuente: mismo valor exacto en runtime, fichero de texto plano
otra vez.

---

## Lo que no se hizo

- **`PgUp`/`PgDn` y el indicador `↓ N líneas más`**: retirados de la spec por la decisión de
  `<Static>`, no pendientes.
- **Sub-prompt de conflicto de merge en `/init`**: cubierto por el gate destructivo existente.
- **`--debug` como flag de arranque**: `/debug` funciona en sesión; el flag de CLI sigue
  controlando solo el nivel de logging.

---

## Verificación

`npm run test:run` → 486 tests verdes (48 nuevos). `npm run lint` limpio. `npm run build` OK.

Los tests nuevos son de **lógica pura**, siguiendo el patrón de `Banner.test.ts` y
`session-commands.test.ts` — no se testea el render de Ink:

| Fichero | Cubre |
|---|---|
| `input-history.test.ts` | Navegación ↑↓, límites sin wrap, no duplicar entradas consecutivas |
| `layout.test.ts` | Breakpoints de 60/72/120 columnas y 24 filas |
| `dot-path.test.ts` | get/set anidado y coerción de tipos tras la extracción |
| `FatalError.test.ts` | Mapa de sugerencias, incluido "no inventar" ante error desconocido |
| `core-history.test.ts` | `clearHistory` / `replaceHistory` / `compress` forzado |
| `session-commands.test.ts` | Los 12 comandos nuevos, sus `hasArgs` y el filtrado de `/c` y `/sessions` |

Pendiente de verificación manual en Windows Terminal: el comportamiento de `\x1b[3J` (borrado de
scrollback) y el panel `<MCPStartup>` contra un server lento real.

---

## Próximo paso

Con esto, `STRATUM_UI_SPECIFICATION.md` y el código dicen lo mismo por primera vez desde el Hito 1.
Ver [[Roadmap]] para lo que venga después.
