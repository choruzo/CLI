import { useEffect, useRef, useState } from 'react';
import { subscribeSidecarFrames } from '../ipc/bridge';
import { notify, setGlobalHotkey } from '../ipc/os';
import type { DesktopOsPrefs, SidecarFrame } from '../ipc/types';
import { configApplied, configSnapshot, isRecord, osPrefs } from '../ipc/validate';
import { TurnWatch, notificationText } from './turn-notifications';
import { post } from './useAgentStream';

/**
 * Integración con el SO (D6). Lo que decide vive en el `.stratumrc.json` que
 * gestiona el sidecar, así que en cada conexión se pide la config (`config_get`)
 * y después se sigue cada `config_state` (guardado en Ajustes o cambio desde la
 * CLI), aunque el panel de Ajustes esté cerrado:
 *
 * - `desktop.globalHotkey` se registra en Rust. Hasta la primera respuesta,
 *   Rust mantiene el atajo por defecto.
 * - `desktop.notifications`: `TurnWatch` decide qué merece aviso y Rust si la
 *   ventana está a la vista.
 * - `applied.providerReady` decide el onboarding del primer arranque.
 */

export interface DesktopOs {
  /** Ya llegó la config del sidecar en esta sesión. */
  loaded: boolean;
  /** Hay un provider por defecto utilizable. */
  providerReady: boolean;
  /** La config en uso cargó bien (si no, la app ya muestra el error). */
  configOk: boolean;
  /** Existe el `.stratumrc.json` global. */
  configExists: boolean;
  prefs: DesktopOsPrefs;
  /** El atajo configurado no se pudo registrar (lo usa otra aplicación…). */
  hotkeyError: string | null;
}

const INITIAL: Omit<DesktopOs, 'hotkeyError'> = {
  loaded: false,
  providerReady: true,
  configOk: true,
  configExists: true,
  prefs: osPrefs(undefined),
};

export function useDesktopOs(
  connected: boolean,
  activeId: string,
  titleOf: (conversationId: string) => string | null,
): DesktopOs {
  const [state, setState] = useState(INITIAL);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const prefsRef = useRef(state.prefs);
  prefsRef.current = state.prefs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const titleRef = useRef(titleOf);
  titleRef.current = titleOf;
  const watchRef = useRef(new TurnWatch());

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const watch = watchRef.current;
    const onFrame = (frame: SidecarFrame) => {
      if (disposed) return;
      const f = frame as unknown as Record<string, unknown>;
      if (!isRecord(f)) return;
      if (f.type === 'config_state') {
        const applied = configApplied(f.applied);
        const snapshot = configSnapshot(f.snapshot);
        if (!applied) return;
        setState({
          loaded: true,
          providerReady: applied.providerReady,
          configOk: applied.ok,
          configExists: snapshot?.exists ?? true,
          prefs: applied.os,
        });
        return;
      }
      const prefs = prefsRef.current.notifications;
      const req = watch.onFrame(f, Date.now(), prefs.minSeconds);
      if (!req || !prefs.enabled) return;
      const { title, body } = notificationText(req, titleRef.current(req.conversationId));
      void notify(title, body, req.conversationId === activeRef.current);
    };
    void subscribeSidecarFrames(onFrame).then((u) => {
      if (disposed) u();
      else unsubscribe = u;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  // Cada conexión (también tras reiniciar el agente): la config vigente. Al
  // perderla, los turnos en vuelo no van a terminar.
  useEffect(() => {
    if (connected) post({ type: 'config_get' });
    else watchRef.current.reset();
  }, [connected]);

  // El atajo configurado, en cuanto se conoce y cada vez que cambia.
  const { loaded } = state;
  const hotkey = state.prefs.globalHotkey;
  useEffect(() => {
    if (!loaded) return;
    let stale = false;
    setGlobalHotkey(hotkey).then(
      () => !stale && setHotkeyError(null),
      (err) => !stale && setHotkeyError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      stale = true;
    };
  }, [loaded, hotkey]);

  return { ...state, hotkeyError };
}
