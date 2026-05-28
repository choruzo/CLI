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
import { StratumAgent } from '../../agent/core.js';
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
  .option('--resume <session-id>', 'resume a previous session (not yet implemented)')
  .action(async (opts: { provider?: string; resume?: string }) => {
    if (opts.resume) {
      process.stderr.write('--resume is not yet implemented (coming in Hito 2).\n');
    }

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

    const agent = new StratumAgent(config, router, registry);
    const version = resolveVersion();

    const { waitUntilExit } = render(React.createElement(App, { agent, version }));

    try {
      await waitUntilExit();
    } catch {
      // exit() was called
    }
  });
