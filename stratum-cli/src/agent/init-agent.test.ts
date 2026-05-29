import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InitAgent } from './init-agent.js';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';

// ---------------------------------------------------------------------------
// Provider mock que devuelve una respuesta de síntesis fija
// ---------------------------------------------------------------------------
function makeTextChunks(text: string): OpenAIStreamChunk[] {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null, index: 0 }] },
    { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
  ];
}

class SynthesisProvider implements IProvider {
  async *complete(_req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    const response = `## Proyecto
Nombre: test-project
Descripción: Proyecto de prueba.

## Stack Tecnológico
- TypeScript
- Node.js

## Estructura
src/    — código fuente

## Convenciones
- snake_case para archivos

## Comandos Clave
- npm run build
`;
    for (const chunk of makeTextChunks(response)) yield chunk;
  }

  async healthCheck() {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `stratum-init-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function collectInitEvents(gen: AsyncGenerator<import('./init-agent.js').InitEvent>) {
  const events: import('./init-agent.js').InitEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InitAgent', () => {
  let tmpDir: string;
  let agent: InitAgent;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    agent = new InitAgent(new SynthesisProvider(), 'test-model');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emite scan_progress, section_ready y done en proyecto vacío', async () => {
    const events = await collectInitEvents(agent.run(tmpDir));

    expect(events.some((e) => e.type === 'section_ready')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    const doneEv = events.find((e) => e.type === 'done');
    expect((doneEv as { type: 'done'; path: string }).path).toContain('STRATUM.md');
  });

  it('genera STRATUM.md con las 5 secciones fijas', async () => {
    await collectInitEvents(agent.run(tmpDir));

    const content = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    expect(content).toContain('## Proyecto');
    expect(content).toContain('## Stack Tecnológico');
    expect(content).toContain('## Estructura');
    expect(content).toContain('## Convenciones');
    expect(content).toContain('## Comandos Clave');
  });

  it('dry-run no escribe STRATUM.md', async () => {
    await collectInitEvents(agent.run(tmpDir, { dryRun: true }));
    expect(existsSync(join(tmpDir, 'STRATUM.md'))).toBe(false);
  });

  it('detecta package.json en el scan', async () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-pkg', version: '1.0.0', devDependencies: { typescript: '^5' } }),
      'utf-8',
    );
    const events = await collectInitEvents(agent.run(tmpDir));
    expect(events.some((e) => e.type === 'scan_progress' && e.file === 'package.json')).toBe(true);
  });

  it('merge: preserva sección manual cuando resolveConflict devuelve false', async () => {
    const originalContent = `# Stratum Memory

## Proyecto
Contenido manual del proyecto.

## Stack Tecnológico

## Estructura

## Convenciones

## Comandos Clave
`;
    writeFileSync(join(tmpDir, 'STRATUM.md'), originalContent, 'utf-8');

    await collectInitEvents(
      agent.run(tmpDir, {
        resolveConflict: async () => false, // preservar siempre
      }),
    );

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    expect(written).toContain('Contenido manual del proyecto.');
  });

  it('merge: actualiza sección vacía automáticamente', async () => {
    const originalContent = `# Stratum Memory

## Proyecto

## Stack Tecnológico

## Estructura

## Convenciones

## Comandos Clave
`;
    writeFileSync(join(tmpDir, 'STRATUM.md'), originalContent, 'utf-8');

    await collectInitEvents(agent.run(tmpDir));

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    // Las secciones vacías deben haberse rellenado con la síntesis
    expect(written).toContain('TypeScript');
  });

  it('merge: preserva secciones extra del usuario', async () => {
    const originalContent = `# Stratum Memory

## Proyecto

## Stack Tecnológico

## Estructura

## Convenciones

## Comandos Clave

## Mi Sección Custom
Contenido personalizado del usuario.
`;
    writeFileSync(join(tmpDir, 'STRATUM.md'), originalContent, 'utf-8');

    await collectInitEvents(agent.run(tmpDir));

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    expect(written).toContain('## Mi Sección Custom');
    expect(written).toContain('Contenido personalizado del usuario.');
  });

  it('buildStratumMd genera estructura correcta', () => {
    const sections = {
      Proyecto: 'Mi proyecto',
      'Stack Tecnológico': 'TypeScript',
      Estructura: 'src/',
      Convenciones: 'snake_case',
      'Comandos Clave': 'npm run build',
    };
    const result = agent.buildStratumMd(sections);
    expect(result).toContain('# Stratum Memory');
    expect(result.indexOf('## Proyecto')).toBeLessThan(result.indexOf('## Stack Tecnológico'));
  });
});
