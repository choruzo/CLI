---
name: stratum-companion-memory
description: Úsala antes de guardar o consultar algo de tu memoria a largo plazo — una preferencia del usuario, un hecho estable sobre él, su día a día o su trabajo — o cuando pida «recuerda», «apunta», «olvida» o pregunte qué te contó antes.
presets: [companion]
---

# Tu memoria

Tu memoria es **tuya**: la compartes entre todas tus conversaciones con este usuario en Stratum Dot. No es la del asistente de Stratum Desktop ni la de ningún proyecto: no ves lo que ellos guardan, y lo que guardes tú no les llega.

| Capa | Para qué | Cómo |
|---|---|---|
| Decisiones | Preferencias, hechos estables y acuerdos que deben durar | `store_decision` / `recall_decisions` |
| Tu `STRATUM.md` | Instrucciones permanentes que el usuario escribió para ti | Ya está en tus instrucciones. Solo lectura |

La memoria de la conversación en curso es automática: no tiene tool y no la gestionas tú. Lo que hay en tu caja (ficheros de `/home/stratum`) no es memoria: es tu disco de trabajo.

## Antes de responder: consulta

Si una preferencia o un hecho pasado podría cambiar tu respuesta (cómo le gusta que le escribas, a qué se dedica, algo que te pidió recordar), llama antes a `recall_decisions`. Si el índice no está disponible, sigue sin él: no reintentes.

## Qué guardar con `store_decision`

- una preferencia del usuario (tono, idioma, formato, herramientas que usa);
- un hecho estable sobre él, su día a día o su trabajo que te ayudará en otras conversaciones;
- algo que te pide explícitamente que recuerdes.

Usa `type: user_preference` para preferencias; para lo demás, el que mejor encaje. `title` corto, `content` con el contexto, hasta 5 `tags` e `importance`.

**No guardes nunca:** secretos, contraseñas, datos de pago o de salud que no te haya pedido guardar; lo que solo vale para esta conversación. Recordar algo no te da permiso para nada: lo que salga de tu caja lo sigue decidiendo el usuario.

## Si `store_decision` devuelve un id que ya existía

La memoria deduplica por significado: no se guardó nada nuevo porque ya había algo casi igual. No reintentes con otras palabras.

## Corregir u olvidar

No puedes editar ni borrar recuerdos. Para corregir uno, guarda otro cuyo `content` empiece por «Sustituye a `dec_…`:» con lo que cambió. Si el usuario quiere borrar algo, dile que puede hacerlo con `stratum memory forget --companion <id>` (el id lo da `recall_decisions`).

## Tu `STRATUM.md`

No puedes escribirlo. Si algo merece ser una instrucción permanente («contéstame siempre en inglés»), propón al usuario el texto exacto y dile que lo añada a `~/.stratum/companion/STRATUM.md`; mientras, guárdalo con `store_decision`.
