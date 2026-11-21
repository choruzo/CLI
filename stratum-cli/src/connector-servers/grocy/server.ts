/**
 * Punto de entrada del conector Grocy (M28): server MCP por stdio. Se empaqueta
 * en un único `.mjs` (tsup, `box-image/connectors/grocy/server.mjs`). Si falta
 * GROCY_URL o GROCY_API_KEY arranca igual: cada tool dice que no está configurado.
 */
import { createMcpServer, serveStdio } from '../lib/mcp-stdio.js';
import { createGrocyTools } from './tools.js';

serveStdio(
  createMcpServer(
    { name: 'grocy', version: '1.2.0' },
    createGrocyTools({
      fetch: globalThis.fetch,
      url: process.env.GROCY_URL,
      apiKey: process.env.GROCY_API_KEY,
    }),
  ),
);
