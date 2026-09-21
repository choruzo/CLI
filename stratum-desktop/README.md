# Stratum Desktop

Shell de escritorio (Tauri v2 + React 18) sobre el core de `stratum-cli`. La
definición completa está en `../STRATUM_DESKTOP_PROJECT_DEFINITION.md` y el plan
por hitos en `../STRATUM_DESKTOP_HITOS.md`. Estado: **D0** (ventana + sidecar
empaquetado + canal autenticado + ping; todavía sin chat).

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

### Tamaños medidos (Windows x64, D0)

| Pieza | Tamaño |
|---|---|
| Shell Tauri (`stratum-desktop.exe`, release) | 8,9 MB |
| Sidecar SEA (`stratum-core.exe`, runtime Node incluido) | 86 MB |
| Resources nativos (better-sqlite3, sqlite-vec, onnxruntime-node, sharp…) | 103 MB |
| Instalador `.msi` | 62 MB |
| Instalador NSIS `.exe` | 41 MB |

En Linux, el SEA pesa 124 MB y los resources 59 MB. La cifra «5–10 MB» solo vale
para el shell Rust.

## Ciclo de vida (15.11)

1. **Cierre normal**: Tauri cierra el stdin del sidecar, que ejecuta sus ganchos
   (`ShutdownRegistry`: servidor IPC, runtime de `exec`, logging y, desde D1, los
   servers MCP de cada agente) y sale con 0. Se espera hasta 2 s.
2. Si no ha salido a tiempo: `kill`.
3. **Si Tauri muere sin poder hacer nada**: en Windows, el Job Object con
   `KILL_ON_JOB_CLOSE` mata el sidecar y todos sus hijos; en Linux, `PR_SET_PDEATHSIG`
   más el EOF en stdin.
