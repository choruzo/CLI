/**
 * Punto de entrada del conector Open-Meteo: server MCP por stdio. Se empaqueta
 * en un único `.mjs` (tsup, `box-image/connectors/open-meteo/server.mjs`).
 */
import { createMcpServer, serveStdio } from '../lib/mcp-stdio.js';
import { createOpenMeteoTools } from './tools.js';

serveStdio(
  createMcpServer(
    { name: 'open-meteo', version: '1.0.0' },
    createOpenMeteoTools({ fetch: globalThis.fetch }),
  ),
);
