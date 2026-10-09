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

- **Hay llamadas al modelo que no están en la traza y compiten por la caché.** Con la extracción
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
