import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatible, withImages } from './openai-compatible.js';
import type { Message, ToolImage } from '../agent/types.js';
import type { RequestImage } from '../agent/screenshots.js';
import { withImageMarkers, type RequestUserImage, type UserImage } from '../agent/user-images.js';

/** M15 — cómo salen las capturas hacia el backend (cuerpo exacto, servidor real). */

let server: Server | undefined;
let lastBody: Record<string, unknown> = {};

async function serve(): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function image(tag: string): ToolImage {
  return {
    mime: 'image/png',
    data: `B64${tag}`,
    width: 1280,
    height: 800,
    bytes: 100,
    sha256: tag.repeat(64).slice(0, 64),
  };
}

const call = (id: string) => ({
  id,
  type: 'function' as const,
  function: { name: 'screen_click', arguments: '{}' },
});

const MESSAGES: Message[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'abre la web' },
  { role: 'assistant', content: null, tool_calls: [call('c1')] },
  { role: 'tool', tool_call_id: 'c1', content: 'Screenshot a…' },
  { role: 'assistant', content: null, tool_calls: [call('c2'), call('c3')] },
  { role: 'tool', tool_call_id: 'c2', content: 'Screenshot b…' },
  { role: 'tool', tool_call_id: 'c3', content: 'Screenshot c…' },
];

const imgs = (...ids: string[]): RequestImage[] =>
  ids.map((id) => ({ toolCallId: id, image: image(id.slice(1)) }));

describe('withImages', () => {
  it('sin imágenes devuelve una copia igual', () => {
    expect(withImages(MESSAGES, MESSAGES, [])).toEqual(MESSAGES);
  });

  it('cada captura va en un user tras el bloque de resultados que la contiene', () => {
    const out = withImages(MESSAGES, MESSAGES, imgs('c1', 'c3')) as Array<Record<string, unknown>>;
    expect(out.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user', // la de c1, antes del siguiente assistant
      'assistant',
      'tool',
      'tool',
      'user', // la de c3, tras el bloque c2+c3
    ]);
    const last = out[8]!.content as Array<Record<string, unknown>>;
    expect(last[0]).toEqual({
      type: 'text',
      text: `Screenshot ${'3'.repeat(12)} (from tool call c3):`,
    });
    expect(last[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,B643' },
    });
    // El historial no se toca.
    expect(MESSAGES).toHaveLength(7);
  });

  it('si tras el bloque ya viene un user, se le anteponen: nunca dos user seguidos', () => {
    const msgs: Message[] = [...MESSAGES, { role: 'user', content: 'sigue' }];
    const out = withImages(msgs, msgs, imgs('c3')) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(msgs.length);
    const content = out[7]!.content as Array<Record<string, unknown>>;
    expect(content.map((p) => p.type)).toEqual(['text', 'image_url', 'text']);
    expect(content[2]).toEqual({ type: 'text', text: 'sigue' });
  });

  it('una captura de una tool que no está en el historial no se inserta', () => {
    const out = withImages(MESSAGES, MESSAGES, imgs('c9'));
    expect(out).toEqual(MESSAGES);
  });
});

describe('OpenAICompatible con imágenes', () => {
  it('las serializa en el cuerpo; sin `images`, el cuerpo es el de siempre', async () => {
    const url = await serve();
    const client = new OpenAICompatible(url, 'k', 'm');
    for await (const _ of client.complete({
      messages: MESSAGES,
      stream: true,
      model: 'm',
      images: imgs('c3'),
    })) {
      /* consumir */
    }
    const sent = lastBody.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(MESSAGES.length + 1);
    expect(JSON.stringify(sent.at(-1))).toContain('data:image/png;base64,B643');

    for await (const _ of client.complete({ messages: MESSAGES, stream: true, model: 'm' })) {
      /* consumir */
    }
    expect(lastBody.messages).toEqual(MESSAGES);
    expect(JSON.stringify(lastBody)).not.toContain('image_url');
  });

  it('con breakpoints de caché explícitos, también', async () => {
    const url = await serve();
    const client = new OpenAICompatible(url, 'k', 'm', {
      cache: {
        usage: true,
        automaticPrefix: false,
        explicitBreakpoints: true,
        cacheKey: false,
        sessionAffinity: false,
      },
    });
    for await (const _ of client.complete({
      messages: MESSAGES,
      stream: true,
      model: 'm',
      images: imgs('c1'),
    })) {
      /* consumir */
    }
    const sent = lastBody.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(MESSAGES.length + 1);
    expect(sent[4]!.role).toBe('user');
    expect(JSON.stringify(sent[4])).toContain('image_url');
  });
});

/** Imágenes del usuario: van junto al mensaje que lleva su marca. */
function userImage(tag: string): UserImage {
  return {
    id: `img-${tag.padEnd(12, '0').slice(0, 12)}`,
    name: `${tag}.png`,
    mime: 'image/png',
    data: `U64${tag}`,
    bytes: 1024,
    sha256: tag.repeat(64).slice(0, 64),
  };
}
const mine = (...list: UserImage[]): RequestUserImage[] => list.map((image) => ({ image }));
type Wire = Array<Record<string, unknown>>;

describe('withImages con imágenes del usuario', () => {
  it('anclada a un user: sus partes van tras el texto del mensaje', () => {
    const a = userImage('a');
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: withImageMarkers('mira esto', [a]) },
    ];
    const out = withImages(msgs, msgs, [], mine(a)) as Wire;
    expect(out).toHaveLength(2);
    const parts = out[1]!.content as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image_url']);
    expect(parts[0]).toEqual({ type: 'text', text: msgs[1]!.content });
    expect(parts[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,U64a' },
    });
    // El historial no se toca.
    expect(msgs[1]!.content).toBe(withImageMarkers('mira esto', [a]));
  });

  it('con la marca en un tool (steering), van en un user tras el bloque, detrás de las capturas', () => {
    const a = userImage('a');
    const msgs: Message[] = [
      ...MESSAGES,
      { role: 'assistant', content: null, tool_calls: [call('c4')] },
      { role: 'tool', tool_call_id: 'c4', content: withImageMarkers('Screenshot d… ', [a]) },
    ];
    const out = withImages(msgs, msgs, imgs('c4'), mine(a)) as Wire;
    expect(out).toHaveLength(msgs.length + 1);
    expect(out.at(-1)!.role).toBe('user');
    const parts = out.at(-1)!.content as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'image_url']);
    expect(JSON.stringify(parts[1])).toContain('B64');
    expect(JSON.stringify(parts[3])).toContain('U64a');
  });

  it('sin marca en el historial no se manda', () => {
    const out = withImages(MESSAGES, MESSAGES, [], mine(userImage('a')));
    expect(out).toEqual(MESSAGES);
  });

  it('captura y imagen del usuario en el user siguiente: captura delante, imagen detrás', () => {
    const a = userImage('a');
    const msgs: Message[] = [
      ...MESSAGES,
      { role: 'user', content: withImageMarkers('y esto', [a]) },
    ];
    const out = withImages(msgs, msgs, imgs('c3'), mine(a)) as Wire;
    expect(out).toHaveLength(msgs.length);
    const parts = out[7]!.content as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'text', 'image_url']);
    expect(JSON.stringify(parts[1])).toContain('B643');
    expect(JSON.stringify(parts[4])).toContain('U64a');
  });
});

describe('OpenAICompatible con imágenes del usuario', () => {
  it('las serializa en el cuerpo', async () => {
    const url = await serve();
    const client = new OpenAICompatible(url, 'k', 'm');
    const a = userImage('a');
    const messages: Message[] = [{ role: 'user', content: withImageMarkers('hola', [a]) }];
    for await (const _ of client.complete({
      messages,
      stream: true,
      model: 'm',
      userImages: mine(a),
    })) {
      /* consumir */
    }
    const sent = lastBody.messages as Wire;
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('data:image/png;base64,U64a');
  });
});
