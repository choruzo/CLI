---
name: connector-renfe
description: Úsala cuando te pregunten por trenes de Cercanías o Rodalies: próximas salidas, cómo ir de una estación a otra, dónde va un tren, retrasos o incidencias.
presets: [companion]
---

# Renfe Cercanías y Rodalies

Tienes siete tools del conector Renfe (sin cuenta ni clave), todas de solo lectura:
`cercanias_nucleos`, `cercanias_lineas`, `cercanias_estaciones`, `cercanias_salidas`,
`cercanias_trayecto`, `cercanias_tren` y `cercanias_avisos`. Devuelven texto ya
resumido, con las horas en hora de Madrid y el retraso calculado.

## Qué preguntas cubre

- «¿Cuándo sale el próximo a Alcalá desde Atocha?» → `cercanias_salidas` con `estacion` y `destino`.
- «¿Qué trenes salen de Sol ahora?» → `cercanias_salidas` solo con `estacion` (`linea` filtra por línea).
- «¿Cómo voy de Sol al aeropuerto?» → `cercanias_trayecto` con `origen` y `destino`
  (directo, o con un transbordo si no hay directo en las próximas 2 horas).
- «¿Dónde va el tren 23537?» → `cercanias_tren` (número corto o trip_id): posición, retraso, vía y paradas.
- «¿Hay incidencias en la R2?» → `cercanias_avisos` con `linea` (y `nucleo` si el nombre se repite).
- «¿Qué líneas hay en Valencia?» → `cercanias_nucleos` y `cercanias_lineas`.

## Cómo encadenarlas

1. Pasa el nombre de la estación tal cual («atocha», «pza catalunya»): no hace falta acento ni mayúsculas.
2. Si hay varias estaciones posibles (p. ej. «Sol» en dos núcleos), la tool no adivina:
   te da los candidatos con su núcleo y un id `est:<id>`. Pregunta al usuario o elige por
   contexto y repite con ese id.
3. Las líneas se piden por id (`madrid/C3`) o por nombre corto con `nucleo` (`C3` + `madrid`).
   `cercanias_lineas` y `cercanias_estaciones` te dan los ids y los transbordos.
4. «Sin datos de tiempo real» es que Renfe no informa de ese tren: di que es el horario, no un retraso de 0.
   «Estimado» es un retraso arrastrado de una parada anterior.

## Límites

- Solo Cercanías y Rodalies. Larga y media distancia todavía no.
- Sin precios, sin venta de billetes ni reservas.
- Horarios de aproximadamente un mes; en el trayecto, como mucho un transbordo.
- Un fallo del tiempo real no es un error: la respuesta sale con el horario.

## Atribución

Cita siempre el origen de los datos («Origen de los datos: Renfe Operadora») y la fecha
de los horarios, y no insinúes que Renfe respalda este servicio. Resume la salida con tus
palabras: no pegues la lista entera si preguntaron algo concreto.
