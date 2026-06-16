import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { ToolRegistry } from '../../tools/registry.js';
import { registerBuiltinTools } from '../../tools/index.js';
import { McpManager } from '../../tools/mcp/manager.js';
import { StratumAgent } from '../../agent/core.js';
import { SessionStore } from '../../session/store.js';
import { resolveMemoryPaths } from '../../config/paths.js';
import { App } from '../ui/App.js';

declare const __VERSION__: string;

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
  .option('--resume <session-id>', 'resume a previous session')
  .action(async (opts: { provider?: string; resume?: string }) => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`Config error: ${String(err)}\n`);
      process.exit(1);
    }

    let router;
    try {
      router = new ProviderRouter(config, opts.provider);
    } catch (err) {
      process.stderr.write(`Provider error: ${String(err)}\n`);
      process.exit(1);
    }

    const registry = new ToolRegistry();
    registerBuiltinTools(registry, config);

    // -----------------------------------------------------------------------
    // MCP servers (§12.8). 'lazy' (default): conexión en background, no bloquea
    // el arranque de la UI. 'eager': espera a que conecten antes del prompt.
    // Un fallo de un server nunca aborta.
    // -----------------------------------------------------------------------
    const mcpManager = new McpManager(config);
    if (config.mcp.servers.length > 0) {
      if (config.mcp.startup === 'eager') {
        const mcpWarnings = await mcpManager.connectAll();
        for (const w of mcpWarnings) {
          process.stderr.write(`[mcp] ${w.message}\n`);
        }
        mcpManager.registerInto(registry);
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

    let sessionId: string | undefined;
    let sessionCreatedAt: string | undefined;
    let agentOptions = {};

    if (opts.resume) {
      try {
        const saved = store.load(opts.resume);
        agentOptions = { initialMessages: saved.messages };
        sessionId = saved.id;
        sessionCreatedAt = saved.createdAt;
        process.stderr.write(`Reanudando sesión ${saved.id}\n`);
      } catch (err) {
        process.stderr.write(`Error al cargar sesión: ${String(err)}\n`);
        process.exit(1);
      }
    }

    const agent = new StratumAgent(config, router, registry, agentOptions);

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

    const { waitUntilExit } = render(React.createElement(App, { agent, version, mcpManager }));

    try {
      await waitUntilExit();
    } catch {
      // exit() was called — normal shutdown
    }

    await mcpManager.shutdownAll();

    // -----------------------------------------------------------------------
    // Guardar sesión al salir
    // -----------------------------------------------------------------------
    try {
      await store.save({
        existingId: sessionId,
        createdAt: sessionCreatedAt ?? sessionStart,
        provider: router.providerName,
        model: router.model,
        project: process.cwd(),
        messages: agent.getMessages(),
        toolCallCount: agent.toolCallCount,
        llmProvider: router.getActive(),
      });
    } catch {
      // No bloquear la salida por un fallo al guardar
    }
  });
