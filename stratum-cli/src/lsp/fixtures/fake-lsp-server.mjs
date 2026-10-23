#!/usr/bin/env node
/**
 * Language server mínimo por stdio para los tests de `LspManager` (encargo
 * UX-2b). Implementa lo justo: `initialize`, `shutdown`, `exit` y, tras cada
 * `didOpen`/`didChange`, una publicación de diagnósticos con un error por cada
 * línea que contenga `ERROR` (mensaje `bad line`) o una lista vacía.
 *
 * Variables de entorno:
 * - `FAKE_LSP_PID_FILE`: escribe su pid ahí al arrancar (tests de `dispose`).
 * - `FAKE_LSP_SILENT=1`: no publica nunca (tests del timeout).
 * - `FAKE_LSP_STARTUP_DELAY_MS`: tarda eso en contestar `initialize` (tests de
 *   `dispose` con un arranque en vuelo).
 * - `FAKE_LSP_GARBAGE=1`: escupe basura sin framing antes de hablar (transporte
 *   roto → el cliente cierra y mata el proceso).
 * - `FAKE_LSP_BAD_DIAGNOSTICS=1`: publica entradas malformadas mezcladas con
 *   una válida (tests de validación).
 */
import { writeFileSync } from 'node:fs';

const pidFile = process.env.FAKE_LSP_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');
const silent = process.env.FAKE_LSP_SILENT === '1';
const startupDelayMs = Number(process.env.FAKE_LSP_STARTUP_DELAY_MS ?? '0');
const garbage = process.env.FAKE_LSP_GARBAGE === '1';
const badDiagnostics = process.env.FAKE_LSP_BAD_DIAGNOSTICS === '1';

// Sin `Content-Length` ni separador: el cliente tiene que darse cuenta de que
// el framing se perdió en vez de acumular para siempre.
if (garbage) process.stdout.write(`basura sin framing ${'x'.repeat(9000)}`);

const diagnosticsFor = (text) => {
  const out = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, index) => {
    const at = line.indexOf('ERROR');
    if (at === -1) return;
    out.push({
      range: {
        start: { line: index, character: at },
        end: { line: index, character: at + 'ERROR'.length },
      },
      severity: 1,
      code: 'FAKE1',
      source: 'fake-lsp',
      message: 'bad line',
    });
  });
  if (badDiagnostics) {
    // Entradas que el cliente tiene que descartar: sin `range`, con líneas no
    // numéricas y sin `message`.
    out.push({ message: 'sin range' });
    out.push({ range: { start: { line: '0', character: 0 } }, message: 'línea no numérica' });
    out.push({ range: { start: { line: 1, character: 1 } } });
  }
  return out;
};

const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]),
  );
};

const publish = (uri, version, text) => {
  if (silent) return;
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri, version, diagnostics: diagnosticsFor(text) },
  });
};

const requests = {
  initialize: () => ({ capabilities: { textDocumentSync: 1 } }),
  shutdown: () => null,
};
const notifications = {
  initialized: () => {},
  exit: () => process.exit(0),
  'textDocument/didOpen': (params) => {
    const doc = params.textDocument ?? {};
    publish(doc.uri, doc.version, doc.text);
  },
  'textDocument/didChange': (params) => {
    const doc = params.textDocument ?? {};
    const text = (params.contentChanges ?? []).map((change) => change.text).join('');
    publish(doc.uri, doc.version, text);
  },
  'textDocument/didClose': () => {},
  'workspace/didChangeConfiguration': () => {},
};

const handle = (message) => {
  if (message === null || typeof message !== 'object') return;
  const method = typeof message.method === 'string' ? message.method : undefined;
  if (method === undefined) return; // respuesta a algo que no pedimos
  if (message.id !== undefined) {
    const handler = requests[method];
    if (handler === undefined) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
      return;
    }
    const reply = () => send({ jsonrpc: '2.0', id: message.id, result: handler(message.params) });
    // `initialize` lento a propósito: deja el arranque en vuelo para los tests
    // de `dispose`/abort.
    if (method === 'initialize' && startupDelayMs > 0) setTimeout(reply, startupDelayMs);
    else reply();
    return;
  }
  const handler = notifications[method];
  if (handler !== undefined) handler(message.params);
};

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const separator = buffer.indexOf('\r\n\r\n');
    if (separator === -1) return;
    const header = buffer.subarray(0, separator).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (match === null) {
      buffer = buffer.subarray(separator + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = separator + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // JSON roto: se ignora
    }
  }
});
process.stdin.resume();
