import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { McpManager } from '../../tools/mcp/manager.js';
import {
  ensureInstallDir,
  installServer,
  isServerInstalled,
  serverInstallPath,
} from '../../tools/mcp/installer.js';

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

const mcpInstall = new Command('install')
  .description('Install MCP servers that declare a "package" into the managed folder (~/.stratum/mcp)')
  .argument('[server]', 'Name of a single server to install (default: all with a "package")')
  .option('-f, --force', 'Reinstall even if already present')
  .action(async (serverName: string | undefined, opts: { force?: boolean }) => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`Config error: ${String(err)}\n`);
      process.exit(1);
    }

    const installDir = ensureInstallDir(config.mcp.installDir);
    process.stdout.write(`Carpeta gestionada: ${installDir}\n\n`);

    let targets = config.mcp.servers.filter((s) => s.package);
    if (serverName) {
      targets = targets.filter((s) => s.name === serverName);
      if (targets.length === 0) {
        process.stderr.write(
          `No hay ningún server con 'package' llamado '${serverName}' en .stratumrc.json.\n`,
        );
        process.exit(1);
      }
    }

    if (targets.length === 0) {
      process.stdout.write(
        'Ningún server declara "package". Añade "package": "<pkg>@<version>" para usar la carpeta gestionada.\n',
      );
      return;
    }

    for (const server of targets) {
      const already = isServerInstalled(server, installDir);
      if (already && !opts.force) {
        process.stdout.write(`● ${server.name}  ya instalado (${serverInstallPath(installDir, server.name)})\n`);
        continue;
      }
      try {
        await installServer(server, installDir, (line) => process.stdout.write(`  ${line}\n`));
        process.stdout.write(`✔ ${server.name}\n`);
      } catch (err) {
        process.stderr.write(`✗ ${server.name}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  });

export const mcpCommand = new Command('mcp')
  .description('Manage MCP (Model Context Protocol) server connections')
  .addCommand(mcpList)
  .addCommand(mcpInstall);
