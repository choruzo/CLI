import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { expandEnvVars } from '../config/loader.js';
import { fetchModels } from '../providers/utils.js';
import { getLogger } from '../logging/index.js';
import { ConfigPanel, sameOrigin } from './config-panel.js';
import type { WorkspaceJanitor } from './retention.js';
import { resolveWorkspaceSettings, type WorkspaceManager } from './workspace.js';
import {
  SECRET_PLACEHOLDER,
  type ConfigApplied,
  type DesktopOsPrefs,
  type ConfigGetFrame,
  type ConfigSaveFrame,
  type ConfigValidateFrame,
  type RetentionRunFrame,
  type WorkspacesUsageGetFrame,
  type ConfigStateFrame,
  type ConversationOutboundFrame,
  type ProviderProbeFrame,
  type SidecarErrorFrame,
} from './protocol.js';

const log = getLogger('desktop.settings');

export type SettingsFrame =
  | ConfigGetFrame
  | ConfigValidateFrame
  | ConfigSaveFrame
  | ProviderProbeFrame
  | RetentionRunFrame
  | WorkspacesUsageGetFrame;

export interface DesktopSettingsOptions {
  panel: ConfigPanel;
  /** Config efectiva (global + capas), como al arrancar (`loadSharedConfig`). */
  load: () => { config: StratumConfig; error: SidecarErrorFrame | null };
  /** Pone en marcha una config efectiva nueva (conversaciones, cola, retención). */
  apply: (config: StratumConfig) => void;
  /** Config con la que arrancó el sidecar: lo que no cambia en caliente se compara con ella. */
  startup: StratumConfig;
  /** Error de config al arrancar, si lo hubo. */
  startupError?: SidecarErrorFrame | null;
  /** Datos de Desktop (resolución de la raíz de workspaces por defecto). */
  dataDir: string;
  workspaces?: WorkspaceManager;
  janitor?: WorkspaceJanitor;
  /** Sondeo de `/models` (tests). */
  probe?: (baseUrl: string, apiKey: string) => Promise<string[]>;
  debounceMs?: number;
}

type Send = (frame: ConversationOutboundFrame) => void;

/** Preferencias del sistema (D6) de una config efectiva. */
export function osPrefsOf(config: StratumConfig): DesktopOsPrefs {
  return {
    notifications: {
      enabled: config.desktop.notifications.enabled,
      minSeconds: config.desktop.notifications.minSeconds,
    },
    globalHotkey: config.desktop.globalHotkey.trim(),
    updates: { autoCheck: config.desktop.updates.autoCheck },
  };
}

/** ¿Hay un provider por defecto que exista? Sin él no se puede conversar (D6: onboarding). */
export function hasUsableProvider(config: StratumConfig): boolean {
  const p = config.provider;
  return (
    !!p && p.default.length > 0 && Object.prototype.hasOwnProperty.call(p.providers, p.default)
  );
}

function appliedFor(config: StratumConfig): Pick<ConfigApplied, 'os' | 'providerReady'> {
  return { os: osPrefsOf(config), providerReady: hasUsableProvider(config) };
}

/**
 * Panel de Ajustes de Stratum Desktop en el sidecar (D5, 15.7): lee y guarda el
 * `.stratumrc.json` global y pone en marcha la config resultante, tanto si la
 * guarda la app como si cambia en disco (la CLI, otro editor).
 *
 * Aplicar nunca deja al sidecar sin config: si la nueva no carga, se sigue con
 * la anterior y `config_state.applied` dice por qué. Lo que no se puede cambiar
 * en caliente (raíz y límites de los workspaces, que Rust recibe en el
 * handshake, y el logging) queda en `restartRequired` hasta reiniciar el agente.
 */
export class DesktopSettings {
  private send: Send = () => undefined;
  private applied: ConfigApplied;
  private stopWatching: (() => void) | null = null;
  private readonly defaults: Record<string, unknown>;

  constructor(private readonly opts: DesktopSettingsOptions) {
    this.applied = {
      ok: !opts.startupError,
      error: opts.startupError?.message ?? null,
      restartRequired: [],
      // Con error de arranque, `startup` son los defaults: sin provider.
      ...appliedFor(opts.startup),
    };
    this.defaults = StratumConfigSchema.parse({}) as unknown as Record<string, unknown>;
  }

  /** Salida hacia el cliente activo (la pone el host). */
  attach(send: Send): void {
    this.send = send;
  }

  start(): void {
    this.stopWatching ??= this.opts.panel.watch(
      () => this.onExternalChange(),
      this.opts.debounceMs,
    );
  }

  stop(): void {
    this.stopWatching?.();
    this.stopWatching = null;
  }

  get appliedState(): ConfigApplied {
    return this.applied;
  }

  async handle(frame: SettingsFrame): Promise<void> {
    switch (frame.type) {
      case 'config_get':
        this.emitState('requested');
        return;
      case 'config_validate': {
        const { issues } = this.opts.panel.validate(frame.text);
        this.send({ type: 'config_validation', requestId: frame.requestId, issues });
        return;
      }
      case 'config_save':
        this.save(frame);
        return;
      case 'provider_probe':
        await this.probe(frame);
        return;
      case 'workspaces_usage_get':
        this.emitUsage();
        return;
      case 'retention_run':
        await this.runRetention();
        return;
    }
  }

  private state(reason: ConfigStateFrame['reason']): ConfigStateFrame {
    return {
      type: 'config_state',
      reason,
      snapshot: this.opts.panel.snapshot(),
      applied: this.applied,
      defaults: this.defaults,
    };
  }

  private emitState(reason: ConfigStateFrame['reason']): void {
    try {
      this.send(this.state(reason));
    } catch (err) {
      this.send({
        type: 'config_error',
        message: `No se pudo leer la configuración: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private save(frame: ConfigSaveFrame): void {
    let result: ReturnType<ConfigPanel['save']>;
    try {
      result = this.opts.panel.save(frame.text, frame.baseHash, frame.force === true);
    } catch (err) {
      this.send({
        type: 'config_error',
        message: `No se pudo guardar la configuración: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    switch (result.kind) {
      case 'conflict':
        this.send({ type: 'config_conflict', snapshot: this.opts.panel.snapshot() });
        return;
      case 'invalid':
        this.send({ type: 'config_invalid', issues: result.issues });
        return;
      case 'read_only':
        this.send({ type: 'config_error', message: result.message });
        return;
      case 'saved':
        log.info('config saved from desktop', { path: this.opts.panel.path });
        this.send({ type: 'config_saved', hash: result.hash });
        this.reload();
        this.emitState('saved');
        return;
    }
  }

  private onExternalChange(): void {
    log.info('config changed on disk', { path: this.opts.panel.path });
    this.reload();
    this.emitState('external');
  }

  /** Recarga la config efectiva y la aplica. Nunca lanza. */
  reload(): void {
    const { config, error } = this.opts.load();
    if (error) {
      log.warn('config reload failed; keeping the previous one', { msg: error.message });
      this.applied = { ...this.applied, ok: false, error: error.message };
      return;
    }
    try {
      this.opts.apply(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('config apply failed', { err });
      this.applied = { ...this.applied, ok: false, error: message };
      return;
    }
    this.applied = {
      ok: true,
      error: null,
      restartRequired: this.restartRequired(config),
      ...appliedFor(config),
    };
  }

  /** Diferencias con la config de arranque que solo se aplican reiniciando el agente. */
  private restartRequired(config: StratumConfig): string[] {
    const out: string[] = [];
    const before = resolveWorkspaceSettings(this.opts.startup, this.opts.dataDir).settings;
    const after = resolveWorkspaceSettings(config, this.opts.dataDir).settings;
    if (before.root !== after.root) out.push('Carpeta de los espacios de trabajo');
    if (before.maxFileBytes !== after.maxFileBytes) out.push('Tamaño máximo por fichero');
    if (before.maxWorkspaceBytes !== after.maxWorkspaceBytes) {
      out.push('Tamaño máximo por espacio de trabajo');
    }
    if (JSON.stringify(this.opts.startup.logging) !== JSON.stringify(config.logging)) {
      out.push('Registro (logging)');
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // ProviderWizard y selector de modelo
  // -------------------------------------------------------------------------

  private async probe(frame: ProviderProbeFrame): Promise<void> {
    const reply = (models: string[], error?: string) =>
      this.send({
        type: 'provider_probe_result',
        requestId: frame.requestId,
        models,
        ...(error ? { error } : {}),
      });
    const baseUrl = String(expandEnvVars(frame.baseUrl)).trim();
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      reply([], 'URL inválida (ej. http://localhost:11434/v1)');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reply([], 'Solo se admiten URLs http:// o https://');
      return;
    }
    let apiKey = frame.apiKey;
    if (apiKey === undefined || apiKey === SECRET_PLACEHOLDER) {
      // La key guardada no sale del sidecar, y solo viaja al servidor para el
      // que se guardó: si no, cambiar la URL en el wizard bastaría para
      // mandarla a cualquier sitio.
      const stored = frame.provider ? this.opts.panel.storedProvider(frame.provider) : null;
      if (stored && stored.apiKey && !sameOrigin(stored.baseUrl, baseUrl)) {
        reply([], 'La URL es de otro servidor: escribe la API key para esta URL.');
        return;
      }
      apiKey = stored && sameOrigin(stored.baseUrl, baseUrl) ? stored.apiKey : '';
    }
    try {
      const models = await (this.opts.probe ?? fetchModels)(baseUrl, String(expandEnvVars(apiKey)));
      if (models.length === 0) reply([], 'El endpoint /models no devolvió modelos');
      else reply(models);
    } catch (err) {
      reply([], err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // Espacios de trabajo
  // -------------------------------------------------------------------------

  private emitUsage(): void {
    const manager = this.opts.workspaces;
    if (!manager) return;
    try {
      this.send({ type: 'workspaces_usage', root: manager.root, ...manager.usage() });
    } catch (err) {
      this.send({
        type: 'config_error',
        message: `No se pudo medir el uso de disco: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async runRetention(): Promise<void> {
    const janitor = this.opts.janitor;
    if (!janitor) return;
    if (!janitor.enabled) {
      this.send({
        type: 'retention_report',
        archived: 0,
        purged: 0,
        inUse: 0,
        failed: 0,
        disabled: true,
      });
      return;
    }
    const report = await janitor.runOnce();
    this.send({
      type: 'retention_report',
      archived: report.archived.length,
      purged: report.purged.length,
      inUse: report.inUse.length,
      failed: report.failed.length,
      disabled: false,
    });
    this.emitUsage();
  }
}
