import { StratumConfigSchema, type StratumConfig } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';

/** Config con un inventario SSH mínimo apuntando al servidor de test. */
export function configWithHost(
  alias: string,
  port: number,
  overrides: Record<string, unknown> = {},
  extraHosts: Record<string, Record<string, unknown>> = {},
): StratumConfig {
  return StratumConfigSchema.parse({
    // Hito 16: la auditoría de comandos es tools.auditLog (default true); los tests no escriben en ~/.stratum.
    tools: { auditLog: false },
    ssh: {
      hosts: {
        [alias]: {
          host: '127.0.0.1',
          port,
          user: 'tester',
          password: 'literal-irrelevante',
          hostKeyPolicy: 'insecure',
          ...overrides,
        },
        ...extraHosts,
      },
    },
  });
}

export function toolContext(
  config: StratumConfig,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: process.cwd(),
    config,
    ...overrides,
  };
}
