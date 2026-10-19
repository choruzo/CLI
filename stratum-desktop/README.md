# Stratum Desktop

App de escritorio de Stratum (Tauri v2 + React 18). **Desde M12 es un cliente de `stratumd`**,
hermano de la CLI y de Stratum Dot: no tiene runtime de agente ni sidecar. Las fronteras entre
clientes están en `../docs/STRATUM_CLIENT_ARCHITECTURE.md` (normativo) y el contrato en
`../docs/protocol.md` (§20 para M12). La definición original y los hitos D0–D7 siguen en
`../STRATUM_DESKTOP_PROJECT_DEFINITION.md` y `../STRATUM_DESKTOP_HITOS.md`.

```text
Desktop (webview) ──invoke──► Rust (dot-link, perfil DESKTOP) ──pipe / socket──► stratumd ──► SessionHost
     UI, nada de estado          descubre, arranca el daemon,                     arbitra      ejecuta
     de sesión propio            saluda, se suscribe, reenvía
```

## Requisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Stratum (`stratum-cli`) | la de este repo | el daemon: Desktop usa la CLI instalada (`stratum daemon start`) o la de `STRATUM_DESKTOP_CLI` (un ejecutable o un `.js`, en desarrollo `../stratum-cli/dist/index.js`) |
| Node.js | 22.x | frontend y la CLI |
| Rust | stable (MSVC en Windows) | shell Tauri (incluye `../stratum-dot/crates/dot-link` por ruta) |
| Windows | MSVC Build Tools + WebView2 | — |
| Linux | `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config` | — |

El usuario final necesita Stratum instalado (`npm i -g stratum-cli`, Node ≥ 22), como con Dot.

## Comandos

```bash
npm install                      # también `npm install` y `npm run build` en ../stratum-cli
npm run tauri dev                # ventana con hot-reload
npm run tauri build              # .msi / .exe (NSIS) en Windows, .deb / .AppImage en Linux

npm run test:run                 # webview (Vitest + jsdom) + arquitectura (tests/)
npm run typecheck
npm run test:native              # cargo test del lado nativo
npm run smoke:clients            # Desktop ↔ Dot ↔ CLI contra un stratumd real
```

`smoke:clients` necesita `npm run build` en `../stratum-cli` y `cargo build -p dot-link` en
`../stratum-dot` (usa `dot-probe --client desktop`, el mismo enlace que la app, sin ventana).

## Arquitectura (M12)

- **Lado nativo** (`src-tauri/src/`): `lib.rs` arranca el enlace (`dot_link::spawn` con
  `ClientProfile::DESKTOP`: `core.hello` como `desktop`, rol `operator`, sigue la foto de conjunto y
  **solo** la sesión que se mira) y reenvía cada evento al webview por `desktop://event`, sin
  interpretarlo. `commands.rs` es la **lista blanca tipada** `desktop_*` (no hay método genérico).
  `prefs.rs` lee en solo lectura `desktop.*` del `.stratumrc.json` global. `workspace.rs` y
  `files.rs`: las carpetas de conversación (subidas, descargas, vista previa, exportar); cada
  comando recibe el `cwd` de la sesión y Rust solo toca carpetas de su raíz. `os.rs`
  (atajo, notificaciones, logs), `updates.rs`, `window_state.rs`. Salir suelta el enlace y nada más.
- **Webview** (`src/`):

  ```text
  Stratum Protocol → client/protocol-store (foto de conjunto, sesión enfocada, historial)
                   → view/ (puro: lista, turnos, modo del campo) → componentes
  ```

  `ipc/native.ts` es la única frontera con Rust para el daemon. `client/protocol-store.ts` valida
  con el contrato y reduce con sus funciones (`applyOverviewEvent`, `followSession`): una foto
  **sustituye**, un hueco pide foto, nada se escribe a mano. `client/ui-store.ts` guarda solo lo de
  la interfaz: qué se mira y lo **pedido aún no visto** («Enviando…», «Pausa pedida…»), que se
  retira cuando la foto lo alcanza. `client/actions.ts`: cada acción es una petición; una mutación
  sin respuesta no se repite. `view/chat.ts` agrupa la conversación del protocolo en turnos para los
  componentes de chat de D1–D7.
- **Conversación nueva**: Rust crea `<raíz>/<uuid>/{inputs,outputs,scratch}` y pide
  `sessions.open { agent: 'assistant', cwd }`. El primer mensaje la abre; si abrir no tuvo
  respuesta, no se envía nada.
- **Lo que Desktop no hace (M12)**: aprobar, contestar preguntas o decidir planes (se ven; se
  resuelven desde Dot o `stratum approvals`), editar la configuración (Ajustes es de solo lectura),
  retención de carpetas, memoria global, trayectoria.
- **Conversaciones de antes de M12**: `stratum desktop import` (una vez). Desktop avisa si quedan;
  no las lee.

Tests: `tests/architecture.test.ts` (sin runtime, sin sidecar, solo el contrato, frontera tipada,
nada que apruebe ni apague el daemon), `src/client/client.test.ts`, `src/view/view.test.ts`,
`src/App.test.tsx`, `cargo test` (`prefs`, `workspace`…), `scripts/smoke-clients.mjs` y las E2E.

> Las secciones siguientes describen D1–D7. Lo que en ellas dependía del sidecar (protocolo v9,
> `ConversationHost`, retención, Ajustes editables, onboarding, trayectoria) se retiró en M12; lo
> de la ventana, las carpetas de conversación y el sistema operativo sigue vigente.

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

`e2e/` maneja la app de verdad por WebDriver (tauri-driver), con un cliente W3C propio
(`webdriver.mjs`) y `node:test`. Cada suite usa un HOME aislado y **arranca un `stratumd` real**
con la CLI compilada antes de abrir la app (si lo arrancase la app colgaría del driver), contra
`mock-llm.mjs`, un servidor OpenAI-compatible que responde en streaming según lo que escriba el test.

| Suite | Qué cubre |
|---|---|
| `window` | Posición guardada fuera de todo monitor → visible; maximizar/restaurar; «Cerrar» guarda la posición |
| `chat` | El primer mensaje abre una sesión del daemon (la CLI la ve igual, origen `desktop`); streaming; controles del run; «Detener» la cancela en el daemon; ficheros de `outputs/`; adjuntar y que el asistente lo lea |
| `lifecycle` | Cerrar Desktop a mitad de un run → el daemon lo termina; reabrir → la misma sesión desde sus fotos; reiniciar el daemon con Desktop abierto → reconecta y se continúa |

Los diálogos nativos de abrir/guardar no se pueden manejar por WebDriver: la feature de Cargo
**`e2e`** (solo en `npm run e2e:build`, nunca en release) los sustituye por `STRATUM_E2E_PICK` /
`STRATUM_E2E_SAVE_DIR`. Con WebDriver cada arranque es un perfil de WebView2 nuevo: no hay
`localStorage` entre aperturas.

```bash
(cd ../stratum-cli && npm run build)   # el daemon de los tests
npm run e2e:build                      # app de depuración con la feature e2e
npm run e2e                            # Linux: xvfb-run -a npm run e2e
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

