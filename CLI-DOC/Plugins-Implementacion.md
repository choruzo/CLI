---
date: 2026-10-03
tags: [plugins, extensibilidad, diseño, stratum-cli]
status: aprobado
---

# Sistema de plugins — diseño e implementación

**Fuentes analizadas** (clonadas el 2026-10-03):

| Proyecto | Commit | Qué se leyó |
|---|---|---|
| opencode (`sst/opencode`) | `907b3bc` | `packages/plugin/src/{index,tool}.ts`, `packages/plugin/src/v2/promise/README.md`, `packages/opencode/src/plugin/{index,loader,shared}.ts`, `docs/plugins.mdx` |
| Pi (`badlogic/pi-mono`, `coding-agent` 1.0.1) | `8369268` | `docs/{extensions,packages,security}.md`, `src/core/extensions/{types,loader,runner,virtual-modules}.ts` |

Ideas reescritas para Stratum, no código portado.

> **Revisión pendiente:** §10 recoge 12 hallazgos de una revisión de Codex (2026-10-03), uno bloqueante (R1, huella de confianza). Conviene resolverlos antes de empezar PL1.

---

## 0. Esto revierte una decisión escrita

`Orientacion-Infraestructura.md` §10.5 dice, literalmente, que **no** hay que construir «un sistema de plugins que cargue módulos TS de un directorio», porque MCP ya cubre ese caso con protocolo y aislamiento de proceso. Ese argumento sigue siendo correcto **para tools**. Lo que MCP no puede hacer, y es lo que justifica reabrirlo:

| Necesidad | ¿MCP? | Por qué no |
|---|---|---|
| Añadir una tool | Sí | — |
| **Interceptar** una tool ajena (vetar, anotar su salida) | No | Un server MCP solo ve sus propias llamadas |
| Reaccionar al ciclo del agente (fin de turno, compresión, error) | No | El protocolo no transporta `AgentEvent` |
| Añadir un `/comando` | No | — |
| Aportar un bloque al system prompt | No | — |
| Distribuir skills + perfiles + comandos + servers MCP como una unidad instalable | No | Hoy se copian carpetas a mano |

Consecuencia de diseño: **el sistema de plugins no compite con MCP por las tools**. Una tool pesada, con dependencias nativas o que deba estar aislada, sigue siendo un server MCP (y un plugin puede declararlo). El plugin en proceso es para lo que necesita estar *dentro* del loop.

Aprobado el 2026-10-03 (D1 de §8): §10.5 de la orientación lleva una nota de revisión que apunta aquí.

---

## 1. Qué hacen opencode y Pi

### 1.1 opencode

- **Forma**: `export const MyPlugin = async (input) => hooks`. `input` trae `client` (SDK HTTP contra el propio servidor), `project`, `directory`, `worktree` y `$` (shell de Bun). Devuelve un objeto de hooks.
- **Hooks**: casi todos con firma `(input, output) => Promise<void>`, donde el plugin **muta `output`**: `tool.execute.before` (muta `args`, o lanza para bloquear), `tool.execute.after`, `chat.params`, `chat.headers`, `permission.ask` (puede devolver `allow`), `shell.env`, `tool.definition`, `experimental.chat.system.transform` (muta el system prompt entero), `experimental.session.compacting` (`context[]` o `prompt` de reemplazo). Más `event` (bus completo, solo notificación), `tool` (mapa de tools nuevas), `auth` y `provider`.
- **Carga**: ficheros en `.opencode/plugins/` y `~/.config/opencode/plugins/` + paquetes npm listados en `plugin: []` del config. Los npm **se instalan solos al arrancar** con Bun en una caché. Orden: config global → config proyecto → dir global → dir proyecto; los hooks corren **en secuencia**, en orden de carga.
- **Compatibilidad**: `engines.opencode` (semver) en el `package.json` del plugin; si no casa, se salta con aviso.
- **Errores**: fallo al cargar → evento de error y se sigue. Un hook que lanza **no se captura** en `trigger` (por eso lanzar bloquea la tool).
- **Sin modelo de confianza**: un repo clonado con `.opencode/plugins/x.ts` ejecuta código al abrirlo.
- **Una tool de plugin con el nombre de una built-in la sustituye.**
- **v2 en marcha** (`@opencode-ai/plugin/v2`): abandonan el objeto de hooks por registro **imperativo** (`ctx.agent.transform(...)`, cada registro devuelve `dispose`) y `define({ id, setup })`. Es la señal más útil: el objeto de hooks no escaló.

### 1.2 Pi

- **Forma**: `export default function (pi: ExtensionAPI)`, registro imperativo: `pi.on(event, handler)`, `pi.registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `registerMcpServer`, renderers de UI…
- **Eventos**: ~30 (`tool_call`, `tool_result`, `before_agent_start`, `context`, `turn_end`, `session_start`/`session_shutdown`, `input`, `user_bash`, `before_provider_headers`…). Cada uno declara su tipo de resultado: unos notifican, otros transforman, otros cancelan. `tool_call` devuelve `{ block, reason }` y **muta `event.input` en sitio**.
- **Fail-safe**: un handler de `tool_call` que lanza **bloquea la tool**; el resto de errores se reportan y se sigue.
- **Carga TS**: `jiti` (transpila al vuelo) + *virtual modules* / alias para que la extensión resuelva `@earendil-works/pi-coding-agent` y `typebox` contra la instancia del host. Los paquetes del host van en `peerDependencies` del plugin: una copia física duplica clases y registros.
- **Paquetes**: `pi install npm:…|git:…|./local`. Un paquete agrupa `extensions/`, `skills/`, `prompts/`, `themes/` por convención o por clave `pi` del `package.json`. Instalación **explícita**, versiones fijadas, filtros por recurso en settings.
- **Project trust**: los recursos ejecutables de un proyecto (`.pi/extensions`, `.pi/settings.json`, `.pi/mcp.json`…) no cargan sin una decisión guardada en `~/.pi/agent/trust.json`. Sin TTY y sin decisión → no cargan. Lo documentan con honestidad: *no* es un sandbox, solo evita que una carpeta ejecute código en silencio.
- **Ciclo de vida**: no arrancar procesos/timers en la factory; hacerlo en `session_start` y cerrar en un `session_shutdown` idempotente.

### 1.3 Qué nos llevamos y qué no

| Idea | Origen | Stratum |
|---|---|---|
| Registro imperativo `setup(api)` con `dispose` | Pi, opencode v2 | **Sí** |
| Fail-closed en el hook previo a la tool | Pi | **Sí** (encaja con `preflight`) |
| Project trust | Pi | **Sí**, reforzado con huella de contenido |
| Paquete = código + skills + perfiles + comandos | Pi | **Sí** |
| Instalación explícita, nunca al arrancar | Pi | **Sí** (reutiliza el patrón de `mcp/installer.ts`) |
| Compatibilidad declarada | opencode | **Sí**, como entero `apiVersion` (convención de `schemaVersion`) |
| Contexto extra para la compresión | opencode | **Sí** (`context[]`, sin reemplazo de prompt) |
| Mutar los argumentos de la tool | ambos | **No en v1** (ver §3.2) |
| Hook que **aprueba** permisos (`permission.ask → allow`) | opencode | **No, nunca** |
| Sustituir una tool built-in | opencode | **No, nunca** |
| Reescribir el system prompt entero | ambos | **No**: solo añadir bloques |
| Instalar npm al arrancar | opencode | **No** |
| `jiti` / transpilador embebido | Pi | **No** (ver §4.3) |
| Hooks de auth/provider | opencode | **No**: un solo tipo de provider, cliente propio |
| Componentes de TUI a medida | Pi | **No en v1** |

---

## 2. Principios

1. **Un plugin solo puede restringir, nunca relajar.** Puede vetar una llamada; no puede aprobarla, ni levantar un `preflight`, un `environmentGate`, el read-only, ni una confirmación.
2. **Las guardas ven lo mismo que se ejecuta.** Ningún hook cambia los argumentos después de que las políticas los hayan evaluado.
3. **Falla cerrado donde protege, falla abierto donde observa.** Un hook de veto que lanza o agota su timeout bloquea la llamada; un hook de notificación que lanza se registra y se ignora.
4. **Sin sandbox, y se dice.** El plugin corre en el proceso con los permisos del usuario. La defensa es *qué se carga* (confianza), no *qué puede hacer*.
5. **Cero dependencias nuevas.** Sin transpilador, sin `semver`, sin `npm-package-arg`.
6. **Nada cambia sin plugins.** Sin ninguno cargado, el host es un no-op: mismo prompt, mismo toolset, mismos tests.
7. **Solo CLI en v1.** El sidecar de Desktop es un Node SEA sin `import()`, y el preset `assistant` tiene un toolset cerrado: ahí no se carga ningún plugin.

---

## 3. Contrato del plugin

### 3.1 Forma

```ts
// ~/.stratum/plugins/guard-env.js
/** @type {import('stratum-cli/plugin').StratumPlugin} */
export default {
  id: 'guard-env',
  apiVersion: 1,
  setup(stratum, options) {
    stratum.on('tool.before', (call) => {
      if (call.tool === 'exec' && /\bterraform\s+destroy\b/.test(String(call.input.command))) {
        return { block: true, reason: 'terraform destroy is not allowed from the agent.' };
      }
    });
  },
};
```

- `id`: misma gramática que los nombres de perfil (minúsculas, dígitos, `-`), ≤32. Único; un duplicado se rechaza (gana el de mayor precedencia, el otro queda en `invalid` con motivo).
- `apiVersion`: entero. Mayor que el soportado → no se carga, con aviso (`SchemaVersionError` no: un plugin incompatible no es fatal).
- `setup` puede ser async; el arranque lo espera con timeout (`plugins.setupTimeoutMs`, 10 s). **No debe arrancar procesos, sockets ni timers**: eso va en `session.start`.
- **El plugin no importa nada del host en runtime.** Toda la API llega por el parámetro; los tipos son `import type` (se borran). Así no hay problema de resolución de módulos ni de instancias duplicadas, que es lo que obliga a Pi a montar alias y virtual modules.

### 3.2 Hooks (`stratum.on`)

`on()` devuelve una función que da de baja ese registro. Los handlers corren **en secuencia, en orden de carga**.

| Hook | Tipo | Recibe | Puede devolver |
|---|---|---|---|
| `tool.before` | veto | `{ tool, input, callId, sessionId, agent }` — `input` es un clon congelado | `{ block: true, reason }` |
| `tool.after` | transforma | lo anterior + `{ ok, output \| error, durationMs }` (ya redactado) | `{ output }` (solo si `ok`) |
| `event` | notifica | `AgentEvent` | — |
| `session.start` | notifica | `{ sessionId, cwd, worktree, resumed }` | — |
| `session.end` | notifica | `{ sessionId, reason }` | — |
| `compaction.context` | aporta | `{ sessionId }` | `string[]` |

Decisiones que no se deducen de la tabla:

- **`tool.before` no muta argumentos en v1.** opencode y Pi lo permiten, pero en Stratum los argumentos ya han pasado por demasiados puntos cuando llega el dispatcher: `requirePlanViolation` (en el `ReactLoop`, antes de despachar), `callEffects`, el evento `tool_call_ready` que la UI ya pintó, el write-log y la auditoría. Un plugin que cambiase `target: local` por `ssh:prod` después de esas comprobaciones sería un bypass de entornos. Bloquear con un `reason` instructivo consigue lo mismo: el modelo reintenta con los argumentos corregidos y esa llamada nueva pasa por todas las guardas.
- **Orden en `ToolDispatcher.dispatch`**: `tool.before` de plugins → `readOnlyVeto` → `environmentGate` → `preflight` → confirmación → ejecución → redacción → `tool.after` → redacción otra vez → truncado. Va primero para que al usuario no se le pregunte por algo que un plugin va a vetar; como no muta, el orden relativo con las guardas no afecta a la seguridad.
- **Un veto de plugin** es `{ ok:false, recoverable:true, countsAsFailure:false }`: no consume reintento ni deshabilita la tool. El `reason` se redacta y se prefija `Blocked by plugin <id>: `.
- **`tool.before` lanza o vence su timeout → la llamada se bloquea.** Si un plugin de guarda está roto, todo se bloquea hasta que el usuario lo desactive (`/plugins disable <id>` o `--no-plugins`). Es deliberado: lo contrario convierte un fallo del plugin en un bypass.
- **`tool.after`** no puede cambiar `ok` ni convertir un error en éxito. Los consumidores internos (`ChangeTracker` lee el diff de `edit_file`, la auditoría, el write-log) leen el resultado **original**; solo cambia lo que va al modelo y a la UI.
- **Las tools de control** (`todo`, `question`, `present_plan`, `update_plan`, `delegate_task`, `test_evidence`) no pasan por el dispatcher: no disparan `tool.before`/`tool.after`. Se observan por `event`.
- **Subagentes**: los hooks de tool aplican también a los hijos (`agent: { kind: 'subagent', profile, id }`). Si no, una guarda se saltaría delegando.
- **Concurrencia**: varias llamadas de un turno corren en paralelo, así que `tool.after` puede reentrar. `tool.before` es secuencial (la fase previa del dispatcher ya lo es).
- **`event`** se alimenta en `StratumAgent.run`, el único punto por el que pasan todos los eventos. Es *fire-and-forget*: no se espera, no retrasa el stream. `thinking` y `text_delta` se entregan (el plugin corre en proceso, ocultárselos no protege nada), pero el payload es un clon: mutarlo no afecta a la UI.
- **Timeouts**: `plugins.hookTimeoutMs` (5 s) por handler. Tres fallos consecutivos de un handler de notificación lo dan de baja para la sesión, con un `warning` `plugin_hook_disabled:<id>`.

### 3.3 Tools (`stratum.registerTool`)

```ts
stratum.registerTool({
  name: 'jira_issue',
  description: 'Fetch a Jira issue by key.',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  async execute(input, ctx) { return `…`; },   // lanzar = tool_error recuperable
});
```

- Nombre final **`plugin__<id>__<tool>`**, con las mismas reglas que MCP (≤64, hash si hay que recortar). **Nunca pisa un nombre existente**: colisión → se omite con aviso.
- `parameters` es **JSON Schema**, por el mismo camino que MCP (`rawParameters` + `z.record(z.unknown())`). No se acepta un schema Zod del plugin: sería otra instancia de Zod y `zodToJsonSchema` sobre ella es frágil entre versiones. La validación de entrada es responsabilidad del plugin, como en MCP.
- `execute` recibe `{ signal, cwd, sessionId, log }` — **no** el `ToolContext` interno (lleva `config` con secretos expandidos y `confirmDestructive`).
- Opcionales: `destructive: true` (pide confirmación por el camino normal), `timeout`, `serialized`.
- La salida entra por el dispatcher: redacción y truncado automáticos.
- **`callEffects`**: una tool de plugin cuenta como **mutante sin target**, igual que una MCP. Consecuencia: no está disponible en sesiones read-only ni en la Fase 1 del modo plan (D3).
- Perfiles: se filtran como cualquier tool (`allowedTools`, `hiddenTools`, glob `plugin__*`). El perfil de sesión `code`/`infra` las trata como las MCP.

### 3.4 Comandos (`stratum.registerCommand`)

```ts
stratum.registerCommand('standup', {
  description: 'Summarise yesterday\'s commits',
  handler: async (args, ctx) => ({ prompt: `Summarise the commits since yesterday. ${args}` }),
});
```

El handler devuelve `{ prompt }` (se envía como mensaje de usuario), `{ text }` (se pinta como salida del comando, sin ronda de LLM) o nada. Un nombre que coincida con un comando de `SESSION_COMMANDS` se rechaza al registrar. Aparecen en el autocompletado y en `/help` con el sufijo `(plugin <id>)`.

En `stratum run` no hay comandos: un plugin que solo registre comandos es inerte ahí.

### 3.5 Bloques de prompt (`stratum.addPromptBlock`)

`stratum.addPromptBlock({ title, body })` — estático, registrado en `setup`. Se inyecta en `promptEnv()` (el único punto de composición del prompt principal: un bloque añadido en otro sitio desaparecería en el siguiente `/model` o `/init`) como `# Plugin: <id> — <title>`, tras las skills. Tope de 4 000 caracteres por plugin; lo que exceda se recorta con aviso. Solo agente principal y preset `coding`; los subagentes no lo reciben (D4).

### 3.6 Utilidades

| | |
|---|---|
| `stratum.log` | `Logger` hijo `plugin.<id>`. **Nunca `console.log`**: Ink es dueño de stdout |
| `stratum.dataDir` | `~/.stratum/plugin-data/<id>/` (creado bajo demanda) para estado propio |
| `stratum.project` | `{ cwd, worktree }` |
| `stratum.version` | versión de Stratum y `apiVersion` del host |
| `stratum.notify(msg, level)` | emite un `warning` `plugin:<id>: …` en el turno en curso; fuera de turno, se pinta como aviso del sistema |

Deliberadamente **fuera**: acceso a la config (lleva secretos expandidos), al historial mutable, al `ProviderRouter`, a `confirmDestructive`.

---

## 4. Descubrimiento, carga y paquetes

### 4.1 De dónde salen

| # | Origen | Confianza |
|---|---|---|
| 1 | `--plugin <ruta>` (repetible, desarrollo) | implícita: lo pidió el usuario en esta invocación |
| 2 | `plugins.entries` del `.stratumrc.json` **global** | implícita |
| 3 | `~/.stratum/plugins/` (ficheros y subcarpetas) | implícita |
| 4 | `plugins.entries` del `.stratumrc.json` **de proyecto** | requiere *project trust* |
| 5 | `<proyecto>/.stratum/plugins/` | requiere *project trust* |

Orden de carga = orden de la tabla = orden de ejecución de hooks. Dentro de un directorio, alfabético. Dedupe por `id`.

Entrada de un directorio: `*.js`/`*.mjs` (y `*.ts`, §4.3) sueltos, o subcarpeta con `package.json` (clave `stratum.plugin` o `main`) o `index.js`. Sin recursión más allá de un nivel. El entry resuelto tiene que quedar **dentro** de la carpeta del plugin por `realpath` (lo mismo que comprueba `installState` para MCP).

### 4.2 Config

```jsonc
"plugins": {
  "enabled": true,
  "hookTimeoutMs": 5000,
  "setupTimeoutMs": 10000,
  "entries": {
    "guard-env":   { "path": "~/dev/guard-env/index.js" },
    "jira":        { "package": "stratum-plugin-jira@1.2.0", "options": { "site": "acme" } },
    "old-thing":   { "enabled": false }
  }
}
```

Misma forma que `mcp.servers` (clave = id, `package` como en el Hito 4.1). `enabled: false` sobre un id descubierto por directorio lo desactiva. `options` llega como segundo argumento de `setup`; las `${VAR}` se expanden como en el resto de la config.

Flags: `--no-plugins` (ni uno, tampoco los globales) y `--plugin <ruta>`.

### 4.3 TypeScript sin transpilador

Los paquetes distribuidos son **JavaScript** (`.js`/`.mjs`, ESM). Para plugins locales `.ts`: se aceptan **solo si `process.features.typescript` es verdadero** (Node ≥ 22.18 quita los tipos de forma nativa, sin flag). En un Node anterior, un `.ts` se rechaza con un mensaje que dice exactamente eso. No se añade `jiti`: es una dependencia de transpilación para un caso que Node ya resuelve, y el `engines` actual (`>=22.0.0`) está a una minor de cubrirlo entero.

Limitación heredada del type-stripping nativo: sin `enum`, sin `namespace`, sin decoradores, y los imports relativos llevan extensión. Se documenta en la guía de autor.

Carga: `import(pathToFileURL(entry).href)` en un helper propio (`plugins/load-module.ts`), **no** `importOptional` (ese es el punto de indirección de las nativas para el SEA).

### 4.4 Tipos para autores

Nuevo entry de build `src/plugins/api.ts` → `dist/plugin.d.ts` + `dist/plugin.js`, con `exports["./plugin"]` en `package.json`. Contiene solo tipos y un `definePlugin` identidad. Requiere activar `dts` en tsup para ese entry (hoy no se emite ningún `.d.ts`). El autor hace `npm i -D stratum-cli` y `import type`.

`api.ts` sigue la regla de `events.ts`: **sin imports de Node ni del resto del core** más allá de tipos, porque es superficie pública.

### 4.5 Paquetes y recursos declarativos

Un plugin en carpeta puede traer, además de código (o en vez de él):

```text
stratum-plugin-acme/
├── package.json        # "stratum": { "plugin": "./index.js", "apiVersion": 1 }
├── index.js            # opcional
├── skills/<nombre>/SKILL.md
├── agents/<nombre>.md
└── commands/<nombre>.md
```

- `skills/` y `agents/` se añaden como raíces extra a `skillDirs()` y al `ProfileLoader`, con la **menor** precedencia (plugin < usuario < proyecto). Un perfil de plugin sigue sujeto a `strictestPolicy`: no puede relajar la política destructiva.
- `commands/*.md`: frontmatter `description` + cuerpo como plantilla (`$ARGUMENTS`), parseado con `agent/frontmatter.ts`. Equivale a un `registerCommand` que devuelve `{ prompt }`. De paso habilita comandos de usuario sin código en `~/.stratum/commands/` y `<proyecto>/.stratum/commands/`.
- **Un paquete sin `index.js` no ejecuta código**: solo recursos. Aun así, en proyecto exige confianza — una skill instruye al modelo, que tiene `exec`.

### 4.6 Instalación gestionada

`stratum plugin add <spec>` instala en `~/.stratum/plugins/<id>/` reutilizando el patrón transaccional de `tools/mcp/installer.ts` (staging por proceso + marcador `.stratum-install.json` escrito lo último + rename; «instalado» = marcador válido, nunca la mera existencia de `node_modules`). Extraer lo común a `runtime/managed-install.ts` en vez de duplicarlo.

Diferencias respecto al instalador MCP:

- **`npm install --ignore-scripts`** siempre. Un `postinstall` es ejecución de código antes de que nadie haya decidido nada.
- **Nunca se instala al arrancar.** Una entrada `package` sin instalar produce un aviso con el comando exacto. (opencode instala solo; es justo lo que no queremos.)
- El marcador guarda la versión **resuelta** y el `integrity` del tarball; `stratum plugin update` es el único que los mueve.
- Solo npm en v1. `git:` queda fuera (D6).

Comandos: `stratum plugin list [--json]` · `add <spec>` · `remove <id>` · `update [id]` · `trust` / `untrust` (§5). En el chat: `/plugins` (estado: cargados, omitidos con motivo, hooks y tools de cada uno) y `/plugins disable|enable <id>` (solo esta sesión).

---

## 5. Confianza de proyecto

El riesgo concreto: `git clone` de un repo ajeno + `stratum chat` = ejecución de código arbitrario si el repo trae `.stratum/plugins/x.js`.

- Decisión en `~/.stratum/trust.json` (escritura atómica, Zod, `schemaVersion`). Clave: `realpath` de la raíz del proyecto. Valor: `{ decision: 'trusted' | 'denied', fingerprint, decidedAt }`.
- **`fingerprint`** = sha256 sobre (ruta relativa + contenido) de todo `<proyecto>/.stratum/plugins/**` salvo `node_modules`, más la sección `plugins` del `.stratumrc.json` de proyecto. **Si cambia, la confianza caduca** y se vuelve a preguntar. Pi guarda solo la ruta: un `git pull` que añade un plugin malicioso carga sin preguntar. Aquí no.
- Sin decisión y con TTY: gate al arrancar, antes de montar el agente, por `askLine` en `run`/`init` y con un componente propio en `chat`. Muestra la lista de ficheros que se van a ejecutar. Opciones: confiar · no cargar esta vez · no cargar nunca.
- **Sin TTY y sin decisión guardada: no se cargan**, con `warning`. Override explícito por invocación: `--trust-project-plugins`.
- **Falla cerrado**: `trust.json` dañado = nada es de confianza (mismo criterio que `known_hosts.json`: tratarlo como vacío y preguntar está bien; tratarlo como «todo aprobado», no).
- Los plugins **globales no deciden** sobre la confianza de proyecto (Pi lo permite con el evento `project_trust`; aquí sería un plugin relajando una guarda, que viola el principio 1).

Observación fuera de alcance: `mcp.servers` de un `.stratumrc.json` de proyecto ya lanza comandos de un repo clonado hoy, sin gate. El mismo `trust.json` podría cubrirlo; Pi lo hace. No forma parte de este diseño, pero conviene decidirlo aparte.

---

## 6. Integración en el código

### 6.1 Módulo nuevo `src/plugins/`

| Fichero | Contenido |
|---|---|
| `api.ts` | Tipos públicos (`StratumPlugin`, `PluginAPI`, payloads de hooks). Sin imports de runtime |
| `discover.ts` | Puro: orígenes → candidatos `{ id?, entry, source, scope }`. Sin `import()` |
| `load-module.ts` | `import()` + validación de la forma del default export (Zod) |
| `host.ts` | `PluginHost`: registro de hooks/tools/comandos/bloques por plugin, `trigger*`, timeouts, aislamiento de errores, `dispose` |
| `trust.ts` | `fingerprint`, `TrustStore`, `trustVerdict` (puro) |
| `resources.ts` | Raíces `skills/`/`agents/`/`commands/` de cada paquete |
| `report.ts` | `formatPluginsReport` / `pluginsToJson` puros (como `profiles-report.ts`) |
| `index.ts` | `loadPlugins(config, opts) → PluginHost` — único punto de entrada |

`PluginHost.empty()` es el no-op que se usa cuando no hay plugins, en Desktop y en los tests existentes.

### 6.2 Puntos de enganche

| Dónde | Cambio |
|---|---|
| `config/schema.ts` | Sección `plugins` (opcional, defaults inertes) |
| `cli/commands/chat.ts`, `run.ts` | `loadPlugins()` tras `configureLogging`; gate de confianza; `host.dispose()` en el teardown, **antes** de `closeExecRuntime()` |
| `agent/core.ts` | `StratumAgentOptions.plugins?: PluginHost`. `promptEnv()` añade los bloques; `makeLoop()` pasa el host por `extras`; `run()` alimenta `event`; `session.start`/`session.end` |
| `agent/types.ts` | `ToolContext.plugins?: PluginHost` (lo propaga el loop; los subagentes heredan el del padre vía `RunSubagentOptions`) |
| `tools/registry.ts` | `dispatch()`: fase `tool.before` antes de `readOnlyVeto`. `dispatchOne`: `tool.after` tras la primera redacción, y segunda redacción sobre lo que devuelva |
| `tools/index.ts` | `registerPluginTools(registry, host)` tras las built-in y MCP (así una colisión siempre la pierde el plugin) |
| `tools/environments.ts` | `callEffects`: `plugin__*` → mutante sin target (ya es el default de «desconocida»; añadir test que lo fije) |
| `agent/harness.ts` | `ContextManager.compress`: `compaction.context` → se anexa a `compressorInput` bajo un encabezado propio, recortado |
| `skills/registry.ts`, `agent/profiles.ts` | Raíces extra de paquetes, precedencia mínima |
| `cli/ui/session-commands.ts`, `App.tsx` | Comandos de plugin en la paleta y en `executeCommand`; `/plugins` |
| `cli/index.ts` | `stratum plugin …`, flags `--no-plugins`, `--plugin`, `--trust-project-plugins` |
| `desktop/*` | Nada. `StratumAgentOptions.plugins` no se pasa |

### 6.3 Invariantes para la §12 de la definición (propuesta §12.19)

1. Un veto de plugin nunca se convierte en aprobación; ningún hook levanta `preflight`, entornos, read-only ni confirmación.
2. `tool.before` recibe un clon congelado; los argumentos ejecutados son los que emitió el modelo.
3. `tool.before` que lanza o vence el timeout bloquea (`countsAsFailure: false`).
4. Todo lo que un plugin devuelve hacia el modelo (veto, salida de `tool.after`, salida de su tool, contexto de compresión) pasa por la redacción.
5. Un plugin no pisa nombres: ni tools, ni comandos, ni ids.
6. Los plugins de proyecto no cargan sin decisión de confianza vigente para su huella actual.
7. Nunca se instala nada al arrancar; `npm` siempre con `--ignore-scripts`.
8. Un fallo de carga de un plugin no impide arrancar; queda en el informe con su motivo.
9. `host.dispose()` es idempotente y tiene timeout: un plugin no puede impedir que el proceso termine (§12.12).

---

## 7. Fases

Numeración pendiente (18–20 están reservados al roadmap de infraestructura).

### PL1 — Host, carga global y hooks de tool
`src/plugins/{api,discover,load-module,host,report,index}.ts`; orígenes 1–3; `tool.before`, `tool.after`, `event`, `session.start`/`session.end`; `stratum plugin list`, `/plugins`, `--no-plugins`, `--plugin`; subagentes heredan el host.
**Tests**: plugin real en `fixtures/plugins/` cargado con `import()`; veto antes de confirmar (no se llama a `onConfirmDestructive`); `input` congelado; handler que lanza → bloqueo; timeout → bloqueo; `tool.after` re-redactado (devuelve un `sk-…` y sale `[redacted: …]`); veto aplicado a un subagente; `ChangeTracker` ve el diff original; sin plugins el prompt y los schemas son byte a byte los de hoy.
**Entregable**: un `.js` en `~/.stratum/plugins/` veta o anota tools.

### PL2 — Tools, comandos, prompt y compresión
`registerTool` (`plugin__<id>__<tool>`), `registerCommand`, `addPromptBlock`, `compaction.context`, `notify`, `dataDir`; entry `./plugin` con `.d.ts`.
**Tests**: colisión de nombre → omitida; tool de plugin vetada en read-only y en Fase 1 de plan; salida truncada y redactada; comando que no puede llamarse `/model`; bloque recortado a 4 000; el bloque sobrevive a `/model` y `/init`.
**Entregable**: un plugin añade una tool y un `/comando`.

### PL3 — Paquetes
Recursos declarativos (`skills/`, `agents/`, `commands/`), `commands/*.md` también en `~/.stratum/commands/`; `runtime/managed-install.ts` extraído del instalador MCP; `stratum plugin add|remove|update`; `apiVersion`.
**Tests**: `runNpm` inyectable (como en MCP); instalación interrumpida no cuenta como instalada; `--ignore-scripts` presente en los argumentos; precedencia plugin < usuario < proyecto en skills y perfiles; los tests del instalador MCP siguen verdes tras la extracción.
**Entregable**: `stratum plugin add stratum-plugin-x` y funciona en la siguiente sesión.

### PL4 — Plugins de proyecto y confianza
`trust.ts`, orígenes 4–5, gate en `chat`/`run`/`init`, `stratum plugin trust|untrust`, `--trust-project-plugins`.
**Tests**: huella cambia al tocar un byte; sin TTY no carga; `trust.json` corrupto → no carga; `denied` no vuelve a preguntar; symlink que saca el entry de la carpeta → rechazado.
**Entregable**: un repo puede traer sus plugins sin que clonarlo ejecute nada.

### PL5 — Opcional, según uso real
`request.headers` (observabilidad tipo Helicone; va en `CompletionRequest`, nunca toca `Authorization`), `exec.env` (inyección de entorno en `exec` local, aplicada **antes** de `scrubGitEnv`), `registerMcpServer`, `ui.confirm`, segmento propio en `StatusBar`, `/plugins reload`, mutación de argumentos (exigiría mover el hook al `ReactLoop`, antes de `tool_call_ready`).

---

## 8. Decisiones tomadas

Resueltas el 2026-10-03: el usuario aceptó las ocho recomendaciones.

| # | Pregunta | Decisión |
|---|---|---|
| D1 | ¿Se reabre la decisión de §10.5 de la orientación? | Sí, acotada: plugins para hooks/comandos/paquetes; MCP sigue siendo la vía para tools pesadas |
| D2 | ¿`tool.before` muta argumentos? | No en v1 (§3.2). Reconsiderar en PL5 |
| D3 | ¿Una tool de plugin puede declararse read-only para usarse en sesiones RO y en Fase 1 de plan? | No en v1: fiarse de la declaración de un tercero debilita el read-only. Si se abre, que sea solo para plugins globales |
| D4 | ¿Los bloques de prompt llegan a los subagentes? | No: contexto aislado y prompt mínimo. Las tools sí |
| D5 | `.ts` local vía type-stripping nativo, ¿o `jiti`? | Nativo, sin `jiti`. Subir `engines` a `>=22.18` lo haría universal; ese cambio no está decidido |
| D6 | ¿Fuentes `git:` además de npm? | No en v1 |
| D7 | ¿El gate de confianza cubre también `mcp.servers` de proyecto? | Sí, pero como cambio aparte de estas fases: altera el comportamiento actual |
| D8 | ¿Plugins en Desktop? | No hasta que haya un caso de uso; exigiría un loader para el SEA y decidir qué significa un hook en el preset `assistant` |

---

## 9. Lo que no se construye

- **Sandbox** (`vm`, worker, proceso hijo con IPC). Un `vm` de Node no es una frontera de seguridad y un proceso hijo con protocolo es reinventar MCP.
- **Marketplace / galería.** `npm search stratum-plugin` basta.
- **Hooks de auth y de provider.** El cliente es propio y hay un solo tipo de provider.
- **Sustituir tools built-in o el system prompt.**
- **Renderers y componentes Ink a medida.** Exponer React/Ink como API pública congela la UI.

---

## 10. Revisión de Codex (2026-10-03)

Revisión de este documento hecha por Codex contra `stratum-cli/src` y contra un clon de `openai/codex` (`58ae3ba`). Solo lectura: **nada de lo anterior se ha modificado**, y las decisiones D1–D8 siguen como estaban. Cada hallazgo queda *pendiente de decisión*. Lo que Codex hace distinto se resume en §10.4; el análisis completo de ese repo está en `Investigacion/codex.md`.

No verificado en esta revisión: lo que §1 afirma de opencode y Pi (no había clones) y el detalle del type-stripping de Node de §4.3.

### 10.1 Bloqueante

**R1 — §5: la huella no cubre todo el código que autoriza.**
Entra `<proyecto>/.stratum/plugins/**` (sin `node_modules`) y la sección `plugins` de la config de proyecto. Quedan fuera, y pueden cambiar sin caducar la confianza:

- una entrada `plugins.entries.<id>.path` de proyecto que apunte a otra carpeta (§4.1, origen 4);
- los imports relativos del plugin que salgan de su carpeta — el `realpath` de §4.1 solo comprueba el entry;
- `node_modules` del plugin, excluido de la huella.

*Propuesta:* la unidad de confianza es el **candidato resuelto**, no la carpeta: huella sobre todos los ficheros que el entry puede cargar. Para orígenes de proyecto, rechazar un `path` que salga de `<proyecto>/.stratum/plugins/` y los imports que salgan de la carpeta del plugin; incluir `node_modules` en la huella o exigir que las dependencias vengan de un paquete instalado con `integrity` verificado (§4.6). Recalcular antes de cada carga y documentar qué cambios externos quedan fuera de la garantía.

### 10.2 Conviene corregir antes de PL1

**R2 — §3.2 y §6.2: `ChangeTracker` no recibe el resultado original.**
§3.2 promete que los consumidores internos leen el resultado original y que `tool.after` solo cambia lo que va al modelo y a la UI. Pero §6.2 aplica `tool.after` dentro de `dispatchOne`, y el loop calcula el write-log **después**, sobre lo que devuelve el dispatcher: `changeFromToolCall(res.toolName, originCall.input, res.result.output)` (`agent/harness.ts:1394`). Un plugin que anote la salida de `edit_file` rompería el recuento de líneas.
*Propuesta:* `DispatchResult` lleva dos campos, el resultado interno y el presentado; o el write-log y la auditoría se registran antes de `tool.after`. Insertar el hook sin más no cumple lo prometido.

**R3 — §3.2: el orden descrito no es el del dispatcher.**
El doc dice `tool.before → readOnlyVeto → environmentGate → preflight → confirmación`. Hoy hay dos fases (`tools/registry.ts:263-276`): primero `readOnlyVeto ?? preflight` para **todas** las llamadas, y después la confirmación, secuencial; `environmentGate` se evalúa dentro de `confirmIfDestructive` (`registry.ts:379`), no antes del `preflight`.
*Propuesta:* describir las fases reales — vetos, confirmaciones, ejecución — y poner `tool.before` en la fase de veto, conservando la garantía de que no se pregunta nada hasta que todos los vetos han terminado.

**R4 — §3.1, §3.2 y §6.3 (invariante 9): un timeout no detiene a un plugin.**
`hookTimeoutMs`, `setupTimeoutMs` y el timeout de `dispose` dejan de *esperar* una promesa. No paran un handler que sigue trabajando, ni código síncrono que bloquea el event loop, ni un `dispose` colgado. «Un plugin no puede impedir que el proceso termine» no se puede garantizar con código en proceso (principio 4: sin sandbox).
*Propuesta:* acotar la invariante a plugins cooperativos; entregar un `AbortSignal` a cada handler; al vencer el timeout, revocar los registros y la API de ese plugin para la sesión; y definir el cierre forzado del host (`process.exit` tras el timeout de `dispose`) para el que no coopere.

**R5 — §3.2: los hooks no atienden la cancelación del turno.**
Los payloads no llevan señal. Una cadena secuencial de `tool.before` sigue corriendo tras un Ctrl+C, retrasa el cierre del turno (§12.12) y puede producir notificaciones tardías.
*Propuesta:* combinar el timeout con la señal del turno (`AbortSignal.any`), comprobar el abort antes de cada handler y antes de pasar a confirmación o ejecución, y descartar los resultados tardíos sin contarlos como fallo del handler.

**R6 — §3.2 y §6.2: `StratumAgent.run` no es el único emisor de eventos.**
`runDelegate` (`agent/core.ts:918`), que usan `@perfil` y `stratum run --delegate`, emite por su propio generador. Instrumentar solo `run()` (`core.ts:277`) deja esos turnos sin hook `event`.
*Propuesta:* una función de entrega compartida por las dos rutas, con tests de delegación directa, delegación del modelo y cancelación.

**R7 — §3.2: `tool.before` también puede reentrar.**
Es secuencial dentro de un dispatcher, pero cada subagente tiene su loop y su dispatcher, comparten el host, y corren en paralelo (`agents.maxConcurrency`). Dos hijos pueden llamar al mismo handler a la vez.
*Propuesta:* documentarlo como contrato (los handlers deben ser reentrantes) o serializar `tool.before` con un mutex del host. El mutex es más simple para el autor del plugin y el coste es pequeño.

**R8 — §3.3: una tool de plugin queda fuera de las políticas por target.**
«Mutante sin target» (`tools/environments.ts:168-172`) la excluye del read-only de sesión, pero `readOnly` de entorno, `requirePlan` y la confirmación de producción iteran sobre `callEffects(...).targets` (`tools/call-policy.ts:70`, `91`, `124`), que está vacío. Una tool de plugin que actúe sobre `ssh:prod` no dispara ninguna de las tres.
*Propuesta:* declararlo como limitación explícita en §3.3. Para operar sobre targets gestionados, el plugin debe pasar por `exec` del host; `destructive: true` no sustituye a un contrato de efectos. Un contrato de efectos declarado por el plugin tiene el mismo problema que D3 (fiarse de un tercero).

**R9 — §3.3 y §6.2: el perfil `infra` no vería las tools de plugin.**
§3.3 dice que `code`/`infra` las tratan como las MCP, pero `infra` las admite por el glob `mcp__*` (`agent/session-profile.ts:65`) y `session-profile.ts` no aparece en §6.2.
*Propuesta:* añadir `plugin__*` a `infra` e incluir el fichero en los puntos de enganche, con un test de composición con el perfil de agente y con read-only.

**R10 — §6.3 (invariante 4): la redacción no cubre todas las salidas.**
La invariante enumera veto, `tool.after`, salida de tool y contexto de compresión. Quedan fuera `{ prompt }` y `{ text }` de los comandos (§3.4), los bloques de prompt (§3.5) y `notify` (§3.6), que llegan al historial, al provider o a la UI.
*Propuesta:* redactar y limitar **toda** salida de un plugin hacia el modelo o el usuario, títulos y avisos incluidos, antes de truncar.

**R11 — §6.2: falta `stratum init`.**
§5 y PL4 piden gate de confianza en `init`, pero §6.2 solo enumera `chat.ts` y `run.ts`. `init` tiene su propio teardown (`cli/commands/init.ts:196-202`).
*Propuesta:* incluir `init.ts` en carga, confianza y `host.dispose()`, o declarar que `init` no carga plugins. Lo segundo es más simple.

### 10.3 Precisión

**R12 — §4.1: `installState` no comprueba `realpath`.** Su comprobación del entry es léxica (`resolve` + `relative` + `existsSync`, `tools/mcp/installer.ts:126-130`). El control por `realpath` que pide §4.1 es un endurecimiento nuevo, no algo que el instalador MCP ya haga.

### 10.4 Contraste con Codex

Codex resuelve el mismo problema con un diseño distinto. No obliga a cambiar nada, pero da contexto a varias decisiones:

| | Codex | Este diseño |
|---|---|---|
| Qué es un plugin | Paquete **declarativo**: skills, servers MCP, hooks, comandos (`core-plugins/src/manifest.rs`). No carga código en su proceso | Código JS en proceso + recursos declarativos (§4.5) |
| Hooks | Fuera de proceso: comando externo (JSON por stdin/stdout) o tool MCP | Función en proceso |
| Ejecución | En paralelo | En secuencia, orden de carga |
| `PreToolUse` que falla | **Falla abierto**: error, timeout o exit distinto de 0 y 2 → la tool se ejecuta | Falla cerrado (principio 3) |
| Mutar argumentos | Sí (`updatedInput`); con varios, gana el que termina último | No en v1 (D2) |
| Aprobar permisos | Sí (`PermissionRequest → allow`; un `deny` gana siempre) | Nunca (principio 1) |
| Timeout por hook | 600 s por defecto | 5 s |
| Confianza de proyecto | Por ruta, sin huella. Sin ella se desactivan config, hooks y exec policies del proyecto | Por ruta + huella de contenido; solo plugins (D7 añade `mcp.servers` aparte) |
| Confianza por hook | Hash de la **config** del hook; `modified` no corre hasta reaprobarlo. No cubre el script | — |
| Instalación npm | `npm pack --ignore-scripts` | `npm install --ignore-scripts` |

Lecturas:

- Secuencial, sin mutación y falla cerrado (principios 1–3, D2) son **más estrictos** que Codex en los tres puntos, y su código muestra por qué: la reescritura por orden de finalización es no determinista y un hook de guarda roto deja pasar la llamada.
- R4 y R5 existen porque los hooks corren en proceso. Un hook que es un comando externo se mata con una señal y no puede bloquear el event loop. §9 descarta el proceso hijo «con protocolo»; un hook de comando (`{ event, matcher, command }`) es más simple que eso y cubre el caso de la guarda sin cargar código. Candidato a PL5, o a PL1 si se quiere empezar por lo de menor riesgo.
- Codex gatea **toda** la capa de proyecto, no una sección. D7 cubre `mcp.servers`; siguen fuera `tools.testCommand`, `tools.sensitivePathAllowlist`, `tools.guardedCommands`, `environments` y `.stratum/agents/` con `destructivePolicy`, que también relajan guardas desde un repo clonado.
- Hooks que Codex tiene y §3.2 no: `Stop` que bloquea la terminación del turno (inyecta el motivo como continuación), `UserPromptSubmit`, `SubagentStart`/`SubagentStop`. Ampliación posible, no una omisión: un `Stop` bloqueante necesita un tope de bloqueos por turno.
