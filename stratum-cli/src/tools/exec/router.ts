import type { IExecBackend } from './backend.js';
import type { TargetKind } from './target.js';
import { localBackend } from './backends/local.js';
import { sshBackend } from './backends/ssh.js';

const BACKENDS: Record<TargetKind, IExecBackend> = {
  local: localBackend,
  ssh: sshBackend,
};

export function getExecBackend(kind: TargetKind): IExecBackend {
  return BACKENDS[kind];
}
