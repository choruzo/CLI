import { createContext, useContext } from 'react';
import { tauriBridge, type NativeBridge } from './native';

/** El lado nativo que usan los componentes. En tests se sustituye por uno de mentira. */
const NativeContext = createContext<NativeBridge>(tauriBridge);

export const NativeProvider = NativeContext.Provider;

export function useNative(): NativeBridge {
  return useContext(NativeContext);
}
