# Prompt caching: qué se mide y cómo se ordena el prompt

Un backend que cachea el prompt solo reutiliza un **prefijo**: procesa de nuevo todo lo que viene
detrás del primer byte que cambia respecto a una petición anterior. Stratum no cachea respuestas ni
guarda prompts por su cuenta; lo que hace es

1. **medir** cuánto del prompt reutilizó el backend en cada llamada, con los datos que el propio
   backend reporta, y
2. **ordenar** el prompt de lo más estable a lo más variable para que ese prefijo sea lo más largo
   posible.

Todo sale de la traza de sesión (`src/trace/`): no hay almacenamiento ni telemetría aparte.

- [Qué se mide](#qué-se-mide)
- [Dónde se ve](#dónde-se-ve)
- [Cómo se ordena el prompt](#cómo-se-ordena-el-prompt)
- [Qué invalida el prefijo](#qué-invalida-el-prefijo)
- [Capacidades por provider](#capacidades-por-provider)
- [Escenarios de eval](#escenarios-de-eval)
- [Las preguntas que se pueden contestar](#las-preguntas-que-se-pueden-contestar)
- [Resultados medidos](#resultados-medidos)
- [Limitaciones](#limitaciones)

## Qué se mide

### Uso de caché de una llamada

El `usage` de cada backend se normaliza a una forma común (`TokenUsage` / `CacheUsage` en
`src/providers/cache.ts`):

| Campo | Significado |
|---|---|
| `promptTokens` | Tokens de entrada **totales**, incluidos los servidos de caché. |
| `cachedReadTokens` | Tokens de entrada que el backend sirvió de su caché. |
| `cacheWriteTokens` | Tokens que la llamada escribió en caché (solo lo reporta Anthropic). |
| `uncachedPromptTokens` | `promptTokens − cachedReadTokens`: lo que hubo que procesar. Derivado. |
| `cacheHitRate` | `cachedReadTokens / promptTokens`. Derivado. |

De dónde sale `cachedReadTokens`, por orden de preferencia:

| Backend | Campo que se lee |
|---|---|
| OpenAI, vLLM (`--enable-prompt-tokens-details`), llama.cpp reciente, LiteLLM | `usage.prompt_tokens_details.cached_tokens` |
| Anthropic (nativo o a través de LiteLLM / OpenRouter) | `usage.cache_read_input_tokens` (y `cache_creation_input_tokens` como escritura) |
| DeepSeek | `usage.prompt_cache_hit_tokens` |
| llama.cpp | `timings.cache_n` (tokens del prompt reutilizados del KV cache) |

**Nunca se estima.** Si el backend no reporta ninguno de esos campos, `cachedReadTokens` queda sin
definir y con él todos los derivados: en la traza no aparece, en las métricas es `null` y en los
informes sale `n/d`. Un `0` reportado, en cambio, es un dato: una llamada fría. Ollama, por ejemplo,
reutiliza su KV cache pero su API compatible no dice cuánto: de él solo se obtiene la estabilidad del
prefijo (más abajo).

Dos casos de borde que la normalización resuelve: el formato nativo de Anthropic deja `input_tokens`
**sin** lo cacheado (se suma), y una pasarela que reporte más tokens leídos de caché que
`prompt_tokens` se trata igual.

### Fría y templada

Una llamada es **fría** (`cold`) si el backend no reutilizó nada (`cachedReadTokens === 0`) y
**templada** (`warm`) si reutilizó algo. Sale del dato, no de la posición: la primera llamada de una
sesión puede ser templada (otra sesión dejó el prefijo en caché) y la décima puede ser fría (la caché
caducó). El TTFT —tiempo hasta el primer token, que ya estaba en la traza— se agrega por separado
para cada clase (`ttftColdMs`, `ttftWarmMs`).

### Estabilidad del prefijo (lado cliente)

Además de lo que diga el backend, el `TraceRecorder` compara el prompt de cada llamada con el de la
anterior **del mismo agente** y anota en el paso (`data.prefix`):

| Campo | Significado |
|---|---|
| `chars` | Tamaño del prompt, en el orden en que un backend lo procesa: tools, system, conversación. |
| `sharedChars` | Caracteres iniciales idénticos a los de la llamada anterior. Ausente en la primera llamada de un agente en ese proceso. |
| `diverged` | Dónde deja de coincidir: `tools`, `system` o `history`. Ausente si solo se añadió al final. |
| `divergedAt` | Índice del mensaje que cambió. |
| `tools`, `system` | Huella (8 hex de sha1) de los schemas de tools y del prompt del sistema. |

Es lo que una caché de prefijo **podría** reutilizar, y funciona con cualquier backend. A la traza va
el recuento, nunca el texto: el prompt anterior se retiene solo en memoria para compararlo, y las
definiciones de tools no se escriben en ningún registro.

La métrica agregada es `prefixStability`: caracteres compartidos / caracteres totales, sobre las
llamadas que tienen con qué compararse.

### Roturas de caché

Una **rotura de caché** es una pérdida **demostrable con lo que reporta el backend**, y solo eso.
`cacheBreaks(model)` (`src/trace/model.ts`) marca una cuando una llamada leyó de caché **menos
tokens que la llamada anterior** del mismo agente: esos tokens estaban en caché —el backend los
sirvió— y han dejado de servir.

No es «todo el potencial de caché que podría haberse reutilizado». En concreto, **no** es una rotura:

- que una llamada lea más (o lo mismo) que la anterior sin llegar al prompt anterior entero, aunque
  Stratum haya reescrito el prompt entre medias (`prefix.diverged`). Ningún backend reporta cuánto
  del prompt anterior dejó guardado —hay granularidad de bloque, tamaño mínimo cacheable y
  caducidad—, así que ahí no hay pérdida que demostrar;
- nada que salga solo de `prefix.sharedChars`: son caracteres medidos en el cliente y **no se
  convierten a tokens**;
- una llamada cuyo backend no reporta caché: ni rompe ni corta la comparación entre las que sí.

El detector es conservador a propósito: prefiere no avisar a inventar una rotura. Lo que el prompt
deja de repetir sin que el backend lo acuse se ve en `prefixStability` y en «Deja de coincidir en»
de cada paso, que miden lo que hace Stratum, no lo que hizo la caché.

La pérdida la demuestra el backend; la **causa** es una atribución: lo que el cliente vio cambiar en
el prompt entre las dos llamadas.

| Causa | Qué pasó |
|---|---|
| `tools` | Cambió la lista de tools ofrecida (o su orden). |
| `system` | Cambió el prompt del sistema. |
| `history` | Se reescribió un mensaje ya enviado. |
| `compression` | Esa reescritura fue una compresión de contexto. |
| `model` | Otro provider u otro modelo: otra caché. |
| `backend` | El prompt solo creció por el final y aun así se leyó menos: caducó, u otra petición ocupó la caché. Stratum no cambió nada. |
| `unknown` | Traza anterior a `prefix`: no hay con qué atribuirlo. |

Solo se cuentan con datos del backend, y nunca en la primera llamada de un proceso: reanudar una
sesión horas después no es una rotura, es otra caché.

**Una rotura de caché no es un error del agente.** No entra en `toolErrors`, `llmErrors`, `hadErrors`
ni en ninguna tasa de fiabilidad; en `eval compare` tiene su propia categoría (`cache`).

## Dónde se ve

| Sitio | Qué muestra |
|---|---|
| `/auditor`, `stratum auditor` | Por llamada: fría o templada, tokens leídos de caché, sin caché, escritos, acierto, prefijo repetido, dónde dejó de coincidir, huellas, y la rotura con su causa. En el pie: acierto global, frías · templadas, TTFT de cada clase, roturas, prefijo estable. |
| Stratum Desktop (panel Trayectoria) | Lo mismo, desde `trace/model.ts`. |
| `stratum stats` | Bloque «Caché de prompt» (acierto, tokens sin caché, frías · templadas, TTFT, roturas por causa, prefijo estable) y, por **provider/modelo**, acierto y TTFT frío y templado. |
| `stratum eval run` / `report` | `caché N %` y roturas por escenario; en el resumen, acierto, frías · templadas, TTFT y prefijo estable. |
| `stratum eval compare` | Regresiones y mejoras de caché por escenario, y las mismas métricas en el resumen agregado. Ver [`eval.md`](eval.md#caché-de-prompt). |

Las trazas anteriores siguen leyéndose: el campo `cachedTokens` que ya se guardaba se toma como
`cachedReadTokens`, y lo que no registraban (`prefix`) queda en `null`.

## Cómo se ordena el prompt

Una petición tiene tres partes, en el orden en que la mayoría de los backends las procesa: las
definiciones de tools, el system prompt y la conversación.

### 1. Definiciones de tools

`ToolRegistry.toToolSchemas()` las emite en orden canónico:

1. las **built-in**, en su orden de registro, que fija el código (`registerBuiltinTools`);
2. las **MCP** (`mcp__*`), ordenadas por nombre.

El orden de registro de las MCP no es estable: con arranque `lazy` depende de qué server conecta
antes, una reconexión las retira y las vuelve a registrar al final, y cada server anuncia su catálogo
en el orden que quiere. Como las tools van al principio del prompt, un cambio de orden invalidaba
todo lo demás.

Lo mismo pasa **dentro** de cada definición MCP: el JSON Schema de sus parámetros lo serializa el
server, y el orden de sus claves puede cambiar entre arranques (otra versión, otro runtime, un mapa
sin orden) sin que el schema cambie. Por eso se envía en **forma canónica** (`canonicalJson`,
`src/tools/canonical-json.ts`): claves de cada objeto ordenadas a todos los niveles, por unidades de
código y no por configuración regional; los arrays (`required`, `enum`, `anyOf`) conservan su orden;
ningún tipo ni valor cambia y el schema que registró el server no se muta (se canonicaliza una copia,
una vez por schema). Dos schemas equivalentes dan la misma petición byte a byte y la misma huella
`prefix.tools`.

Los schemas de las built-in **no** se reordenan: salen de Zod en un orden que fija el código, así
que ya son deterministas, y reordenarlos cambiaría lo que ve el modelo sin ganar nada.

### 2. System prompt

`buildSystemPrompt` (`src/agent/system-prompt.ts`) lo ensambla así:

| # | Bloque | Cambia cuando… |
|---|---|---|
| 1 | Instrucciones base (`BASE_PROMPT`), `# Shell` | se actualiza Stratum; el shell, por plataforma |
| 2 | `# Long-term memory`, `# Remote hosts (SSH)`, `# Environments` | se edita `.stratumrc.json` |
| 3 | `# Read-only mode` | `/readonly`, `--read-only` |
| 4 | `# Asking the user`, guías (`# Operating guides`) o sus cuerpos (`# Work routing`, `# Testing discipline`) | cambian los perfiles disponibles, `tools.testCommand` o `prompt.guides` |
| 5 | `# Skills`, `# Agent profiles` (ordenados por nombre), `# Active agent profile` | se añade o edita una skill o un perfil; `/agent` |
| 6 | `## Project Memory` (`STRATUM.md`) | se edita `STRATUM.md`, `/init` |
| 7 | `<env>`: modelo, cwd, raíz del workspace, plataforma, fecha, agente o subagente | **otra carpeta, otro día, `/model`, `/provider`** |
| 8 | Tareas abiertas (`todo`) y ciclo TDD, reinyectados por el loop | cada vez que el agente actualiza su lista |

El bloque `<env>` iba el segundo, justo detrás de las instrucciones base: dos sesiones del mismo
proyecto lanzadas desde carpetas distintas, o en días distintos, solo compartían ese primer bloque.
Ahora es lo último antes de lo que cambia durante el turno. El prompt del asistente de Desktop
(`buildAssistantPrompt`) sigue el mismo criterio: modelo y fecha al final.

**Un bloque nuevo se coloca por lo a menudo que cambia, no por tema.** El orden lo fija
`src/agent/prompt-cache-order.test.ts`.

### 3. Conversación

Solo se añade por el final. Los únicos puntos que reescriben mensajes ya enviados son la compresión
de contexto y `/clear`, `/compact` o reanudar otra sesión.

## Qué invalida el prefijo

De mayor a menor alcance. «Se pierde» es lo que el backend tiene que volver a procesar.

| Qué cambia | Se pierde | Cuándo ocurre |
|---|---|---|
| Provider o modelo | Todo: es otra caché | `/model`, `/provider`, fallback automático |
| Lista de tools | Todo lo que va detrás de la primera tool distinta: system y conversación | Un server MCP conecta tarde o anuncia un catálogo nuevo; una tool se deshabilita al agotar reintentos; cambio de modo (plan ↔ execute), de perfil de agente o de sesión, `/readonly` |
| Bloques 1–6 del system prompt | Desde ese bloque: el resto del system y la conversación | Editar config, skills, perfiles o `STRATUM.md`; `/agent`, `/readonly`, `/init` |
| `<env>` | El bloque y la conversación | Otra carpeta, otro día, `/model` |
| Tareas abiertas / ciclo TDD | **La conversación entera** | Cada llamada a `todo` o `test_evidence` que cambie el estado |
| Compresión de contexto | La conversación a partir del resumen | Al superar el umbral, `/compact` |
| Nada (solo crece) | Nada | El caso normal |

El que más pesa dentro de una sesión es el bloque de tareas: vive en el system prompt —a propósito,
para sobrevivir a la compresión y no acumular mensajes— y el system prompt va antes que la
conversación, así que cada actualización de la lista obliga a reprocesar todo el historial. La traza
lo registra como rotura con causa `system` cuando el backend acusa la pérdida. No se ha cambiado: sacarlo del system prompt altera
cómo ve el modelo sus tareas, que es comportamiento, no caché.

## Capacidades por provider

Que una API sea OpenAI-compatible no dice nada de su caché. `CacheCapabilities`
(`src/providers/cache.ts`) describe lo que admite cada provider:

```ts
interface CacheCapabilities {
  usage: boolean;               // reporta cuánto salió de caché
  automaticPrefix: boolean;     // reutiliza solo el prefijo común
  explicitBreakpoints: boolean; // admite marcas cache_control
  cacheKey: boolean;            // admite prompt_cache_key
  sessionAffinity: boolean;     // admite session_id
}
```

Se infieren del backend (por la `baseUrl`, como el resto de la detección) y cada clave se puede
fijar en la config del provider:

```json
"providers": {
  "pasarela": {
    "type": "openai-compatible",
    "baseUrl": "http://localhost:4000/v1",
    "model": "claude-sonnet-4-5",
    "cache": { "explicitBreakpoints": true }
  }
}
```

| Backend | `usage` | `automaticPrefix` | `cacheKey` | `explicitBreakpoints` | `sessionAffinity` |
|---|---|---|---|---|---|
| OpenAI (`api.openai.com`) | sí | sí | **sí** | no | no |
| llama.cpp | sí | sí | no | no | no |
| vLLM | sí | sí | no | no | no |
| SGLang | sí | sí | no | no | no |
| Ollama | no | sí | no | no | no |
| LiteLLM / desconocido | sí | no | no | no | no |

`usage` y `automaticPrefix` son informativas: el dato de caché se lee siempre que venga. Las otras
tres **cambian la petición**, y por eso solo están activas donde se sabe que el backend las acepta
—un campo desconocido hace que algunos servidores rechacen la petición entera—:

- **`cacheKey`** → `prompt_cache_key: <sessionId>`. Agrupa en la misma caché las peticiones de una
  sesión de Stratum. De serie solo en OpenAI.
- **`explicitBreakpoints`** → marcas `cache_control: { "type": "ephemeral" }` al final del system
  prompt y en el último mensaje `user`/`tool` con texto. Para Anthropic a través de una pasarela
  compatible (LiteLLM, OpenRouter); Stratum no tiene provider nativo de Anthropic. Nunca de serie.
- **`sessionAffinity`** → `session_id: <sessionId>`, para asociar la sesión de Stratum con una
  sesión del servidor (SGLang). Nunca de serie.

El id de sesión es el de Stratum (`RunOptions.sessionId`): el de `chat`, el efímero de cada
`stratum run`, y el del padre en los subagentes.

**Trabajo futuro (no implementado).** `prompt_cache_key` es hoy siempre el id de sesión. Una clave
por sesión no comparte caché entre dos sesiones con el mismo prefijo (dos `stratum run` seguidos en
el mismo proyecto). Una opción `cacheKey: "session" | "prompt" | "none"` permitiría elegir: `session`
(lo actual), `prompt` (una clave derivada de la huella de tools + system, compartida por todas las
sesiones con ese prefijo) y `none` (no mandar clave y dejar el enrutado al backend). No se ha hecho
porque no hay todavía una medida contra OpenAI que diga cuál gana; cuando la haya, entra con su
escenario de eval, como el resto.

## Escenarios de eval

`evals/scenarios/cache/`. Con `--mock`, el modelo de guion simula una caché de prefijo ideal (ver
[`eval.md`](eval.md#caché-de-prompt)), así que los números son reproducibles.

| Escenario | Qué comprueba |
|---|---|
| `cache-repeated-system-prefix` | Dos sesiones del mismo proyecto desde carpetas distintas: la primera llamada de la segunda es templada y reutiliza todo lo anterior a `<env>`. |
| `cache-growing-multi-turn-context` | Tres turnos en una sesión (`followUps`): una sola llamada fría y ninguna rotura entre turnos. |
| `cache-tool-loop-prefix` | Seis llamadas en un turno agéntico: el prompt anterior es prefijo exacto del siguiente. |
| `cache-stable-toolset-order` | Un server MCP anuncia sus tools en otro orden en su segundo arranque: la segunda sesión reutiliza igual. |
| `cache-compression-cache-impact` | Una compresión a mitad de turno: menos tokens, una rotura con causa `compression` y ningún error. |

Cada uno distingue la primera llamada fría de las templadas con `coldCalls` y `warmCalls`.

## Las preguntas que se pueden contestar

| Pregunta | Dónde mirar |
|---|---|
| ¿Qué porcentaje del prompt se reutiliza? | `cacheHitRate` (lo que dice el backend) y `prefixStability` (lo que permite Stratum), en `stratum stats`, en el pie de `/auditor` y en `eval`. |
| ¿Qué cambio rompió el caché? | La rotura y su causa en el paso de `/auditor`; «Roturas de caché» por causa en `stratum stats`; el criterio `cache_break` en un escenario. |
| ¿La compresión mejora tokens pero empeora el TTFT? | En la traza, la llamada posterior a «Contexto comprimido»: `uncachedPromptTokens` y TTFT frente a la anterior. `cache-compression-cache-impact` lo reproduce. |
| ¿Un reordenamiento del prompt mejora el acierto sin cambiar el éxito? | `stratum eval compare <antes> <después>`: `cacheHitRate` por escenario junto a `successRate`. |
| ¿Qué provider o modelo aprovecha mejor el mismo contexto? | La tabla «Modelos» de `stratum stats` (acierto y TTFT frío · templado por provider/modelo), o dos `eval run` del mismo grupo con `--provider` distinto. |

## Resultados medidos

Las dos optimizaciones se midieron por separado con `stratum eval run --mock` antes de quedarse,
contra un baseline tomado con la observabilidad ya puesta y el prompt sin tocar:

| Cambio | Escenario | Acierto de caché | Tokens sin caché |
|---|---|---|---|
| Orden canónico de las tools | `cache-stable-toolset-order` | 61,9 % → 74,3 % | 11,8 K → 7,9 K (−33 %) |
| Bloque `<env>` al final | `cache-repeated-system-prefix` | 70,2 % → 74,1 % | la primera llamada de la segunda sesión pasa a reutilizar el 98,5 % de su prompt |

Los otros 40 escenarios no cambian: 37/37 PASS antes y después, y las mismas llamadas, tokens y
errores. Contra un backend real (`glm5.3-flash`), la segunda sesión de
`cache-repeated-system-prefix` reutilizó 6 784 de 6 943 tokens en su primera llamada.

Lo que se probó y **no** se ha cambiado, porque no daba una mejora medible o porque tocaba el
comportamiento:

- Reordenar las tools para que un subagente comparta más con su padre: su toolset ya es un
  prefijo del toolset del padre (las tools de control se registran las últimas), y lo que rompe el prefijo
  es que la lista acaba antes, no el orden.
- Mover `# Read-only mode` o el perfil activo a la cola dinámica: solo se notaría al conmutarlos a
  mitad de sesión, y ahí la conversación se pierde igual porque va detrás del system prompt.
- Sacar las tareas abiertas del system prompt (ver arriba).

## Limitaciones

- **Validación contra un backend real.** Las cifras de una sesión de varios turnos contra llama.cpp,
  cruzadas con el log del propio servidor, están en [`prompt-caching-live.md`](prompt-caching-live.md).
- **El TTFT incluye la cola del servidor.** La extracción automática de memoria y el compresor de
  contexto llaman al modelo fuera del loop: no están en la traza, y en un servidor de un solo slot
  retrasan el primer token de la llamada siguiente aunque su caché esté intacta.
- **El orden tools → system → conversación es un modelo.** Es el de Anthropic y el del modelo de
  guion; las plantillas de chat de algunos modelos locales incrustan las tools dentro o después del
  system. `prefix.sharedChars` y el guion miden con ese orden; lo que reutiliza un backend real es lo
  que diga su `usage`.
- **La caché del guion es ideal**: sin TTL, sin tamaño mínimo de prefijo, sin desalojos, y comparte
  entre todas las peticiones del escenario. Es la cota de lo reutilizable, no una predicción.
- **Las roturas dependen de que el backend reporte caché.** Sin ese dato solo queda
  `prefixStability`.
- **`cacheBreaks` infracuenta, a propósito.** Solo ve pérdidas respecto a lo que el backend ya
  había servido. Una reescritura temprana del prompt (una compresión cuando la caché aún leía
  poco) puede desperdiciar caché recién escrita sin que lo leído baje: no se marca, porque no se
  puede demostrar. Con un backend que reportase de forma fiable lo que escribe en cada llamada
  se podría afinar; hoy solo lo hace Anthropic y no está verificado aquí.
- **La llamada del compresor de contexto no está en la traza** (no pasa por el loop): su coste y su
  efecto sobre la caché de un servidor de un solo slot no se ven.
- **`explicitBreakpoints` y `sessionAffinity` no se han probado contra un backend real**: la forma
  de la petición está cubierta por tests, pero no hay verificación de extremo a extremo con
  Anthropic ni con SGLang. Por eso son opt-in.
- **El TTFT del guion es un retardo simulado** (0,03 ms por token no cacheado, tope 400 ms) más el
  ruido del equipo: sirve para ejercitar la comparación, no para medir un backend.
