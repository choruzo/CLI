import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StratumConfigSchema, type StratumConfig } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';
import { buildAssistantRegistry } from '../../host/assistant.js';
import { buildAssistantPrompt } from '../../agent/system-prompt.js';
import { callEffects } from '../environments.js';
import {
  createGenerateImageTool,
  GENERATE_IMAGE_TOOL,
  callImageTag,
  imageFileStem,
  resolveImageEndpoint,
} from './generate.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

function config(extra: Record<string, unknown> = {}): StratumConfig {
  return StratumConfigSchema.parse({
    provider: {
      default: 'nan',
      providers: {
        nan: {
          type: 'openai-compatible',
          baseUrl: 'https://img.example/v1/',
          model: 'glm',
          apiKey: 'sk-secret-key-1234',
        },
      },
    },
    ...extra,
  });
}

const withImages = (): StratumConfig => config({ imageGeneration: { model: 'flux-2-klein' } });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gen-image-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function ctx(cfg: StratumConfig): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: dir,
    config: cfg,
    workspace: { root: dir, readOnly: ['inputs'], writable: ['outputs', 'scratch'] },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('generate_image', () => {
  it('pide al provider configurado y guarda la imagen en outputs/', async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ b64_json: PNG.toString('base64') }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await createGenerateImageTool().execute(
      { prompt: 'a fox', size: '768x1024', name: 'Zorro acuarela' },
      ctx(withImages()),
    );
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://img.example/v1/images/generations');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-secret-key-1234',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'flux-2-klein',
      prompt: 'a fox',
      n: 1,
      size: '768x1024',
      response_format: 'b64_json',
    });
    const files = readdirSync(join(dir, 'outputs'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^zorro-acuarela-\d{14}\.png$/);
    expect(readFileSync(join(dir, 'outputs', files[0]!))).toEqual(PNG);
    // La salida empieza por la ruta: Desktop la lee de ahí.
    expect(result.ok && result.output.split('\n')[0]).toBe(`outputs/${files[0]}`);
  });

  it('descarga la URL si el provider no devuelve base64, sin mandar la apiKey', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/images/generations')
        ? json({
            data: [{ url: 'https://cdn.example/a.jpg' }, { url: 'https://cdn.example/b.jpg' }],
          })
        : new Response(JPEG, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await createGenerateImageTool().execute(
      { prompt: 'two foxes', n: 2 },
      ctx(withImages()),
    );
    expect(result.ok).toBe(true);
    const download = fetchMock.mock.calls[1] as unknown as [string, RequestInit | undefined];
    expect(download[0]).toBe('https://cdn.example/a.jpg');
    expect(JSON.stringify(download[1] ?? {})).not.toContain('sk-secret');
    expect(readdirSync(join(dir, 'outputs')).sort()).toEqual([
      expect.stringMatching(/^imagen-\d{14}-1\.jpg$/),
      expect.stringMatching(/^imagen-\d{14}-2\.jpg$/),
    ]);
  });

  it('rechaza lo que no es una imagen y no deja nada en outputs/', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [{ b64_json: Buffer.from('<html>').toString('base64') }] })),
    );
    const result = await createGenerateImageTool().execute({ prompt: 'x' }, ctx(withImages()));
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, 'outputs'))).toBe(false);
  });

  it('un error HTTP del provider llega al modelo, redactado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'bad size; key sk-secret-key-1234' }, 400)),
    );
    const result = await createGenerateImageTool().execute({ prompt: 'x' }, ctx(withImages()));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('HTTP 400');
  });

  it('marca los ficheros con la llamada y nunca pisa uno anterior', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ data: [{ b64_json: PNG.toString('base64') }] })),
    );
    const c = { ...ctx(withImages()), callId: 'call_AbC123' };
    await createGenerateImageTool().execute({ prompt: 'x', name: 'gato' }, c);
    await createGenerateImageTool().execute({ prompt: 'x', name: 'gato' }, c);
    expect(readdirSync(join(dir, 'outputs')).sort()).toEqual([
      'gato-callabc123-v2.png',
      'gato-callabc123.png',
    ]);
  });

  it('valida el tamaño', () => {
    expect(() => createGenerateImageTool().schema.parse({ prompt: 'x', size: 'grande' })).toThrow();
  });

  it('nombre de fichero seguro', () => {
    const now = Date.UTC(2026, 10, 3, 18, 0, 0);
    expect(imageFileStem('../../Árbol de Navidad!', undefined, now)).toBe(
      'arbol-de-navidad-20261103180000',
    );
    expect(imageFileStem(undefined, undefined, now)).toBe('imagen-20261103180000');
    expect(imageFileStem('zorro', 'call_9F2a-XYZ0123456', now)).toBe('zorro-xyz0123456');
    expect(callImageTag('call_1')).toBe('call1');
  });

  it('cuenta como escritura de fichero (read-only la veta)', () => {
    expect(callEffects(GENERATE_IMAGE_TOOL, {}).mutating).toBe(true);
  });
});

describe('generate_image en el asistente', () => {
  it('solo se registra con imageGeneration y un provider que exista', () => {
    expect(buildAssistantRegistry(config()).get(GENERATE_IMAGE_TOOL)).toBeUndefined();
    expect(buildAssistantRegistry(withImages()).get(GENERATE_IMAGE_TOOL)).toBeDefined();
    const missing = config({ imageGeneration: { provider: 'otro', model: 'x' } });
    expect(resolveImageEndpoint(missing)).toBeNull();
    expect(buildAssistantRegistry(missing).get(GENERATE_IMAGE_TOOL)).toBeUndefined();
  });

  it('el prompt anuncia las imágenes solo con la tool y el workspace', () => {
    const workspace = { root: dir, readOnly: ['inputs'], writable: ['outputs'] };
    expect(buildAssistantPrompt(undefined, { workspace, imageGeneration: true })).toContain(
      '# Images',
    );
    expect(buildAssistantPrompt(undefined, { workspace })).not.toContain('# Images');
    expect(buildAssistantPrompt(undefined, { imageGeneration: true })).not.toContain('# Images');
  });
});
