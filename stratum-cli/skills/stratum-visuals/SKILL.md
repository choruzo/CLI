---
name: stratum-visuals
description: Úsala antes de responder cuando una explicación gane con un gráfico, una tabla de métricas, un diagrama de un proceso o una comparación visual — cantidades que comparar, una evolución en el tiempo, proporciones, pasos o partes de un sistema — o cuando el usuario pida «gráfico», «visual», «diagrama» o «muéstramelo».
presets: [assistant]
---

# Visuales en la respuesta

En Desktop puedes acompañar el texto con un visual: un bloque de código con lenguaje `visual` que contiene un fragmento HTML. Desktop lo pinta en el chat cuando la valla se cierra.

## Cuándo usar uno

| Qué quieres mostrar | Forma |
|---|---|
| Comparar categorías | Barras horizontales |
| Evolución en el tiempo | Líneas |
| Parte de un todo | Barra apilada al 100 % (tarta solo si hay 4–5 porciones o menos) |
| Métricas clave | Fichas KPI |
| Proceso o flujo | Pasos con flechas |
| Jerarquía o arquitectura | Cajas anidadas |

## Cuándo no

- Un solo número o una respuesta corta.
- Algo que una tabla markdown resuelve igual de bien.
- Cuando no tienes datos.

**Nunca inventes cifras.** Usa las que dio el usuario, las de un fichero o las de una búsqueda, y di la fuente en el texto. Si son ilustrativas o aproximadas, dilo en el título del visual.

## El texto manda

El visual acompaña, no sustituye. La conclusión va en el texto, antes o después del bloque. El visual lleva título, unidades y, si aplica, la fuente en pequeño. Un visual por idea; como mucho dos o tres por respuesta.

## El formato

- Se pinta HTML, CSS (`<style>` inline o atributos `style`) y SVG inline. Va en un `<iframe>` sin scripts.
- **JavaScript no se ejecuta**: ni `<script>` ni `on*=`. Nada de Chart.js, D3, canvas dibujado con JS ni animaciones con JS.
- **Nada externo carga**: ni imágenes remotas, ni hojas de estilo, ni fuentes de Google, ni `<link>`. Solo `data:` en imágenes.
- Los enlaces no se pueden pulsar dentro del visual. Ponlos en el texto, fuera del bloque.
- El fondo es transparente sobre el tema oscuro de la app. Ya hay `body { margin: 0 }`, el color de texto y la fuente de la app.
- Variables CSS: `--color-accent`, `--color-accentBright`, `--color-success`, `--color-error`, `--color-warning`, `--color-textPrimary`, `--color-textResponse`, `--color-textMuted`, `--color-textFaint`, `--color-borderSubtle`, `--color-borderMedium`, `--color-bgPanel`. Para series: `--viz-1` … `--viz-6` (ámbar, turquesa, violeta, celeste, rosa, lima), `--viz-grid` (rejilla) y `--viz-axis` (ejes y etiquetas). Úsalas en vez de colores a mano: `fill="var(--viz-1)"` o `style="fill: var(--viz-1)"`.
- El ancho es fluido: ocupa el ancho del mensaje (unos 600–900 px). La altura se ajusta sola al contenido, hasta 1200 px. En SVG: `viewBox` y `width="100%"`, sin alto fijo en px.
- Mientras la respuesta llega se ve «preparando visual…»; el usuario puede alternar a ver el HTML.
- Mantenlo pequeño: menos de unos 15 KB.

## Diseño

- Etiqueta directamente las marcas en vez de poner una leyenda, si caben.
- No codifiques solo con color: añade etiqueta, posición o símbolo.
- Rejilla tenue (`--viz-grid`). Las barras parten de cero.
- Números con su unidad y un redondeo sensato.
- Ordena las barras por valor, salvo que el orden tenga sentido propio (meses).
- Texto de 12 px o más y contraste suficiente sobre fondo oscuro.
- Dentro de cada `<svg>`, un `<title>` que describa el gráfico para accesibilidad.

## Plantillas

La valla exterior `~~~~` solo sirve para enseñarlas aquí: en tu respuesta escribe únicamente el bloque ```visual.

Barras horizontales (SVG, escala 4 px por unidad desde x = 150):

~~~~
```visual
<svg viewBox="0 0 600 220" width="100%" role="img">
  <title>Tiempo de respuesta por servicio, en ms (cifras ilustrativas)</title>
  <line x1="150" y1="10" x2="150" y2="205" style="stroke: var(--viz-axis)" />
  <g style="font-size: 13px; fill: var(--viz-axis)">
    <text x="140" y="39" text-anchor="end">API</text>
    <text x="140" y="89" text-anchor="end">Auth</text>
    <text x="140" y="139" text-anchor="end">Búsqueda</text>
    <text x="140" y="189" text-anchor="end">Correo</text>
  </g>
  <rect x="150" y="20" width="336" height="28" rx="3" style="fill: var(--viz-1)" />
  <rect x="150" y="70" width="248" height="28" rx="3" style="fill: var(--viz-1)" />
  <rect x="150" y="120" width="148" height="28" rx="3" style="fill: var(--viz-1)" />
  <rect x="150" y="170" width="84" height="28" rx="3" style="fill: var(--viz-1)" />
  <g style="font-size: 13px; fill: var(--color-textPrimary)">
    <text x="494" y="39">84 ms</text>
    <text x="406" y="89">62 ms</text>
    <text x="306" y="139">37 ms</text>
    <text x="242" y="189">21 ms</text>
  </g>
</svg>
```
~~~~

Fichas KPI (HTML y CSS):

~~~~
```visual
<style>
  .kpis { display: flex; flex-wrap: wrap; gap: 12px; }
  .kpi { flex: 1 1 160px; padding: 14px 16px; border: 1px solid var(--color-borderSubtle); border-radius: 8px; background: var(--color-bgPanel); }
  .kpi .v { font-size: 28px; font-weight: 600; color: var(--color-textPrimary); }
  .kpi .l { font-size: 13px; color: var(--color-textMuted); }
  .kpi .d { margin-top: 4px; font-size: 13px; }
  .up { color: var(--color-success); }
  .down { color: var(--color-error); }
</style>
<div class="kpis">
  <div class="kpi"><div class="v">1.240</div><div class="l">Usuarios activos</div><div class="d up">▲ 8 % vs. mes anterior</div></div>
  <div class="kpi"><div class="v">3,2 %</div><div class="l">Conversión</div><div class="d down">▼ 0,4 pt vs. mes anterior</div></div>
  <div class="kpi"><div class="v">48 s</div><div class="l">Tiempo medio</div><div class="d up">▲ 5 s vs. mes anterior</div></div>
</div>
```
~~~~

Proceso de cuatro pasos (flex que se adapta al ancho):

~~~~
```visual
<style>
  .flow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .step { flex: 1 1 130px; padding: 12px; text-align: center; font-size: 14px; border: 1px solid var(--color-borderMedium); border-radius: 8px; background: var(--color-bgPanel); color: var(--color-textPrimary); }
  .step small { display: block; margin-top: 2px; font-size: 12px; color: var(--color-textMuted); }
  .arrow { color: var(--viz-axis); font-size: 18px; }
</style>
<div class="flow">
  <div class="step">1. Recoger<small>datos de entrada</small></div>
  <span class="arrow">→</span>
  <div class="step">2. Validar<small>formato y rangos</small></div>
  <span class="arrow">→</span>
  <div class="step">3. Procesar<small>cálculo y reglas</small></div>
  <span class="arrow">→</span>
  <div class="step">4. Entregar<small>informe final</small></div>
</div>
```
~~~~

**No hagas nunca:**

- `<script>` ni atributos `on*=`: no se ejecutan.
- Recursos externos (imágenes, hojas de estilo, fuentes, `<link>`).
- Colores fijos que ignoren el tema, como un fondo blanco.
- Visuales decorativos sin datos.
- Cifras inventadas presentadas como reales.
- Meter el visual en `outputs/` cuando el usuario solo quería verlo en el chat. Si quiere el fichero, entonces sí: un `.html` en `outputs/`.
