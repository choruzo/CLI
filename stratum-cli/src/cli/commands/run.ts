import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { ToolRegistry } from '../../tools/registry.js';
import { registerBuiltinTools } from '../../tools/index.js';
import { StratumAgent } from '../../agent/core.js';

function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const val = String(input[keys[0]!] ?? '');
  return val.length > 60 ? val.slice(0, 57) + '...' : val;
}

export const runCommand = new Command('run')
  .description('Run a one-shot task with the agent')
  .argument('<task>', 'task to execute')
  .option('--provider <name>', 'use a specific provider from config')
  .option('--allow-destructive', 'approve all destructive operations without prompting')
  .option('--deny-destructive', 'block all destructive operations automatically')
  .action(
    async (
      task: string,
      opts: { provider?: string; allowDestructive?: boolean; denyDestructive?: boolean },
    ) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        process.stderr.write(`[fatal] Config error: ${String(err)}\n`);
        process.exit(1);
      }

      let router;
      try {
        router = new ProviderRouter(config, opts.provider);
      } catch (err) {
        process.stderr.write(`[fatal] Provider error: ${String(err)}\n`);
        process.exit(1);
      }

      const registry = new ToolRegistry();
      registerBuiltinTools(registry, config);
      const agent = new StratumAgent(config, router, registry);

      const controller = new AbortController();
      process.on('SIGINT', () => {
        controller.abort();
        process.stderr.write('\n[cancelled]\n');
        process.exit(130);
      });

      const isColorTty = process.stdout.isTTY;
      const toolLabel = isColorTty ? chalk.hex('#9CA3AF')('[tool]') : '[tool]';
      const errorLabel = isColorTty ? chalk.hex('#EF4444')('[error]') : '[error]';
      const fatalLabel = isColorTty ? chalk.hex('#EF4444').bold('[fatal]') : '[fatal]';

      let toolStartTimes = new Map<string, number>();
      let finalText = '';

      try {
        for await (const event of agent.run(task, {
          signal: controller.signal,
          allowDestructive: opts.allowDestructive,
        })) {
          switch (event.type) {
            case 'text_delta':
              finalText += event.delta;
              break;

            case 'tool_call_start':
              if (!toolStartTimes.has(event.id)) {
                toolStartTimes.set(event.id, Date.now());
                process.stderr.write(`${toolLabel} ${event.name}: ...\n`);
              }
              break;

            case 'tool_result': {
              const duration = (
                (Date.now() - (toolStartTimes.get(event.id) ?? Date.now())) /
                1000
              ).toFixed(1);
              const label =
                summarizeInput(
                  (() => {
                    try {
                      return JSON.parse(event.result.slice(0, 200));
                    } catch {
                      return {};
                    }
                  })(),
                ) || event.result.slice(0, 60);
              process.stderr.write(`${toolLabel} ${event.name}: ${label}  (${duration}s)\n`);
              toolStartTimes.delete(event.id);
              break;
            }

            case 'tool_error':
              process.stderr.write(`${errorLabel} ${event.name}: ${event.error}\n`);
              toolStartTimes.delete(event.id);
              break;

            case 'error':
              if (event.fatal) {
                process.stderr.write(`${fatalLabel} ${event.message}\n`);
              } else {
                process.stderr.write(`${errorLabel} ${event.message}\n`);
              }
              break;

            case 'done':
              break;
          }
        }
      } catch (err) {
        process.stderr.write(`${fatalLabel} ${String(err)}\n`);
        process.exit(1);
      }

      if (finalText) {
        process.stdout.write(finalText + '\n');
      }
    },
  );
