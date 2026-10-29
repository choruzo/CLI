---
name: stratum-skill-authoring
description: Úsala cuando el usuario quiera crear, escribir, mejorar o revisar una skill de Stratum, o convertir una forma de trabajar que repite en instrucciones reutilizables.
presets: [coding, assistant, companion]
---

# Diseñar una skill

Una skill es un fichero markdown con instrucciones para un tipo de tarea. Stratum pone en tus instrucciones solo su nombre y su `description`; el cuerpo se carga con `read_skill` cuando la tarea encaja. Por eso la `description` decide si la skill se usa, y el cuerpo, si se usa bien.

## 1. Entiende la tarea antes de escribir

Pregunta (con `question`, en una sola tanda) lo que no sepas:

- ¿Qué tarea concreta cubre y qué frases usaría el usuario al pedirla?
- ¿Qué hace hoy mal o de forma inconsistente el agente sin ella?
- ¿Para el agente de código, para el asistente o para ambos?
- ¿Solo para un proyecto o para todos los del usuario?

## 2. Escribe el frontmatter

```markdown
---
name: nombre-en-minusculas-con-guiones
description: Úsala cuando … (disparadores concretos: verbos, objetos, frases del usuario).
presets: [coding]          # coding, assistant, o ambos
---
```

- `name`: corto, en minúsculas, con guiones. Una skill con el mismo nombre que otra de menor precedencia la sustituye.
- `description`: empieza por «Úsala cuando…» y nombra situaciones reconocibles, no el contenido. Mal: «Guía de despliegue». Bien: «Úsala cuando el usuario pida desplegar, publicar una release o subir a producción».
- `presets`: sin él la skill vale solo para el agente de código.

## 3. Escribe el cuerpo

- Pasos accionables en imperativo, en el orden en que se hacen. Nada de teoría ni de historia.
- Lo que el agente no sabría solo: comandos exactos, rutas, criterios para decidir, errores típicos y cómo evitarlos.
- Qué no hacer, si hay un error frecuente.
- Cómo comprobar que salió bien (un comando, un resultado esperado).
- Breve: si pasa de una pantalla, probablemente son dos skills.
- No incluyas secretos ni datos personales: la skill puede compartirse.

## 4. Guárdala en su sitio

| Para                            | Ruta                                     |
| ------------------------------- | ---------------------------------------- |
| Este proyecto                   | `<repo>/.stratum/skills/<name>/SKILL.md` |
| Todos los proyectos del usuario | `~/.stratum/skills/<name>/SKILL.md`      |

Precedencia: proyecto > usuario > las de serie de Stratum. Las nuevas se ven al empezar la siguiente sesión (`stratum skills list` las enumera).

**Si eres el asistente** (no puedes escribir fuera de tu carpeta): escribe el fichero en `outputs/<name>/SKILL.md` y dile al usuario a qué ruta de la tabla copiarlo. Recuerda que el asistente solo carga las skills de serie de Stratum: una skill de usuario la usará su agente de código.

**Si eres el asistente de Stratum Dot** (trabajas en tu caja y no ves los ficheros del usuario): escribe el fichero en la carpeta compartida, `/exchange/<name>/SKILL.md`, y dile al usuario a qué ruta de la tabla copiarlo. Tú tampoco cargas skills de usuario: la usará su agente de código.

## 5. Revísala con el usuario

Enséñale la `description` y pregúntale si reconoce en ella las frases con las que pediría esa tarea. Si no, reescríbela: es lo que más importa.
