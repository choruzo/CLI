---
name: connector-home-assistant
description: Úsala cuando te pidan consultar o manejar la casa: luces, enchufes, temperatura, persianas, sensores, escenas o cerraduras.
presets: [companion]
---

# Home Assistant: consultar y manejar la casa

Tienes ocho tools del conector Home Assistant: `ha_resumen`, `ha_buscar`,
`ha_estado`, `ha_historial` y `ha_comprobar` (solo lectura) y `ha_encender`,
`ha_apagar` y `ha_accion` (actúan en la casa y piden aprobación a la persona).

## Qué preguntas cubre

- «¿Qué hay en casa?», «¿qué habitaciones tengo?» → `ha_resumen`.
- «¿Está encendida la luz del salón?», «¿qué temperatura hay en el dormitorio?» →
  `ha_buscar` para dar con la entidad y `ha_estado` para su detalle.
- «¿Cuándo se cayó el WLED?», «¿cuánto rato estuvo encendida la calefacción?»,
  «¿qué temperatura hizo anoche?» → `ha_historial`.
- «Enciende la luz del salón al 40 %», «apaga todo el salón», «sube la persiana» →
  `ha_encender` / `ha_apagar`.
- «Cierra la puerta con llave», «activa la alarma», «manda una notificación» →
  `ha_accion`.

## Cómo encadenarlas

1. Si no conoces la casa, empieza por `ha_resumen`: dominios y áreas.
2. `ha_buscar` con `texto` (nombre o parte), `dominio` (`light`, `switch`,
   `sensor`, `climate`…) o `area`. Sin acentos ni mayúsculas. Si salen varias,
   no adivines: pregunta cuál o actúa sobre todas las que la persona pidió.
3. `ha_estado` con el `entity_id` (o una lista de hasta 20) para el detalle.
   `ha_comprobar` es solo lectura y da el estado de UNA entidad (o de un
   atributo) en forma estructurada: sirve para comprobar justo lo que vigilaría
   un vigilante.
4. `ha_historial` con el `entity_id` (o hasta 10) y, o bien `horas` (las
   últimas N hasta ahora; por defecto 24, máximo 168 = 7 días), o bien `desde` y
   `hasta` en hora de la casa (`AAAA-MM-DDTHH:MM`, o `AAAA-MM-DD` para el día
   entero) para un rato concreto: «ayer de 21:00 a 22:00» es `desde`
   `2026-11-19T21:00` y `hasta` `2026-11-19T22:00`. Da el estado al empezar, los
   cambios con su hora, el tiempo en cada estado y, si es un sensor numérico,
   mínimo y máximo (por día si pasa de 24 h). Si salen muchos cambios, enseña
   los últimos; para ver los anteriores, pide un periodo más corto.
5. `ha_encender` y `ha_apagar` aceptan hasta 10 ids a la vez; `brillo` (0-100)
   solo vale con luces. Cubren luces, enchufes, ventiladores, climatización,
   automatizaciones, sirenas, humidificadores y persianas (abrir/cerrar);
   escenas y scripts solo se encienden (ejecutan).
6. `ha_accion` (`dominio`, `servicio`, `entity_id`, `datos`) es para lo demás:
   cerraduras, alarma, escenas con parámetros, notificaciones. `datos` no lleva
   `entity_id`.
7. Tras una acción, la salida lista lo que cambió. Si dice que no hubo cambios,
   puede tardar unos segundos: comprueba con `ha_estado` antes de dar por fallida
   la orden.

## Límites

- Una entidad «no disponible» o «sin dato» no está caída necesariamente: no la
  conviertas en apagada ni en 0.
- Las cerraduras y la alarma son delicadas: confirma con la persona qué quiere
  antes de llamar a `ha_accion`, aunque la aprobación también se le pida.
- Si dice que Home Assistant no está configurado o el token no vale, la persona
  debe ejecutar `stratum connectors setup home-assistant`; tú no puedes hacerlo.
- Si no se resuelve el nombre de la casa, necesita la URL con dominio completo
  (p. ej. `homeassistant.home`) o la IP.
- El historial llega como mucho a 7 días y solo de lo que guarda el recorder de
  Home Assistant; «sin datos» puede ser que no lo guarda. No hay gráficas.
- No puedes crear automatizaciones de Home Assistant (actuarían solas, sin
  aprobación). Si te la piden, escribe la propuesta en YAML para que la persona
  la pegue ella misma en Home Assistant.
- `ha_acceso` es para el diagnóstico: no hace falta usarla salvo que la persona
  pregunte si la conexión funciona.
