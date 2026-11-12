---
name: connector-home-assistant
description: Úsala cuando te pidan consultar o manejar la casa: luces, enchufes, temperatura, persianas, sensores, escenas o cerraduras.
presets: [companion]
---

# Home Assistant: consultar y manejar la casa

Tienes seis tools del conector Home Assistant: `ha_resumen`, `ha_buscar` y
`ha_estado` (solo lectura) y `ha_encender`, `ha_apagar` y `ha_accion` (actúan en
la casa y piden aprobación a la persona).

## Qué preguntas cubre

- «¿Qué hay en casa?», «¿qué habitaciones tengo?» → `ha_resumen`.
- «¿Está encendida la luz del salón?», «¿qué temperatura hay en el dormitorio?» →
  `ha_buscar` para dar con la entidad y `ha_estado` para su detalle.
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
4. `ha_encender` y `ha_apagar` aceptan hasta 10 ids a la vez; `brillo` (0-100)
   solo vale con luces. Cubren luces, enchufes, ventiladores, climatización,
   automatizaciones, sirenas, humidificadores y persianas (abrir/cerrar);
   escenas y scripts solo se encienden (ejecutan).
5. `ha_accion` (`dominio`, `servicio`, `entity_id`, `datos`) es para lo demás:
   cerraduras, alarma, escenas con parámetros, notificaciones. `datos` no lleva
   `entity_id`.
6. Tras una acción, la salida lista lo que cambió. Si dice que no hubo cambios,
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
- No hay históricos ni gráficas: solo el estado actual.
