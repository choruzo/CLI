# Stratum Desktop

Shell de escritorio (Tauri v2 + React 18) sobre el core de `stratum-cli`. La
definición completa está en `../STRATUM_DESKTOP_PROJECT_DEFINITION.md` y el plan
por hitos en `../STRATUM_DESKTOP_HITOS.md`. Estado: **D1 cerrado**; D2–D5
implementados y verificados; **D6** (integración con el SO y pipeline de build)
implementado — ver abajo.

## Requisitos de desarrollo

| Herramienta | Versión | Para qué |
|---|---|---|
| Node.js | 22.x (probado con 22.20) | frontend, build del sidecar. **Es también el runtime que se embebe en el sidecar**: los `.node` de `stratum-cli/node_modules` se compilaron para su ABI |
| Rust | stable (MSVC en Windows) | shell Tauri |
| Windows | MSVC Build Tools + WebView2 | — |
| Linux | `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config` | — |

El usuario final **no** necesita ni Rust ni Node: la app instalada es un binario
nativo con el sidecar autónomo dentro.

## Comandos

```bash
npm install                      # también `npm install` en ../stratum-cli
npm run sidecar:build            # bundle + SEA + resources nativos + self-test
npm run tauri dev                # ventana con hot-reload
npm run tauri build              # .msi / .exe (NSIS) en Windows, .deb / .AppImage en Linux

npm run test:run                 # tests del frontend (Vitest + jsdom)
npm run typecheck
cd src-tauri && cargo test       # unitarios + integración contra el SEA real
```

`sidecar:build` hay que repetirlo cada vez que cambia el core (`stratum-cli/src`).
Los tests de integración de Rust se saltan con un aviso si el SEA no está construido.

## Arquitectura de D0

```
webview (React) ──invoke/Channel──► Rust (relay) ──named pipe / unix socket──► stratum-core (SEA)
                                     │ genera token + ruta                         │ valida token
                                     │ hace el handshake                           │ ping → pong
                                     │ Job Object / PDEATHSIG                      │ ganchos de apagado
```

- **`src-tauri/src/sidecar.rs`**: lanza el sidecar con `std::process` (no con el
  plugin shell: hace falta controlar stdin y meterlo en un Job Object), con
  stdout/stderr a `logs/sidecar.log`.
- **`src-tauri/src/transport.rs`**: conexión al pipe, handshake y filtrado de las
  tramas que manda el frontend.
- **`src-tauri/src/ipc.rs`**: relay y comandos `sidecar_status`,
  `sidecar_subscribe`, `sidecar_send`; eventos `sidecar://status` y `sidecar://ready`.
- **`stratum-cli/src/desktop/`**: el lado Node (servidor del canal, protocolo,
  ciclo de vida, sondeo de nativos). Entry: `stratum-cli/src/desktop-server.ts`.
- **Frontend**: `src/ipc/bridge.ts` es el único punto de contacto con Rust;
  `src/hooks/useSidecar.ts` mantiene el estado; `src/theme.ts` reexporta la
  paleta de la CLI y la vuelca como variables CSS.

### Decisiones de D0 que se apartan del texto original de la definición

| Tema | Definición original | Implementado | Motivo |
|---|---|---|---|
| Transporte del webview | WebSocket contra el pipe/socket | Relay por Rust (Tauri `Channel` + `invoke`) | Un webview no puede abrir un named pipe ni un unix socket: WebSocket solo habla TCP. El relay mantiene el canal único y ordenado (15.9) sin abrir TCP (15.1, 15.10) |
| Quién hace el handshake | El frontend | Rust | El token no sale nunca del proceso Tauri: un fallo de contenido en el webview no puede filtrarlo |
| Paso del token | `--desktop-token <TOKEN>` | Variable de entorno `STRATUM_DESKTOP_TOKEN` | La línea de comandos de un proceso la lee cualquier usuario (`ps`, `/proc/<pid>/cmdline`); el entorno solo el mismo usuario. El sidecar la borra de su entorno al leerla |
| Validación de `Origin` | Rechazar `Origin ≠ tauri://localhost` | No aplica | Sin HTTP/WebSocket no hay cabecera `Origin`; la defensa es el token más el nombre aleatorio del pipe |
| Framing | WebSocket | NDJSON (una línea JSON por trama) | Tope de 4 KiB antes de autenticar y 16 MiB después |
| Binario base del SEA | Descargado de nodejs.org | `process.execPath` del Node que construye | Los `.node` se usan tal cual los compiló `npm install`: el runtime embebido tiene que tener exactamente esa ABI |
| Plugin shell | `shell:execute` | Ninguno; `capabilities/default.json` solo con `core:default` | El sidecar lo lanza Rust directamente |

## Empaquetado del sidecar (15.2)

Método: **Node SEA** (`node --experimental-sea-config` + `postject`), en
`scripts/build-sea.mjs`:

1. `npm run build:desktop` en stratum-cli: un único CommonJS
   (`dist-desktop/stratum-core.cjs`) con todo el core menos los paquetes de
   `stratum-cli/src/desktop/resource-packages.json`.
2. Blob SEA con `useCodeCache`, inyectado en una copia del ejecutable de Node →
   `src-tauri/binaries/stratum-core-<target-triple>[.exe]` (`bundle.externalBin`).
3. Los paquetes nativos y su clausura de dependencias se copian a
   `src-tauri/resources/sidecar/node_modules` (`bundle.resources`), podados a lo
   que se ejecuta en esta plataforma. El sidecar los resuelve con un
   `createRequire` apuntado a `STRATUM_RESOURCES_DIR` (ver
   `stratum-cli/src/runtime/optional-import.ts` y el banner de
   `stratum-cli/tsup.desktop.config.ts`).
4. Self-test: el binario se ejecuta con un PATH sin Node y tiene que reportar
   `sea: true` y los tres nativos cargados.

La poda no copia las dependencias que solo sirven para instalar un nativo
(`prebuild-install`, `node-gyp`…) ni los `prebuilds/<so>-<arch>` de otras
plataformas. Además de ahorrar espacio, evita que linuxdeploy aborte al generar el
AppImage por pasar `ldd` sobre binarios de Android o iOS. `build-sea.mjs` también
borra `src-tauri/target/*/{sidecar,bundle}`, porque Tauri copia ahí los resources
y nunca elimina los ficheros que desaparecen de la fuente.

### Tamaños medidos (D0, x64)

| Pieza | Windows | Linux |
|---|---|---|
| Shell Tauri (`stratum-desktop`, release) | 8,9 MB | — |
| Sidecar SEA (runtime Node incluido) | 86 MB | 124 MB |
| Resources nativos (better-sqlite3, sqlite-vec, onnxruntime-node, sharp…) | 98 MB | 54 MB |
| Instaladores | `.msi` 61 MB · NSIS 40 MB | `.deb` 65 MB · `.AppImage` 140 MB (lleva WebKitGTK) |

La cifra «5–10 MB» solo vale para el shell Rust.

En WSL, linuxdeploy no puede montar su propia AppImage sin FUSE:
`APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri build`.

## Ciclo de vida (15.11)

1. **Cierre normal**: Tauri cierra el stdin del sidecar, que ejecuta sus ganchos
   (`ShutdownRegistry`: servidor IPC, runtime de `exec`, logging y, desde D1, los
   servers MCP de cada agente) y sale con 0. Se espera hasta 2 s.
2. Si no ha salido a tiempo: `kill`.
3. **Si Tauri muere sin poder hacer nada**: en Windows, el Job Object con
   `KILL_ON_JOB_CLOSE` mata el sidecar y todos sus hijos; en Linux, `PR_SET_PDEATHSIG`
   más el EOF en stdin. `PDEATHSIG` se dispara cuando muere el **hilo** que lanzó
   el proceso, así que `SidecarProcess::spawn` solo se llama desde el hilo
   dedicado del supervisor (D1), que vive tanto como la app; nunca desde un
   worker de Tokio.

## Chat de asistente (D1)

```
webview                      Rust                               stratum-core (SEA)
useAgentStream ─invoke──► sidecar_send (lista blanca + 1 MiB) ─pipe─► codec.ts (Zod estricto)
      ▲                                                                   │
      └──Channel──── relay (un suscriptor, reparto en bridge.ts) ◄─pipe── ConversationHost
                          ▲                                                └ ConversationSession × N
                     supervisor.rs (hilo dedicado,                            (StratumAgent preset
                     backoff 1→2→5→10 s, máx. 4)                               `assistant`, registry
                                                                               y router propios)
```

- **Protocolo v2** (`stratum-cli/src/desktop/protocol.ts`): `new_conversation`,
  `close_conversation`, `chat`, `cancel`, `answer_questions`,
  `confirm_response` con `conversationId`; salida `agent_event`, `turn_ended`,
  `chat_rejected`, `confirm_request`, `questions_request`, `prompt_resolved`,
  `conversation_opened|closed|error`. `cancel` viaja por el mismo canal ordenado
  que el stream (15.9).
- **Autenticación (15.1)**: una trama de conversación solo llega al host desde
  una conexión autenticada; el cliente activo tiene un *lease*
  (`connectionId`) y el cierre tardío de una conexión sustituida no cancela los
  turnos de la nueva.
- **Turnos**: uno a la vez por conversación, una única tarea que siempre acaba
  en `turn_ended` y guarda la sesión. Confirmaciones (5 min) y preguntas
  (10 min) se resuelven solas con `deny`/`null` al vencer, cancelar o cerrar.
  `allow-all` vale para el resto de la conversación.
- **Rehidratación (15.5)**: sesiones en `~/.stratum/desktop/sessions/<uuid>.json`
  (escritura atómica). Tras un reinicio del sidecar el frontend reenvía
  `new_conversation {resume: true}` y el agente recupera el historial; el turno
  que estaba a medias se ofrece para reintentar.
- **Memoria del asistente**: `~/.stratum/desktop/memory/`, separada de la de
  cualquier proyecto.
- **Ajustes (D5, 15.7)**: `Ctrl+,`, `/settings` o ⚙. El `.stratumrc.json`
  global lo lee, valida y escribe el **sidecar** (`stratum-cli/src/desktop/config-panel.ts`
  y `settings.ts`), no Rust: tiene el schema y aplica la config nueva a cada
  conversación antes de su siguiente turno. Las API keys literales llegan al
  webview como `••••••••` y se restauran al guardar (nunca hacia otra URL);
  guardar es concurrencia optimista por sha256 y el watcher del directorio solo
  avisa si el contenido difiere del último conocido, así que una escritura
  propia no vuelve como cambio externo. El frontend está en
  `src/components/settings/` y `src/hooks/useConfig.ts`; el ProviderWizard usa
  la lógica de la CLI (`wizard-logic.ts`). `sidecar_reload` reinicia el agente
  para lo que solo cambia al arrancar (raíz y límites de los workspaces, logging).
- **Markdown (15.13)**: `marked.lexer` solo trocea en bloques; cada bloque se
  renderiza con react-markdown memoizado por su texto, así que en streaming solo
  se re-parsea el último. Resaltado con `rehype-highlight` (nodos, sin HTML
  inyectado) solo en vallas cerradas. Sin HTML crudo, URLs solo `http(s)`/
  `mailto`, imágenes como enlace y enlaces sin `href` que abren el navegador del
  sistema.

## Integración con el SO (D6)

Las preferencias viven en el `.stratumrc.json` global, como el resto de Ajustes
(pestaña **Sistema**): `desktop.notifications.{enabled,minSeconds}` y
`desktop.globalHotkey` (gramática de Tauri; `""` = sin atajo). El sidecar las
valida (`stratum-cli/src/config/accelerator.ts`, compartido con el webview) y las
entrega en `config_state.applied.os` (protocolo v7), junto a
`applied.providerReady`. `useDesktopOs` pide la config en cada conexión y sigue
cada cambio, con Ajustes abierto o no.

- **Atajo global** (`src-tauri/src/os.rs`, `tauri-plugin-global-shortcut`): Rust
  registra `CommandOrControl+Shift+Space` al arrancar —para traer la ventana
  aunque el agente no arranque— y lo sustituye por el configurado en cuanto llega.
  Si el nuevo no se puede registrar (otra app lo tiene), recupera el anterior y
  Ajustes muestra el error. Pulsarlo restaura (si está minimizada u oculta) y
  enfoca la ventana. En Linux solo funciona bajo X11 (también XWayland): en una
  sesión Wayland nativa el registro falla y Ajustes lo dice.
- **Notificaciones** (`tauri-plugin-notification`): `TurnWatch`
  (`src/hooks/turn-notifications.ts`, puro) mide cada turno desde la cola hasta
  `turn_ended` y pide aviso si dura ≥ `minSeconds` y no se canceló; también
  cuando el agente espera una confirmación o respuestas. **Rust** decide si
  procede (`should_notify`: ventana sin foco, minimizada u oculta, o conversación
  que no es la visible) y recorta el texto. En `tauri dev` el aviso sale a nombre
  de «Windows PowerShell»; instalada, con el nombre de la app. Pulsar el aviso no
  enfoca la ventana: el plugin no expone el clic en Windows ni en Linux.
- **Onboarding**: sin provider utilizable, bienvenida → ProviderWizard (el de
  Ajustes, mismo guardado atómico) → la conversación se reabre sola con el
  provider nuevo y el input queda enfocado. «Ahora no» deja un aviso con
  «Conectar un modelo».
- **Errores del sidecar**: si el agente no llega a conectar ni una vez,
  `StartupFailure` ocupa la ventana (motivo, últimas líneas de `sidecar.log`,
  Reintentar, Ver logs). Una caída posterior es el banner no bloqueante de
  siempre, ahora también con «Ver logs». Los errores de config del arranque
  llevan «Abrir ajustes» y «Ver logs». `logs_open`/`logs_tail` los sirve Rust.

Ningún plugin nuevo da permisos al webview: todo pasa por comandos propios
(`os_set_hotkey`, `os_notify`, `logs_open`, `logs_tail`).

## Pipeline de build (D6)

`.github/workflows/desktop-release.yml`, separado del release de npm:

| Disparador | Resultado |
|---|---|
| Tag `desktop-vX.Y.Z` | Build en Windows y Linux + **Release en borrador** con los instaladores y `SHA256SUMS.txt` (pre-release si la versión es `0.x` o lleva sufijo) |
| Manual (`workflow_dispatch`) | Solo build; los instaladores quedan como artefactos del run |

Cada plataforma: versiones coherentes (`tauri.conf.json` = `package.json` =
`Cargo.toml` = tag), `npm ci` en los dos paquetes, tests del core (`src/desktop`,
`src/config`), typecheck y tests del frontend, `sidecar:build` (con su self-test
sin Node en el PATH), `cargo test` contra el SEA recién construido y
`tauri build --ci`. Windows produce `.msi` + NSIS (`windows-latest`); Linux,
`.deb` + `.AppImage` en `ubuntu-22.04` (glibc antigua a propósito, para que el
AppImage arranque en distribuciones de hace un par de años) con
`APPIMAGE_EXTRACT_AND_RUN=1`.

Firma, toda opcional — sin los secrets, instaladores sin firmar:

| Secret | Qué hace |
|---|---|
| `WINDOWS_CERTIFICATE` (PFX en base64) + `WINDOWS_CERTIFICATE_PASSWORD` | Authenticode: se importa el certificado y Tauri firma ejecutable, sidecar e instaladores (`certificateThumbprint`, sha256, sello de tiempo de DigiCert). Quita el aviso de SmartScreen a medida que el certificado gana reputación |
| `TAURI_SIGNING_PRIVATE_KEY` + `..._PASSWORD` | Clave minisign del **updater** (D7). Se pasa ya al build, pero solo se usa cuando se activen los artefactos del updater. Se genera con `npm run tauri signer generate` |
| `GPG_PRIVATE_KEY` (armored) + `GPG_PASSPHRASE` | Firmas `.asc` separadas del `.deb` y del `.AppImage` |

`build-sea.mjs` quita ahora la firma Authenticode de la copia de `node.exe` antes
de inyectar el blob (`signtool remove /s`, si hay Windows SDK): tras la
inyección esa firma quedaba rota, y un binario con firma rota es peor que uno sin
firmar —y estorba a la firma propia—.
