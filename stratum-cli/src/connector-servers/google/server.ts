/**
 * Punto de entrada del conector de Google (Gmail, Tasks y Calendar): server MCP por stdio.
 * Se empaqueta en un único `.mjs` (tsup, `box-image/connectors/google/server.mjs`).
 * Si falta GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o GOOGLE_REFRESH_TOKEN arranca
 * igual: cada tool dice que no está configurado.
 */
import { createMcpServer, serveStdio } from '../lib/mcp-stdio.js';
import { createGoogleTools } from './tools.js';

serveStdio(
  createMcpServer(
    { name: 'google', version: '1.2.0' },
    createGoogleTools({
      fetch: globalThis.fetch,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    }),
  ),
);
