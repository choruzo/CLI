import { create } from 'zustand';
import type { AppInfo, ConnectionState } from '../bridge/native';

/** Estado de la conexión con el daemon. Lo dicta el lado nativo; aquí solo se guarda. */
interface ConnectionStore {
  state: ConnectionState;
  info: AppInfo | null;
  /** Versión del último daemon con el que se conectó (se conserva al reconectar). */
  lastServerVersion: string | null;
  setState(state: ConnectionState): void;
  setInfo(info: AppInfo): void;
}

export const useConnection = create<ConnectionStore>((set) => ({
  state: { kind: 'starting' },
  info: null,
  lastServerVersion: null,
  setState: (state) =>
    set((prev) => ({
      state,
      lastServerVersion: state.kind === 'connected' ? state.serverVersion : prev.lastServerVersion,
    })),
  setInfo: (info) => set({ info }),
}));

export function canControl(state: ConnectionState): boolean {
  return state.kind === 'connected' && state.capabilities.includes('control');
}
