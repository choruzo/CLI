import { Command } from 'commander';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const DEFAULT_CONFIG = {
  provider: {
    default: 'local-ollama',
    providers: {
      'local-ollama': {
        type: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:32b',
        apiKey: 'ollama',
        contextWindow: 32768,
      },
    },
  },
};

const STRATUM_MD_TEMPLATE = `# Stratum Memory

## Proyecto
<!-- Describe tu proyecto, stack y convenciones aquí -->
<!-- Ejemplo:
Repositorio: mi-proyecto
Stack: TypeScript + Node.js
-->

## Instrucciones para el agente
<!-- Comportamientos específicos que Stratum debe seguir en este proyecto -->
<!-- Ejemplo:
- Siempre verificar antes de ejecutar comandos destructivos
- Comentarios en español
-->
`;

export const initCommand = new Command('init')
  .description('Initialize Stratum in the current directory')
  .option('--force', 'overwrite existing files')
  .action((options: { force?: boolean }) => {
    const cwd = process.cwd();
    const configPath = join(cwd, '.stratumrc.json');
    const stratumMdPath = join(cwd, 'STRATUM.md');
    let created = false;

    if (existsSync(configPath) && !options.force) {
      process.stdout.write(`.stratumrc.json already exists. Use --force to overwrite.\n`);
    } else {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
      process.stdout.write(`Created .stratumrc.json\n`);
      created = true;
    }

    if (existsSync(stratumMdPath) && !options.force) {
      process.stdout.write(`STRATUM.md already exists. Use --force to overwrite.\n`);
    } else {
      writeFileSync(stratumMdPath, STRATUM_MD_TEMPLATE, 'utf-8');
      process.stdout.write(`Created STRATUM.md\n`);
      created = true;
    }

    if (created) {
      process.stdout.write('\nNext steps:\n');
      process.stdout.write('  1. Edit .stratumrc.json to configure your LLM provider\n');
      process.stdout.write('  2. Edit STRATUM.md to describe your project context\n');
      process.stdout.write('  3. Run: stratum chat\n');
    }
  });
