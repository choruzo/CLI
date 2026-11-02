import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionHost } from './session-host.js';
import { ensureCompanionWorkspace } from './companion.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { createSessionEnv } from '../runtime/session-env.js';
import { imageMarker, type UserImage } from '../agent/user-images.js';
import type { CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent } from '../agent/types.js';

/**
 * Imágenes del usuario en el agente: con visión declarada llegan a la petición
 * (fuera del historial, que solo lleva su marca); sin ella, aviso y nada se manda.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-userimg-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeConfig(vision: boolean): StratumConfig {
  return StratumConfigSchema.parse({
    provider: {
      default: 'test',
      providers: {
        test: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: '',
          model: 'test-model',
          contextWindow: 32768,
          models: vision ? { 'test-model': { vision: { coordinates: 'pixels' } } } : {},
        },
      },
    },
    memory: { autoExtract: false, globalFile: join(root, 'global-STRATUM.md') },
    tools: { auditLog: false },
    trace: { enabled: false },
  });
}

class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push(req);
    return super.complete(req);
  }
}

const hosts: SessionHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((h) => h.dispose({ cancelBackground: true })));
});

let n = 0;
async function hostWith(provider: MockProvider, vision: boolean): Promise<SessionHost> {
  const dataDir = join(root, `data-${++n}`);
  const config = makeConfig(vision);
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(provider);
  const host = await SessionHost.create({
    env: createSessionEnv({ cwd: ensureCompanionWorkspace(dataDir), env: {} }),
    config,
    router,
    preset: 'companion',
    companionDataDir: dataDir,
  });
  hosts.push(host);
  return host;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const IMAGE: UserImage = {
  id: 'img-0123456789ab',
  name: 'captura.png',
  mime: 'image/png',
  data: 'QkFTRTY0LURFLUxBLUlNQUdFTg==',
  bytes: 4096,
  sha256: '0123456789ab'.repeat(6).slice(0, 64),
};

describe('imágenes del usuario en el agente', () => {
  it('con visión: la petición las lleva, el historial solo la marca y nunca el base64', async () => {
    const provider = new RecordingProvider([makeTextRound('veo')]);
    const host = await hostWith(provider, true);
    await collect(host.run('mira', { images: [IMAGE] }));
    expect(provider.requests[0]!.userImages!.map((r) => r.image.id)).toEqual([IMAGE.id]);
    const history = host.agent.getMessages();
    expect(JSON.stringify(history)).toContain(imageMarker(IMAGE));
    expect(JSON.stringify(history)).not.toContain(IMAGE.data);
  });

  it('sin visión: aviso al empezar y la petición no lleva imágenes', async () => {
    const provider = new RecordingProvider([makeTextRound('no veo')]);
    const host = await hostWith(provider, false);
    const events = await collect(host.run('mira', { images: [IMAGE] }));
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toMatchObject({ type: 'warning' });
    expect((warning as { message: string }).message).toContain('vision');
    expect(provider.requests[0]!.userImages).toBeUndefined();
    expect(JSON.stringify(host.agent.getMessages())).not.toContain(IMAGE.data);
  });

  it('sin imágenes no hay aviso ni userImages', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    const host = await hostWith(provider, false);
    const events = await collect(host.run('hola'));
    expect(events.some((e) => e.type === 'warning')).toBe(false);
    expect(provider.requests[0]!.userImages).toBeUndefined();
  });

  it('enqueueUserMessage sin turno (not-accepting) no guarda las imágenes', async () => {
    const provider = new RecordingProvider([makeTextRound('veo'), makeTextRound('otra vez')]);
    const host = await hostWith(provider, true);
    const result = host.agent.enqueueUserMessage('tarde', [IMAGE]);
    expect(result.status).toBe('not-accepting');
    // Un turno nuevo, sin la imagen: su marca no está en el historial y el
    // buffer, vacío, no la manda.
    await collect(host.run('hola'));
    expect(provider.requests[0]!.userImages).toBeUndefined();
  });
});
