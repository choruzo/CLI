import { Command } from 'commander';
import { createInterface } from 'readline';
import chalk from 'chalk';
import type {
  ConfirmRequest,
  DestructiveDecision,
  DestructivePolicy,
  Plan,
  PlanDecision,
  RunOptions,
} from '../../agent/types.js';
import { strictestPolicy } from '../../agent/profiles.js';
import { PLAN_MODE_PROMPT } from '../../agent/plan.js';
import { makeCliQuestionAsker } from '../ask-questions.js';
import { PlanStore, generatePlanId } from '../../session/plan-store.js';
import { SubagentStore } from '../../session/subagent-store.js';
import { generateSessionId } from '../../session/store.js';
import { loadConfig } from '../../config/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { ToolRegistry } from '../../tools/registry.js';
import { registerBuiltinTools } from '../../tools/index.js';
import { McpManager } from '../../tools/mcp/manager.js';
import { closeExecRuntime } from '../../tools/exec/runtime.js';
import { warnConfigDeprecations } from '../../config/deprecation-warning.js';
import { StratumAgent } from '../../agent/core.js';
import { warnInheritedGitRouting } from '../../git/env-warning.js';
import {
  configureLogging,
  flushLogging,
  getLogger,
  isLogLevel,
  type LogLevel,
} from '../../logging/index.js';

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
  .option('--agent <profile>', 'use an agent profile (mode primary/all) as the main agent')
  .option(
    '--delegate <profile>',
    'hand the task straight to a subagent profile (mode subagent/all), without the main agent',
  )
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
        agent?: string;
        delegate?: string;
        logLevel?: string;
        debug?: boolean;
      },
    ) => {
      // Hito 15: `--delegate` no pasa por el agente principal, así que no hay
      // plan que presentar ni perfil principal que activar.
      if (opts.delegate && (opts.plan || opts.agent)) {
        process.stderr.write('[fatal] --delegate no se combina con --plan ni con --agent.\n');
        process.exit(1);
      }

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
      warnInheritedGitRouting();
      warnConfigDeprecations();

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

      // Hito 15 — perfiles: `--agent` activa uno como agente principal;
      // `--delegate` le entrega la tarea a un subagente sin pasar por el principal.
      let profileFailure: string | null = null;
      if (opts.agent) {
        const applied = agent.setPrimaryProfile(opts.agent);
        if (!applied.ok) profileFailure = `--agent: ${applied.error}`;
        else for (const note of applied.notes) process.stderr.write(`[agent] ${note}\n`);
      } else if (opts.delegate) {
        const name = opts.delegate;
        const delegable = agent.delegableProfiles().map((p) => p.name);
        if (!delegable.includes(name)) {
          profileFailure = agent.listProfiles().some((p) => p.name === name)
            ? `--delegate: '${name}' es un perfil principal (mode: primary); usa --agent ${name}.`
            : `--delegate: el perfil '${name}' no existe. Disponibles: ${delegable.join(', ')}.`;
        }
      }
      if (profileFailure) {
        await mcpManager.shutdownAll();
        await closeExecRuntime();
        await flushLogging();
        process.stderr.write(`[fatal] ${profileFailure}\n`);
        process.exit(1);
      }

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
      // Un perfil principal solo endurece la política, nunca la relaja.
      policy = strictestPolicy(policy, agent.getActiveProfile()?.destructivePolicy);

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
      const subagentStore = new SubagentStore(process.cwd());

      let toolStartTimes = new Map<string, number>();
      let finalText = '';
      // Con `--delegate` la salida es el resumen del subagente y el exit code su estado.
      let delegateStatus: string | null = null;
      // Atribución de subagentes en paralelo (§5.6): prefijo `[sub perfil#n]` a
      // stderr para que la salida entrelazada de varios hijos sea legible.
      const subLabels = new Map<string, string>(); // subagentId → "perfil#n"
      const subLabel = (id: string): string => {
        const tag = subLabels.get(id) ?? 'sub';
        return isColorTty ? chalk.hex('#F59E0B')(`[sub ${tag}]`) : `[sub ${tag}]`;
      };
      // Dedup de tool_call_start del hijo: el evento se repite por cada chunk de
      // argumentos streameado; solo imprimimos la primera aparición (como el
      // handler principal con `toolStartTimes`). Clave = subagentId:innerId.
      const subToolSeen = new Set<string>();

      try {
        const runOpts: RunOptions = {
          signal: controller.signal,
          // `run` es one-shot y no persiste sesión, pero el id sí correlaciona
          // en el log de auditoría SSH los comandos de una misma invocación.
          sessionId: generateSessionId(),
          allowDestructive: opts.allowDestructive,
          destructivePolicy: policy,
          onConfirmDestructive: policy === 'ask' ? confirmDestructive : undefined,
          // Tanda única de preguntas (Hito 2.5, F7). Sin TTY no hay callback:
          // el loop se lo dice al agente y este continúa con supuestos.
          onAskQuestions: makeCliQuestionAsker(),
          onSubagentPersist: (rec) =>
            rec.result
              ? subagentStore.saveResult(rec.id, rec.profile, rec.task, rec.result)
              : subagentStore.saveRunning(rec.id, rec.profile, rec.task),
          ...(planMode
            ? {
                mode: 'plan' as const,
                onApprovePlan,
                onPlanPersist: (p: Plan) => planStore.save(planRef, task, p, planCreatedAt),
              }
            : {}),
        };
        const events = opts.delegate
          ? agent.runDelegate(opts.delegate, task, runOpts)
          : agent.run(input, runOpts);
        for await (const event of events) {
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

            // La tanda de preguntas la imprime el propio asker (readline);
            // aquí solo se deja constancia de que se omitió.
            case 'questions_asked':
              break;

            case 'questions_answered':
              if (event.answers === null) {
                process.stderr.write(
                  '[question] sin respuesta: el agente continuará con supuestos.\n',
                );
              }
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

            // ----- Subagentes (Hito 8C, §5.6): salida atribuible por prefijo -----
            case 'subagent_started': {
              const n = subLabels.size + 1;
              subLabels.set(event.subagentId, `${event.profile}#${n}`);
              process.stderr.write(`${subLabel(event.subagentId)} ⊳ delegado: ${event.task}\n`);
              break;
            }

            case 'subagent_event': {
              // Solo se refleja la actividad de tools del hijo (no su text_delta).
              const inner = event.event;
              if (inner.type === 'tool_call_start') {
                const key = `${event.subagentId}:${inner.id}`;
                if (!subToolSeen.has(key)) {
                  subToolSeen.add(key);
                  process.stderr.write(`${subLabel(event.subagentId)} ${inner.name}: ...\n`);
                }
              } else if (inner.type === 'tool_result') {
                process.stderr.write(`${subLabel(event.subagentId)} ✓ ${inner.name}\n`);
              } else if (inner.type === 'tool_error') {
                process.stderr.write(
                  `${subLabel(event.subagentId)} ✗ ${inner.name}: ${inner.error}\n`,
                );
              }
              break;
            }

            case 'subagent_completed': {
              const r = event.result;
              const files = r.filesChanged.length;
              process.stderr.write(
                `${subLabel(event.subagentId)} ${r.status === 'completed' ? '✓' : '✗'} ${r.status} · ` +
                  `${r.usage.iterations} it · ${files} fichero${files === 1 ? '' : 's'}\n`,
              );
              if (opts.delegate) {
                finalText = r.status === 'completed' ? r.summary : '';
                delegateStatus = r.status;
                if (r.status !== 'completed' && r.error) {
                  process.stderr.write(`${errorLabel} ${r.error}\n`);
                }
              }
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
        await closeExecRuntime();
        getLogger('cli').error('run aborted with error', { err });
        await flushLogging();
        process.stderr.write(`${fatalLabel} ${String(err)}\n`);
        process.exit(1);
      }

      await mcpManager.shutdownAll();
      // Hito 9 (§12.12): cerrar los sockets SSH antes de salir.
      await closeExecRuntime();
      await flushLogging();

      if (controller.signal.aborted) {
        process.exit(130);
      }

      if (finalText) {
        process.stdout.write(finalText + '\n');
      }

      // `--delegate`: un subagente que no completó no es un éxito para quien
      // encadena `stratum run` en un script.
      if (opts.delegate && delegateStatus !== 'completed') {
        process.exit(1);
      }
    },
  );
