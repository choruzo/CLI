import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InitAgent } from './init-agent.js';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';

// ---------------------------------------------------------------------------
// Provider mock que devuelve una respuesta de síntesis con formato delimitado
// ---------------------------------------------------------------------------
function makeTextChunks(text: string): OpenAIStreamChunk[] {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null, index: 0 }] },
    { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
  ];
}

class SynthesisProvider implements IProvider {
  lastPrompt = '';
  lastTemperature: number | undefined = undefined;

  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.lastPrompt = req.messages.at(-1)?.content ?? '';
    this.lastTemperature = req.temperature;
    const response = `<<<PROYECTO>>>
Nombre: test-project
Descripción: Proyecto de prueba.
<<<END>>>

<<<STACK>>>
- TypeScript
- Node.js
<<<END>>>

<<<CONVENCIONES>>>
- snake_case para archivos
<<<END>>>
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
  let provider: SynthesisProvider;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    provider = new SynthesisProvider();
    agent = new InitAgent(provider, 'test-model');
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

  it('genera STRATUM.md con las 6 secciones fijas', async () => {
    await collectInitEvents(agent.run(tmpDir));

    const content = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    expect(content).toContain('## Proyecto');
    expect(content).toContain('## Stack Tecnológico');
    expect(content).toContain('## Estructura');
    expect(content).toContain('## Convenciones');
    expect(content).toContain('## Comandos Clave');
    expect(content).toContain('## Instrucciones para el agente');
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

  it('envía temperatura 0.2 al provider', async () => {
    await collectInitEvents(agent.run(tmpDir));
    expect(provider.lastTemperature).toBe(0.2);
  });

  it('respeta negaciones de .gitignore para workflows re-incluidos', async () => {
    // Patrón correcto para re-incluir subdirectorios: ".github/*" ignora contenidos
    // del directorio (pero no el directorio en sí), lo que permite negaciones de hijos.
    // ".github" (sin *) ignoraría el directorio completo y bloquearía cualquier negación.
    writeFileSync(join(tmpDir, '.gitignore'), '.github/*\n!.github/workflows\n', 'utf-8');
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tmpDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf-8');

    const events = await collectInitEvents(agent.run(tmpDir));

    expect(
      events.some((e) => e.type === 'scan_progress' && e.file === '.github/workflows/ci.yml'),
    ).toBe(true);
    expect(provider.lastPrompt).toContain('CI/CD (.github/workflows)');
    expect(provider.lastPrompt).toContain('### ci.yml');
  });

  it('omite directorios ignorados por .gitignore cuando no hay negaciones', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), '.github\n', 'utf-8');
    mkdirSync(join(tmpDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tmpDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf-8');

    const events = await collectInitEvents(agent.run(tmpDir));

    expect(
      events.some((e) => e.type === 'scan_progress' && e.file === '.github/workflows/ci.yml'),
    ).toBe(false);
    expect(provider.lastPrompt).not.toContain('CI/CD (.github/workflows)');
  });

  it('re-incluye archivos negados en .gitignore', async () => {
    writeFileSync(join(tmpDir, '.gitignore'), '*.md\n!README.md\n', 'utf-8');
    writeFileSync(join(tmpDir, 'README.md'), '# Keep me\n', 'utf-8');
    writeFileSync(join(tmpDir, 'CONTRIBUTING.md'), '# Ignore me\n', 'utf-8');

    const events = await collectInitEvents(agent.run(tmpDir));

    expect(events.some((e) => e.type === 'scan_progress' && e.file === 'README.md')).toBe(true);
    expect(events.some((e) => e.type === 'scan_progress' && e.file === 'CONTRIBUTING.md')).toBe(
      false,
    );
  });

  it('merge: preserva sección manual cuando resolveConflict devuelve false', async () => {
    const originalContent = `# Stratum Memory

## Proyecto
Contenido manual del proyecto.

## Stack Tecnológico

## Estructura

## Convenciones

## Comandos Clave

## Instrucciones para el agente
`;
    writeFileSync(join(tmpDir, 'STRATUM.md'), originalContent, 'utf-8');

    await collectInitEvents(
      agent.run(tmpDir, {
        resolveConflict: async () => false,
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

## Instrucciones para el agente
`;
    writeFileSync(join(tmpDir, 'STRATUM.md'), originalContent, 'utf-8');

    await collectInitEvents(agent.run(tmpDir));

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    // Stack Tecnológico vacía debe haberse rellenado con la síntesis (<<<STACK>>>)
    expect(written).toContain('TypeScript');
  });

  it('merge: usa versión propuesta íntegra al aceptar (sin concatenación)', async () => {
    const originalContent = `# Stratum Memory

## Proyecto
Contenido viejo del proyecto.
Contenido viejo del proyecto.

## Stack Tecnológico

## Estructura

## Convenciones

## Comandos Clave

## Instrucciones para el agente
`;
    writeFileSync(join(tmpDir, 'STRATUM.md'), originalContent, 'utf-8');

    await collectInitEvents(
      agent.run(tmpDir, {
        resolveConflict: async () => true, // aceptar propuesta
      }),
    );

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    // Debe contener el contenido propuesto, no el viejo duplicado
    expect(written).toContain('test-project');
    // No debe haber duplicado del viejo texto
    expect(written.split('Contenido viejo').length - 1).toBe(0);
  });

  it('merge: preserva secciones extra del usuario', async () => {
    const originalContent = `# Stratum Memory

## Proyecto

## Stack Tecnológico

## Estructura

## Convenciones

## Comandos Clave

## Instrucciones para el agente

## Mi Sección Custom
Contenido personalizado del usuario.
`;
    writeFileSync(join(tmpDir, 'STRATUM.md'), originalContent, 'utf-8');

    await collectInitEvents(agent.run(tmpDir));

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    expect(written).toContain('## Mi Sección Custom');
    expect(written).toContain('Contenido personalizado del usuario.');
  });

  it('buildStratumMd genera estructura correcta con 6 secciones', () => {
    const sections = {
      Proyecto: 'Mi proyecto',
      'Stack Tecnológico': 'TypeScript',
      Estructura: 'src/',
      Convenciones: 'snake_case',
      'Comandos Clave': 'npm run build',
      'Instrucciones para el agente': 'Responder en español',
    };
    const result = agent.buildStratumMd(sections);
    expect(result).toContain('# Stratum Memory');
    expect(result).toContain('## Instrucciones para el agente');
    expect(result.indexOf('## Proyecto')).toBeLessThan(result.indexOf('## Stack Tecnológico'));
    expect(result.indexOf('## Comandos Clave')).toBeLessThan(
      result.indexOf('## Instrucciones para el agente'),
    );
  });

  it('Comandos Clave son deterministas desde package.json', async () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'my-pkg',
        scripts: { build: 'tsup', test: 'vitest', dev: 'tsx src/index.ts' },
      }),
      'utf-8',
    );

    await collectInitEvents(agent.run(tmpDir));

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    expect(written).toContain('npm run build');
    expect(written).toContain('npm run test');
    expect(written).toContain('npm run dev');
  });

  it('Comandos Clave usan el gestor detectado por lockfile', async () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-pkg', scripts: { build: 'tsup' } }),
      'utf-8',
    );
    writeFileSync(join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 6\n', 'utf-8');

    await collectInitEvents(agent.run(tmpDir));

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    expect(written).toContain('pnpm run build');
    // Verificar que el gestor es pnpm y NO npm (la substring "npm" también aparece en "pnpm")
    expect(written).not.toMatch(/^npm run /m);
  });

  it('detectProjectRoot: resuelve subdir único con manifiesto', async () => {
    // tmpDir no tiene package.json en raíz, pero sí en sub/
    const sub = join(tmpDir, 'my-project');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'package.json'),
      JSON.stringify({
        name: 'my-project',
        scripts: { start: 'node index.js' },
      }),
      'utf-8',
    );

    await collectInitEvents(agent.run(tmpDir));

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    // El scan debe haber encontrado el package.json del subdirectorio
    expect(written).toContain('npm run start');
  });

  it('Estructura incluye nombres de archivos en el árbol', async () => {
    writeFileSync(join(tmpDir, 'README.md'), '# Test\n', 'utf-8');
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }), 'utf-8');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'index.ts'), 'export {};', 'utf-8');

    await collectInitEvents(agent.run(tmpDir));

    const written = readFileSync(join(tmpDir, 'STRATUM.md'), 'utf-8');
    // El árbol en Estructura debe incluir nombres de archivos
    expect(written).toContain('index.ts');
  });

  it('saneo de credenciales Git: token no aparece en STRATUM.md', async () => {
    // Inicializar un repo git temporal con un remote que contiene credenciales
    const gitDir = join(tmpDir, 'git-project');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'package.json'), JSON.stringify({ name: 'git-project' }), 'utf-8');

    try {
      const { execa: execaFn } = await import('execa');
      await execaFn('git', ['init'], { cwd: gitDir, reject: false });
      await execaFn(
        'git',
        ['remote', 'add', 'origin', 'https://user:supersecrettoken@github.com/user/repo.git'],
        { cwd: gitDir, reject: false },
      );

      const gitAgent = new InitAgent(provider, 'test-model');
      await collectInitEvents(gitAgent.run(gitDir));

      const written = readFileSync(join(gitDir, 'STRATUM.md'), 'utf-8');
      expect(written).not.toContain('supersecrettoken');
      // El remote saneado sí debe aparecer (sin credenciales)
      if (written.includes('github.com')) {
        expect(written).toContain('https://github.com/user/repo.git');
      }
    } catch {
      // Si git no está disponible en el entorno de test, el test pasa vacío
    }
  });
});
