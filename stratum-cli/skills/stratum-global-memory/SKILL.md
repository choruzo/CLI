---
name: stratum-global-memory
description: Úsala antes de guardar o consultar algo de tu memoria a largo plazo — una preferencia del usuario, un hecho estable sobre él o su trabajo — o cuando pida «recuerda», «apunta», «olvida» o pregunte qué te contó antes.
presets: [assistant]
---

# Memoria global del asistente

Tu memoria es **global**: la compartes entre todas las conversaciones con este usuario y no pertenece a ningún proyecto. No ves la memoria de los repositorios donde trabaja su agente de código, y lo que guardes no llega allí.

| Capa | Para qué | Cómo |
|---|---|---|
| Decisiones | Preferencias, hechos estables y acuerdos que deben durar | `store_decision` / `recall_decisions` |
| `STRATUM.md` global | Instrucciones permanentes que el usuario escribió para ti | Ya está en tus instrucciones. Solo lectura |

La memoria de la conversación en curso es automática: no tiene tool y no la gestionas tú.

## Antes de responder: consulta

Si una preferencia o un hecho pasado podría cambiar tu respuesta (cómo le gusta que le escribas, a qué se dedica, algo que te pidió recordar), llama antes a `recall_decisions`. Si el índice no está disponible, sigue sin él: no reintentes.

## Qué guardar con `store_decision`

- una preferencia del usuario (tono, idioma, formato, herramientas que usa);
- un hecho estable sobre él o su trabajo que le ayudará en otras conversaciones;
- algo que te pide explícitamente que recuerdes.

Usa `type: user_preference` para preferencias; para lo demás, el que mejor encaje. `title` corto, `content` con el contexto, hasta 5 `tags` e `importance`.

**No guardes nunca:** secretos, contraseñas, datos de pago o de salud que no te haya pedido guardar; detalles de un proyecto concreto (eso es de la memoria de ese proyecto); lo que solo vale para esta conversación. Stratum también extrae recuerdos por su cuenta: no repitas a mano lo trivial.

## Si `store_decision` devuelve un id que ya existía

La memoria deduplica por significado: no se guardó nada nuevo porque ya había algo casi igual. No reintentes con otras palabras.

## Corregir u olvidar

No puedes editar ni borrar recuerdos. Para corregir uno, guarda otro cuyo `content` empiece por «Sustituye a `dec_…`:» con lo que cambió. Si el usuario quiere borrar algo, dile que puede hacerlo con `stratum memory forget --global <id>` (el id lo da `recall_decisions`).

## `STRATUM.md` global

No puedes escribirlo. Si algo merece ser una instrucción permanente («contéstame siempre en inglés»), propón al usuario el texto exacto y dile que lo añada a `~/.stratum/STRATUM.md`; mientras, guárdalo con `store_decision`.
