---
date: 2026-08-27
tags: [diario, hito-9, ssh, ssh2, host-keys, sftp, stratum-cli]
hito: 9
commit: (sin commitear)
---

# Diario — Hito 9: SSH Nativo

## Resumen

El diferenciador operacional del proyecto: el agente administra infraestructura remota desde el
mismo loop ReAct con que maneja ficheros locales, **sin invocar el binario `ssh` del sistema**.
Todo el protocolo corre dentro del proceso Node vía `ssh2`. 77 tests nuevos (421 → 422 en total con
el resto de la suite).

Verificado contra un host real (Ubuntu 24.04) con un modelo local `qwen3.6-35b-a3b` sobre LiteLLM.

---

## Qué se implementó

### Inventario y validación temprana (`config/schema.ts`)

`SSHHostSchema` + `ssh.{hosts,auditLog}`, deliberadamente **opcional y sin default**: si no hay
sección `ssh`, `registerSshTools` no registra nada y el modelo no ve las tools.

Un `superRefine` rechaza en carga lo que el pool no podría arreglar en runtime: host sin ningún
método de auth, `strict` sin `hostKeyHash`, y `jumpHost` inexistente, cíclico o de más de 2 saltos.
Fallar aquí evita que un ciclo cuelgue el pool.

### `SSHConnectionPool` (`pool.ts`)

Apertura lazy. El mapa `inflight` es el mutex de establecimiento: dos `ssh_exec` paralelos al mismo
alias comparten una promesa de conexión en vez de abrir dos sockets — necesario porque `ssh_exec` va
con `serialized: false`. Jump hosts vía `forwardOut`. `closeAll()` cierra las hojas antes que los
bastiones.

Reconexión: **solo** para conexiones ya establecidas que se caen (2s → 4s → 8s). El primer fallo de
apertura rechaza de inmediato, sin backoff — el agente decide si reintenta.

### Verificación de host key (`known-hosts.ts`)

TOFU sobre `~/.stratum/known_hosts.json` (formato propio, escritura atómica), `strict` con
fingerprint pinneado, `insecure` para lab. Un **mismatch aborta siempre**, con `recoverable: false`
y sin override interactivo.

### Tools

`ssh_exec` (`exec.ts`) con `pty`, `stdin`, `cwd`, corte en `maxBytes` (256 KB) y `commandTimeout`
(30 s), ambos matando el proceso remoto con `stream.signal('KILL')`. Devuelve XML `<ssh_result>`.
`ssh_upload` / `ssh_download` (`sftp.ts`) con `fastPut`/`fastGet`.

### Auditoría, CLI y UI

`~/.stratum/logs/ssh-audit.jsonl` con rotación a 10 MB. Comandos `stratum ssh list|trust`.
`<ToolCallBlock>` muestra `⌗ alias` y pinta la duración en `warning` si supera 1 s (UI §5.8).

---

## Decisiones técnicas clave

### El gate TOFU reutiliza `confirmDestructive`

En vez de un canal propio con componente Ink dedicado, la verificación de host key usa
`ToolContext.confirmDestructive`, que ya está cableado a `<DestructiveConfirm>` en el chat, readline
en `stratum run` y deny automático sin TTY. El comportamiento correcto en CI sale gratis.

`allow-all` (`!`) se interpreta como "aprobar **este** host": confiar en un fingerprint nunca puede
extenderse al siguiente.

### `isDestructive()` en vez de `destructive: true`

§12.14 escribía `destructive: true` pero describía "confirmar *si* detecta patrones peligrosos". En
este `ToolRegistry`, `destructive: true` significa confirmar SIEMPRE. La traducción fiel al
dispatcher existente es el predicado dinámico, que confirma si el host lleva `confirmAll` o si el
comando encaja con `tools.destructivePatterns` (reutilizando `commandIsDestructive` de
`shell/bash.ts`, sin duplicar lógica).

La detección de patrones es una **red blanda** contra descuidos del modelo, no un control real: el
campo `command` va a un shell remoto y un `base64 -d | sh` la esquiva sin esfuerzo. La defensa de
verdad es `confirmAll: true`.

### `keychain:` no implementado

Desviación consciente de §12.14: `keytar` es una dependencia nativa sin mantenimiento activo. El
resolvedor soporta `env:<VAR>`, literal y el fallback `STRATUM_SSH_<ALIAS>_SECRET`; un `keychain:`
devuelve un error que explica la alternativa en vez de fallar en silencio.

### Tests contra un servidor SSH real, no mocks

`ssh2` trae un `Server` completo, así que `test-server.ts` levanta uno en proceso con host key
generada al vuelo. Los 77 tests ejercitan el protocolo de verdad: exec con exit codes y stdin,
truncado por `maxBytes`, timeout, roundtrip SFTP, TOFU/strict/insecure y mismatch, reutilización de
socket entre calls concurrentes, y jump hosts a través de un túnel `forwardOut` real.

---

## Bugs que encontró la verificación, no los tests

Ambos aparecieron ejecutando el CLI compilado de punta a punta:

1. **Fuga de sockets en `runtime.ts`.** El singleton sustituía el pool sin cerrar el anterior. Un
   test de SFTP pasó de 10 s (timeout del hook) a 142 ms al arreglarlo.
2. **Error tardío sin listener tumbaba el proceso.** `ssh2` emite `error` de forma asíncrona incluso
   después de que la promesa de conexión se resuelva o rechace ("Connection lost before handshake").
   Sin manejador, ese EventEmitter mataba el proceso entero: `stratum ssh list` crasheaba con dos
   hosts, uno caído. Ahora el listener es **permanente**, montado antes de conectar, y distingue
   "antes" de "después" de resolverse. Con test de regresión.

También quedó a medias el cableado del `sessionId`: el campo llegaba al `ToolContext` pero ni `chat`
ni `run` ni los subagentes lo ponían, así que la auditoría salía sin él. Ahora `chat` genera el id
**al arrancar** (antes se generaba al guardar), `run` usa uno efímero por invocación, y los
subagentes heredan el del padre.

---

## Nota sobre interop CJS/ESM

`ssh2` es CJS. El detector de exports de Node reconoce `Client` como named export pero **no**
`Server` ni `utils`, que hay que tomar del default import — importante en `test-server.ts`. Además
`ssh2` va en `external` de `tsup.config.ts`: resuelve su binding nativo opcional con requires
dinámicos y bundlearlo rompe esa resolución.

---

## Verificación contra host real

| Prueba | Resultado |
|--------|-----------|
| TOFU primera conexión | Fingerprint real mostrado, denegado sin TTY, persistido al confiarlo |
| `ssh list` | `● lab usuario@host:22 [connected, 48ms]` |
| Agente + `ssh_exec` | Distro, kernel y uptime en un turno |
| SFTP roundtrip | SHA-256 idéntico origen ↔ vuelta |
| Gate destructivo | `rm -f` bloqueado, descrito como `ssh_exec [lab]: rm -f …` |
| `maxBytes` | `yes` (infinito) cortado en 4096 B a los 148 ms |
| `timeout` | `sleep 120` muerto a los 3129 ms con `COMMAND KILLED` |
| `stdin` | `sudo -S id` → `uid=0(root)` |
| `pty: true` | TTY real asignada (`/dev/pts/1`) |
| Paralelismo | Dos `ssh_exec` simultáneos compartiendo un solo socket |
| Subagentes | Dos en paralelo por SSH, heredando el `sessionId` del padre |

Sin verificar: agent forwarding no soportado en v1, autenticación por `privateKey`/`useAgent` contra
un host real, y Ctrl+C sobre un `ssh_exec` largo.

---

## Próximo paso

Hito 9 cierra el roadmap definido en §9. Ver [[Roadmap]] para lo que venga después.
