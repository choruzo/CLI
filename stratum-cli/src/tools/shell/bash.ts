import { z } from 'zod';
import { execa } from 'execa';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import {
  hardDenyReason,
  guardedBlockReason,
  guardedConfirmLabel,
  commandPathVerdict,
} from '../guards.js';

const schema = z.object({
  command: z.string().describe('Shell command to execute'),
  timeout: z.number().int().positive().optional().describe('Timeout in milliseconds'),
});

const SHELL: string | boolean = process.platform === 'win32' ? 'pwsh.exe' : true;

/**
 * Safety check (§12.5): detecta si un comando contiene patrones destructivos.
 * Los patrones vienen de `tools.destructivePatterns` en la config. Cada patrón
 * se busca como palabra completa (case-sensitive — `DROP`/`DELETE` apuntan a
 * SQL en mayúsculas; `rm`/`dd` a comandos shell en minúsculas).
 */
export function commandIsDestructive(command: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s;|&("'\`])${escaped}(?:$|[\\s;|&)"'\`])`);
    if (re.test(command)) return true;
  }
  return false;
}

/**
 * Veto de capas 1 y 2 (Hito 11), compartido con `ssh_exec`: lo que es
 * catastrófico en local lo es igual en un host remoto. Devuelve el motivo del
 * rechazo, o `null` si el comando pasa.
 */
export function commandVeto(
  command: string,
  guardedCommands?: Record<string, 'allow' | 'confirm' | 'block'>,
): string | null {
  const hard = hardDenyReason(command);
  if (hard) {
    return (
      `Blocked by a non-negotiable safety rule: ${hard}. ` +
      'This rule cannot be disabled by configuration or by user approval. ' +
      'Narrow the command to the specific target you actually need.'
    );
  }
  const guarded = guardedBlockReason(command, guardedCommands);
  if (guarded) {
    return (
      `Blocked by policy: ${guarded} is set to "block" in tools.guardedCommands. ` +
      'Ask the user to run it themselves, or to change that policy in .stratumrc.json.'
    );
  }
  // Capa 3 sobre el shell: sin esto, bloquear `read_file` sobre una clave no
  // sirve de nada, porque `cat` sigue disponible y el modelo encuentra el
  // rodeo solo. Mismo veredicto y mismo texto que en las tools de fichero.
  const sensitive = commandPathVerdict(command);
  if (sensitive && sensitive.tier === 'blocked') {
    return (
      `the command reads or writes "${sensitive.path}" (${sensitive.reason}). ` +
      'Credentials and private key material are never accessed by the agent, through file tools ' +
      'or through the shell, and no configuration or user approval can enable it. ' +
      'If you need a value from it, ask the user to provide just that value.'
    );
  }
  return null;
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Execute a shell command and return stdout and stderr. Timeouts after 30s by default. ' +
    'Commands matching destructive patterns (rm, dd, mkfs, DROP, ...) require user confirmation. ' +
    'A few catastrophic commands (rm -rf on / or ~, git clean -fd, mkfs, chmod -R 777, ' +
    'dd onto a block device) are rejected outright and no approval can enable them.',
  schema,
  destructive: false,
  serialized: true,
  // El timeout real lo gestiona la propia tool (bashTimeout de config o el
  // parámetro `timeout` del LLM). El del dispatcher queda alto como red de
  // seguridad para no matar comandos largos legítimos.
  timeout: 600000,

  preflight(params: unknown, ctx: ToolContext): ToolResult | null {
    const parsed = schema.safeParse(params);
    if (!parsed.success) return null;
    const veto = commandVeto(parsed.data.command, ctx.config.tools.guardedCommands);
    return veto ? { ok: false, error: veto, recoverable: false } : null;
  },

  isDestructive(params: unknown, ctx: ToolContext): boolean {
    const parsed = schema.safeParse(params);
    if (!parsed.success) return false;
    if (guardedConfirmLabel(parsed.data.command, ctx.config.tools.guardedCommands)) return true;
    // Ruta sensible del nivel `confirm` (.env, secrets/, .npmrc) tocada desde el
    // shell: mismo gate que si se hubiera pedido con read_file.
    if (
      commandPathVerdict(parsed.data.command, ctx.config.tools.sensitivePathAllowlist)?.tier ===
      'confirm'
    ) {
      return true;
    }
    return commandIsDestructive(parsed.data.command, ctx.config.tools.destructivePatterns);
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { command, timeout } = schema.parse(params);
    const timeoutMs = timeout ?? ctx.config.tools.bashTimeout;

    // On Linux/Mac, detached puts the child in its own process group so we can
    // kill the entire group (sh + its children) on timeout, preventing orphaned
    // processes from keeping the stdout/stderr pipes open indefinitely.
    const subprocess = execa(command, {
      shell: SHELL,
      cancelSignal: ctx.signal,
      all: true,
      reject: false,
      cwd: ctx.cwd,
      ...(process.platform !== 'win32' && { detached: true }),
    });

    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      const pid = subprocess.pid;
      if (pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {}
        }, 500);
      } else {
        subprocess.kill('SIGTERM');
        setTimeout(() => subprocess.kill('SIGKILL'), 500);
      }
    }, timeoutMs);

    try {
      const result = await subprocess;
      clearTimeout(timeoutId);

      if (timedOut) {
        return { ok: false, error: `Command timed out after ${timeoutMs}ms`, recoverable: true };
      }

      const output = result.all ?? result.stdout ?? '';
      const stderr = result.stderr;
      const exitCode = result.exitCode;

      let text = output;
      if (stderr && stderr !== output) text += (text ? '\n' : '') + stderr;
      if (exitCode !== 0) {
        text += `\n[exit code: ${exitCode}]`;
        return { ok: false, error: text.trim(), recoverable: true };
      }

      return { ok: true, output: text.trim() || '(no output)' };
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg, recoverable: true };
    }
  },
};
