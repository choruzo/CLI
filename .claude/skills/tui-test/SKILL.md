---
name: tui-test
description: Lanza y maneja la TUI interactiva de Stratum CLI (`stratum chat`) en un terminal real para ver lo que pinta y probar un cambio de UI o del loop de punta a punta. Úsalo al tocar `src/cli/ui/`, atajos, /comandos, confirmaciones o cualquier cosa que el usuario vea en el chat.
---

El arnés vive en `stratum-cli/scripts/tui/` (`harness.mjs`, `mock-llm.mjs`, `smoke.mjs`); su `README.md` tiene la API completa y las trampas. Léelo antes de escribir un escenario.

1. `cd stratum-cli && npm run build` — el arnés lanza `dist/`, no `src/`. Sin build se prueba código viejo.
2. `npm run tui:smoke` (con `-- --show` imprime cada pantalla) para comprobar que nada básico se ha roto: bienvenida, paleta, turno, tool call, confirmación destructiva, cancelación, errores y salida.
3. Para lo que estés implementando, escribe un escenario `.mjs` **en el scratchpad** que importe el arnés por ruta absoluta (`file:///D:/…/stratum-cli/scripts/tui/harness.mjs`), maneja la UI con `type`/`key`/`submit`, espera con `waitFor` y **mira la pantalla** con `shot()`. Un escenario que solo arranca no prueba nada.
4. Si el cambio merece quedar cubierto, añade un `check(...)` a `smoke.mjs`.

Reglas:

- HOME y proyecto son temporales: nunca apuntes el arnés a `~/.stratum` ni a la config real del usuario.
- Usa el mock (`startMockLlm`, guion propio con `text`/`reasoning`/`toolCall`/`httpError`) salvo que el usuario pida probar contra un modelo real.
- Teclas de una en una (ya lo hace `type`); cancelar un turno es `Ctrl+C`, no `Esc`.
- Informa de lo que viste en pantalla, y distingue lo comprobado de lo que no llegaste a manejar.
