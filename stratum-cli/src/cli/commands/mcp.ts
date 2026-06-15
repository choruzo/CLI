import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { McpManager } from '../../tools/mcp/manager.js';

const mcpList = new Command('list')
  .description('List all MCP servers and their available tools')
  .action(async () => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`Config error: ${String(err)}\n`);
      process.exit(1);
    }

    if (config.mcp.servers.length === 0) {
      process.stdout.write('No MCP servers configured in .stratumrc.json.\n');
      process.stdout.write(
        'Add a server under the "mcp.servers" key. Example:\n' +
          '  { "name": "chrome-devtools", "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] }\n',
      );
      return;
    }

    const manager = new McpManager(config);
    const warnings = await manager.connectAll();

    for (const warn of warnings) {
      process.stderr.write(`[warn] ${warn.message}\n`);
    }

    const summary = manager.getStatusSummary();
    process.stdout.write(
      `MCP servers: ${summary.connected} connected, ${summary.disconnected} disconnected\n\n`,
    );

    for (const client of manager.getClients()) {
      const connected = client.status === 'connected';
      const statusIcon = connected ? '●' : '○';
      const statusLabel = connected ? 'connected' : client.status;

      process.stdout.write(`${statusIcon} ${client.name}  [${statusLabel}]\n`);

      if (client.tools.length === 0) {
        process.stdout.write('  (no tools available)\n');
      } else {
        process.stdout.write(`  tools (${client.tools.length}):\n`);
        for (const tool of client.tools) {
          const desc = tool.description ? `  — ${tool.description}` : '';
          process.stdout.write(`    • ${client.name}/${tool.name}${desc}\n`);
        }
      }
      process.stdout.write('\n');
    }

    await manager.shutdownAll();
  });

export const mcpCommand = new Command('mcp')
  .description('Manage MCP (Model Context Protocol) server connections')
  .addCommand(mcpList);
