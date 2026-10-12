#!/usr/bin/env node
import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { runCommand } from './commands/run.js';
import { memoryCommand } from './commands/memory.js';
import { sessionsCommand } from './commands/sessions.js';
import { configCommand } from './commands/config.js';
import { initCommand } from './commands/init.js';
import { providerCommand } from './commands/provider.js';
import { mcpCommand } from './commands/mcp.js';
import { logsCommand } from './commands/logs.js';
import { sshCommand } from './commands/ssh.js';
import { agentsCommand } from './commands/agents.js';
import { auditorCommand } from './commands/auditor.js';
import { evalCommand } from './commands/eval.js';
import { statsCommand } from './commands/stats.js';
import { daemonCommand } from './commands/daemon.js';
import { cliVersion } from './version.js';
import { ConfigError } from '../config/loader.js';
import { SchemaVersionError } from '../config/schema-version.js';

const program = new Command();

program
  .name('stratum')
  .description('Extensible CLI agent powered by a ReAct loop')
  .version(cliVersion(), '-v, --version');

program.addCommand(chatCommand);
program.addCommand(runCommand);
program.addCommand(memoryCommand);
program.addCommand(sessionsCommand);
program.addCommand(configCommand);
program.addCommand(initCommand);
program.addCommand(providerCommand);
program.addCommand(mcpCommand);
program.addCommand(logsCommand);
program.addCommand(sshCommand);
program.addCommand(agentsCommand);
program.addCommand(auditorCommand);
program.addCommand(evalCommand);
program.addCommand(statsCommand);
program.addCommand(daemonCommand);

// Una config rota se explica con su mensaje (fichero, línea o clave), no con
// la traza: los comandos que no capturan `loadConfig()` llegan aquí.
program.parseAsync().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof SchemaVersionError) {
    process.stderr.write(`Config error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
