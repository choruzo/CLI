#!/usr/bin/env node
/**
 * Navegador falso para los tests de `cdp.ts` y `BrowserManager`: habla CDP por
 * los fd 3 (entrada) y 4 (salida), mensajes JSON separados por `\0`, como
 * `--remote-debugging-pipe`. Implementa lo justo: una pestaña (`T1`, sesión
 * `S1`), la intercepción de `Fetch` del documento principal en `Page.navigate`
 * y respuestas fijas a lo demás. Los argumentos del navegador de verdad llegan
 * detrás del script y se ignoran.
 *
 * `Runtime.evaluate` con una expresión `__nav:<url>` simula una navegación que
 * inicia la página (un clic, un `location =`): pide la petición del documento
 * principal y contesta `{ continued }` según lo que decida Stratum.
 *
 * Variables de entorno:
 * - `FAKE_BROWSER_PID_FILE`: escribe `<pid> <pid del nieto>` al arrancar; lanza
 *   un nieto que no termina solo (tests de procesos huérfanos).
 * - `FAKE_BROWSER_HUGE=1`: tras `Page.enable` manda un mensaje enorme.
 * - `FAKE_BROWSER_SILENT=<método>`: nunca contesta ese método (plazos).
 * - `FAKE_BROWSER_IGNORE_CLOSE=1`: no sale con `Browser.close` (hay que matarlo).
 * - `FAKE_BROWSER_EXIT_AFTER_SETUP=1`: sale solo tras el arranque (caída).
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';

// Sockets, no flujos de `fs`: en Windows una lectura de `fs` pendiente sobre el
// pipe impide que `process.exit` termine el proceso.
const input = new Socket({ fd: 3, readable: true, writable: false });
const output = new Socket({ fd: 4, readable: false, writable: true });

const silent = process.env.FAKE_BROWSER_SILENT ?? '';
const huge = process.env.FAKE_BROWSER_HUGE === '1';
const ignoreClose = process.env.FAKE_BROWSER_IGNORE_CLOSE === '1';
const exitAfterSetup = process.env.FAKE_BROWSER_EXIT_AFTER_SETUP === '1';

const pidFile = process.env.FAKE_BROWSER_PID_FILE;
if (pidFile) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(pidFile, `${process.pid} ${grandchild.pid}`, 'utf8');
}

const send = (message) => output.write(`${JSON.stringify(message)}\0`);
const event = (method, params, sessionId) =>
  send({ method, params, ...(sessionId ? { sessionId } : {}) });

// Un PNG de 1×1 y la cabecera de un JPEG de 32×16 (basta para leer su tamaño).
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02,
  0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]).toString('base64');

let url = 'about:blank';
let nextRequest = 1;
/** requestId → resolver con `true` (continuar) o `false` (fallar). */
const pausedRequests = new Map();

/** Una petición del documento principal: espera a que Stratum la decida. */
function pauseDocument(target) {
  return pauseRequest(target, 'Document');
}

/** Una petición cualquiera (un subrecurso con `Fetch`, `Script`…): lo mismo. */
function pauseRequest(target, resourceType) {
  const requestId = `r${nextRequest++}`;
  return new Promise((resolve) => {
    pausedRequests.set(requestId, resolve);
    event(
      'Fetch.requestPaused',
      { requestId, request: { url: target, method: 'GET' }, resourceType, frameId: 'T1' },
      'S1',
    );
  });
}

function loaded(target) {
  url = target;
  event('Page.frameStartedLoading', { frameId: 'T1' }, 'S1');
  event('Page.frameNavigated', { frame: { id: 'T1', url } }, 'S1');
  event(
    'Network.responseReceived',
    { requestId: 'n1', type: 'Document', frameId: 'T1', response: { url, status: 200 } },
    'S1',
  );
  event('Page.loadEventFired', { timestamp: 1 }, 'S1');
  event('Page.frameStoppedLoading', { frameId: 'T1' }, 'S1');
}

async function handle(msg) {
  const { id, method, params = {}, sessionId } = msg;
  if (method === silent) return;
  const reply = (result = {}) => send({ id, result, ...(sessionId ? { sessionId } : {}) });
  switch (method) {
    case 'Target.setAutoAttach':
      reply();
      if (!sessionId) {
        event('Target.attachedToTarget', {
          sessionId: 'S1',
          targetInfo: { targetId: 'T1', type: 'page', url },
          waitingForDebugger: false,
        });
      }
      return;
    case 'Page.enable':
      reply();
      if (huge)
        event(
          'Runtime.consoleAPICalled',
          { type: 'log', args: [{ type: 'string', value: 'x'.repeat(64 * 1024) }] },
          'S1',
        );
      return;
    case 'Runtime.runIfWaitingForDebugger':
      reply();
      if (exitAfterSetup) setTimeout(() => process.exit(3), 50);
      return;
    case 'Fetch.continueRequest':
    case 'Fetch.failRequest': {
      reply();
      const resolve = pausedRequests.get(params.requestId);
      pausedRequests.delete(params.requestId);
      resolve?.(method === 'Fetch.continueRequest');
      return;
    }
    case 'Page.navigate': {
      const continued = await pauseDocument(params.url);
      if (!continued) {
        reply({ frameId: 'T1', errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
        return;
      }
      reply({ frameId: 'T1', loaderId: `L${nextRequest}` });
      loaded(params.url);
      return;
    }
    case 'Runtime.evaluate': {
      const expression = String(params.expression ?? '');
      if (expression.startsWith('__nav:')) {
        const target = expression.slice('__nav:'.length);
        const continued = await pauseDocument(target);
        if (continued) loaded(target);
        reply({ result: { type: 'object', value: { continued } } });
        return;
      }
      // Un subrecurso que pide la página.
      if (expression.startsWith('__sub:')) {
        const continued = await pauseRequest(expression.slice('__sub:'.length), 'Fetch');
        reply({ result: { type: 'object', value: { continued } } });
        return;
      }
      // Volver a una página desde la caché: se carga sin que nada pase por `Fetch`.
      if (expression.startsWith('__restore:')) {
        loaded(expression.slice('__restore:'.length));
        reply({ result: { type: 'object', value: { continued: true } } });
        return;
      }
      if (expression.includes('__stratumBrowser') && expression.includes('maxChars')) {
        reply({
          result: {
            type: 'object',
            value: {
              title: 'Fake page',
              url,
              text: '# Fake\n[e1] button "OK"\n[e2] textbox "Email"',
              truncated: false,
              refs: 2,
            },
          },
        });
        return;
      }
      if (expression.includes('scrollIntoView')) {
        const ok = /\("e[12]"\)$/.test(expression);
        reply({
          result: {
            type: 'object',
            value: ok ? { ok: true, clicked: false, editable: true, x: 5, y: 5 } : { ok: false },
          },
        });
        return;
      }
      if (expression === 'document.title') {
        reply({ result: { type: 'string', value: 'Fake page' } });
        return;
      }
      if (expression === 'throw') {
        reply({
          result: { type: 'object' },
          exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: nope' } },
        });
        return;
      }
      reply({ result: { type: 'number', value: 42 } });
      return;
    }
    case 'Page.captureScreenshot':
      reply({ data: params.format === 'jpeg' ? JPEG : PNG });
      return;
    case 'Page.getNavigationHistory':
      reply({ currentIndex: 0, entries: [{ id: 1, url, title: 'Fake page' }] });
      return;
    case 'Browser.close':
      reply();
      if (!ignoreClose) setTimeout(() => process.exit(0), 20);
      return;
    default:
      reply();
  }
}

let buffer = '';
input.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const text = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    void handle(JSON.parse(text));
  }
});
input.on('end', () => {
  if (!ignoreClose) process.exit(0);
});
