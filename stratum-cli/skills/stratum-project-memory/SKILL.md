---
name: stratum-project-memory
description: Úsala antes de guardar o consultar algo de la memoria del proyecto — una decisión técnica, una convención, una preferencia del usuario sobre este repo — o cuando el usuario pida «recuerda», «apunta», «olvida» o pregunte qué se decidió antes.
presets: [coding]
---

# Memoria del proyecto

Trabajas en un proyecto y solo ves **su** memoria. No hay memoria global en esta sesión: lo que guardes se queda en este repositorio.

| Capa | Dónde vive | Para qué |
|---|---|---|
| Decisiones | `<raíz del repo>/.stratum/memory/decisions.json` (con `store_decision` / `recall_decisions`) | Decisiones, convenciones y preferencias que deben sobrevivir a esta tarea |
| `STRATUM.md` | `<raíz del repo>/STRATUM.md` (lo ves ya en tus instrucciones) | Reglas del proyecto que deben estar presentes en **cada** sesión |

La memoria de la conversación (lo que se compacta en sesiones largas) es automática: no tiene tool y no la gestionas tú.

## Antes de decidir: consulta

Si vas a elegir algo que podría estar decidido ya (una librería, un patrón, cómo nombrar, cómo probar), llama antes a `recall_decisions` con una consulta en lenguaje natural. Si devuelve algo aplicable, síguelo y menciónalo; si contradice lo que pide el usuario, pregúntale.

Si responde que el índice semántico no está disponible, sigue sin él: no reintentes.

## Qué guardar con `store_decision`

Guarda solo lo que un agente futuro necesitaría y no podría deducir del código:

- una decisión con su porqué («usamos X en lugar de Y porque…»);
- una convención del proyecto que no está escrita en otro sitio;
- la causa de un bug difícil y cómo se resolvió;
- una preferencia del usuario sobre cómo trabajar en este repo.

Rellena todos los campos: `title` corto (≤ 100), `content` con contexto, alternativas y razón, `type` (`architectural`, `tooling`, `convention`, `bug_fix`, `security`, `user_preference`), hasta 5 `tags` e `importance`.

**No guardes nunca:** secretos, tokens, contraseñas o rutas a credenciales; el estado de la tarea en curso (eso va en `todo`); lo que ya está en `STRATUM.md` o en el código; detalles que solo valen para esta conversación. Además Stratum extrae decisiones por su cuenta al final de cada respuesta: no repitas a mano lo trivial.

## Si `store_decision` devuelve un id que ya existía

La memoria deduplica por significado (similitud ≥ 0,9). Si el id devuelto no es nuevo, **no se guardó nada**: había una decisión casi igual. No reintentes con otras palabras. Si lo nuevo de verdad matiza lo anterior, guárdalo como corrección (abajo).

## Corregir u olvidar

No puedes editar ni borrar decisiones. Para corregir una:

1. Guarda una decisión nueva cuyo `content` empiece por «Sustituye a `dec_…`:» y explique qué cambió y por qué.
2. Dile al usuario que puede borrar la antigua con `stratum memory forget <id>`.

Si el usuario pide olvidar algo, dale ese mismo comando con el id (búscalo con `recall_decisions`).

## Cuándo usar `STRATUM.md`

Para reglas que el agente debe tener siempre delante en este repo (comandos de build y test, convenciones de estilo, zonas que no tocar). Edítalo con `edit_file`, de forma breve: se carga entero en cada sesión. Si la regla es una decisión puntual, mejor `store_decision`. No escribas el `STRATUM.md` global (`~/.stratum/STRATUM.md`): es del asistente, no de este proyecto.

## Modo read-only y modo plan

`store_decision` no está disponible en una sesión read-only ni antes de aprobar un plan. No lo intentes: anota lo que guardarías y propónselo al usuario al final. `recall_decisions` sí funciona.
