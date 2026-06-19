import { Command } from 'commander';
import React from 'react';
import { render, Box, Text } from 'ink';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { OpenAICompatible } from '../../providers/openai-compatible.js';
import { upsertProvider, removeProvider, setDefaultProvider } from '../../config/writer.js';
import { ProviderWizard } from '../ui/ProviderWizard.js';
import { theme } from '../ui/theme.js';
import type { WizardResult } from '../ui/wizard-logic.js';

// -----------------------------------------------------------------------------
// stratum provider add — wizard interactivo (Hito 3.5)
// -----------------------------------------------------------------------------

interface AddAppProps {
  existingNames: string[];
  onDone: (result: WizardResult | null) => void;
}

function AddApp({ existingNames, onDone }: AddAppProps) {
  const [finished, setFinished] = React.useState<string | null>(null);

  if (finished) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.success}>{finished}</Text>
      </Box>
    );
  }

  return (
    <ProviderWizard
      mode="add"
      existingNames={existingNames}
      onComplete={(result) => {
        setFinished(`Provider "${result.name}" configurado.`);
        onDone(result);
      }}
      onCancel={() => onDone(null)}
    />
  );
}

const providerAdd = new Command('add')
  .description('Wizard interactivo para añadir un provider a .stratumrc.json')
  .action(async () => {
    let existingNames: string[] = [];
    try {
      const config = loadConfig();
      existingNames = Object.keys(config.provider?.providers ?? {});
    } catch {
      // Config inexistente o inválida: el wizard la crea desde cero
    }

    let result: WizardResult | null = null;
    const { unmount, waitUntilExit } = render(
      React.createElement(AddApp, {
        existingNames,
        onDone: (r: WizardResult | null) => {
          result = r;
          // Pequeño delay para que Ink pinte el mensaje final antes de desmontar
          setTimeout(() => unmount(), 50);
        },
      }),
    );
    await waitUntilExit();

    if (!result) {
      process.stderr.write('Wizard cancelado. No se modificó la configuración.\n');
      process.exitCode = 1;
      return;
    }

    const r = result as WizardResult;
    try {
      const { configPath, backupPath, created } = upsertProvider(r.name, r.config, r.makeDefault);
      process.stdout.write(
        `${created ? 'Creado' : 'Actualizado'} ${configPath}` +
          (backupPath ? ` (backup: ${backupPath})` : '') +
          '\n',
      );
      if (r.makeDefault) {
        process.stdout.write(`Provider activo: ${r.name} (${r.config.model})\n`);
      }
    } catch (err) {
      process.stderr.write(`Error al escribir la config: ${String(err)}\n`);
      process.exitCode = 1;
    }
  });

// -----------------------------------------------------------------------------
// stratum provider list — tabla con estado de conectividad
// -----------------------------------------------------------------------------

const providerList = new Command('list')
  .description('Lista los providers configurados con estado de conectividad')
  .action(async () => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`Config error: ${String(err)}\n`);
      process.exit(1);
    }

    const providers = config.provider?.providers ?? {};
    const names = Object.keys(providers);
    if (names.length === 0) {
      process.stdout.write('No hay providers configurados. Ejecuta `stratum provider add`.\n');
      return;
    }

    // Ping en paralelo (GET /models, timeout 5s)
    const states = await Promise.all(
      names.map(async (name) => {
        const p = providers[name];
        const client = new OpenAICompatible(p.baseUrl, p.apiKey, p.model);
        return client.healthCheck();
      }),
    );

    const defaultName = config.provider?.default;
    const col = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));
    const wName = Math.max(...names.map((n) => n.length + 2), 8);
    const wUrl = Math.max(...names.map((n) => providers[n].baseUrl.length), 10);
    const wModel = Math.max(...names.map((n) => providers[n].model.length), 8);

    process.stdout.write(
      chalk.bold(
        `  ${col('ALIAS', wName)}  ${col('TIPO', 18)}  ${col('BASE URL', wUrl)}  ${col('MODELO', wModel)}  ESTADO\n`,
      ),
    );
    names.forEach((name, i) => {
      const p = providers[name];
      const dot = states[i] ? chalk.green('●') : chalk.red('●');
      const mark = name === defaultName ? chalk.hex('#F59E0B')('▶ ') : '  ';
      const alias = name === defaultName ? chalk.bold(col(name, wName)) : col(name, wName);
      process.stdout.write(
        `${mark}${alias}  ${col(p.type, 18)}  ${col(p.baseUrl, wUrl)}  ${col(p.model, wModel)}  ${dot}\n`,
      );
    });
    process.stdout.write(chalk.dim('\n  ▶ = provider activo · ● verde = /models responde\n'));
  });

// -----------------------------------------------------------------------------
// stratum provider use / remove
// -----------------------------------------------------------------------------

const providerUse = new Command('use')
  .description('Cambia el provider activo (provider.default)')
  .argument('<name>', 'alias del provider')
  .action((name: string) => {
    try {
      const { configPath, backupPath } = setDefaultProvider(name);
      process.stdout.write(
        `Provider activo: ${name} (${configPath})` +
          (backupPath ? ` · backup: ${backupPath}` : '') +
          '\n',
      );
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

const providerRemove = new Command('remove')
  .description('Elimina un provider de la config')
  .argument('<name>', 'alias del provider')
  .action((name: string) => {
    try {
      const { configPath, backupPath, newDefault } = removeProvider(name);
      process.stdout.write(`Eliminado "${name}" de ${configPath}\n`);
      if (backupPath) process.stdout.write(`Backup: ${backupPath}\n`);
      if (newDefault) {
        process.stdout.write(`El provider activo era "${name}" → nuevo activo: ${newDefault}\n`);
      }
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

export const providerCommand = new Command('provider')
  .alias('providers')
  .description('Gestión de providers LLM (add/list/use/remove) sin editar .stratumrc.json a mano')
  .addCommand(providerAdd)
  .addCommand(providerList)
  .addCommand(providerUse)
  .addCommand(providerRemove);
