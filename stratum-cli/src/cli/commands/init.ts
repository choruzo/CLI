import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { ToolRegistry } from '../../tools/registry.js';
import { registerBuiltinTools } from '../../tools/index.js';
import { StratumAgent } from '../../agent/core.js';
import { INITIALIZE_PROMPT } from '../../agent/initialize-prompt.js';

// ---------------------------------------------------------------------------
// Plantilla de .stratumrc.json por defecto
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  provider: {
    default: 'litellm',
    providers: {
      litellm: {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:4000/v1',
        model: 'gpt-oss',
        apiKey: 'sk-1234',
        contextWindow: 32768,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Comando
// ---------------------------------------------------------------------------

export const initCommand = new Command('init')
  .description('Explore the project and create or update STRATUM.md')
  .argument('[focus]', 'Optional focus or constraints for the agent (e.g. "focus on the test setup")')
  .option('--provider <name>', 'use a specific provider from config')
  .option('--allow-destructive', 'approve all destructive operations without prompting')
  .action(
    async (
      focus: string | undefined,
      opts: { provider?: string; allowDestructive?: boolean },
    ) => {
      const cwd = process.cwd();

      process.stdout.write('\n  Stratum — Inicializando proyecto\n\n');

      // Crear .stratumrc.json si no existe
      const configPath = join(cwd, '.stratumrc.json');
      if (!existsSync(configPath)) {
        writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
        process.stdout.write('  ✓ .stratumrc.json creado\n\n');
      }

      let config;
      try {
        config = loadConfig(cwd);
      } catch (err) {
        process.stderr.write(`\n  [error] Config: ${String(err)}\n`);
        process.exit(1);
      }

      let router;
      try {
        router = new ProviderRouter(config, opts.provider);
      } catch (err) {
        process.stderr.write(`\n  [error] Provider: ${String(err)}\n`);
        process.exit(1);
      }

      const registry = new ToolRegistry();
      registerBuiltinTools(registry, config);
      const agent = new StratumAgent(config, router, registry);

      // Construir el prompt reemplazando las variables
      const prompt = INITIALIZE_PROMPT
        .replaceAll('${path}', cwd)
        .replaceAll('$ARGUMENTS', focus?.trim() || '(none)');

      const controller = new AbortController();
      let aborting = false;
      process.on('SIGINT', () => {
        if (aborting) process.exit(1);
        aborting = true;
        process.stderr.write('\n[cancelled]\n');
        controller.abort();
      });

      const isColorTty = process.stdout.isTTY;
      const toolLabel = isColorTty ? chalk.hex('#9CA3AF')('[tool]') : '[tool]';
      const errorLabel = isColorTty ? chalk.hex('#EF4444')('[error]') : '[error]';
      const fatalLabel = isColorTty ? chalk.hex('#EF4444').bold('[fatal]') : '[fatal]';

      const toolStartTimes = new Map<string, number>();

      try {
        for await (const event of agent.run(prompt, {
          signal: controller.signal,
          allowDestructive: opts.allowDestructive,
          compressionMode: 'conservative',
        })) {
          switch (event.type) {
            case 'text_delta':
              process.stdout.write(event.delta);
              break;

            case 'tool_call_start':
              if (!toolStartTimes.has(event.id)) {
                toolStartTimes.set(event.id, Date.now());
                process.stderr.write(`${toolLabel} ${event.name}: ...\n`);
              }
              break;

            case 'tool_result': {
              const duration = (
                (Date.now() - (toolStartTimes.get(event.id) ?? Date.now())) / 1000
              ).toFixed(1);
              process.stderr.write(`${toolLabel} ${event.name}  (${duration}s)\n`);
              toolStartTimes.delete(event.id);
              break;
            }

            case 'tool_error':
              process.stderr.write(`${errorLabel} ${event.name}: ${event.error}\n`);
              toolStartTimes.delete(event.id);
              break;

            case 'warning':
              process.stderr.write(`${errorLabel} ${event.message}\n`);
              break;

            case 'error':
              if (event.fatal) {
                process.stderr.write(`\n${fatalLabel} ${event.message}\n`);
              } else {
                process.stderr.write(`${errorLabel} ${event.message}\n`);
              }
              break;

            case 'done':
              process.stdout.write('\n');
              break;
          }
        }
      } catch (err) {
        process.stderr.write(`\n${fatalLabel} ${String(err)}\n`);
        process.exit(1);
      }

      if (controller.signal.aborted) {
        process.exit(130);
      }

      process.stdout.write(
        '\n  Tip: versiona STRATUM.md en git — se carga automáticamente en cada sesión.\n\n',
      );
    },
  );
