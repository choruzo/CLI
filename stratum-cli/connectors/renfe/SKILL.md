---
name: connector-renfe
description: Úsala cuando te pregunten por trenes de Renfe: Cercanías o Rodalies (salidas, trayectos, incidencias) y larga o media distancia (AVE, AVLO, Alvia, Intercity, Euromed, MD, Regional: horarios, retrasos, cancelaciones).
presets: [companion]
---

# Renfe: Cercanías, Rodalies y larga y media distancia

Diez tools del conector Renfe (sin cuenta ni clave), todas de solo lectura. Devuelven texto
ya resumido, con las horas en hora de Madrid y el retraso calculado.

- **Cercanías y Rodalies** (trenes de núcleo urbano: C1, R2…): `cercanias_nucleos`, `cercanias_lineas`,
  `cercanias_estaciones`, `cercanias_salidas`, `cercanias_trayecto`, `cercanias_tren`, `cercanias_avisos`.
- **Larga y media distancia** (AVE, AVLO, Alvia, Intercity, Euromed, MD, Regional…): `trenes_salidas`,
  `trenes_trayecto`, `trenes_tren`.

## Cuál usar

- «¿Cuándo sale el próximo a Alcalá desde Atocha?» → `cercanias_salidas` (`estacion`, `destino`).
- «¿Cómo voy de Sol al aeropuerto?» → `cercanias_trayecto` (directo o con un transbordo).
- «¿Hay incidencias en la R2?» → `cercanias_avisos`. «¿Qué líneas hay en Valencia?» → `cercanias_nucleos` y `cercanias_lineas`.
- «¿Qué AVE salen de Atocha hacia Sevilla?» → `trenes_salidas` (`estacion`, `destino`, `producto` opcional).
- «¿Cómo llego de Madrid a Barcelona mañana?» → `trenes_trayecto` con `fecha: "mañana"`.
- «¿Dónde va el AVE 3123?» → `trenes_tren` con el número (`3123`, con o sin ceros): cancelación, retraso, posición y recorrido.
- Si la ruta es entre ciudades, es larga distancia (`trenes_*`); si es dentro de una ciudad o su área, Cercanías.

## Cómo encadenarlas

1. Pasa el nombre de la estación tal cual («atocha», «sevilla»): sin acento ni mayúsculas.
2. Si hay varias estaciones posibles («Madrid» tiene Atocha, Chamartín…), la tool no adivina: devuelve los
   candidatos con su id (`est:<id>` en Cercanías, `ld:<id>` en larga distancia). Pregunta al usuario o elige
   por contexto y repite con ese id.
3. Las líneas de Cercanías se piden por id (`madrid/C3`) o por nombre corto con `nucleo`.
4. En larga distancia `fecha` es `"YYYY-MM-DD"`, `"hoy"` o `"mañana"` (por defecto hoy) y `desde` una hora `"HH:MM"`.
   El tiempo real solo existe para hoy: otro día devuelve el horario. Si la fecha se sale de los horarios, la tool dice hasta qué día llegan.
5. «Sin datos de tiempo real» es que Renfe no informa de ese tren: es el horario, no un retraso de 0. «Estimado» es un retraso arrastrado de una parada anterior.

## Límites

- Sin precios, billetes, reservas ni plazas.
- Cercanías: hasta un transbordo, y avisos de incidencias. Larga distancia: **solo trenes directos, sin
  transbordos ni avisos**; si no hay directo, dilo y mira `trenes_salidas` en el origen.
- Las cancelaciones y retrasos de hoy salen del tiempo real de Renfe (en una huelga, muchos trenes
  salen «cancelado»); no los inventes si dice «sin datos de tiempo real».
- Horarios de aproximadamente un mes (Cercanías) o varios meses (larga distancia). Un fallo del tiempo real no
  es un error: la respuesta sale con el horario.

## Atribución

Cita siempre el origen de los datos («Origen de los datos: Renfe Operadora») y la fecha de los horarios, y no
insinúes que Renfe respalda este servicio. Resume la salida con tus palabras: no pegues la lista entera si
preguntaron algo concreto.
