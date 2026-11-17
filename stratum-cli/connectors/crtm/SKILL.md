---
name: connector-crtm
description: Úsala cuando te pregunten por el transporte público de Madrid: metro ligero, autobuses de la EMT o estaciones y líneas de Metro (cuándo pasa, cada cuánto, qué líneas paran, cómo ir de una parada a otra).
presets: [companion]
---

# Transporte de Madrid: Metro, Metro Ligero y EMT

Cuatro tools del conector CRTM (sin cuenta ni clave), todas de solo lectura, con los datos abiertos
del Consorcio Regional de Transportes de Madrid. Devuelven texto ya resumido y en hora de Madrid.

- `transporte_paradas`: buscar estaciones y paradas por nombre, o listar las de una línea en orden.
- `transporte_lineas`: líneas de un modo (`metro`, `ml` = Metro Ligero, `emt`) y sus paradas.
- `transporte_salidas`: próximas salidas desde una parada.
- `transporte_trayecto`: trayectos directos de una parada a otra.

## Qué da cada modo

- **Metro Ligero (`ml`)**: horas exactas («sale 18:42, en 6 min»).
- **EMT (`emt`)**: autobuses por **frecuencia según horario** («cada 8 min, hasta las 09:00»); no hay horas exactas y no se inventan.
- **Metro (`metro`)**: estaciones, líneas y correspondencias, pero **sin horarios**: el calendario que publica el CRTM
  está caducado y la tool lo dice. No des horas ni frecuencias de Metro de memoria.

## Cómo encadenarlas

1. «¿Cuándo pasa el ML1 por Las Tablas?» → `transporte_salidas` con `parada: "Las Tablas"` y `linea: "ML1"`.
2. «¿Cada cuánto pasa el 27 en Cibeles?» → `transporte_salidas` con `parada`, `linea: "27"` y `modo: "emt"`.
3. «¿Qué líneas paran en Plaza de Castilla?» → `transporte_paradas` con el nombre: lista modo, líneas e id.
4. Si el nombre es ambiguo (una calle con varias paradas de EMT, o el mismo nombre en Metro y en autobús), la tool
   no adivina: devuelve candidatas con su id `modo:id`. Elige por contexto o pregunta, y repite con ese id.
5. «¿Qué paradas tiene la línea 27?» → `transporte_paradas` con `linea` y `modo` (sin `nombre`), o `transporte_lineas`.
6. «¿Cómo voy de A a B?» → `transporte_trayecto`: solo **directos** en una misma línea. Si no hay, dilo y mira
   `transporte_salidas` en el origen.
7. `linea` admite `ML1`, `L1` (Metro) y `27` (EMT); un número suelto existe en Metro y en EMT, así que pon `modo`.

## Límites

- **Sin tiempo real**: nada de retrasos, posición ni «el autobús llega en 3 min». Todo es «según horario».
- Metro sin horario vigente (ver arriba). Sin trayectos con transbordo ni cambios entre modos.
- Sin autobuses interurbanos ni de otros municipios, Cercanías (eso es Renfe) ni precios.
- Es lo publicado: una obra o un desvío no aparecen.

## Atribución

Cita siempre el origen de los datos («CRTM», y «EMT Madrid» cuando haya autobuses) y la fecha de los horarios que
trae la salida, y no insinúes que el CRTM o la EMT respaldan este servicio. Resume con tus palabras: no pegues
la lista entera si preguntaron algo concreto.
