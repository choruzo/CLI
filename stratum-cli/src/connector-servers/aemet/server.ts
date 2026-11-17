/**
 * Punto de entrada del conector AEMET (tiempo y avisos oficiales de España):
 * server MCP por stdio. Se empaqueta en un único `.mjs` (tsup,
 * `box-image/connectors/aemet/server.mjs`).
 *
 * Sin secretos: los XML de previsión y el RSS de avisos son públicos. Nada se
 * pide al arrancar (`initialize` contesta al instante): cada tool descarga lo
 * suyo, con caché en memoria (previsión 30 min por municipio y tipo, RSS 5 min).
 */
import { createMcpServer, serveStdio } from '../lib/mcp-stdio.js';
import { AemetForecast } from './forecast.js';
import { createAemetTools } from './tools.js';
import { AemetAvisos } from './warnings.js';

const forecast = new AemetForecast();
const avisos = new AemetAvisos();

serveStdio(
  createMcpServer({ name: 'aemet', version: '1.0.0' }, createAemetTools({ forecast, avisos })),
);
