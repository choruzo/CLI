import { createInterface } from 'readline';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { InitAgent } from '../../agent/init-agent.js';

// ---------------------------------------------------------------------------
// Plantilla de .stratumrc.json por defecto
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  provider: {
    default: 'local-ollama',
    providers: {
      'local-ollama': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3.5:9b',
        apiKey: 'ollama',
        contextWindow: 32768,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers de salida plain-text (sin Ink)
// ---------------------------------------------------------------------------

function spin(label: string): () => void {
  const frames = ['⟳', '⟳', '⟳'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${label}   `);
  }, 120);
  return () => {
    clearInterval(interval);
    process.stdout.write(`\r  ✓ ${label}\n`);
  };
}

function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n  ⚠  ${question} (s/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 's');
    });
  });
}

// ---------------------------------------------------------------------------
// Comando
// ---------------------------------------------------------------------------

export const initCommand = new Command('init')
  .description(
    'Initialize Stratum in the current directory (scans project and generates STRATUM.md)',
  )
  .option('--force', 'overwrite existing STRATUM.md without merge prompts')
  .option('--dry-run', 'show what would be generated without writing files')
  .action(async (options: { force?: boolean; dryRun?: boolean }) => {
    const cwd = process.cwd();

    process.stdout.write('\n  Stratum — Inicializando proyecto\n\n');

    // -----------------------------------------------------------------------
    // Crear .stratumrc.json si no existe
    // -----------------------------------------------------------------------
    const configPath = join(cwd, '.stratumrc.json');
    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
      process.stdout.write('  ✓ .stratumrc.json creado\n');
    }

    // -----------------------------------------------------------------------
    // Cargar config y provider
    // -----------------------------------------------------------------------
    let config;
    try {
      config = loadConfig(cwd);
    } catch (err) {
      process.stderr.write(`\n  [error] Config: ${String(err)}\n`);
      process.exit(1);
    }

    let router;
    try {
      router = new ProviderRouter(config);
    } catch (err) {
      process.stderr.write(`\n  [error] Provider: ${String(err)}\n`);
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Ejecutar InitAgent
    // -----------------------------------------------------------------------
    const activeProviderName = config.provider?.default ?? 'desconocido';
    const activeProviderBaseUrl =
      config.provider?.providers?.[activeProviderName]?.baseUrl ?? 'desconocida';
    const agent = new InitAgent(router.getActive(), router.model, {
      name: activeProviderName,
      baseUrl: activeProviderBaseUrl,
    });

    const stopScan = spin('Escaneando estructura...');
    let scanDone = false;
    let stopDetect: (() => void) | null = null;

    const resolveConflict = async (section: string): Promise<boolean> => {
      return ask(
        `La sección "## ${section}" tiene contenido escrito a mano.\n     ¿Actualizar con la información del scan?`,
      );
    };

    try {
      for await (const ev of agent.run(cwd, {
        force: options.force,
        dryRun: options.dryRun,
        resolveConflict,
      })) {
        switch (ev.type) {
          case 'scan_progress':
            if (!scanDone) {
              // aún en fase de scan — el spinner ya está activo
            }
            break;

          case 'section_ready':
            if (!scanDone) {
              stopScan();
              scanDone = true;
              stopDetect = spin('Detectando stack y generando STRATUM.md...');
            }
            break;

          case 'merge_conflict':
            // merge_conflict_resolved se emite tras el prompt interactivo
            break;

          case 'done':
            if (stopDetect) {
              stopDetect();
            } else if (!scanDone) {
              stopScan();
            }
            if (options.dryRun) {
              process.stdout.write(`\n  (dry-run) Se habría escrito: ${ev.path}\n`);
            } else {
              process.stdout.write(
                `\n  ✓ STRATUM.md ${ev.isNew ? 'creado' : 'actualizado'} en ${ev.path}\n`,
              );
            }
            process.stdout.write(
              '\n  Tip: edita STRATUM.md para añadir convenciones o instrucciones\n',
            );
            process.stdout.write(
              '  permanentes al agente. Se carga automáticamente en cada sesión.\n\n',
            );
            break;

          case 'error':
            if (stopDetect) stopDetect();
            else if (!scanDone) stopScan();
            process.stderr.write(`\n  [error] ${ev.message}\n`);
            process.exit(1);
        }
      }
    } catch (err) {
      process.stderr.write(`\n  [error] ${String(err)}\n`);
      process.exit(1);
    }
  });
