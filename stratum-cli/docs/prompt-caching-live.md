# Caché de prompt: validación contra un backend real

Cifras observadas el 2026-10-08 en la rama `feat/prompt-cache-observability`, en el commit
`64aec3e1b`, que llevaba el bloque `<env>` **al final** del system prompt. A raíz de esta validación
ese bloque volvió a su posición original (ver «Decisión» al final); todo lo demás que se midió aquí
sigue igual. Son de **una máquina y un modelo**: sirven para comprobar que lo que mide Stratum coincide con lo que hace el backend, no
como referencia de rendimiento. Ningún test depende de ellas; la referencia determinista siguen
siendo los escenarios con guion (`stratum eval run --mock`).

## Entorno

| | |
|---|---|
| Backend | llama.cpp (`llama-server`, commit `31385c9ce`, 2026-09-29), `--parallel 1`, `-c 32768`, `--jinja`, todo en GPU |
| Modelo | `Qwen3.5-9B-Q8_0.gguf` |
| Hardware | NVIDIA RTX 5060 Ti 16 GB, Windows 11 |
| Stratum | `stratum run … --then …` (cuatro turnos en una sesión), provider OpenAI-compatible sin ninguna capacidad de caché activada |

llama.cpp reporta la caché en `timings.cache_n` / `prompt_tokens_details.cached_tokens`; Stratum la
lee con `normalizeUsage` sin configurar nada.

## Una sesión de cuatro turnos, dos veces

Servidor recién arrancado. La misma sesión de cuatro turnos (tres lecturas de fichero y un resumen)
se ejecuta dos veces seguidas, como dos `stratum run` distintos. Extracción automática de memoria
desactivada (`memory.autoExtract: false`; ver «Lo que se encontró»).

| Sesión | Turno | Llamada | Tokens de entrada | Leídos de caché | Sin caché | llama.cpp procesó¹ | Acierto | TTFT |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 7 385 | 0 | 7 385 | 7 385 | 0,0 % | 4 263 ms |
| 1 | 1 | 2 | 7 454 | 7 381 | 73 | 73 | 99,0 % | 272 ms |
| 1 | 2 | 3 | 7 477 | 7 381 | 96 | 96 | 98,7 % | 359 ms |
| 1 | 2 | 4 | 7 549 | 7 473 | 76 | 76 | 99,0 % | 246 ms |
| 1 | 3 | 5 | 7 571 | 7 473 | 98 | 98 | 98,7 % | 346 ms |
| 1 | 3 | 6 | 7 626 | 7 567 | 59 | 59 | 99,2 % | 218 ms |
| 1 | 4 | 7 | 7 662 | 7 567 | 95 | 95 | 98,8 % | 387 ms |
| 2 | 1 | 1 | 7 385 | 7 381 | 4 | 4 | 99,9 % | 122 ms |
| 2 | 1 | 2 | 7 454 | 7 381 | 73 | 73 | 99,0 % | 215 ms |
| 2 | 2 | 3 | 7 477 | 7 381 | 96 | 96 | 98,7 % | 348 ms |
| 2 | 2 | 4 | 7 549 | 7 473 | 76 | 76 | 99,0 % | 215 ms |
| 2 | 3 | 5 | 7 571 | 7 473 | 98 | 98 | 98,7 % | 331 ms |
| 2 | 3 | 6 | 7 626 | 7 567 | 59 | 59 | 99,2 % | 213 ms |
| 2 | 4 | 7 | 7 662 | 7 567 | 95 | 95 | 98,8 % | 323 ms |

¹ Del log del propio servidor (`prompt eval time = … / N tokens`), no de Stratum.

Resumen de `stratum stats` sobre las dos trazas: acierto 92,1 % (97,1K de 105,4K tokens de entrada),
1 llamada fría y 13 templadas, TTFT 4,26 s frío y 277 ms templado, 0 roturas de caché, prefijo
estable 99,3 %.

Qué se comprueba:

- **Primera llamada fría.** Solo la primera del servidor recién arrancado lee 0 tokens.
- **Las siguientes, templadas**, dentro del turno y entre turnos de la misma sesión.
- **`uncachedPromptTokens` coincide con el backend.** En las 14 llamadas, `promptTokens −
  cachedReadTokens` es exactamente el número de tokens que el log de llama.cpp dice haber procesado.
- **Fría y templada salen del dato, no de la posición.** La primera llamada de la segunda sesión es
  templada (7 381 de 7 385): el prompt del sistema y las tools del proceso anterior seguían en el
  slot. Con `<env>` de vuelta en su sitio esa llamada sigue siendo templada, pero solo reutiliza las
  tools y las instrucciones base (lo que va antes de `<env>`).
- **TTFT.** El primer token tarda unas quince veces menos con la caché templada.
- **Sin regresiones funcionales.** Los ocho turnos acabaron en `stop` con la respuesta correcta
  (`4500`, `OPS-7731`, `v2.4.1` y el resumen), 6 llamadas a tools y 0 errores.

## Escenarios de eval en live

`stratum eval run --group cache --provider llamacpp`, sin reiniciar el servidor entre escenarios:

| Escenario | Resultado | Llamadas | Acierto de caché |
|---|---|---|---|
| `cache-repeated-system-prefix` | PASS | 4 | 95,9 % |
| `cache-growing-multi-turn-context` | PASS | 6 | 97,8 % |
| `cache-tool-loop-prefix` | PASS | 3 | 66,0 % |
| `cache-stable-toolset-order` | PASS | 4 | 74,6 % |
| `cache-compression-cache-impact` | FAIL (dos intentos) | 4–5 | 43,5 % |

En conjunto: 4 llamadas frías y 18 templadas, TTFT 4,73 s frío y 705 ms templado.

El escenario de compresión falla con este modelo por motivos que no son de la caché: en su primera
llamada antepone `work/` a las tres rutas, los tres `read_file` fallan a la vez y la tool queda
deshabilitada (§12.3); el resumen de contexto tarda más de un minuto en un modelo de 9B y agota el
tiempo del escenario, y en el segundo intento el modelo dejó la respuesta dentro de su razonamiento.
Con `glm5.3-flash` ese escenario pasa. Lo que sí deja ver es el detector con datos reales: tras la
compresión la llamada leyó 6 920 tokens de caché frente a los 7 447 de la anterior, y la traza lo
marca como rotura con causa `compression`.

## Lo que se encontró

- **Había llamadas al modelo que no estaban en la traza y compiten por la caché** (resuelto: ver
  [Llamadas auxiliares, por origen](#llamadas-auxiliares-por-origen)). Con la extracción
  automática de memoria activa (el valor por defecto), el log del servidor muestra 22 peticiones
  para 14 llamadas trazadas: una extracción por turno. En un servidor de un solo slot, la primera
  llamada de cada turno espera a que termine, y el TTFT templado medio sube de 277 ms a 7,3 s sin
  que cambie un solo token de caché (el acierto sigue en el 92 %). El TTFT de la traza es tiempo
  hasta el primer token **incluida la cola del servidor**; no es solo procesado de prompt. Lo mismo
  vale para la llamada del compresor de contexto.
- **Respuesta final vacía con este modelo, también en `main`.** En una tarea de tres lecturas,
  `Qwen3.5-9B` deja a veces la respuesta dentro del bloque de razonamiento y el turno acaba sin
  texto. Se comparó `main` (`d18821cfa`) con la rama, alternando ejecuciones: respuesta correcta en
  54 de 60 con `main` y en 48 de 60 con la rama. La diferencia (90 % frente a 80 %) no es
  estadísticamente concluyente con esa muestra (p ≈ 0,2, Fisher), pero tampoco descarta que mover el
  bloque `<env>` al final del prompt del sistema —lo único que cambia en el prompt entre las dos—
  influya en un modelo pequeño. Las llamadas a tools fueron equivalentes en las dos (mismas rutas,
  0 errores).

## Decisión

El bloque `<env>` se devolvió a la posición que tiene en `main`, justo detrás de las instrucciones
base. El A/B no demuestra que moverlo empeore las respuestas, pero tampoco lo descarta, y el
beneficio (unos 4 puntos de acierto en `cache-repeated-system-prefix` con guion, y una primera
llamada casi entera de caché en la segunda sesión) no compensa el riesgo de cambiar el
comportamiento de un modelo pequeño. El resto del trabajo —medición, orden y schemas canónicos de
las tools, detector de roturas— no toca el texto que ve el modelo y se mantiene.

Queda como siguiente trabajo trazar las llamadas auxiliares al modelo (extracción de memoria y
compresión) por origen: ver «Siguiente trabajo» en [`prompt-caching.md`](prompt-caching.md).

## Llamadas auxiliares, por origen

Repetición de la prueba con las llamadas auxiliares ya en la traza (rama
`feat/trace-auxiliary-llm-calls`, 2026-10-09). Mismo backend (`llama-server` `31385c9ce`,
`--parallel 1`, `-c 32768`, `--jinja`), mismo modelo y la misma sesión de cuatro turnos, con el
servidor recién arrancado en cada ejecución. Las cifras de tiempo son de ese equipo; lo que se
comprueba es que cuadran las cuentas.

| | `autoExtract: false` | `autoExtract: true` |
|---|---|---|
| Peticiones en el log del backend | 8 | 11 |
| **Requests visibles en Stratum** | **8** | **11** |
| Agent calls | 8 | 7 |
| Memory calls | 0 | 4 |
| Compression calls | 0 | 0 |
| TTFT agent (medio) | 1 735 ms | 7 897 ms |
| TTFT agent frío · templado | 11 736 ms · 306 ms | 9 563 ms · 7 619 ms |
| TTFT agent con · sin auxiliar en curso | n/d · 1 735 ms | 15 005 ms · 2 566 ms |
| Cache hit agent | 86,8 % | 85,1 % |
| Cache hit auxiliary | n/d | 53,5 % |
| Tokens de entrada agent · auxiliary | 60 474 · — | 52 749 · 1 369 |
| Llamadas del agente con una auxiliar en curso | 0 | 3 (43,6 s de espera solapada) |
| Roturas de caché (agent) | 1 | 0 |

(El modelo resolvió el primer turno en tres llamadas en una ejecución y en dos en la otra; de ahí
8 frente a 7 llamadas del agente.)

Con la extracción activa, llamada a llamada:

| # | Turno | Origen | Inicio | Duración | TTFT | Entrada | Caché | Sin caché | Backend procesó | Auxiliar en curso |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | `agent` | 0,00 s | 11 366 ms | 9 563 ms | 7 387 | 0 | 7 387 | 7 387 | — |
| 2 | 1 | `agent` | 11,44 s | 384 ms | 234 ms | 7 459 | 7 383 | 76 | 76 | — |
| 3 | 1 | `memory-extraction` | 11,82 s | 13 759 ms | 1 105 ms | 302 | 0 | 302 | 302 | |
| 4 | 2 | `agent` | 11,82 s | 15 952 ms | 14 244 ms | 7 482 | 7 383 | 99 | 99 | 1 (13 758 ms) |
| 5 | 2 | `agent` | 27,78 s | 467 ms | 235 ms | 7 555 | 7 478 | 77 | 77 | — |
| 6 | 2 | `memory-extraction` | 28,25 s | 14 127 ms | 484 ms | 326 | 244 | 82 | 82 | |
| 7 | 3 | `agent` | 28,25 s | 16 114 ms | 14 583 ms | 7 577 | 7 478 | 99 | 99 | 1 (14 126 ms) |
| 8 | 3 | `agent` | 44,36 s | 435 ms | 230 ms | 7 632 | 7 573 | 59 | 59 | — |
| 9 | 3 | `memory-extraction` | 44,80 s | 15 724 ms | 555 ms | 348 | 244 | 104 | 104 | |
| 10 | 4 | `agent` | 44,80 s | 18 236 ms | 16 188 ms | 7 657 | 7 573 | 84 | 84 | 1 (15 722 ms) |
| 11 | 4 | `memory-extraction` | 63,04 s | 14 332 ms | 440 ms | 393 | 244 | 149 | 149 | |

Lo que se ve:

- **Las cuentas cuadran.** Cada petición del log del servidor es un paso de la traza con su origen,
  y `promptTokens − cachedReadTokens` de las once coincide con los tokens que llama.cpp dice haber
  procesado, también en las de extracción. No queda ninguna petición sin atribuir.
- **El TTFT lento de la primera llamada de cada turno es espera detrás de la extracción.** Las
  llamadas 4, 7 y 10 arrancan en el mismo milisegundo que la extracción del turno anterior, procesan
  menos de 100 tokens nuevos (el acierto de caché del agente no cambia: 85 % frente a 87 %) y tardan
  14–16 s en dar el primer token: exactamente lo que dura la extracción, que el único slot atiende
  antes. Las demás llamadas templadas, sin auxiliar en vuelo, dan el primer token en ~230 ms.
- **La extracción es cara por la salida, no por la entrada.** Lleva 300–400 tokens de entrada, de los
  que reutiliza los 244 del prompt del extractor a partir de la segunda, pero genera unos 600 tokens
  cada vez (el modelo razona antes de devolver `[]`): ~14 s de slot ocupado por turno.
- **En este caso la caché del agente sobrevive a la extracción**: tras cada una, el agente vuelve a
  leer su prefijo entero. llama.cpp conserva el prompt anterior del slot; con otro backend, o con
  menos memoria para esa caché, no tiene por qué ser así.
- **Lo que la traza no mide** es la cola del servidor. `overlappingAuxiliaryMs` es el tiempo en que
  las dos peticiones estaban en vuelo a la vez, visto desde el cliente; que el slot estuviese
  ocupado por la otra se deduce aquí del log de llama.cpp, no de Stratum.

Para repetirlo: la sesión de «Cómo repetirlo» con `memory.autoExtract` en `false` y en `true`, y
`stratum stats --dir <trace.dir>` — el bloque «LLM calls» da las filas por origen. El número de
peticiones del servidor son las líneas `launch_slot_: … processing task` de su log.

## Cómo repetirlo

```bash
llama-server -m <modelo>.gguf --port 8093 -ngl 99 -c 32768 --jinja --parallel 1

# en un proyecto con un provider que apunte a http://127.0.0.1:8093/v1 y `trace.dir` propio
stratum run "Lee data/service.conf y dime solo el valor de timeout_ms." \
  --then "Ahora lee data/owners.yml y dime solo el ticket." \
  --then "Lee data/VERSION y dime solo la versión." \
  --then "Sin leer nada más: resume en una línea los tres valores."
stratum stats --dir <trace.dir>
stratum auditor            # por llamada: fría o templada, leídos de caché, sin caché, TTFT
```

Para comparar con el backend, el log de `llama-server` lleva una línea `prompt eval time = … / N
tokens` por petición: `N` tiene que ser el «Tokens sin caché» del paso correspondiente.
