/**
 * Presets de language server (encargo UX-2b). Con el nombre basta en
 * `.stratumrc.json`: `"servers": { "typescript": {} }`. Un servidor declarado
 * con más campos sobreescribe el preset **campo a campo**, así que cambiar solo
 * `args` conserva el comando y las extensiones del preset.
 */

export interface LspServerPreset {
  command: string;
  args: string[];
  extensions: string[];
}

/** Presets embebidos: nombre en la config → cómo arrancarlo y qué edita. */
export const LSP_PRESETS: Record<string, LspServerPreset> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
  },
  pyright: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py'],
  },
  'rust-analyzer': {
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
  },
};

/** Lo que el usuario escribe por servidor; todo opcional si hay preset. */
export interface LspServerSettings {
  command?: string;
  args?: string[];
  extensions?: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
}

/** Servidor ya resuelto contra su preset: lo que consume el `LspManager`. */
export interface ResolvedLspServer {
  name: string;
  command: string;
  args: string[];
  /** Minúsculas y con punto delante (`.ts`), que es como se compara aquí. */
  extensions: string[];
  env: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
}

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (trimmed === '') return trimmed;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

/**
 * Resuelve la sección `lsp.servers` a servidores completos. Un nombre sin
 * preset exige `command`, y sin preset ni extensiones no hay nada que atender:
 * el schema ya lo rechaza al cargar la config, así que aquí se descarta en
 * silencio (defensivo, nunca lanza).
 */
export function resolveLspServers(servers: Record<string, LspServerSettings>): ResolvedLspServer[] {
  const resolved: ResolvedLspServer[] = [];
  for (const [name, settings] of Object.entries(servers)) {
    const preset = LSP_PRESETS[name];
    const command = settings.command ?? preset?.command;
    if (command === undefined || command === '') continue;
    resolved.push({
      name,
      command,
      args: settings.args ?? preset?.args ?? [],
      extensions: (settings.extensions ?? preset?.extensions ?? []).map(normalizeExtension),
      env: settings.env ?? {},
      ...(settings.initializationOptions === undefined
        ? {}
        : { initializationOptions: settings.initializationOptions }),
    });
  }
  return resolved;
}
