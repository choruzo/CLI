# Stratum Desktop

Shell de escritorio (Tauri v2 + React 18) sobre el core de `stratum-cli`. La
definición completa está en `../STRATUM_DESKTOP_PROJECT_DEFINITION.md` y el plan
por hitos en `../STRATUM_DESKTOP_HITOS.md`. Estado: **D1 cerrado**; D2–D5
implementados y verificados; **D6 cerrado** (integración con el SO y pipeline de
build, instaladores de CI probados en Windows y Linux) — ver abajo.

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
| `TAURI_SIGNING_PRIVATE_KEY` + `..._PASSWORD` | Clave minisign del **updater** (D7). Con ella el build añade `createUpdaterArtifacts` y cada instalador lleva su `.sig`; sin ella, instaladores sin auto-update. La pública está en `tauri.conf.json` (`plugins.updater.pubkey`) |
| `GPG_PRIVATE_KEY` (armored) + `GPG_PASSPHRASE` | Firmas `.asc` separadas del `.deb` y del `.AppImage` |

`build-sea.mjs` quita ahora la firma Authenticode de la copia de `node.exe` antes
de inyectar el blob (`signtool remove /s`, si hay Windows SDK): tras la
inyección esa firma quedaba rota, y un binario con firma rota es peor que uno sin
firmar —y estorba a la firma propia—.

## Pulido (D7)

### Ventana frameless (15.14)

`decorations: false`: la barra de título es `TitleBar.tsx` (32 px): logo, título
de la conversación activa, un hueco para el conmutador Chat | Code de D8 y los
controles ─ □ × como botones de verdad (Tab, nombre accesible, «Restaurar»
cuando está maximizada). Todo lo que no es un control lleva
`data-tauri-drag-region` (arrastrar; doble clic maximiza). Permisos justos en
`capabilities/default.json`: `core:window:allow-{minimize,toggle-maximize,
internal-toggle-maximize,close,start-dragging}`. Ajustes y el onboarding
empiezan debajo de la barra, así la ventana se puede mover y cerrar con ellos
abiertos; la pantalla de fallo de arranque también la lleva.

La ventana arranca oculta (`visible: false`) y `window_state.rs` la coloca donde
estaba antes de mostrarla. Se guarda el último rectángulo **normal** (sin
maximizar ni minimizar) más si estaba maximizada, en
`<app_config_dir>/window-state.json`, al cerrar y al salir. Al restaurar,
`clamp_to_monitors` (puro, con tests) lo ajusta a las áreas de trabajo de los
monitores conectados: si ya no comparte nada con ninguno (se cerró en un
monitor externo que no está), se centra en el principal; nunca es mayor que el
área; y la barra de título queda dentro, con al menos 120 px a la vista.

### Animaciones y accesibilidad

- **Espera del agente**: `ThinkingIndicator` — tres estratos que se depositan y
  una frase que rota cada 4 s. Las frases (`thinking-phrases.ts`) son de
  geología, no «Pensando…»: *Sedimentando*, *Contando varvas*, *Midiendo el
  buzamiento* mientras espera; *Metamorfoseando*, *Subduciendo dudas* mientras
  razona; *Sacando testigos*, *Perforando* con una tool en marcha; y pasados 30 s,
  *Esto va por eras geológicas*. Deterministas por turno (hash del id), sin
  `Math.random()`. A partir de 3 s enseña el tiempo y «Esc para detener».
- **Razonamiento del modelo**: `ReasoningBlock`. En vivo, una ventana de cuatro
  líneas con la cola del razonamiento («Razonando · 12 s»); al empezar la
  respuesta se pliega a «Razonó 12 s · N palabras», desplegable entero. Se guarda
  recortado en el transcript (8 000 caracteres por bloque), así que sobrevive a
  reabrir la conversación. Ver *Razonamiento* más abajo.
- **Desplegables** (`Collapse`): altura animada con `grid-template-rows`
  0fr → 1fr, sin medir el DOM; plegados quedan `inert`. Los usan tool calls,
  razonamiento y las novedades de una actualización. El sidebar abre y cierra
  animando su anchura y desmonta el panel al terminar.
- Mensajes que entran con un leve ascenso, cursor de streaming que respira, icono
  de la tool en marcha que gira y «pop» al terminar.
- `prefers-reduced-motion`: nada se desliza, gira ni parpadea.
- **Foco visible** en todo lo interactivo; **salto** «Ir al mensaje» con el
  primer Tab; foco atrapado (`useFocusTrap`) en Ajustes, el wizard y el
  onboarding, y devuelto al cerrar; pestañas de Ajustes y raíl del sidebar con
  flechas/Inicio/Fin; la confirmación destructiva enfoca «Denegar»; la lista de
  mensajes es una región enfocable; un anunciador (`role="status"`) dice una vez
  por turno «Stratum está trabajando» / «Respuesta lista» en vez de leer el
  streaming a trozos.
- **Contraste**: `textFaint` pasa a `#7C8493` (4,5:1 sobre todos los fondos);
  `theme.test.ts` comprueba WCAG AA para cada color de texto sobre cada fondo.

### Razonamiento

El core emite `thinking` desde `reasoning_content` (llama.cpp, vLLM, DeepSeek) o
`reasoning` (vLLM reciente, OpenRouter), y separa un `<think>…</think>` **al
principio** del contenido (Ollama, `--reasoning-format none`). El razonamiento
nunca entra en el historial del agente. En la CLI se pinta plegado en una línea
(`⊙ razonando…` en vivo, `⊙ razonó · N palabras` al terminar) y entero con
`/debug`.

### Auto-update

`tauri-plugin-updater`, manejado solo por Rust (`updates.rs`): el webview pide
`update_check` / `update_install` y no tiene permisos del plugin. Al conectar
(si `desktop.updates.autoCheck`, por defecto sí) se busca en silencio; el banner
ofrece «Instalar y reiniciar» o «Más tarde» (que aparca esa versión). Ajustes →
Sistema tiene «Buscar actualizaciones» y el interruptor. **Nunca se instala sin
que el usuario lo pida.** Antes de instalar se guarda la ventana y se apaga el
sidecar (en Windows el instalador NSIS sale con `process::exit`, en modo
`passive`, y relanza la app).

El manifiesto no puede colgar del «latest» de GitHub, que es la release de la
CLI: vive en una release fija, **`desktop-updater`**
(`…/releases/download/desktop-updater/latest.json`). Flujo de una versión:

1. Subir la versión en `tauri.conf.json`, `package.json` y `Cargo.toml`.
2. Tag `desktop-vX.Y.Z` → el workflow construye con la clave y deja la release en
   borrador con instaladores y `.sig`.
3. **Publicar** la release → el job `updater-manifest` genera `latest.json`
   (`scripts/updater-manifest.mjs`, con tests) a partir de las `.sig` y lo sube a
   `desktop-updater`. Las apps instaladas lo verán en su siguiente arranque.

La clave privada no está en el repo: se generó con `tauri signer generate` en
`~/.tauri/stratum-updater.key` (contraseña al lado, `.password`) y va a los
secrets `TAURI_SIGNING_PRIVATE_KEY` (el **contenido** del fichero: la variable de ruta no la acepta el bundler) y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
**Perderla obliga a reinstalar a mano**: las apps instaladas solo aceptan
paquetes firmados con ella. `STRATUM_UPDATE_ENDPOINT` sustituye el endpoint
(pruebas contra un servidor local; la firma se sigue exigiendo).

### Tests E2E

`e2e/` maneja la app de verdad (shell + sidecar SEA) por WebDriver
(tauri-driver), con un cliente W3C propio (`webdriver.mjs`, sin webdriverio) y
`node:test`. Cada suite arranca la app con un HOME aislado (config, sesiones,
workspaces y datos del webview) contra `mock-llm.mjs`, un servidor
OpenAI-compatible que responde en streaming con razonamiento y tool calls según
lo que escriba el test.

| Suite | Qué cubre |
|---|---|
| `window` | Posición guardada fuera de todo monitor → la ventana aparece visible; maximizar/restaurar con los controles propios; «Cerrar» guarda la posición |
| `chat` | TitleBar frameless, respuesta en streaming, razonamiento plegado, anuncio accesible, indicador de espera y «Detener» |
| `files` | Adjuntar → el agente lo lee de `inputs/`; genera un fichero en `outputs/` → «Guardar como…» |
| `retention` | Conversación con ficheros → relanzar con retención de segundos → `tar.gz` → abrirla lo restaura |
| `conversations` | Título automático, «Nueva», cambiar, renombrar, eliminar |
| `settings` | Cambiar una preferencia y guardar escribe el `.stratumrc.json`; pestañas con flechas; Esc |
| `onboarding` | Sin config: bienvenida → wizard contra el mock (sondea `/models`) → primera respuesta |

Los diálogos nativos de abrir/guardar no se pueden manejar por WebDriver: la
feature de Cargo **`e2e`** (solo en `npm run e2e:build`, nunca en release) los
sustituye por `STRATUM_E2E_PICK` / `STRATUM_E2E_SAVE_DIR` cuando la suite los
define.

```bash
npm run sidecar:build   # el SEA con el core actual
npm run e2e:build       # app de depuración con la feature e2e
npm run e2e             # Linux: xvfb-run -a npm run e2e
```

- **Linux**: `webkit2gtk-driver` (`WebKitWebDriver`) y `xvfb`; `cargo install
  tauri-driver --locked`. Es lo que corre la CI (`.github/workflows/desktop-e2e.yml`,
  `ubuntu-22.04`), que sube capturas y logs si algo falla
  (`STRATUM_E2E_ARTIFACTS`).
- **Windows**: `msedgedriver` de la **misma versión** que WebView2 (la de
  `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-…}` → `pv`,
  descarga en `https://msedgedriver.microsoft.com/<versión>/edgedriver_win64.zip`)
  y `STRATUM_E2E_NATIVE_DRIVER=<ruta a msedgedriver.exe>`. Se ejecuta en local:
  en CI el driver tendría que seguir cada actualización de WebView2.

