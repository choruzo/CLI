import { Command } from 'commander';
import { createInterface } from 'readline';
import chalk from 'chalk';
import type {
  ConfirmRequest,
  DestructiveDecision,
  DestructivePolicy,
  Plan,
  PlanDecision,
} from '../../agent/types.js';
import { PLAN_MODE_PROMPT } from '../../agent/plan.js';
import { PlanStore, generatePlanId } from '../../session/plan-store.js';
import { loadConfig } from '../../config/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { ToolRegistry } from '../../tools/registry.js';
import { registerBuiltinTools } from '../../tools/index.js';
import { McpManager } from '../../tools/mcp/manager.js';
import { StratumAgent } from '../../agent/core.js';
import { configureLogging, flushLogging, getLogger, isLogLevel, type LogLevel } from '../../logging/index.js';

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
  .option('--plan', 'plan-and-execute mode: produce a plan, approve, then execute step by step')
  .option('--yes, --approve-plan', 'auto-approve the plan in --plan mode (no prompt)')
  .option('--log-level <level>', 'log level: trace|debug|info|warn|error|silent')
  .option('--debug', 'enable verbose debug logging (level debug + file sink)')
  .action(
    async (
      task: string,
      opts: {
        provider?: string;
        allowDestructive?: boolean;
        denyDestructive?: boolean;
        plan?: boolean;
        approvePlan?: boolean;
        logLevel?: string;
        debug?: boolean;
      },
    ) => {
      if (opts.logLevel && !isLogLevel(opts.logLevel)) {
        process.stderr.write(`[fatal] Invalid --log-level: ${opts.logLevel}\n`);
        process.exit(1);
      }

      let config;
      try {
        config = loadConfig();
      } catch (err) {
        process.stderr.write(`[fatal] Config error: ${String(err)}\n`);
        process.exit(1);
      }

      configureLogging(config, {
        level: opts.logLevel as LogLevel | undefined,
        debug: opts.debug,
        // Por defecto stderr solo muestra warn+ para no duplicar la UI de run;
        // --debug o --log-level lo elevan al nivel solicitado.
        stderrLevel: 'warn',
      });
      getLogger('cli').debug('run start', { task: task.slice(0, 120) });

      let router;
      try {
        router = new ProviderRouter(config, opts.provider);
      } catch (err) {
        process.stderr.write(`[fatal] Provider error: ${String(err)}\n`);
        process.exit(1);
      }

      const registry = new ToolRegistry();
      registerBuiltinTools(registry, config);

      // MCP servers: conexión eager antes de lanzar el agente (§12.8)
      const mcpManager = new McpManager(config);
      if (config.mcp.servers.length > 0) {
        const mcpWarnings = await mcpManager.connectAll();
        for (const w of mcpWarnings) {
          process.stderr.write(`[mcp] ${w.message}\n`);
        }
        mcpManager.registerInto(registry);
      }

      const agent = new StratumAgent(config, router, registry);

      const controller = new AbortController();
      let aborting = false;
      process.on('SIGINT', () => {
        if (aborting) {
          process.exit(1);
          return;
        }
        aborting = true;
        process.stderr.write('\n[cancelled]\n');
        controller.abort();
      });

      // Política destructiva (§12.5):
      // --allow-destructive → 'allow'; --deny-destructive → 'deny';
      // sin flags → 'ask' con prompt interactivo si stdin es TTY, 'deny' si no (CI/piped).
      let policy: DestructivePolicy = 'ask';
      if (opts.allowDestructive) policy = 'allow';
      else if (opts.denyDestructive) policy = 'deny';
      else if (!process.stdin.isTTY) policy = 'deny';

      const confirmDestructive = async (req: ConfirmRequest): Promise<DestructiveDecision> => {
        process.stderr.write(
          `\n⚠  El agente quiere ejecutar una operación destructiva:\n   ${req.description}\n\n`,
        );
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = await new Promise<string>((resolve) =>
            rl.question('¿Continuar? (s/N/!) ', resolve),
          );
          const a = answer.trim().toLowerCase();
          if (a === '!') return 'allow-all';
          return a === 's' || a === 'y' || a === 'si' || a === 'sí' || a === 'yes'
            ? 'approve'
            : 'deny';
        } finally {
          rl.close();
        }
      };

      const isColorTty = process.stdout.isTTY;
      const toolLabel = isColorTty ? chalk.hex('#9CA3AF')('[tool]') : '[tool]';
      const errorLabel = isColorTty ? chalk.hex('#EF4444')('[error]') : '[error]';
      const fatalLabel = isColorTty ? chalk.hex('#EF4444').bold('[fatal]') : '[fatal]';

      // -----------------------------------------------------------------------
      // Hito 7 — Plan & Execute en `run` (no interactivo, UI §5.4). El plan se
      // imprime en stderr; la aprobación se resuelve por flags/TTY (sin TTY y
      // sin --yes el plan es el entregable y se termina sin ejecutar).
      // -----------------------------------------------------------------------
      const planMode = opts.plan === true;
      const input = planMode ? PLAN_MODE_PROMPT.replaceAll('$ARGUMENTS', task) : task;

      const printPlan = (plan: Plan): void => {
        plan.steps.forEach((s, i) => {
          process.stderr.write(`[plan] ${i + 1}. ${s.title}\n`);
        });
      };

      const onApprovePlan = async (plan: Plan): Promise<PlanDecision> => {
        printPlan(plan);
        if (opts.approvePlan) return { decision: 'approve', plan };
        if (!process.stdout.isTTY) {
          // CI/pipe sin --yes: el plan es el entregable; no se ejecuta.
          process.stderr.write('[plan] sin TTY y sin --yes: no se ejecuta el plan.\n');
          return { decision: 'reject' };
        }
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = await new Promise<string>((resolve) =>
            rl.question('[plan] ¿Ejecutar? (S/N) ', resolve),
          );
          const a = answer.trim().toLowerCase();
          return a === 's' || a === 'y' || a === 'si' || a === 'sí' || a === 'yes'
            ? { decision: 'approve', plan }
            : { decision: 'reject' };
        } finally {
          rl.close();
        }
      };

      const planStore = new PlanStore(process.cwd());
      const planRef = generatePlanId();
      const planCreatedAt = new Date().toISOString();
      const planStepTitles = new Map<string, { n: number; title: string }>();

      let toolStartTimes = new Map<string, number>();
      let finalText = '';

      try {
        for await (const event of agent.run(input, {
          signal: controller.signal,
          allowDestructive: opts.allowDestructive,
          destructivePolicy: policy,
          onConfirmDestructive: policy === 'ask' ? confirmDestructive : undefined,
          ...(planMode
            ? {
                mode: 'plan' as const,
                onApprovePlan,
                onPlanPersist: (p: Plan) => planStore.save(planRef, task, p, planCreatedAt),
              }
            : {}),
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

            case 'warning':
              process.stderr.write(`${errorLabel} [warning] ${event.message}\n`);
              break;

            case 'context_compressed':
              process.stderr.write(
                `[ctx] Contexto comprimido: ${event.tokensBefore} → ${event.tokensAfter} tokens ` +
                  `(${event.roundsCompressed} rondas)\n`,
              );
              break;

            case 'plan_proposed':
              event.plan.steps.forEach((s, i) =>
                planStepTitles.set(s.id, { n: i + 1, title: s.title }),
              );
              break;

            case 'plan_step_update': {
              const meta = planStepTitles.get(event.stepId);
              const label = meta ? `${meta.n}. ${meta.title}` : event.stepId;
              process.stderr.write(`[plan] ${label}  (${event.status})\n`);
              break;
            }

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
        await mcpManager.shutdownAll();
        getLogger('cli').error('run aborted with error', { err });
        await flushLogging();
        process.stderr.write(`${fatalLabel} ${String(err)}\n`);
        process.exit(1);
      }

      await mcpManager.shutdownAll();
      await flushLogging();

      if (controller.signal.aborted) {
        process.exit(130);
      }

      if (finalText) {
        process.stdout.write(finalText + '\n');
      }
    },
  );
