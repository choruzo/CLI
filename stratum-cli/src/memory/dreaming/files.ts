import { dirname, join } from 'path';
import type { StratumConfig } from '../../config/schema.js';
import { resolveMemoryPaths } from '../../config/paths.js';
import { ProposalStore } from './proposals.js';
import { DreamStateStore } from './state.js';

/**
 * Las propuestas y el estado de dreaming de una memoria: junto a su
 * `decisions.json` (cada preset tiene los suyos; ninguno ve los de otro).
 */
export function openDreamingFiles(config: StratumConfig): {
  proposals: ProposalStore;
  state: DreamStateStore;
} {
  const dir = dirname(resolveMemoryPaths(config).decisionsFile);
  return {
    proposals: new ProposalStore(join(dir, 'proposals.json')),
    state: new DreamStateStore(join(dir, 'dreaming.json')),
  };
}
