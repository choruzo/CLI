import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { discoverContextWindow } from '../startup-model.js';
import { ToolRegistry } from '../../tools/registry.js';
import { registerBuiltinTools } from '../../tools/index.js';
import { McpManager } from '../../tools/mcp/manager.js';
import { closeExecRuntime } from '../../tools/exec/runtime.js';
import { openSessionTrace, pruneTraces } from '../../trace/store.js';
import { SessionAuditor } from '../../trace/auditor.js';
import { warnConfigDeprecations } from '../../config/deprecation-warning.js';
import { StratumAgent } from '../../agent/core.js';
import { SessionStore, generateSessionId } from '../../session/store.js';
import { SubagentStore } from '../../session/subagent-store.js';
import { prepareSessionResume } from '../../session/resume.js';
import { SessionCheckpointer } from '../../session/checkpoint.js';
import { pruneOldPlans } from '../../session/cleanup.js';
import { resolveMemoryPaths } from '../../config/paths.js';
import { App } from '../ui/App.js';
import { animateStartupLogo } from '../ui/startup-logo-animation.js';
import { warnInheritedGitRouting } from '../../git/env-warning.js';
import { resolveSessionProfile } from '../../agent/session-profile.js';
import { sessionProfileFlag } from '../session-flags.js';
import {
  configureLogging,
  flushLogging,
  getLogger,
  isLogLevel,
  type LogLevel,
} from '../../logging/index.js';

declare const __VERSION__: string;

/** Cadencia del checkpoint periódico de la sesión (además del de fin de turno). */
const CHECKPOINT_EVERY_MS = 30_000;

/** Ejecuta un paso del teardown sin dejar que su fallo aborte los siguientes. */
async function settle(step: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    getLogger('cli').warn('teardown step failed', { step, err });
  }
}

function resolveVersion(): string {
  if (typeof __VERSION__ !== 'undefined') return __VERSION__;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(thisDir, '..', '..', '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.1.0';
  }
}

export const chatCommand = new Command('chat')
  .description('Start an interactive REPL session with the agent')
  .option('--provider <name>', 'use a specific provider from config')
  .option('--model <id>', 'start with a specific model of the provider (this session only)')
  .option('--resume <session-id>', 'resume a previous session')
  .option('--read-only', 'observation only: no file writes and only read-only commands')
  .option('--profile <name>', 'session profile: auto | code | infra | full | <custom>')
  .option('--infra', 'shortcut for --profile infra')
  .option('--code', 'shortcut for --profile code')
  .option('--log-level <level>', 'log level: trace|debug|info|warn|error|silent')
  .option('--debug', 'enable verbose debug logging (level debug + file sink)')
  .action(
    async (opts: {
      provider?: string;
      model?: string;
      resume?: string;
      logLevel?: string;
      debug?: boolean;
      readOnly?: boolean;
      profile?: string;
      infra?: boolean;
      code?: boolean;
    }) => {
      const profileFlag = sessionProfileFlag(opts);
      if (!profileFlag.ok) {
        process.stderr.write(`${profileFlag.error}\n`);
        process.exit(1);
      }
      if (opts.logLevel && !isLogLevel(opts.logLevel)) {
        process.stderr.write(`Invalid --log-level: ${opts.logLevel}\n`);
        process.exit(1);
      }

      let config;
      try {
        config = loadConfig();
      } catch (err) {
        process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      // Ink es dueño de stdout; el sink de stderr se mantiene en warn+ por defecto
      // para no entrelazarse con la UI. --debug/--log-level lo elevan, y el sink de
      // fichero (si está activo) recibe el nivel completo igualmente.
      configureLogging(config, {
        level: opts.logLevel as LogLevel | undefined,
        debug: opts.debug,
        stderrLevel: 'warn',
      });
      getLogger('cli').debug('chat start', { provider: opts.provider, resume: opts.resume });
      warnInheritedGitRouting();
      warnConfigDeprecations();

      let router;
      try {
        router = new ProviderRouter(config, opts.provider);
      } catch (err) {
        process.stderr.write(`Provider error: ${String(err)}\n`);
        process.exit(1);
      }
      if (opts.model?.trim()) router.switchModel(opts.model.trim());
      // Sin modelo configurado, `App` abre el selector al montar (y esa consulta
      // ya trae las ventanas). Con modelo, se consulta en background.
      if (router.model && router.contextWindowIsDiscoverable) {
        void discoverContextWindow(router.getActiveConfig());
      }

      const registry = new ToolRegistry();
      registerBuiltinTools(registry, config);

      // -----------------------------------------------------------------------
      // MCP servers (§12.8). 'lazy' (default): conexión en background, no bloquea
      // el arranque de la UI. 'eager': espera a que conecten antes del prompt.
      // Un fallo de un server nunca aborta.
      // -----------------------------------------------------------------------
      const mcpManager = new McpManager(config);
      // Con arranque eager, el panel <MCPStartup> del banner (UI §14) muestra el
      // progreso en vivo: la conexión se lanza aquí pero NO se espera, o la fase
      // de conexión habría terminado antes de que Ink pintase nada. Los fallos
      // se ven en el propio panel — escribir a stderr aquí corrompería el render.
      let mcpEager = false;
      if (config.mcp.servers.length > 0) {
        if (config.mcp.startup === 'eager') {
          mcpEager = true;
          void mcpManager.connectAll().then(() => {
            mcpManager.registerInto(registry);
          });
        } else {
          mcpManager.startBackground(registry, (w) => {
            process.stderr.write(`[mcp] ${w.message}\n`);
          });
        }
        mcpManager.startHeartbeat();
      }

      // -----------------------------------------------------------------------
      // Sesiones: cargar historial previo si --resume
      // -----------------------------------------------------------------------
      const paths = resolveMemoryPaths(config);
      const store = new SessionStore(paths.sessionsDir);

      // El id se genera al arrancar, no al guardar: así lo que se escribe fuera
      // de la sesión durante el turno (auditoría SSH, §12.14) puede correlacionarse.
      let sessionId: string = generateSessionId();
      // Un único store de subagentes para la sesión: `App` persiste en él y aquí
      // se marcan, tras guardar, los huérfanos avisados al reanudar (8B endurecido).
      const subagentStore = new SubagentStore(process.cwd());
      const retentionDays = config.agents.subagentRetentionDays;
      if (retentionDays > 0) subagentStore.prune(retentionDays * 24 * 60 * 60 * 1000);
      pruneOldPlans(store, process.cwd(), config.session.planRetentionDays);
      let sessionCreatedAt: string | undefined;
      // Versión en disco de la que parte la sesión reanudada: si al salir ya no
      // es esa, otra terminal la guardó y esta conversación se guarda aparte.
      let resumedUpdatedAt: string | undefined;
      let agentOptions = {};
      // Hito 17: una sesión read-only se reanuda read-only; el perfil guardado se
      // reaplica salvo que un flag pida otro.
      let resumedReadOnly = false;
      let resumedProfile: string | undefined;

      if (opts.resume) {
        try {
          const saved = store.load(opts.resume);
          agentOptions = { initialMessages: saved.messages };
          sessionId = saved.id;
          sessionCreatedAt = saved.createdAt;
          resumedUpdatedAt = saved.updatedAt;
          process.stderr.write(`Reanudando sesión ${saved.id}\n`);

          // Hito 7 / 8B — plan a medias y subagentes interrumpidos (§12.6, §12.16),
          // buscados en el proyecto de la sesión. Los subagentes no se
          // reejecutan (no son idempotentes): el preámbulo pide verificar, y los
          // avisados se marcan tras guardar la sesión.
          const resume = prepareSessionResume(saved, process.cwd());
          for (const w of resume.warnings) process.stderr.write(`[stratum] ${w}\n`);
          if (resume.preamble) {
            agentOptions = { initialMessages: saved.messages, resumePreamble: resume.preamble };
          }
          if (resume.plan) {
            agentOptions = {
              ...agentOptions,
              planRef: resume.plan.ref,
              resumePlan: resume.plan.plan,
              resumeTask: resume.plan.task,
              resumeCreatedAt: resume.plan.createdAt,
              resumePlanRoot: resume.plan.root,
            };
            process.stderr.write(`Reanudando plan in_progress (${resume.plan.ref})\n`);
          }
          if (resume.orphans.length > 0) {
            subagentStore.deferInterrupted(
              resume.orphans.map((o) => o.id),
              resume.subagentStore,
            );
            process.stderr.write(
              `Reanudando: ${resume.orphans.length} subagente(s) interrumpido(s)\n`,
            );
          }
          // Hito 15: perfil activo como agente principal. Se añade al final
          // porque las ramas anteriores reconstruyen `agentOptions` enteras.
          if (saved.activeAgent) {
            agentOptions = { ...agentOptions, activeAgent: saved.activeAgent };
          }
          resumedReadOnly = saved.readOnly === true;
          resumedProfile = saved.sessionProfile;
        } catch (err) {
          process.stderr.write(
            `Error al cargar sesión: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      }

      // Hito 17: validar el perfil antes de arrancar Ink (un nombre mal escrito
      // es un error de invocación, no algo que descubrir a mitad de sesión).
      const requestedProfile = profileFlag.profile ?? resumedProfile;
      if (profileFlag.profile) {
        const check = resolveSessionProfile(profileFlag.profile, config);
        if (!check.ok) {
          process.stderr.write(`--profile: ${check.error}\n`);
          process.exit(1);
        }
      }
      const agent = new StratumAgent(config, router, registry, {
        ...agentOptions,
        readOnly: opts.readOnly === true || resumedReadOnly,
        ...(requestedProfile ? { sessionProfile: requestedProfile } : {}),
      });
      const resumeNotice = agent.takeResumeNotice();
      if (resumeNotice) process.stderr.write(`${resumeNotice}\n`);

      // Warm-up opcional del modelo de embeddings (§12.10): precarga el ONNX en
      // background durante el arranque para que la primera recuperación/escritura
      // de memoria no pague la latencia de carga. No bloquea la UI ni lanza.
      if (config.memory.embeddingWarmup) {
        void import('../../memory/decision-memory.js').then(({ getDecisionMemory }) =>
          getDecisionMemory(config).embedder.warmup(),
        );
      }

      const version = resolveVersion();
      const sessionStart = new Date().toISOString();

      // Traza de la sesión (`/auditor`): se graba siempre; el visor web solo se
      // levanta si se pide. Una sesión reanudada sigue en su mismo fichero.
      if (config.trace.retentionDays > 0) {
        pruneTraces(config, config.trace.retentionDays * 24 * 60 * 60 * 1000);
      }
      const auditor = new SessionAuditor(
        openSessionTrace(config, sessionId, { cwd: process.cwd(), version }),
      );

      // Guardado incremental (checkpoints): antes la sesión solo se escribía al
      // salir limpiamente, y un cierre de la ventana o un fallo la perdía entera.
      // El checkpointer es el único escritor de la sesión, también al salir.
      const checkpointer = new SessionCheckpointer(store, {
        id: sessionId,
        expectedUpdatedAt: resumedUpdatedAt,
        snapshot: () => ({
          createdAt: sessionCreatedAt ?? sessionStart,
          provider: router.providerName,
          model: router.model,
          project: process.cwd(),
          messages: agent.getMessages(),
          toolCallCount: agent.toolCallCount,
          planRef: agent.getPlanRef(),
          activeAgent: agent.getActiveProfile()?.name ?? null,
          readOnly: agent.isReadOnly(),
          sessionProfile: agent.getSessionProfileRequest(),
        }),
      });
      const checkpointTimer = setInterval(
        () => void checkpointer.checkpoint(),
        CHECKPOINT_EVERY_MS,
      );
      checkpointTimer.unref();
      // Cierre por señal (terminal cerrada → SIGHUP, `kill` → SIGTERM): no pasa
      // por la salida normal de Ink, así que se guarda aquí antes de salir.
      let signalled = false;
      const onFatalSignal = (signal: NodeJS.Signals): void => {
        if (signalled) return;
        signalled = true;
        void checkpointer.checkpoint().finally(() => {
          process.exit(signal === 'SIGTERM' ? 143 : 129);
        });
      };
      process.on('SIGTERM', onFatalSignal);
      process.on('SIGHUP', onFatalSignal);

      const logoPreRendered = await animateStartupLogo({ stdout: process.stdout });

      const { waitUntilExit } = render(
        React.createElement(App, {
          agent,
          version,
          mcpManager,
          mcpEager,
          logoPreRendered,
          sessionId,
          registry,
          subagentStore,
          auditor,
          onCheckpoint: () => void checkpointer.checkpoint(),
        }),
        // Ctrl+C es de App (cancelar el turno, doble pulsación para salir, §10):
        // con el default de Ink, la tecla desmontaba la UI y nunca llegaba.
        { exitOnCtrlC: false },
      );

      try {
        await waitUntilExit();
      } catch {
        // exit() was called — normal shutdown
      }
      clearInterval(checkpointTimer);
      process.off('SIGTERM', onFatalSignal);
      process.off('SIGHUP', onFatalSignal);

      // -----------------------------------------------------------------------
      // Guardar sesión al salir. Va ANTES del teardown: si el cierre de MCP o de
      // SSH lanzase, antes se perdía la conversación entera.
      // -----------------------------------------------------------------------
      try {
        const savedSession = await checkpointer.saveFinal(router.getActive());
        // El aviso de los huérfanos ya está guardado en la sesión: ahora sí.
        subagentStore.commitDeferred();
        if (savedSession.forkedFrom) {
          process.stderr.write(
            `La sesión ${savedSession.forkedFrom} se guardó desde otra terminal mientras ` +
              `estaba abierta aquí; para no perder ninguna de las dos, esta conversación ` +
              `se guardó como ${savedSession.id} (stratum sessions resume ${savedSession.id}).\n`,
          );
        }
      } catch (err) {
        // No bloquear la salida por un fallo al guardar, pero tampoco callarlo:
        // es la conversación entera.
        process.stderr.write(
          `[stratum] No se pudo guardar la sesión ${checkpointer.sessionId}: ${String(err)}\n`,
        );
      }

      // Teardown: cada paso por separado, para que un fallo no deje el resto
      // sin cerrar (sin cerrar SSH el proceso no termina, §12.12).
      await settle('mcp shutdown', () => mcpManager.shutdownAll());
      // Hito 9 (§12.12): sin cerrar las conexiones SSH, sus sockets mantienen
      // vivo el event loop y el proceso nunca termina.
      await settle('exec runtime shutdown', () => closeExecRuntime());
      await settle('subagent store dispose', () => subagentStore.dispose());
      await settle('auditor shutdown', () => auditor.dispose());
      await flushLogging();
    },
  );
