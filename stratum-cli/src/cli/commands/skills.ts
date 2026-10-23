import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { sessionSkills, type SkillEntry } from '../../skills/registry.js';

/** Salida de texto de `stratum skills list`: una skill por bloque, con su ruta debajo. */
export function formatSkills(entries: SkillEntry[]): string {
  if (entries.length === 0) return 'No hay skills.\n';
  return (
    entries
      .map(
        (e) =>
          `${e.name}  [${e.scope}]  ${e.presets.join(',')}  — ${e.description || '(sin descripción)'}\n  ${e.path}`,
      )
      .join('\n') + '\n'
  );
}

/** Salida `--json`: lo que describe a cada skill, sin el cuerpo. */
export function skillsJson(entries: SkillEntry[]): string {
  return JSON.stringify(
    entries.map((e) => ({
      name: e.name,
      description: e.description,
      scope: e.scope,
      presets: e.presets,
      path: e.path,
      source: e.source,
    })),
    null,
    2,
  );
}

const skillsList = new Command('list')
  .description('List the skills available to the agent')
  .option('--assistant', "list the assistant's skills (built-in only) instead of the code agent's")
  .option('--json', 'output as JSON')
  .action((opts: { assistant?: boolean; json?: boolean }) => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (!config.skills.enabled) {
      process.stdout.write('Las skills están desactivadas (skills.enabled: false).\n');
      return;
    }
    // Lo mismo que vería una sesión nueva de ese agente en este directorio.
    const registry = sessionSkills(config, opts.assistant ? 'assistant' : 'coding', process.cwd());
    process.stdout.write(
      opts.json ? skillsJson(registry.entries) + '\n' : formatSkills(registry.entries),
    );
  });

export const skillsCommand = new Command('skills')
  .description('Inspect the skills available to the agent')
  .addCommand(skillsList);
