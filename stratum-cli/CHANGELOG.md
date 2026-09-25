# Changelog — Stratum CLI

Cambios de cada versión del paquete [`stratum-cli`](https://www.npmjs.com/package/stratum-cli), de la más reciente a la más antigua. Stratum Desktop se versiona aparte: ver [`stratum-desktop/CHANGELOG.md`](../stratum-desktop/CHANGELOG.md).

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, [SemVer](https://semver.org/lang/es/) (mientras la versión sea `0.x`, una minor puede traer cambios incompatibles, que se señalan en «Cambios a tener en cuenta»). Las notas de cada versión también están en su [GitHub Release](https://github.com/choruzo/CLI/releases).

> Las versiones anteriores a la 0.2.1-beta.0 solo existen como tags de git: la primera publicación en npm fue la 0.2.1-beta.0.

## [0.6.0] — 2026-09-25

Centrada en el **Hito 17**: entornos con *blast radius*, modo read-only y perfil de sesión.

### Añadido
- **Entornos** (`environments` en `.stratumrc.json`): cada entorno casa por glob con `local` o `ssh:<alias>` y declara `tier`, `policy` (`allow` / `ask` / `confirm-always`), `requirePlan`, `readOnly` y `confirmation` (`typed` / `simple`). Solo afectan a lo que cambia algo: leer en producción nunca pregunta.
- `confirm-always` fuerza la confirmación aunque haya `--allow-destructive` o allow-all de sesión. Confirmación con nombre: en los entornos críticos se teclea el alias para aprobar.
- `requirePlan` escala el turno a modo plan antes de tocar ese entorno.
- **Modo read-only** (`--read-only` en `chat` y `run`, `/readonly`): inapelable, heredado por los subagentes y guardado en la sesión. Clasificador de comandos de solo lectura por lista blanca (git, kubectl, docker, systemctl, curl, sed, cmdlets `Get-*`…); la fase de exploración del modo plan admite estos comandos.
- **Perfil de sesión** `code` / `infra` / `full` / `auto` y propios en `session.profiles` (`--profile`, `--infra`, `--code`, `/profile`), combinado con el perfil de agente.
- Badges `⬢ entorno`, `RO` y `⬡ perfil` en la barra de estado y comando `/env`.
- **Razonamiento del modelo** (`reasoning_content`, `reasoning` o `<think>` inicial) plegado en una línea (`⊙ razonando…` / `⊙ razonó · N palabras`) y entero con `/debug`. Nunca entra en el historial.
- Core de Stratum Desktop D5–D7: panel de Ajustes (lectura/escritura del `.stratumrc.json` global con secretos enmascarados), notificaciones y atajo global (`desktop.notifications`, `desktop.globalHotkey`, gramática en `config/accelerator.ts`), razonamiento en el transcript y `desktop.updates.autoCheck`. Sin cambios de comportamiento en la CLI.

### Cambiado
- `stratum config set` escribe el fichero de forma atómica.

### Cambios a tener en cuenta
- Con `environments` definidos, `stratum run` sin TTY deniega los cambios en entornos `confirm-always` aunque el plan se apruebe con `--yes`.

## [0.5.0] — 2026-09-23

Centrada en el **Hito 16**: ejecución unificada, auditoría universal y redacción de salidas.

### Añadido
- Tool **`exec`** con `target` (`local` o `ssh:<alias>`) y backends con capacidades declaradas; descripción generada con los targets de la configuración.
- Cancelación estructurada y `maxBytes` en local que descarta la salida sobrante sin matar el proceso.
- Exit code real en Windows (`pwsh`), con contrato *best-effort* documentado.
- **Auditoría universal** de toda ejecución en `~/.stratum/logs/exec-audit.jsonl` (`tools.auditLog`), con el comando redactado y sin `stdin`.
- **Redacción de secretos** en las salidas (PEM, `Authorization`, `Bearer`, `sk-…`, `xox?-`, JWT, tokens de GitHub) con núcleo no desactivable y literales propios en `tools.redaction.extraPatterns`.
- Core compartido con Stratum Desktop D0–D4: `schemaVersion` en config y sesiones, preset de prompt `assistant`, confinamiento de las tools de fichero a un workspace e `importOptional()` para las dependencias nativas.

### Cambiado
- Un comando que se ejecutó y falló es un `tool_error` recuperable que no consume reintento, y el contador de reintentos pasa a ser consecutivo.

### Corregido
- Lag de la UI en streams largos.
- Los tests de guardas ya no escriben en la auditoría real del usuario.
- `tsc --noEmit` en verde.

### Cambios a tener en cuenta
- Las tools `bash` y `ssh_exec` desaparecen en favor de `exec`. Los perfiles de agente que las listen muestran un aviso en `/agents` y `stratum agents list`; hay que cambiarlas a mano.
- `ssh.auditLog` queda obsoleto y se migra solo a `tools.auditLog`.

## [0.4.0] — 2026-09-14

Hitos 11 a 15.

### Añadido
- **Disciplina operativa** (Hito 11): bloque `# Work routing` en el system prompt; guardas por capas (hard-deny no configurable, `tools.guardedCommands` y rutas sensibles) evaluadas antes de pedir confirmación; tool `todo` con panel `<TodoView>`, `/todo` y `Ctrl+T`.
- **Skills** (Hito 12): descubrimiento en `~/.stratum/skills`, `~/.claude/skills` y sus equivalentes de proyecto, con índice en el prompt y cuerpo bajo demanda. **Riesgo del cambio**: aviso `large_change` al superar las 400 líneas autoradas.
- **TDD estricto** (Hito 13) con `tools.testCommand`: tool `test_evidence` que valida el ciclo RED → GREEN → REFACTOR. **Panel de cambios** `+N/-M` en la barra de estado y `/changes`. **Contabilidad de tokens** con estado (`Σ` real, `Σ n/d` si el backend no informa).
- **Transversales de prompting** (Hito 14): saneado de `GIT_DIR`/`GIT_WORK_TREE` heredados, opciones de `question` con token opaco y dominio cerrado, contrato de identidad y guías por puntero (`prompt.guides: 'pointers'`).
- **Perfiles de agente de primera clase** (Hito 15): `description` y `mode`, `@perfil tarea` en el chat, `stratum run --delegate` y `--agent`, `/agent`, `/agents` y `stratum agents list [--json]`.

### Corregido
- La capa de rutas sensibles también se aplica a los comandos de shell (`cat`, `Get-Content`, redirecciones…).
- `/context` usaba «tokens» para dos cosas distintas.
- `token_budget_unmetered` se emite también en turnos de una sola iteración.

## [0.3.0] — 2026-09-11

Primera versión estable en npm, con el mismo contenido que la 0.2.1-beta.0. La etiqueta `latest` apunta desde aquí a versiones estables.

## [0.2.1-beta.0] — 2026-09-11

Primera publicación en npm. Hitos 7 a 10.

### Añadido
- **Plan & Execute** (Hito 7): `/plan <tarea>` y `stratum run --plan` (`--yes`); plan de solo lectura, aprobación con edición inline y ejecución con checklist, persistido en `.stratum/plans/` y reanudable con `chat --resume`.
- **Subagentes** (Hito 8): tool `delegate_task` con contexto aislado y perfiles en `.stratum/agents/`; presupuesto de tokens, persistencia y reanudación; ejecución en paralelo acotada (`agents.maxConcurrency`), árbol vivo `<AgentTree>` e inspector `/subagents`.
- **SSH nativo** (Hito 9) sobre `ssh2`: pool de conexiones, verificación de host keys (TOFU/strict), jump hosts, `ssh_exec`, `ssh_upload`/`ssh_download`, auditoría y `stratum ssh list|trust`.
- **Cierre de la UI base** (Hito 10): `/clear`, `/compact`, `/context`, `/debug`, `/mcp reload`, `/sessions`, `/config`; `Ctrl+L`, `Ctrl+U` e historial de inputs; `<FatalError>`, `<InitProgressBlock>` y `<MCPStartup>`.
- Tool **`question`** (Hito 2.5 F7): una tanda de preguntas al usuario; sin TTY el agente sigue con supuestos.

### Corregido
- La autocompactación medía mal el contexto y rompía el historial.
- Parpadeo del logo al arrancar.

## [0.2.0] — 2026-06-19

Hitos 2 a 6. Solo tag de git.

### Añadido
- **Memoria** (Hitos 2 y 5): `STRATUM.md` global y de proyecto en el system prompt, decision store `decisions.json`, índice semántico `sqlite-vec` con embeddings ONNX locales, tools `store_decision` y `recall_decisions`, extracción automática y `stratum memory list|search|forget`.
- **Init estilo opencode** (Hito 2.5): `stratum init` y `/init` con `INITIALIZE_PROMPT`, tools `glob`/`list_directory`/`grep`, `read_file` con líneas numeradas y compresión conservadora.
- **Tools completas** (Hito 3): `edit_file` con diff unificado, `web_search` (DuckDuckGo + Tavily), `web_fetch`, confirmación destructiva y timeouts con cancelación.
- **Providers** (Hitos 3.5 y 6): asistente `stratum provider add`, `/model` con descubrimiento en vivo, `/provider`, fallback automático entre providers y health check.
- **MCP** (Hitos 4 y 4.1): cliente con heartbeat y reconexión, tools `mcp__<server>__<tool>`, carpeta gestionada `~/.stratum/mcp/` y arranque `lazy`/`eager`.
- Logging estructurado con niveles, fichero JSONL rotado y `stratum logs`.

## [0.1.4] — 2026-05-29

### Cambiado
- CI: se retira el paso de publicación en npm hasta configurar `NPM_TOKEN`.

## [0.1.3] — 2026-05-29

### Corregido
- Un timeout mata el grupo de procesos entero: los huérfanos ya no bloquean los streams en Linux.
- El script de release gestiona el commit y el tag directamente (problemas de npm con git en Windows).

## [0.1.2] — 2026-05-28

Primera versión etiquetada. Hitos 0 y 1.

### Añadido
- Scaffolding: TypeScript, tsup (ESM + CJS), Vitest y Commander.js.
- **Core agent loop** (Hito 1): loop ReAct en streaming con cliente OpenAI-compatible propio, `StreamBuffer` para tool calls fragmentadas, `ToolRegistry` y tools básicas, y UI con Ink.
- `/init` para generar o actualizar `STRATUM.md`.
- Render de markdown de las respuestas.

[0.6.0]: https://github.com/choruzo/CLI/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/choruzo/CLI/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/choruzo/CLI/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/choruzo/CLI/compare/v0.2.1-beta.0...v0.3.0
[0.2.1-beta.0]: https://github.com/choruzo/CLI/compare/v0.2.0...v0.2.1-beta.0
[0.2.0]: https://github.com/choruzo/CLI/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/choruzo/CLI/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/choruzo/CLI/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/choruzo/CLI/releases/tag/v0.1.2
