import { Command } from 'commander';
import React from 'react';
import { render, Box, Text } from 'ink';
import chalk from 'chalk';
import { loadConfig } from '../../config/loader.js';
import { OpenAICompatible } from '../../providers/openai-compatible.js';
import {
  upsertProvider,
  removeProviderEverywhere,
  setDefaultProvider,
  setProviderModel,
} from '../../config/writer.js';
import { fetchModelInfos, type ModelInfo } from '../../providers/utils.js';
import { ProviderWizard } from '../ui/ProviderWizard.js';
import { theme } from '../ui/theme.js';
import {
  buildProviderEntry,
  resolveApiKey,
  validateAlias,
  validateBaseUrl,
  type WizardResult,
} from '../ui/wizard-logic.js';

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

interface AddFlags {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  contextWindow?: string;
  default?: boolean;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Alta sin wizard: con la URL y la key basta. Los modelos se piden a
 * `GET /models`; sin `--model` no se fija ninguno y se elige al arrancar.
 */
async function addFromFlags(
  name: string | undefined,
  flags: AddFlags,
  existingNames: string[],
): Promise<void> {
  if (!name) fail('Falta el alias: stratum provider add <alias> --base-url <url> …');
  if (!flags.baseUrl) fail('Falta --base-url <url>.');
  if (flags.apiKey && flags.apiKeyEnv) fail('Usa --api-key o --api-key-env, no los dos.');
  const aliasError = validateAlias(name, existingNames);
  if (aliasError) fail(aliasError);
  const urlError = validateBaseUrl(flags.baseUrl);
  if (urlError) fail(urlError);

  let contextWindow: number | undefined;
  if (flags.contextWindow !== undefined) {
    contextWindow = Number(flags.contextWindow);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      fail(`--context-window inválido: ${flags.contextWindow}`);
    }
  }

  // En disco va el placeholder, nunca el valor de la variable.
  const storedKey = flags.apiKeyEnv ? '${' + flags.apiKeyEnv + '}' : (flags.apiKey ?? '');
  const { key, missing } = resolveApiKey(storedKey);
  if (missing.length > 0) fail(`Variable de entorno no definida: ${missing.join(', ')}`);

  let models: ModelInfo[] = [];
  try {
    models = await fetchModelInfos(flags.baseUrl, key);
    process.stdout.write(
      `${models.length} modelos en ${flags.baseUrl}: ${models.map((m) => m.id).join(', ')}\n`,
    );
  } catch (err) {
    process.stderr.write(`Aviso: no se pudieron listar los modelos (${errorText(err)}).\n`);
  }
  const model = flags.model?.trim();
  if (model && models.length > 0 && !models.some((m) => m.id === model)) {
    fail(`El modelo "${model}" no está entre los que expone el provider.`);
  }

  try {
    const entry = buildProviderEntry({
      baseUrl: flags.baseUrl,
      apiKey: storedKey,
      model,
      contextWindow,
    });
    const { configPath, created } = upsertProvider(name, entry, flags.default === true);
    process.stdout.write(`${created ? 'Creado' : 'Actualizado'} ${configPath}\n`);
    process.stdout.write(
      model
        ? `Provider "${name}" configurado con el modelo ${model}.\n`
        : `Provider "${name}" configurado sin modelo fijo: se elige al arrancar ` +
            '`stratum chat`, o con --model en `stratum run`.\n',
    );
  } catch (err) {
    fail(`Error al escribir la config: ${errorText(err)}`);
  }
}

const providerAdd = new Command('add')
  .description('Añade un provider a .stratumrc.json: wizard interactivo, o directo con --base-url')
  .argument('[name]', 'alias del provider (solo con --base-url)')
  .option('--base-url <url>', 'URL base de la API (con /v1): alta sin wizard')
  .option('--api-key-env <VAR>', 'variable de entorno con la API key (se guarda como ${VAR})')
  .option('--api-key <key>', 'API key literal (queda en claro en el archivo)')
  .option('--model <id>', 'modelo por defecto; sin él se elige al arrancar')
  .option('--context-window <n>', 'ventana de contexto en tokens')
  .option('--default', 'dejarlo como provider activo')
  .action(async (name: string | undefined, flags: AddFlags) => {
    let existingNames: string[] = [];
    try {
      const config = loadConfig();
      existingNames = Object.keys(config.provider?.providers ?? {});
    } catch {
      // Config inexistente o inválida: el wizard la crea desde cero
    }

    if (flags.baseUrl || name) {
      await addFromFlags(name, flags, existingNames);
      return;
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
        process.stdout.write(`Provider activo: ${r.name} (${r.config.model ?? ''})\n`);
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
      process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
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
    const modelOf = (n: string) => providers[n].model || '(al arrancar)';
    const wModel = Math.max(...names.map((n) => modelOf(n).length), 8);

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
        `${mark}${alias}  ${col(p.type, 18)}  ${col(p.baseUrl, wUrl)}  ${col(modelOf(name), wModel)}  ${dot}\n`,
      );
    });
    process.stdout.write(chalk.dim('\n  ▶ = provider activo · ● verde = /models responde\n'));
  });

// -----------------------------------------------------------------------------
// stratum provider models — lo que expone GET /models
// -----------------------------------------------------------------------------

const providerModels = new Command('models')
  .description('Lista los modelos que expone un provider (GET /models)')
  .argument('[name]', 'alias del provider (por defecto, el activo)')
  .option('--set <id>', 'fija ese modelo como el por defecto del provider')
  .action(async (name: string | undefined, opts: { set?: string }) => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      fail(`Config error: ${errorText(err)}`);
    }
    const alias = name ?? config.provider?.default;
    const entry = alias ? config.provider?.providers[alias] : undefined;
    if (!alias || !entry) fail(`Provider "${alias ?? ''}" no existe en la config.`);

    let models: ModelInfo[];
    try {
      models = await fetchModelInfos(entry.baseUrl, entry.apiKey);
    } catch (err) {
      fail(`No se pudieron listar los modelos: ${errorText(err)}`);
    }

    if (opts.set) {
      if (models.length > 0 && !models.some((m) => m.id === opts.set)) {
        fail(`El modelo "${opts.set}" no está entre los que expone "${alias}".`);
      }
      let path: string | null;
      try {
        path = setProviderModel(alias, opts.set);
      } catch (err) {
        fail(`Error al escribir la config: ${errorText(err)}`);
      }
      if (!path) fail(`"${alias}" no está definido en ningún .stratumrc.json escribible.`);
      process.stdout.write(`Modelo por defecto de "${alias}": ${opts.set} (${path})\n`);
      return;
    }

    for (const m of models) {
      const mark = m.id === entry.model ? chalk.hex('#F59E0B')('▶ ') : '  ';
      const ctx = entry.models?.[m.id]?.contextWindow ?? m.contextWindow;
      process.stdout.write(`${mark}${m.id}${ctx ? chalk.dim(`  ${ctx} tokens`) : ''}\n`);
    }
    process.stdout.write(
      chalk.dim(`\n  ${models.length} modelos en ${entry.baseUrl} · ▶ = modelo por defecto\n`),
    );
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
  .alias('rm')
  .description('Elimina un provider (con su modelo y sus ajustes por modelo) de la config')
  .argument('<name>', 'alias del provider')
  .action((name: string) => {
    try {
      for (const { configPath, backupPath, newDefault } of removeProviderEverywhere(name)) {
        process.stdout.write(`Eliminado "${name}" de ${configPath}\n`);
        if (backupPath) process.stdout.write(`Backup: ${backupPath}\n`);
        if (newDefault) {
          process.stdout.write(`El provider activo era "${name}" → nuevo activo: ${newDefault}\n`);
        }
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
  .addCommand(providerModels)
  .addCommand(providerUse)
  .addCommand(providerRemove);
