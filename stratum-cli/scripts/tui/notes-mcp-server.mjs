// Conector MCP de pruebas (M17): un bloc de notas sobre stdio, para los E2E
// del `companion` con conectores. Protocolo real del SDK, sin mocks.
//
//   list_notes  — solo lee (en los E2E se declara en `readOnlyTools`)
//   add_note    — escribe una nota (cambia algo fuera de la caja: se confirma)
//
// Entorno: NOTES_FILE = fichero JSON con las notas (se crea si falta).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const file = process.env.NOTES_FILE;
if (!file) {
  process.stderr.write('NOTES_FILE is required\n');
  process.exit(2);
}
const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : []);

const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_notes',
      description: "List the user's notes.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'add_note',
      description: "Add a note to the user's notes.",
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The note' } },
        required: ['text'],
      },
    },
  ],
}));

const text = (t) => ({ content: [{ type: 'text', text: t }] });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  if (req.params.name === 'list_notes') {
    const notes = read();
    return text(
      notes.length === 0 ? 'No notes.' : notes.map((n, i) => `${i + 1}. ${n}`).join('\n'),
    );
  }
  if (req.params.name === 'add_note') {
    const note = String(args.text ?? '').trim();
    if (!note) return { content: [{ type: 'text', text: 'text is required' }], isError: true };
    writeFileSync(file, JSON.stringify([...read(), note]));
    return text(`Added note: ${note}`);
  }
  return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
