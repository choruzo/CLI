# Mejoras visuales de Stratum Desktop

Revisión del frontend (`src/styles.css`, `src/components/**`) con una restricción: **ninguna mejora puede costar rendimiento**. En la práctica eso significa:

- Animar solo `transform`, `opacity` y colores; nunca `width`/`height`/`top` en elementos que se repiten.
- Nada de `backdrop-filter` ni `filter: blur()` sobre zonas grandes o que hagan scroll (WebView2 repinta la capa entera en cada frame).
- Sombras grandes solo en elementos pequeños o flotantes (menú `/`, diálogos), nunca en cada mensaje.
- Ninguna animación en bucle nueva: las que ya existen (cursor, estratos, spinner) bastan.
- Todo respeta `prefers-reduced-motion`, que ya neutraliza animaciones y transiciones de forma global.

## Cambios aplicados

### 1. Composer rediseñado (`InputArea.tsx` + `styles.css`)

| Antes | Después |
|---|---|
| Textarea con borde propio y dos botones de texto al lado («Adjuntar», «Enviar») | Una sola tarjeta redondeada (14 px) que contiene todo: `+` a la izquierda, textarea sin borde en el centro y la flecha `>` a la derecha |
| «Detener» como botón de texto | Botón circular con un cuadrado ■ (el icono de parar habitual) |
| Enviar deshabilitado = ámbar al 45 % (parecía pulsable) | Gris neutro: se distingue a simple vista |
| Foco = outline del textarea | Anillo suave en la tarjeta (`:focus-within`, 3 px de ámbar al 16 %) |

- Los iconos son SVG en línea con la misma rejilla 24×24 y los trazos redondeados del sidebar, sin fuentes de iconos ni dependencias.
- **Accesibilidad intacta**: los botones conservan `aria-label` «Adjuntar ficheros», «Enviar» y «Detener», así que siguen funcionando los tests (`files.test.tsx`, `useAgentStream.test.tsx`) y los E2E (`clickButton('Detener')`, `clickButton('Adjuntar ficheros')`). Se añade `title` con el atajo («Enviar (Enter)», «Detener (Esc)»).
- Los chips de adjuntos y los avisos van dentro de la tarjeta, encima del texto.
- Pulsar un botón da una respuesta táctil de `scale(0.92)` (solo `transform`).

### 2. Pulido general (sección «Pulido visual» al final de `styles.css`)

- **Scrollbars finas en la paleta** (`scrollbar-width: thin` + `scrollbar-color`): sustituyen las grises del sistema, que desentonaban con el tema oscuro. Coste nulo.
- **Selección de texto** en ámbar translúcido en vez del azul del sistema (el editor JSON conserva su regla propia, más específica).
- **Cifras tabulares** (`font-variant-numeric: tabular-nums`) en StatusBar, duraciones de tools, latencia y contador de palabras del razonamiento: los números que cambian ya no hacen bailar el ancho.
- **Hover fundido** (140 ms, solo color/fondo/borde) en botones, chips, rail, iconos y conversaciones del sidebar; `translateY(1px)` al pulsar botones.
- **Burbuja del usuario** con un tinte cálido (`color-mix` al 7 % de ámbar) y la esquina inferior derecha apuntando al emisor; antes era idéntica a cualquier panel.
- **Markdown**: `h1`/`h2` con línea inferior, `hr` estilizado, algo de aire entre ítems de lista, cabeceras de tabla con fondo, y `line-height` de 1.5 en bloques de código.
- **Estado vacío** con el logo de estratos (`AppLogo`, el SVG que ya usa el onboarding) sobre «¿En qué puedo ayudarte?», y el texto de ayuda menciona ahora «el botón +».
- **Menú `/`**: radio de 10 px y entrada con el mismo `message-in` que los mensajes (una vez, 140 ms).
- **Tool calls**: la cabecera se ilumina al pasar el ratón.
- `-webkit-font-smoothing: antialiased` en toda la ventana.

**Verificación**: `npm run build` (typecheck + Vite) y los 162 tests de Vitest pasan; se revisó el composer en una captura con el CSS compilado (normal, deshabilitado y detener). El CSS pasa de ~39 a 42,9 kB (7,9 kB gzip).

## Sugerencias pendientes

Por orden de relación impacto/esfuerzo. Todas son compatibles con la restricción de rendimiento.

### Alta prioridad

1. **Botón «Copiar» en los bloques de código**, con la etiqueta del lenguaje en una cabecera fina (`pre` → `div.code-block` con `header`). Hoy no hay forma de copiar un bloque sin seleccionarlo a mano. Solo aparece con `:hover`/`:focus-within`, con `navigator.clipboard` y un «✓ Copiado» de 1,5 s.
2. **Botón flotante «Ir al final»** cuando el usuario ha subido y llega texto nuevo (`ConversationView` ya sabe si está «pegado» abajo: `stickRef`). Pequeño círculo sobre el composer con una flecha ↓ y un punto ámbar si hay contenido sin leer.
3. **Sugerencias en el estado vacío**: 3–4 chips («Resume un fichero», «Explica este error», «Redacta un correo») que rellenan el composer. Reutilizan `.chip`.
4. **Iconos por tipo de tool** en `ToolCallBlock`: fichero (read/write/edit), lupa (glob/grep/web_search), globo (web_fetch), cerebro (memoria). Hoy todas llevan el mismo glifo; con un `Record<toolName, path>` como el del sidebar se lee de un vistazo qué está haciendo el agente.

### Media prioridad

5. **Marca del agente al inicio de cada turno**: el logo de estratos en miniatura (14 px) junto a la primera línea de la respuesta, en lugar de texto suelto. Ayuda a escanear conversaciones largas.
6. **Acciones por mensaje al pasar el ratón** (copiar respuesta, reintentar, copiar como markdown), alineadas a la derecha y solo con `:hover`/`:focus-within`, como las de `.conv-item__actions`.
7. **Avisos como toasts** (esquina inferior derecha, se van solos a los 5 s) en vez de líneas `notice--dismissable` que empujan el composer hacia arriba.
8. **StatusBar por segmentos**: separadores `·` o pequeñas «píldoras» con fondo en provider, modelo, tokens y contexto; el porcentaje de contexto como una barra de 40 px (ya existe `.progress`).
9. **Tipografía propia empaquetada**: Inter (UI) y JetBrains Mono (código) en `woff2` locales con `font-display: swap`, ~150 kB en total y sin red. Da identidad y un render idéntico en Windows, macOS y Linux (hoy depende de `system-ui`). Subconjunto latino para no pagar glifos que no se usan.
10. **Resaltado de sintaxis más rico**: la paleta de `hljs-*` solo cubre seis clases; añadir `hljs-variable`, `hljs-type`, `hljs-meta`, `hljs-tag`/`hljs-name` (HTML/JSX) y `hljs-regexp`. Solo CSS.

### Baja prioridad / más trabajo

11. **Tema claro**: la paleta ya es un objeto de tokens (`theme.ts` → `--color-*`), así que bastaría un segundo objeto y `prefers-color-scheme`. Requiere revisar el contraste AA con `theme.test.ts` y los colores fijos que quedan (`#c42b1c` del cierre, `rgba(245,158,11,…)` del editor JSON).
12. **Ajustes en tarjetas**: agrupar las secciones de `SettingsPanel` en tarjetas con título e icono, como hacen las apps de escritorio modernas.
13. **Transición entre conversaciones**: un `opacity` de 120 ms al cambiar de conversación en el sidebar, para que no «parpadee» el contenido.

### Mejoras de rendimiento que acompañan a lo visual

- **`content-visibility: auto`** (con `contain-intrinsic-size`) en los mensajes cerrados de `.message-list`: en conversaciones largas el navegador deja de maquetar y pintar lo que está fuera de pantalla. Es la contrapartida que permite añadir más detalle visual sin coste. Probarlo con el scroll «pegado» abajo y con el índice (`OutlinePanel`), que salta a anclas.
- **Partir el bundle** (Vite avisa: 671 kB, 205 kB gzip): `common` de lowlight registra ~35 lenguajes al arrancar; cargar el renderer de markdown/resaltado, `SettingsPanel` y `ProviderWizard` con `import()` dinámico acorta el arranque de la ventana.
- Mantener la regla actual: las animaciones nuevas, en `transform`/`opacity`, y cualquier bucle nuevo, detrás de `prefers-reduced-motion`.
