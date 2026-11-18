---
name: connector-crtm
description: Úsala cuando te pregunten por el transporte público de Madrid: metro, metro ligero, autobuses de la EMT, autobuses urbanos de otros municipios o interurbanos (cuándo pasa, cada cuánto, qué líneas paran, cómo ir de una parada a otra).
presets: [companion]
---

# Transporte de Madrid: Metro, Metro Ligero y autobuses

Cuatro tools del conector CRTM (sin cuenta ni clave), todas de solo lectura, con los datos abiertos
del Consorcio Regional de Transportes de Madrid. Devuelven texto ya resumido y en hora de Madrid.

- `transporte_paradas`: buscar estaciones y paradas por nombre, o listar las de una línea en orden.
- `transporte_lineas`: líneas de un modo y sus paradas.
- `transporte_salidas`: próximas salidas desde una parada.
- `transporte_trayecto`: trayectos directos de una parada a otra.

## Los cinco modos

| `modo`        | Qué es                                                                                   | Horarios                                                                        |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `metro`       | Metro de Madrid                                                                          | **sin horario vigente**: estaciones, líneas y correspondencias sí; no des horas |
| `ml`          | Metro Ligero                                                                             | horas exactas                                                                   |
| `emt`         | autobuses de la EMT (Madrid capital)                                                     | **por frecuencia** («cada 8 min hasta las 09:00»); nunca horas exactas          |
| `urbano`      | autobuses urbanos de los **demás municipios** (Aranjuez, Pinto, Valdemoro, Tres Cantos…) | horas exactas                                                                   |
| `interurbano` | autobuses **interurbanos** (los 6xx de Moncloa a la Sierra, los 4xx a la Sagra…)         | horas exactas                                                                   |

`modo` acepta esos ids o su nombre («Metro Ligero», «bus interurbano», «autobuses urbanos»).

Si no sabes el modo y el número de línea no está en varias redes, **no hace falta decirlo**: la tool
busca en todos y resuelve sola. Solo hay que decidir cuando avisa de que hay varias.

## Cuando la línea o la parada es ambigua: no adivines

- Un mismo número existe en varias redes (el 1 está en Metro, en la EMT y en el urbano de Aranjuez y
  de Ciempozuelos), y dentro de una red el número se repite entre municipios (el 1 de Aranjuez y el 1
  de Ciempozuelos son dos líneas distintas). La tool **no elige**: devuelve los candidatos con su id
  `modo:línea` (`urbano:9__1__040_`) y con el nombre largo, que es lo que suele decir el municipio.
- Lo mismo con las paradas: devuelve candidatas con su id `modo:id`. Repite la consulta con `modo`,
  con el id de la línea o con el de la parada, o pregunta a la persona cuál quiere.
- El **municipio** solo aparece cuando el GTFS lo trae en el nombre largo de la línea («CIRCULAR DE
  CIEMPOZUELOS», «MADRID (Moncloa)-MONTE ROZAS»). El feed del CRTM publica una sola agencia para
  todas las redes de autobús, así que no inventes de qué pueblo es una línea si el nombre no lo dice.

## Cómo encadenarlas

1. «¿Cuándo pasa el ML1 por Las Tablas?» → `transporte_salidas` con `parada: "Las Tablas"` y `linea: "ML1"`.
2. «¿Cada cuánto pasa el 27 en Cibeles?» → `transporte_salidas` con `parada`, `linea: "27"` y `modo: "emt"`.
3. «¿Cuándo pasa el 625 en Moncloa?» → `transporte_salidas` con `parada` y `linea: "625"` (solo existe en
   los interurbanos, no hace falta `modo`). Si Moncloa le devuelve varias paradas por sentido, repite con
   el id de la que quiera (el intercambiador que agrupa todos los andenes es `est_90_14`).
4. «¿Qué líneas paran en Plaza de Castilla?» → `transporte_paradas` con el nombre: lista modo, líneas e id.
5. «¿Qué paradas tiene la línea 27?» → `transporte_paradas` con `linea` y `modo` (sin `nombre`), o `transporte_lineas`.
6. «¿Cómo voy de A a B?» → `transporte_trayecto`: solo **directos** en una misma línea. Si no hay, dilo y
   mira `transporte_salidas` en el origen.
7. `linea` admite `ML1`, `L1` (Metro), `27` (EMT), `625` (interurbano) y el id `modo:línea` cuando hace falta.

## Límites

- **Sin tiempo real**: nada de retrasos, posición ni «el autobús llega en 3 min». Todo es «según horario».
- Metro sin horario vigente (ver arriba). Sin trayectos con transbordo ni cambios entre modos.
- Sin Cercanías (eso es Renfe), sin precios y sin municipios que el feed no nombre.
- Es lo publicado: una obra o un desvío no aparecen.

## Atribución

Cita siempre el origen de los datos («CRTM», y «EMT Madrid» cuando haya autobuses de la EMT) y la fecha de
los horarios que trae la salida, y no insinúes que el CRTM o la EMT respaldan este servicio. Resume con tus
palabras: no pegues la lista entera si preguntaron algo concreto.
