---
name: connector-open-meteo
description: Úsala cuando te pregunten por el tiempo, la temperatura, la lluvia, el viento o la previsión de un lugar.
presets: [companion]
---

# Open-Meteo: tiempo y previsión

Tienes tres tools del conector Open-Meteo (sin cuenta ni clave): `buscar_lugar`,
`tiempo_actual` y `prevision`. Todas son de solo lectura.

## Qué preguntas cubre

- «¿Qué tiempo hace ahora en Sevilla?», «¿cuántos grados hay?», «¿hace viento?» → `tiempo_actual`.
- «¿Llueve mañana en Bilbao?» → `prevision` con `dias: 2` (hoy y mañana).
- «¿Qué tiempo hará el fin de semana?» → `prevision` con `dias` de 5 a 7.
- «¿Cómo va a evolucionar la tarde?» → `prevision` con `por_horas: true`.

## Cómo encadenarlas

1. Pasa el nombre tal cual en `lugar` a `tiempo_actual` o `prevision`.
2. Si hay varios lugares con ese nombre, la tool no adivina: te devuelve la lista
   con sus ids. Pregunta al usuario cuál es, o elige por el contexto que ya tengas
   (su ciudad, su país), y repite con `lugar: "geo:<id>"`.
3. `pais` (código ISO-2, p. ej. `ES`) filtra candidatos y evita la ambigüedad.
4. `buscar_lugar` sirve para ver candidatos de antemano o para obtener un id.
5. Si la salida dice «Interpreté X como Y», dilo al usuario por si era otro lugar.

## Límites

- Previsión de 7 días como máximo; para más allá, di que no hay datos fiables.
- No hay históricos (qué tiempo hizo ayer o el año pasado).
- No hay alertas oficiales (AEMET u otras): ante una tormenta fuerte, no
  sustituyas el aviso oficial y recomienda consultarlo.
- Un valor «sin dato» es que la fuente no lo trae; no lo conviertas en 0.

## Atribución

Al dar los datos, cita siempre «Datos: Open-Meteo.com». Resume la salida con
tus palabras: no pegues la lista entera si el usuario solo preguntó algo concreto.
