# Orientación a infraestructura — análisis y roadmap propuesto

**Fecha:** 2026-09-12 · **Estado:** bloque 1 implementado como Hito 16 (2026-09-15, spec en §12.17 de `STRATUM_PROJECT_DEFINITION.md`) y bloque 2 como Hito 17 (2026-09-23, spec en §12.18); bloques 3–5 pendientes
**Punto de partida:** Hito 14 cerrado (709 tests verdes). La investigación `gentle-pi` está agotada: no queda nada pendiente de ella.

Este documento responde a una pregunta: *dado que la base del CLI es sólida, ¿qué le falta a Stratum para ser una herramienta orientada a infraestructura* — nube y local, revisión de bugs, depuración de redes, fallos de sistema operativo y virtualización?

No es un documento vinculante como la §12 de `STRATUM_PROJECT_DEFINITION.md`. Es el análisis previo a decidir los Hitos 15+.

---

## 1. Diagnóstico

Stratum hoy es **un agente de código muy bien construido**. Eso condiciona tres supuestos que están cableados en toda la arquitectura y que juegan en contra del caso de uso de infraestructura:

| Supuesto actual | Realidad de infraestructura |
|---|---|
| Un `cwd`, un repositorio, una máquina | N hosts, M cuentas cloud, K clusters |
| El estado del mundo vive en ficheros | El estado vive en procesos, sockets, APIs y logs |
| El trabajo es mutar (escribir código) | El trabajo es **observar primero**, mutar al final y poco |
| Un error es reproducible | Un incidente es efímero: reiniciar destruye la evidencia |

Lo que falta **no son más tools**. Faltan tres primitivas transversales de las que cuelga todo lo demás:

1. **Un modelo de *target*** — dónde se ejecuta esto. Hoy existe a medias en SSH y no existe en `bash`.
2. **Una noción de *evidencia observacional*** — lo que `test_evidence` es para TDD, pero para diagnóstico: hipótesis → medición → descarte.
3. **Un modo read-only de primera clase** — `PLAN_ALLOWLIST` ya insinúa la idea, pero atada a plan mode.

Las tools concretas (red, SO, cloud, contenedores) son la parte fácil y vienen después.

---

## 2. `ExecutionTarget` — la pieza que falta bajo todo

### El problema

Hoy `bash` ejecuta en local y `ssh_exec` en remoto: dos tools distintas, dos superficies distintas, dos esquemas distintos. El agente tiene que saber cuál usar. Las guardas se comparten **a medias** vía `commandVeto` — que es la solución correcta, pero es un parche entre dos consumidores. Con cuatro o cinco backends de ejecución (`kubectl exec`, `docker exec`, `az vm run-command`, WinRM) ese patrón se rompe: o se replica la lógica de guardas en cada tool, o alguna se la salta.

### La propuesta

Un `ExecutionTarget` como concepto de primera clase:

```
target := local
        | ssh:<alias>
        | container:<engine>/<id>
        | pod:<context>/<ns>/<name>[:<container>]
        | winrm:<alias>
```

Y una tool `exec` única que lo tome como parámetro, con los backends detrás de una interfaz `IExecBackend` (el mismo patrón que `IProvider` en `providers/base.ts`: un método, muchas implementaciones, un router que elige).

### Qué se gana, concretamente

- **Guardas en un solo punto.** `preflight` se evalúa una vez, sobre el par `(comando, target)`, no replicado por tool.
- **Guardas sensibles al target.** `rm -rf /var/lib/postgresql` en el portátil es una cosa; en `ssh:prod-db` es otra. Hoy la capa 1 de `tools/guards.ts` es idéntica para ambos, lo que obliga a elegir entre ser demasiado laxo en local o demasiado estricto en remoto.
- **Auditoría universal.** `ssh/audit.ts` se generaliza a *todo* comando ejecutado en cualquier sitio. Hoy un `bash` local no deja rastro en el JSONL, que en infraestructura es justo lo que quieres tener.
- **Una sola superficie que enseñar al modelo.** Menos tools visibles, menos confusión sobre cuál usar.

### Coste y riesgo

Es un **refactor**, no una feature. Hay que mantener `ssh_exec` como alias durante una transición, o aceptar la rotura. A cambio, es el cambio que más rinde a largo plazo: todo el bloque 6 de este documento depende de él para no duplicar guardas cinco veces.

### Notas de diseño

- `bash` **desaparece**, absorbida en `exec` con `target: local`. Decisión cerrada en §11.1; la forma del esquema resultante, en §2.5.
- El `cwd` deja de ser global y pasa a ser por target.
- `inferBashWrites` (Hito 8C) tiene que volverse consciente del target para que la detección de conflictos entre subagentes no mezcle escrituras de máquinas distintas.

---

## 2.5 La forma del esquema de `exec`

Al comparar los dos esquemas reales aparece un resultado que cambia el enfoque del refactor.

### `ssh_exec` no tiene ni un solo parámetro específico de SSH

| Parámetro de `ssh_exec` (`tools/ssh/exec.ts:15`) | ¿Específico de SSH? |
|---|---|
| `host` | No — **es** el `target`, con otro nombre |
| `command`, `cwd`, `timeout` | No, universales |
| `maxBytes` | No. Y `bash` **no lo tiene**: un `journalctl` local puede devolver 200 MB |
| `pty` | No. `docker exec -t` y `kubectl exec -t` lo tienen igual; en local es un pseudo-terminal normal |
| `stdin` | No. `bash` tampoco lo tiene: hoy no se puede hacer `sudo -S` en local |

Lo que hay no son dos tools distintas, sino una tool **rica** (`ssh_exec`, seis parámetros) y una tool **pobre** (`bash`, dos: `command` y `timeout`).

**Corolario para el Hito 16:** el esquema de `exec` no es «`bash` más un `target`». Es **`ssh_exec` con `host` generalizado a `target`**. El trabajo se desplaza: más esfuerzo en el backend local (que tiene que implementar `pty`, `stdin` y `maxBytes`, que hoy le faltan) y menos en todo lo demás.

### Capacidades por backend

Queda un caso que resolver: `pty: true` contra un backend que no lo soporta.

- **Ignorarlo en silencio** es la opción peligrosa. Si se pide `pty` es para un `sudo`; sin TTY el comando espera un prompt que nunca llega hasta que salta el timeout. Un fallo silencioso que parece un cuelgue de red.
- **Declarar capacidades y rechazar** con `tool_error` recuperable, nombrando qué targets sí lo soportan. El modelo reintenta en la misma iteración.

Por tanto `IExecBackend` no expone solo `run()`, sino también `capabilities: { pty, stdin, cwd, maxBytes }`. Es el mismo patrón de `detectCapabilities` en `providers/utils.ts`, que ya resuelve si un backend soporta `/models`.

### Dos consecuencias

**1. `ssh_upload` / `ssh_download` siguen el mismo camino.** Su esquema (`{host, localPath, remotePath}`) es puro transporte, y `docker cp` / `kubectl cp` son la misma operación. Sale una tool `copy` con `target` en un extremo, y las dos tools SSH desaparecen igual que `ssh_exec`. No entra en el Hito 16 —el transporte de ficheros no bloquea nada— pero el diseño debe contemplarlo para no rehacerlo después.

**2. El registro condicional cambia de naturaleza.** Hoy la regla es elegante: sin inventario `ssh`, las tools SSH no existen y el modelo no las ve. Con `exec` unificada la tool **siempre** existe, porque el target `local` siempre está disponible. Lo que pasa a ser dinámico es **la lista de targets en la descripción de la tool**, generada en arranque — igual que hoy el bloque de inventario SSH se inyecta en el system prompt solo si hay hosts. Mismo principio, distinto vehículo. Conviene anotarlo porque **una descripción de tool generada dinámicamente es algo que el proyecto no tiene hoy en ningún sitio**.

---

## 3. Entornos y blast radius — la guarda ortogonal que falta

El sistema de guardas actual (Hito 11) es de lo mejor que tiene el proyecto: tres capas, la 1 no configurable, `preflight` inapelable. Pero clasifica **comandos**, no **entornos**. En infraestructura el mismo comando es trivial o catastrófico según dónde caiga, y esa dimensión hoy no se puede expresar.

### La propuesta

Un eje ortogonal en `.stratumrc.json`:

```jsonc
"environments": {
  "prod":    { "match": ["ssh:prod-*", "pod:prod/*"], "policy": "confirm-always", "requirePlan": true },
  "staging": { "match": ["ssh:stg-*"],                "policy": "ask" },
  "lab":     { "match": ["ssh:lab-*", "local"],       "policy": "allow" }
}
```

Con dos reglas que hoy son inexpresables:

- **`requirePlan`** — en el entorno marcado no se ejecuta nada fuera de un plan aprobado. El mecanismo ya está entero (Hito 7); solo falta poder **exigirlo** por entorno en vez de que dependa de que el usuario escriba `/plan`.
- **Confirmación con nombre** — para `prod`, que la confirmación pida teclear el alias del host en vez de aceptar un sí/no. Es la diferencia entre aprobar por reflejo y aprobar de verdad. `<DestructiveConfirm>` necesita una variante de entrada de texto.

### UI

Badge de entorno en `StatusBar`, en rojo cuando el target activo es producción. Trivial de implementar, desproporcionado en prevención. El accidente clásico de infraestructura no es escribir mal el comando: es escribirlo bien en la ventana equivocada.

---

## 4. Tool `diagnosis` — la pieza diferencial

Esta es la idea con más valor del documento, y la que nadie más ha construido.

### El patrón que ya funciona

El Hito 13 resolvió TDD con tres piezas que son la misma idea a tres niveles:

1. El **prompt** (`# Testing discipline`) convence al modelo de intentarlo.
2. La **tool** (`test_evidence`) le impide saltárselo: un RED que pasa, un GREEN sin RED previo o un refactor en rojo se rechazan con `tool_error` recuperable.
3. El **perfil** (`.stratum/agents/tdd.md`) se lo delega entero a un hijo.

El diagnóstico de infraestructura necesita exactamente lo mismo, y por la misma razón: **el modelo, suelto, se salta la disciplina**.

### El fallo que corrige

Un modelo sin estructura, ante un incidente, hace esto: ve un error en un log, decide que la causa es X, reinicia el servicio. A veces acierta. Cuando falla, ha destruido la evidencia y no puede volver atrás. Y en incidentes largos vuelve a probar la misma hipótesis tres veces porque no recuerda haberla descartado.

### El ciclo

```
SYMPTOM → HYPOTHESIS → OBSERVATION → (CONFIRMED | REFUTED) → REMEDIATION
```

Con validaciones de orden duras, el mismo tipo que `applyTddRecord`:

- No se registra `REMEDIATION` sin una hipótesis en estado `CONFIRMED` → `tool_error` recuperable.
- Una hipótesis no puede pasar a `CONFIRMED` sin **al menos una** observación asociada.
- Las observaciones deben venir de comandos **read-only**, verificable con el clasificador que ya existe en las guardas.
- Las hipótesis **refutadas se conservan** en el registro y se reinyectan en el system prompt, para que el modelo no las repita.

### Reutilización

`agent/tdd.ts` sirve casi tal cual como plantilla: snapshot completo en cada tool result, reinyección antes de cada iteración, rehidratación en `--resume` sin store nuevo en disco. Esa última propiedad vale oro aquí: un incidente de tres horas con relevo de turno, y el agente mantiene el hilo de qué se descartó ya.

### Artefacto

`.stratum/incidents/<id>.md` como timeline del incidente — síntoma, hipótesis probadas con su veredicto, observaciones con su comando y su salida, remediación aplicada. Es el post-mortem medio escrito, y es un entregable que el usuario se lleva.

### Interacción con `store_decision`

La memoria de decisiones (Hito 5) encaja aquí sin cambios: una hipótesis confirmada en un incidente es exactamente el tipo de conocimiento que quieres recuperar por KNN seis meses después, cuando el mismo síntoma reaparezca. Vale la pena que `diagnosis` proponga guardar la conclusión como decisión al cerrar.

---

## 5. Read-only mode de primera clase

`PLAN_ALLOWLIST` ya tiene la idea, pero está atada a la fase 1 de plan mode. Para infraestructura hace falta como **modo de sesión**: `stratum chat --read-only` y `/readonly` para alternar.

Semántica: solo observación. Ni escrituras, ni mutaciones, ni siquiera con `--allow-destructive` ni con el allow-all de sesión. El vehículo ya existe — `preflight` es inapelable por construcción.

Es el modo por defecto natural para *«mira por qué está caído esto»*, y quita el miedo a soltar el agente en un entorno real. Probablemente debería ser el **default** cuando el target resuelto pertenece a un entorno marcado como `prod`.

---

## 6. Tools nuevas, por capas

Con lo anterior en su sitio, las tools son la parte fácil. Por orden de rentabilidad:

### 6.1 Red

La capa donde más se diagnostica y donde menos herramientas hay.

`net_probe`, con sub-operaciones:

| Operación | Detalle |
|---|---|
| DNS | A/AAAA/CNAME/MX/TXT/NS, contra un servidor concreto opcional |
| TCP | connect con latencia y fallo desglosado (refused / timeout / unreachable) |
| TLS | cadena completa, expiración, SAN, versión, cifrado negociado |
| HTTP | timings desglosados: DNS, connect, TLS, TTFB, total |
| Traza | traceroute / tracert |

Dos requisitos que marcan la diferencia:

- **Salida estructurada**, no texto crudo de `curl -v`. El parseo de salida de herramientas de red es donde los modelos alucinan más, y es innecesario: casi todo es nativo en Node (`dns`, `net`, `tls`, `undici`) salvo traceroute.
- **Ejecutable desde un target remoto.** La pregunta real casi nunca es *«¿lo veo yo?»* sino *«¿lo ve el pod?»*. Esto depende del bloque 2.

### 6.2 Sistema operativo

- `sys_inspect` — `ToolResult` normalizado: carga, memoria, disco **con inodos** (el fallo que nadie ve venir), top de procesos por CPU y por RSS, uptime, puertos en escucha. Multi-OS: Linux, Windows (vía PowerShell/CIM) y macOS, con la misma forma de salida.
- `service_status` — systemd / Windows Services / launchd normalizados a un vocabulario común.
- `log_query` — journalctl / Event Log / ficheros con rotación, con filtro por ventana temporal y severidad. Dos detalles imprescindibles:
  - **Deduplicación de líneas repetidas.** Un log de incidente son 50 000 líneas de la misma excepción; el truncado actual a ~30 k caracteres (cabeza 80 % + cola 20 %) se come justo la información útil del medio. Hace falta colapsar repeticiones **antes** de truncar, con contador.
  - **Anclaje temporal relativo** — «últimos 15 min», no timestamps absolutos que el modelo calcula mal.

### 6.3 Cloud

**Decisión de diseño importante: no escribir SDKs.** Envolver los CLIs oficiales (`aws`, `az`, `gcloud`, `kubectl`) forzando `--output json` y parseando.

Razones:
- La superficie de un SDK cloud es inmensa y cambia cada semana.
- Los CLIs ya resuelven auth, SSO, perfiles y MFA — problemas duros que no aportan nada replicar.
- El binario que el usuario ya tiene configurado es el que tiene las credenciales correctas.

Lo que sí aporta valor propio:
- **Normalizar y mostrar el contexto activo** (perfil / suscripción / proyecto / cluster) en la `StatusBar`. El accidente clásico de cloud es operar sobre la cuenta equivocada.
- `tools/optional.ts` (Hito 13) es exactamente el patrón correcto para la ausencia del binario: sin `aws` instalado, la tool devuelve un resultado **exitoso** con instrucciones de qué usar en su lugar, no un `tool_error` que interrumpe el loop y consume un reintento. Ya está construido.

### 6.4 Virtualización y contenedores

- `docker` / `podman`: ps, logs, inspect, stats, y `exec` como **target**, no como tool aparte.
- `kubectl`: pods, logs, describe y **events** — lo más infravalorado en diagnóstico de Kubernetes y lo primero que hay que mirar.
- libvirt / Proxmox / Hyper-V según demanda real; no especular.

---

## 7. Perfiles de subagente — lo que ya está construido y encaja mejor de lo que parece

La arquitectura del Hito 8C —paralelismo con semáforo, merge de eventos, `<AgentTree>`— **encaja con infraestructura mejor que con código**, y probablemente ese potencial está infrautilizado hoy.

Un triaje de incidente es inherentemente paralelo: revisar red, revisar logs, revisar recursos, revisar cambios recientes. Cuatro subagentes read-only, cada uno con su hipótesis, convergiendo en el padre. El árbol Ink que ya existe es la visualización correcta de eso, y el mutex de confirmaciones contra la TTY única ya está resuelto.

Perfiles a añadir en `.stratum/agents/`: `netdiag`, `sysdiag`, `k8s`, `cloud-audit`. Todos con toolset read-only y `maxIterations` bajo — un triaje que no converge en pocas iteraciones es una hipótesis mala, no una que necesite más presupuesto.

---

## 8. Dos detalles que van a morder

### 8.1 Windows

Es la plataforma de desarrollo del proyecto y hoy `bash` asume POSIX. Para infraestructura local en Windows hace falta una ruta PowerShell real. `collectCommandPaths` ya contempla alias de PowerShell (Hito 13), así que la intención está registrada — lo que falta es el ejecutor.

### 8.2 Secretos en la salida de las tools

**Esto hay que arreglarlo antes de tocar cloud, no después.**

`logging/redact.ts` redacta los campos de los logs, pero la **salida de las tools no pasa por ahí**. Un `kubectl get secret -o yaml`, un `env` dentro de un contenedor o un `cat` de un fichero de configuración mete credenciales en el historial de conversación — que se persiste en `SessionStore` **y se reenvía al provider en cada iteración**.

La capa 3 de las guardas (Hito 11 + Hito 13) protege las rutas sensibles y los comandos que las vuelcan, pero es best-effort por construcción y no cubre secretos que llegan por API en vez de por fichero. Hace falta un paso de redacción sobre el `ToolResult` antes de que entre en el historial, reutilizando y ampliando los patrones de `logging/redact.ts`.

---

## 9. Roadmap propuesto

| Hito | Contenido | Por qué en ese orden |
|---|---|---|
| **16** ✅ | `ExecutionTarget` + tool `exec` unificada + auditoría universal + redacción de salidas de tool | Todo lo demás cuelga de esto |
| **17** ✅ | Entornos con blast radius + read-only mode + **perfil de sesión** (§10.5) + badge de contexto en `StatusBar` | La seguridad antes que el alcance; y el perfil tiene que existir **antes** de que el 18 empiece a añadir tools |
| **18** | `net_probe` + `sys_inspect` + `log_query` + `service_status` | Diagnóstico puro, sin dependencias externas |
| **19** | Tool `diagnosis` + perfiles de triaje + `.stratum/incidents/` | La pieza diferencial, ya con sustrato debajo |
| **20** | Wrappers cloud + virtualización + contexto activo en la barra | Lo más amplio y lo que más envejece |

El orden no es negociable en su primera mitad: los hitos 16 y 17 son los que hacen que los demás sean **seguros de usar**, y el 19 es el que convierte a Stratum en algo que hoy no existe en el mercado en vez de en otro wrapper de CLIs.

> **Renumerado el 2026-09-15.** El número 15 lo ocupó «Perfiles de agente de primera clase», así que el roadmap pasa a 16–20. El bloque 1 está implementado (Hito 16). Decisiones de implementación que concretan este documento: `pty` en `local` se declara no soportado (sin `node-pty`); `ssh_exec` también se retira sin alias; la auditoría vive en `exec-audit.jsonl` con `ssh.auditLog` como alias; un comando que se ejecutó y falló es `tool_error` que no consume reintento; `maxBytes` en local descarta sin matar; y los patrones extra de redacción son solo literales (ReDoS).

---

## 10. Observación estratégica sobre el Hito 20

En el bloque cloud se compite con `aws q`, `kubectl-ai` y media docena de herramientas más, todas con más cobertura y respaldo del propio proveedor. Esa carrera se pierde siempre por cobertura.

La ventaja defendible está en el **Hito 19**: disciplina de diagnóstico verificada por tooling, con memoria de decisiones persistente entre sesiones. Eso es propio, encaja con la filosofía que el proyecto lleva construida desde el Hito 11, y no depende de seguirle el ritmo a la superficie de API de nadie.

---

## 10.5 Filtrado de herramientas y perfil de sesión

El riesgo real de este roadmap no es el peso del binario: es el **coste de contexto y la confusión de elección**. Conviene dejarlo escrito antes de empezar.

### El riesgo

Hoy hay 16 tools en `src/tools/` más las de control (`todo`, `question`, `test_evidence`, `delegate_task`, `present_plan`, `update_plan`) — unas 20 visibles. El system prompt son 25 KB de fuente. El roadmap completo añade 10-12 tools más.

Treinta y pico tools simultáneas es el punto donde un modelo pequeño —el caso de uso declarado del proyecto— empieza a elegir mal: llama a `exec` para algo que tiene tool propia, o duda entre `net_probe` y `sys_inspect`. Ahí se pierde la agilidad aunque el binario pese lo mismo.

Por el lado del peso no hay riesgo: 14 dependencias de producción hoy, y casi todo lo propuesto es Node nativo (`dns`, `net`, `tls`, `undici`) o wrappers de binarios que el usuario ya tiene. El roadmap completo debería añadir **cero o una** dependencia nueva — esa es justamente la razón de la decisión de §6.3 de no escribir SDKs cloud.

### Estado actual del descubrimiento de herramientas

Revisado el 2026-09-12. **No hay autodescubrimiento de tools internas.** El registro es una lista estática en `registerBuiltinTools` (`src/tools/index.ts`) con imports explícitos, más dos registros condicionales que siguen siendo llamadas cableadas:

- `registerSshTools(registry, config)` — solo si hay inventario `ssh`
- `registerTddTools(registry, config)` — solo si hay `tools.testCommand`

El **único** mecanismo genuinamente dinámico es **MCP**: `McpManager` consulta `tools/list` del server en runtime y registra lo que encuentre como `mcp__<server>__<tool>`. Es decir, el proyecto ya tiene una puerta de extensión dinámica, y es la correcta — no hace falta inventar un sistema de plugins que cargue ficheros TS arbitrarios, porque MCP ya es eso con un protocolo detrás.

**Conclusión:** el patrón de registro condicional funciona y está probado dos veces; lo que falta no es descubrimiento, es **selección**.

### Tres mecanismos de visibilidad ya construidos

| Mecanismo | Dónde | Alcance hoy |
|---|---|---|
| `isToolVisibleInMode` | `registry.ts:26` | Modo plan/execute |
| `isToolVisibleForProfile` + `ToolsetFilter` | `registry.ts:47-63` | Solo subagentes |
| Registro condicional | `tools/index.ts` | SSH y TDD |

`ToolsetFilter` es exactamente la abstracción que hace falta (`allowedTools` + `isSubagent`), pero **solo se aplica a los hijos**. La sesión raíz siempre ve todo.

### La propuesta: perfil de sesión

Aplicar `ToolsetFilter` a la sesión raíz, no solo a los subagentes:

```
stratum chat              → autodetecta por el entorno
stratum chat --infra      → toolset de infraestructura, código en mínimos
stratum chat --code       → lo de hoy, nada de infraestructura
```

Más `/profile <nombre>` para alternar en caliente, como ya se hace con `/provider`.

Y en config, reutilizando el formato de los perfiles de subagente, que ya soporta `allowedTools` (`agent/profiles.ts:48`):

```jsonc
"session": {
  "profile": "auto",          // auto | code | infra | <nombre propio>
  "profiles": {
    "infra": { "allowedTools": ["exec", "net_probe", "sys_inspect", "log_query", "read_file", "grep", "diagnosis"] }
  }
}
```

La autodetección sigue el criterio que ya se usa para SSH y que §11.4 aplica a `diagnosis`: si hay inventario `ssh` o `kubectl`/`docker` en el `PATH`, hay infraestructura a la vista. Un desarrollador que solo escribe código **nunca ve** las tools de infraestructura, y su sesión pesa exactamente lo que pesa hoy.

Coste: bajo. No es un mecanismo nuevo, es mover el punto de aplicación de uno existente.

### Corolario: los bloques de prompt siguen la misma regla

El filtrado no sirve de nada si el system prompt sigue inyectando todo. `# Testing discipline` no pinta nada en una sesión de infraestructura, igual que el bloque de inventario SSH hoy no aparece si no hay hosts. Cada bloque debe condicionarse al perfil activo, no solo a la config.

Y aquí `prompt.guides: 'pointers'` (Hito 14) gana sentido de golpe. Se dejó como opt-in porque un modelo pequeño no sigue punteros y se queda sin la disciplina. Pero en una sesión de infraestructura con 12 tools nuevas el cálculo cambia: el contexto que liberan los punteros puede valer más que la disciplina que cuesta. Merece medirse antes de decidir, no asumirse.

### Lo que NO hay que construir

Un sistema de plugins que cargue módulos TS de un directorio. MCP ya cubre ese caso con un protocolo, aislamiento de proceso y un ciclo de vida probado (Hitos 4 y 4.1). Duplicarlo con carga dinámica en proceso añadiría una superficie de seguridad nueva a cambio de nada.

---

## 11. Decisiones tomadas

Las cuatro preguntas de diseño que condicionaban el Hito 16, resueltas el 2026-09-12.

### 11.1 `bash` se absorbe en `exec`, sin fachada

**Decisión:** absorción directa en el Hito 16. No se mantiene `bash` como alias.

**Motivo:** la rotura real es menor de lo que parecía — tres ficheros de perfil (`code.md`, `shell.md`, `tdd.md`), un bloque del system prompt y los tests. El `.stratumrc.json` de usuario **no se ve afectado**: `tools.guardedCommands` habla de comandos (`gitPushForce`, `npmPublish`), no de nombres de tool. Frente a eso, dos tools que hacen lo mismo son una fuente real de confusión para modelos pequeños, que son el caso de uso del proyecto. El coste de la transición se paga una vez.

**Forma del esquema:** ver §2.5 — se parte de `ssh_exec`, no de `bash`.

### 11.2 El modelo de entornos vive en `.stratumrc.json`

**Decisión:** sección `environments` dentro de `.stratumrc.json`, junto a `ssh.hosts`.

**Motivo:** coherencia con el inventario SSH, que ya vive ahí. Partir el inventario de infraestructura en dos ficheros es peor que tener uno grande. Si crece, el schema Zod admite referencia a fichero externo sin cambiar el modelo mental.

### 11.3 La redacción de salidas tiene núcleo no configurable

**Decisión:** un núcleo de patrones **no desactivable** (claves privadas, cabeceras `Authorization`, formatos conocidos `sk-` / `xox-` / JWT) más una lista de patrones adicionales configurable por el usuario. No se puede quitar nada del núcleo, solo añadir.

**Motivo:** es la misma decisión que la capa 1 de las guardas en el Hito 11 — un secreto filtrado al historial no puede depender de un fichero JSON. Pero el riesgo aquí es distinto: el **falso positivo**. Un patrón agresivo que tache un hash de commit o un ID de recurso con forma de clave deja al modelo ciego sin explicación.

**Corolario obligatorio:** el texto redactado se sustituye por `[redacted: <motivo>]`, nunca se elimina. Si el campo desaparece, el modelo asume que está vacío y razona sobre una premisa falsa.

### 11.4 `diagnosis` se registra bajo condición de infraestructura

**Decisión:** la tool se registra solo si la sesión tiene infraestructura a la vista — hay inventario `ssh`, o `kubectl` / `docker` en el `PATH`.

**Motivo:** es el mismo criterio que ya se aplica a las tools SSH (sin hosts, no se registran). El razonamiento de `test_evidence` con `tools.testCommand` —*exigir evidencia sin un comando que ejecutar invita a inventarla*— aquí aplica solo a medias: el diagnóstico no necesita un comando configurado, porque las observaciones salen de tools read-only que ya existen. Pero registrarla en una sesión de escribir código es ruido puro: una tool más en el schema que el modelo puede invocar sin sentido. Sin infraestructura a la vista, no hay incidente que diagnosticar.

> **Hito 17 (2026-09-23).** Decisiones de implementación que concretan §3, §5 y §10.5 (spec en §12.18): las reglas de entorno solo afectan a lo que **muta** (leer en producción nunca pregunta), sobre un clasificador read-only por allowlist; `requirePlan` escala el turno a modo plan en vez de solo rechazar, y la Fase 1 del plan admite `exec` read-only; `confirm-always` no lo levanta nada salvo la confirmación de esa llamada; y el perfil `auto` resuelve a `full` (no a `infra`) cuando hay infraestructura a la vista, para no quitar las tools de código a quien solo tiene docker instalado. El «read-only por defecto en producción» queda cubierto por `requirePlan`, que es exactamente eso: observar libre, cambiar solo con plan aprobado.
