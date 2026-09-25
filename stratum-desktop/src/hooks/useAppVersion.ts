import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

/** Versión de la app instalada (la de `tauri.conf.json`); `null` hasta saberla o fuera de Tauri. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return version;
}
