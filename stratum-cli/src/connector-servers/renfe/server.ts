/**
 * Punto de entrada del conector Renfe (Cercanías y Rodalies, y larga y media
 * distancia): server MCP por stdio. Se empaqueta en un único `.mjs` (tsup,
 * `box-image/connectors/renfe/server.mjs`).
 *
 * Cercanías y larga distancia son independientes: cada uno tiene su índice, su
 * gestor de actualización y su tiempo real, y si uno falla el otro sigue.
 *
 * `STRATUM_RENFE_OFFLINE=1` (solo para tests): no descarga nada ni consulta el
 * tiempo real. `STRATUM_CONNECTOR_CACHE` cambia el directorio de la caché.
 */
import { createMcpServer, serveStdio } from '../lib/mcp-stdio.js';
import { RealtimeSource } from './realtime.js';
import { IndexManager, LdIndexManager, renfeCacheDir } from './static-feed.js';
import { createRenfeCheckTools, createRenfeTools, type RenfeContext } from './tools.js';
import { createTrenesTools } from './tools-ld.js';

const offline = process.env.STRATUM_RENFE_OFFLINE === '1';

const manager = new IndexManager({
  dir: renfeCacheDir(),
  fetch: globalThis.fetch,
  offline,
});
const ldManager = new LdIndexManager({
  dir: renfeCacheDir(),
  fetch: globalThis.fetch,
  offline,
});
// La reconstrucción va en segundo plano: `initialize` contesta al instante.
manager.start();
ldManager.start();

const cercanias: RenfeContext = {
  withIndex: (fn) => manager.withIndex(fn),
  realtime: offline ? null : new RealtimeSource({ fetch: globalThis.fetch }),
};

serveStdio(
  createMcpServer({ name: 'renfe', version: '1.3.0' }, [
    ...createRenfeTools(cercanias),
    ...createRenfeCheckTools(cercanias),
    ...createTrenesTools({
      withIndex: (fn) => ldManager.withIndex(fn),
      realtime: offline ? null : new RealtimeSource({ fetch: globalThis.fetch, suffix: '_LD' }),
    }),
  ]),
);
