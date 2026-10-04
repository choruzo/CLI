# Arnés de la TUI

Maneja `stratum chat` como lo haría una persona: lo lanza en un pseudo-terminal
real (`@lydell/node-pty`, ConPTY en Windows), pasa la salida por un emulador de
terminal sin ventana (`@xterm/headless`) y deja leer la pantalla ya renderizada.
Los tests de Vitest no cubren esto: aquí se ve lo que Ink pinta de verdad y cómo
responde a cada tecla.

```bash
npm run build          # el arnés lanza dist/, no src/
npm run tui:smoke      # recorrido de humo (✓/✗, exit 1 si algo falla)
npm run tui:smoke -- --show   # además imprime cada pantalla
```

## Escribir un escenario

Un escenario es un `.mjs` suelto; no hace falta dejarlo en el repo.

```js
import { launch } from './scripts/tui/harness.mjs';
import { startMockLlm, mockConfig, text, toolCall } from './scripts/tui/mock-llm.mjs';

const mock = await startMockLlm();            // guion por defecto
const t = launch({ config: mockConfig(mock.baseUrl) });
try {
  await t.waitForBanner();
  await t.submit('hola');
  await t.waitForIdle();
  t.shot('tras el primer turno');             // imprime la pantalla
  console.log(t.styleOf('●'));                // { fg: '#…', bold, … }
} finally {
  await t.close();
  await mock.close();
}
```

`launch()` crea un HOME y un proyecto temporales (`t.home`, `t.project`): no toca
`~/.stratum` ni la config real, y `t.close()` los borra. Opciones: `config`
(`.stratumrc.json` global, `null` para ninguno), `args` (`['chat']`), `cols`,
`rows`, `files` (ficheros del proyecto) y `env`.

| Método | Qué hace |
|---|---|
| `type(texto)` / `key(nombre, veces)` / `submit(texto)` | Teclear, pulsar una tecla de `KEYS`, teclear + Enter |
| `paste(texto)` / `resize(cols, rows)` | Pegado en bloque, cambio de tamaño |
| `screen()` / `tail(n)` / `scrollback()` / `raw()` | Pantalla visible, sus últimas líneas, con historial, bytes crudos |
| `styleOf(texto)` | Color y atributos de la celda donde empieza ese texto |
| `waitFor(re)` / `waitGone(re)` / `waitForBanner()` / `waitForIdle()` / `waitExit()` | Esperas; al vencer lanzan con la pantalla en el mensaje |
| `shot(etiqueta, { last })` | Imprime la pantalla |
| `logs()` | Log JSONL parseado (con `logging: { level: 'debug', file: { enabled: true } }` en la config) |

## El mock

`startMockLlm(script)` sirve `/models` y `/chat/completions` en streaming. El
guion recibe `{ body, messages, last, said, n }` y devuelve pasos construidos
con `text()`, `reasoning()` y `toolCall()`, o `httpError(status, mensaje)`. El
guion por defecto está descrito en la cabecera de `mock-llm.mjs`; `mock.requests`
guarda cada petición recibida.

```js
const mock = await startMockLlm(({ last }) =>
  last.role === 'tool' ? text('listo') : toolCall('read_file', { path: 'a.txt' }),
);
```

Para probar contra un modelo real basta con pasar a `launch()` una config que
apunte a él.

## Trampas

- **Teclas de una en una.** Ink trata un bloque de bytes como un pegado y no
  reconoce el Enter que va dentro: por eso `type()` escribe carácter a carácter.
- **Cancelar es `Ctrl+C`**, no `Esc`. Tras cancelar, el siguiente input se
  fusiona con el `user` anterior (nunca dos `user` seguidos), así que el guion
  ve los dos textos en `said`.
- **Un `/comando` que no existe no llega al modelo**: la UI responde
  `✗ Comando desconocido`. Una ruta (`/etc/hosts …`) sí se envía como texto.
- **Sin `npm run build` se prueba código viejo.**
- La pantalla tiene `rows` filas: lo que ya subió está en `scrollback()`.
