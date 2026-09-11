<div align="center">
  <img src="https://raw.githubusercontent.com/choruzo/CLI/main/assets/banner.png" alt="STRATUM" width="640" />
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/stratum-cli?style=flat-square&color=F5A623&labelColor=111111)](https://www.npmjs.com/package/stratum-cli)
[![node](https://img.shields.io/badge/node-22+-F5A623?style=flat-square&labelColor=111111&logo=node.js&logoColor=F5A623)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-F5A623?style=flat-square&labelColor=111111)](https://github.com/choruzo/CLI/blob/main/LICENSE)

**Agente CLI extensible · Provider-agnostic · Local-first**

</div>

---

Stratum es un agente de línea de comandos construido sobre un loop **ReAct** (Reason → Act → Observe), con **plan-and-execute**, **subagentes** y **SSH nativo**. Funciona con cualquier API OpenAI-compatible: Ollama, llama.cpp, vLLM, LiteLLM y OpenAI nativo. No requiere ninguna cuenta ni API key propietaria.

## Instalación

Requiere **Node.js 22 o superior**.

```bash
npm install -g stratum-cli
stratum --help
```

También puedes ejecutarlo sin instalar:

```bash
npx stratum-cli chat
```

## Inicio rápido

```bash
# 1. Apunta Stratum a tu backend (asistente interactivo)
stratum provider add

# 2. Genera STRATUM.md con el contexto del proyecto
stratum init

# 3. Sesión interactiva
stratum chat

# ...o una tarea one-shot
stratum run "Analiza ./src y resume la arquitectura"

# ...o modo plan-and-execute (planifica, aprueba, ejecuta)
stratum run --plan "Refactoriza el módulo de autenticación"
```

## Capacidades

| Área | Detalle |
|---|---|
| Loop ReAct + streaming | Iteraciones con tool calls, compresión de contexto automática |
| Provider router | Fallback automático entre providers, health check en background, `/provider` en sesión |
| Tools built-in | `read_file`, `write_file`, `edit_file`, `glob`, `list_directory`, `grep`, `bash`, `web_search`, `web_fetch`, `question` |
| SSH nativo | `ssh_exec`, `ssh_upload`, `ssh_download` sobre `ssh2` — nunca invoca el binario `ssh` del sistema |
| Confirmación destructiva | Interactiva en `chat`, readline en `run`, deny automático sin TTY |
| Cliente MCP | Arranque lazy/eager, heartbeat, backoff, carpeta gestionada `~/.stratum/mcp/` |
| Memoria en 3 capas | `STRATUM.md` · `decisions.json` · índice semántico `vectors.db` |
| Plan & Execute | Planificación en 3 fases con aprobación interactiva y persistencia incremental |
| Multi-agente | `delegate_task`, perfiles markdown, ejecución paralela acotada, árbol vivo e inspector `/subagents` |
| Sesiones persistentes | `list`, `resume`, `delete`, `prune` |

## Configuración

`stratum init` y `stratum provider add` crean la configuración por ti. También puedes escribir `.stratumrc.json` a mano en la raíz del proyecto:

```json
{
  "provider": {
    "default": "local-ollama",
    "providers": {
      "local-ollama": {
        "type": "openai-compatible",
        "baseUrl": "http://localhost:11434/v1",
        "model": "qwen2.5-coder:32b",
        "apiKey": "ollama",
        "contextWindow": 32768
      }
    }
  }
}
```

> Las variables `${VAR_NAME}` se expanden desde el entorno al cargar la config.
> `contextWindow` debe reflejar el contexto **real** de tu servidor — un valor incorrecto degrada la calidad de `stratum init`.
> El ejemplo completo con todas las secciones está en [`.stratumrc.json.example`](https://github.com/choruzo/CLI/blob/main/stratum-cli/.stratumrc.json.example).

### Hosts remotos (SSH)

Las tools `ssh_exec`, `ssh_upload` y `ssh_download` **solo se registran si defines un inventario** — sin sección `ssh`, el modelo ni siquiera las ve. El agente se refiere a los hosts **solo por su alias**; las credenciales nunca pasan por el modelo.

```json
{
  "ssh": {
    "hosts": {
      "bastion": { "host": "bastion.example.com", "user": "javi", "privateKey": "~/.ssh/id_ed25519" },
      "prod-web": { "host": "192.168.1.10", "user": "javi", "privateKey": "~/.ssh/id_ed25519", "jumpHost": "bastion", "confirmAll": true }
    }
  }
}
```

La primera conexión muestra el fingerprint y pregunta (TOFU); después verifica en silencio contra `~/.stratum/known_hosts.json`. Si la host key cambia, la conexión se **aborta siempre** — no hay override interactivo. Cada comando remoto queda registrado en `~/.stratum/logs/ssh-audit.jsonl`.

> **Sobre la detección de comandos destructivos:** es una red de seguridad blanda contra descuidos del modelo, no un control real — un `base64 -d | sh` la esquiva sin esfuerzo. La defensa de verdad en hosts de producción es `confirmAll: true`.

### Dependencias opcionales

La búsqueda semántica de memoria (capa 3) usa `@xenova/transformers`, `better-sqlite3` y `sqlite-vec`, declaradas como `optionalDependencies`. Si su compilación nativa falla o las omites, Stratum **sigue funcionando**: el índice degrada a una búsqueda brute-force en JS y `decisions.json` nunca se pierde.

## Comandos

```
stratum chat                            Sesión interactiva
stratum chat --resume <id>              Reanuda una sesión guardada
stratum run "<tarea>"                   Tarea one-shot
stratum run --plan "<tarea>"            Modo plan-and-execute
stratum run --allow-destructive "..."   Aprueba tools destructivas automáticamente
stratum run --deny-destructive "..."    Deniega tools destructivas automáticamente
stratum init [--force] [--dry-run]      Genera/actualiza STRATUM.md
stratum config get|set <clave> [valor]  Lee/escribe configuración
stratum sessions list|resume|delete|prune   Gestión de sesiones
stratum memory list|search|forget       Gestión de la memoria de decisiones
stratum mcp list|install [server]       Servidores MCP
stratum providers                       Providers configurados
stratum ssh list|trust <alias>          Inventario SSH y host keys
stratum logs path|tail [n]              Fichero de logs (bug reports)
```

Dentro de `stratum chat`:

```
/plan <tarea>                Inicia el modo plan-and-execute
/subagents                   Inspector de transcripts de subagentes
/provider <name>             Cambia de provider en la sesión activa
/model                       Selecciona modelo (descubrimiento en vivo)
/memory list|search|forget   Memoria de decisiones desde el chat
/tools                       Tools disponibles, incluidas las MCP
/context · /compact · /clear Gestión del contexto de la conversación
```

## Enlaces

- **Código y documentación:** [github.com/choruzo/CLI](https://github.com/choruzo/CLI)
- **Roadmap y especificaciones:** [`STRATUM_PROJECT_DEFINITION.md`](https://github.com/choruzo/CLI/blob/main/STRATUM_PROJECT_DEFINITION.md)
- **Incidencias:** [github.com/choruzo/CLI/issues](https://github.com/choruzo/CLI/issues)

---

<div align="center"><sub>MIT License</sub></div>
