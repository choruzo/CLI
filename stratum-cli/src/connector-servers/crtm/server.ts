/**
 * Punto de entrada del conector CRTM (transporte público de Madrid): server MCP
 * por stdio. Se empaqueta en un único `.mjs` (tsup,
 * `box-image/connectors/crtm/server.mjs`).
 *
 * Cada modo (Metro, Metro Ligero, EMT, autobuses urbanos de los demás municipios
 * e interurbanos) tiene su índice y su gestor de actualización, independientes:
 * si uno falla, los demás siguen. Sin tiempo real.
 *
 * `STRATUM_CRTM_OFFLINE=1` (solo para tests): no descarga nada.
 * `STRATUM_CONNECTOR_CACHE` cambia el directorio de la caché.
 */
import { createMcpServer, serveStdio } from '../lib/mcp-stdio.js';
import { FEED_MODES, type ModeId } from './feeds.js';
import { ModeManager, crtmCacheDir } from './static-feed.js';
import { createCrtmTools } from './tools.js';

const offline = process.env.STRATUM_CRTM_OFFLINE === '1';

const managers = new Map<ModeId, ModeManager>(
  FEED_MODES.map((m) => [
    m.id,
    new ModeManager({ mode: m.id, dir: crtmCacheDir(), fetch: globalThis.fetch, offline }),
  ]),
);
// La construcción va en segundo plano: `initialize` contesta al instante.
for (const m of managers.values()) m.start();

serveStdio(
  createMcpServer({ name: 'crtm', version: '1.0.0' }, [
    ...createCrtmTools({
      open: (mode) => managers.get(mode)!.open(),
      unavailable: (mode) => managers.get(mode)!.unavailableMessage(),
    }),
  ]),
);
