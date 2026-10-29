import type { IExecBackend } from './backend.js';
import type { TargetKind } from './target.js';
import { localBackend } from './backends/local.js';
import { sshBackend } from './backends/ssh.js';
import { containerBackend } from './backends/container.js';

const BACKENDS: Record<TargetKind, IExecBackend> = {
  local: localBackend,
  ssh: sshBackend,
  container: containerBackend,
};

export function getExecBackend(kind: TargetKind): IExecBackend {
  return BACKENDS[kind];
}
