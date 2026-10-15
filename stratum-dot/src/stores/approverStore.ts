import { create } from 'zustand';
import type { ApproverStatus } from '../bridge/native';

/**
 * Estado de la autoridad de aprobar. Lo dicta el broker nativo; aquí solo se
 * guarda para pintarlo. No hay nada más que guardar: la clave no pasa por el
 * webview, y desbloquear es abrir una ventana nativa.
 */
interface ApproverStore {
  status: ApproverStatus;
  setStatus(status: ApproverStatus): void;
}

export const useApprover = create<ApproverStore>((set) => ({
  status: { kind: 'unavailable', reason: 'not-connected' },
  setStatus: (status) => set({ status }),
}));

export function canResolve(status: ApproverStatus): boolean {
  return status.kind === 'ready';
}
