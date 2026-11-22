/**
 * Punto de entrada del conector Home Assistant: server MCP por stdio. Se empaqueta
 * en un único `.mjs` (tsup, `box-image/connectors/home-assistant/server.mjs`).
 * Si falta HA_URL o HA_TOKEN arranca igual: cada tool dice que no está configurado.
 */
import { createMcpServer, serveStdio } from '../lib/mcp-stdio.js';
import { createHomeAssistantTools } from './tools.js';
import { nodeWebSocket } from './ws-node.js';

serveStdio(
  createMcpServer(
    { name: 'home-assistant', version: '1.4.0' },
    createHomeAssistantTools({
      fetch: globalThis.fetch,
      url: process.env.HA_URL,
      token: process.env.HA_TOKEN,
      WebSocket: nodeWebSocket(),
    }),
  ),
);
