import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InitReActExplorer, type ExplorerFindings } from './init-explorer.js';
import { InitAgent } from './init-agent.js';
import type { InitEvent, ScanData } from './init-agent.js';
import { MockProvider, makeToolCallRound, makeTextRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `stratum-explorer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMinimalScanData(root: string): ScanData {
  return {
    scannedFiles: [],
    manifests: {},
    configs: {},
    docs: {},
    ciFiles: {},
    entryPoints: {},
    dirTree: '',
    packageManager: undefined,
    projectRoot: root,
    isMonorepo: false,
    packages: [],
    git: undefined,
  };
}

async function drainExplorer(
  gen: AsyncGenerator<InitEvent, ExplorerFindings, unknown>,
): Promise<{ events: InitEvent[]; findings: ExplorerFindings }> {
  const events: InitEvent[] = [];
  while (true) {
    const step = await gen.next();
    if (step.done) return { events, findings: step.value };
    events.push(step.value);
  }
}

/** Provider de síntesis que devuelve una respuesta con formato delimitado y cuenta sus llamadas. */
class CountingSynthesisProvider implements IProvider {
  callCount = 0;

  async *complete(_req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.callCount++;
    const response = `<<<PROYECTO>>>
Proyecto de prueba.
<<<END>>>

<<<STACK>>>
- TypeScript
<<<END>>>

<<<CONVENCIONES>>>
- snake_case
<<<END>>>
`;
    yield { choices: [{ delta: { content: response }, finish_reason: 'stop', index: 0 }] };
  }

  async healthCheck() {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Tests de InitReActExplorer
// ---------------------------------------------------------------------------

describe('InitReActExplorer', () => {
  let tmpDir: string;
  const config = StratumConfigSchema.parse({});
  const CONTEXT_WINDOW = 8192;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emite explorer_step por cada tool call y acumula filesRead', async () => {
    const claudeMdPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(
      claudeMdPath,
      '# Instrucciones\nUsa siempre TypeScript.\nConfirmar antes de borrar.',
    );

    const provider = new MockProvider([
      // Ronda 1: el agente lee CLAUDE.md
      makeToolCallRound('tc1', 'read_file', { path: claudeMdPath }),
      // Ronda 2: texto de resumen → loop se detiene (no hay más tool calls)
      makeTextRound(
        'CLAUDE.md contiene instrucciones: TypeScript obligatorio, confirmar antes de borrar.',
      ),
    ]);

    const explorer = new InitReActExplorer(provider, 'test-model', config, CONTEXT_WINDOW);
    const scanData = makeMinimalScanData(tmpDir);

    const { events, findings } = await drainExplorer(explorer.explore(scanData, tmpDir));

    // Debe haber al menos un explorer_step
    const steps = events.filter((e) => e.type === 'explorer_step');
    expect(steps.length).toBeGreaterThanOrEqual(1);

    // El primer step debe corresponder al read_file
    const firstStep = steps[0] as {
      type: 'explorer_step';
      iteration: number;
      action: string;
      file?: string;
    };
    expect(firstStep.action).toBe('leer');
    expect(firstStep.file).toBe(claudeMdPath);
    expect(firstStep.iteration).toBe(1);

    // filesRead debe incluir CLAUDE.md
    expect(findings.filesRead).toContain(claudeMdPath);

    // findings debe contener el resumen del modelo
    expect(findings.findings).toContain('TypeScript');
  });

  it('devuelve ExplorerFindings vacío si el modelo no llama tools (termina por stop)', async () => {
    const provider = new MockProvider([
      // El modelo decide no explorar y da directamente el resumen
      makeTextRound('Sin hallazgos adicionales.'),
    ]);

    const explorer = new InitReActExplorer(provider, 'test-model', config, CONTEXT_WINDOW);
    const scanData = makeMinimalScanData(tmpDir);

    const { events, findings } = await drainExplorer(explorer.explore(scanData, tmpDir));

    // No debe haber steps
    expect(events.filter((e) => e.type === 'explorer_step')).toHaveLength(0);

    // filesRead vacío, findings con el texto del modelo
    expect(findings.filesRead).toHaveLength(0);
    expect(findings.findings).toBeTruthy();
  });

  it('termina limpiamente cuando se agota el presupuesto (max_iterations)', async () => {
    // 9 rondas de tool calls para superar el máximo de 8 iteraciones
    const rounds: OpenAIStreamChunk[][] = [];
    for (let i = 0; i < 9; i++) {
      rounds.push(makeToolCallRound(`tc${i}`, 'list_directory', { path: '.', depth: 1 }));
    }

    const provider = new MockProvider(rounds);
    const explorer = new InitReActExplorer(provider, 'test-model', config, CONTEXT_WINDOW);
    const scanData = makeMinimalScanData(tmpDir);

    // No debe lanzar error
    let error: unknown = null;
    let findings: ExplorerFindings | undefined;
    try {
      const gen = explorer.explore(scanData, tmpDir);
      const result = await drainExplorer(gen);
      findings = result.findings;
    } catch (err) {
      error = err;
    }

    expect(error).toBeNull();
    expect(findings).toBeDefined();
    // El explorer puede haber ejecutado hasta 8 steps
    // (el loop se corta en max_iterations antes de la 9ª iteración del provider)
  });

  it('glob y list_directory están disponibles como tools y emiten explorer_step', async () => {
    const provider = new MockProvider([
      // Ronda 1: glob para buscar archivos md
      makeToolCallRound('tc1', 'glob', { pattern: '**/*.md' }),
      // Ronda 2: list_directory
      makeToolCallRound('tc2', 'list_directory', { path: tmpDir, depth: 1 }),
      // Ronda 3: resumen
      makeTextRound('Exploración completada. No se encontraron archivos de instrucciones.'),
    ]);

    const explorer = new InitReActExplorer(provider, 'test-model', config, CONTEXT_WINDOW);
    const scanData = makeMinimalScanData(tmpDir);

    const { events } = await drainExplorer(explorer.explore(scanData, tmpDir));

    const steps = events.filter((e) => e.type === 'explorer_step') as Array<{
      type: 'explorer_step';
      iteration: number;
      action: string;
      file?: string;
    }>;

    expect(steps.length).toBe(2);
    expect(steps[0]!.action).toBe('buscar');
    expect(steps[0]!.file).toBe('**/*.md');
    expect(steps[1]!.action).toBe('listar');
  });
});

// ---------------------------------------------------------------------------
// Tests de integración: InitAgent con noExplore
// ---------------------------------------------------------------------------

describe('InitAgent.noExplore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('con noExplore: true, solo hace 1 llamada LLM (sin fase explorer)', async () => {
    const provider = new CountingSynthesisProvider();
    const config = StratumConfigSchema.parse({});

    // Con config y contextWindow → explorer habilitado, pero lo desactivamos con noExplore
    const agent = new InitAgent(provider, 'test-model', {
      config,
      contextWindow: 8192,
    });

    const events: InitEvent[] = [];
    for await (const ev of agent.run(tmpDir, { noExplore: true })) {
      events.push(ev);
    }

    // Solo 1 llamada LLM: la de síntesis
    expect(provider.callCount).toBe(1);
    // No debe haber ningún explorer_step
    expect(events.some((e) => e.type === 'explorer_step')).toBe(false);
    // Debe terminar con done
    expect(events.at(-1)?.type).toBe('done');
  });

  it('sin config/contextWindow, el explorer nunca corre aunque noExplore sea false', async () => {
    const provider = new CountingSynthesisProvider();

    // Sin config ni contextWindow → explorer deshabilitado automáticamente
    const agent = new InitAgent(provider, 'test-model');

    const events: InitEvent[] = [];
    for await (const ev of agent.run(tmpDir, { noExplore: false })) {
      events.push(ev);
    }

    expect(provider.callCount).toBe(1);
    expect(events.some((e) => e.type === 'explorer_step')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('con config y contextWindow, el explorer corre y emite explorer_step', async () => {
    const claudeMdPath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, '# Project Instructions\nDont delete files without confirmation.');

    const config = StratumConfigSchema.parse({});

    // Proveedor multi-round:
    // - Round 1 (explorer): lee CLAUDE.md
    // - Round 2 (explorer): resumen del explorer
    // - Round 3 (síntesis): respuesta de síntesis
    const explorerRound1 = makeToolCallRound('tc1', 'read_file', { path: claudeMdPath });
    const explorerRound2 = makeTextRound('CLAUDE.md encontrado con instrucciones del proyecto.');
    const synthesisRound = [
      {
        choices: [
          {
            delta: {
              content: `<<<PROYECTO>>>
Proyecto de prueba.
<<<END>>>

<<<STACK>>>
- TypeScript
<<<END>>>

<<<CONVENCIONES>>>
- snake_case
<<<END>>>
`,
            },
            finish_reason: 'stop' as const,
            index: 0,
          },
        ],
      },
    ];

    const multiProvider = new MockProvider([explorerRound1, explorerRound2, synthesisRound]);

    const agent = new InitAgent(multiProvider, 'test-model', {
      config,
      contextWindow: 8192,
    });

    const events: InitEvent[] = [];
    for await (const ev of agent.run(tmpDir, { noExplore: false })) {
      events.push(ev);
    }

    // Debe haber al menos un explorer_step
    expect(events.some((e) => e.type === 'explorer_step')).toBe(true);
    // Debe terminar con done
    expect(events.at(-1)?.type).toBe('done');
  });
});
