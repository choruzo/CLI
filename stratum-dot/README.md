# Stratum Dot

Cockpit de escritorio de Stratum (Tauri v2): una ventana pequeña y una bandeja para ver las
sesiones vivas de `stratumd` —las que aloja el daemon y las que publican `stratum run` y
`stratum chat`—, pausar, reanudar, cancelar o redirigir sus runs y **conversar con Stratum**:
*New chat* abre una sesión alojada en el daemon, que sigue viva aunque cierres Dot.

Dot es un **cliente del Stratum Protocol** y nada más: no aloja sesiones, no tiene runtime y se
puede cerrar sin que cambie nada. Arquitectura, ciclo de vida, frontera de seguridad y
limitaciones: [`docs/dot.md`](../docs/dot.md). Contrato: [`docs/protocol.md`](../docs/protocol.md).

```text
stratum-dot/
├── src/                 frontend (React)
│   ├── app/             raíz, acciones, atajos, ErrorBoundary
│   ├── bridge/          la frontera con el lado nativo (comandos tipados + eventos)
│   ├── protocol/        el contrato de stratum-cli, reexportado; validar y aplicar
│   ├── stores/          connectionStore · sessionStore · uiStore (proyección para pintar)
│   ├── components/      piezas
│   └── screens/         Overview · SessionDetail (Chat / Activity) · NewChat · Incompatible
├── src-tauri/           shell nativo: ventana, bandeja, comandos `dot_*`
├── crates/dot-link/     cliente nativo del protocolo (sin Tauri) + `dot-probe`
├── tests/               invariantes de arquitectura
├── scripts/             smokes contra un daemon real (`smoke-real`, `smoke-chat`)
└── e2e/                 la app de verdad, con tauri-driver
```

## Requisitos

- Node 22, Rust estable y las dependencias de sistema de Tauri v2.
- `stratum-cli` instalado (`stratum` en el `PATH`) para que Dot pueda arrancar el daemon. En
  desarrollo, `STRATUM_DOT_CLI` apunta a la CLI del repositorio.

## Uso en desarrollo

```bash
(cd ../stratum-cli && npm ci && npm run build)
npm ci
STRATUM_DOT_CLI=../stratum-cli/dist/index.js npm run tauri dev
```

En PowerShell: `$env:STRATUM_DOT_CLI = "..\stratum-cli\dist\index.js"; npm run tauri dev`.

| Variable | Efecto |
|---|---|
| `STRATUM_DOT_CLI` | CLI con la que arrancar el daemon (ejecutable, o `.js` que se lanza con `node`) |
| `STRATUM_DOT_NO_AUTOSTART=1` | No arrancar el daemon aunque no haya ninguno |
| `STRATUM_DOT_NO_TRAY=1` | Sin bandeja (cerrar la ventana sale de Dot) |

## Tests

```bash
npm run test:native   # cargo test -p dot-link: unidad + enlace contra un daemon de pruebas (pipe real)
npm run test:run      # vitest: protocolo, stores, interfaz y arquitectura
npm run typecheck
npm run smoke:real    # `dot-probe` contra un stratumd real y un `stratum run` (necesita ../stratum-cli/dist)
npm run smoke:chat    # abrir una sesión del daemon y conversar con ella, contra un stratumd real

npm run e2e:build     # app de depuración
npm run e2e           # la ventana real con tauri-driver (`dot.e2e.mjs` y `chat.e2e.mjs`)
```

El E2E usa el mismo montaje que la suite de Desktop: `tauri-driver` (`cargo install
tauri-driver --locked`) y el driver nativo — en Windows, `msedgedriver` de la versión exacta de
WebView2, con `STRATUM_E2E_NATIVE_DRIVER=<ruta>`; en Linux, `webkit2gtk-driver` bajo Xvfb.
`--shots <carpeta>` guarda una captura de cada paso.

Todos los tests con procesos reales usan un HOME temporal: no tocan `~/.stratum` ni el daemon
que tengas en marcha.

## Empaquetado

```bash
npm run tauri build           # instaladores de la plataforma (nsis · deb · appimage)
```

Sin firma ni auto-update todavía (M9).
