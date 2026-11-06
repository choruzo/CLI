/**
 * Tipos de los ajustes editables (`src-tauri/src/settings.rs`). Sin imports: lo
 * que el lado nativo manda al webview, ya con los secretos enmascarados. El
 * nivel de cada clave (A libre, B con confirmación nativa) lo decide Rust; aquí
 * solo se pinta.
 */

/** A: libre. B: pide la ventana de confirmación nativa. */
export type SettingsLevel = 'A' | 'B';

/** Qué hay que reiniciar para que un cambio surta efecto. */
export type SettingsRestart = 'session' | 'daemon' | 'app';

export type SettingsKind =
  | 'bool'
  | 'enum'
  | 'int'
  | 'number'
  | 'text'
  | 'url'
  | 'secret'
  | 'autoInt'
  | 'alias'
  | 'color'
  | 'path';

/** Un secreto: si está y de dónde sale. Nunca su valor. */
export interface SecretView {
  set: boolean;
  /** Si es `${VAR}`: el nombre de la variable (no es secreto). */
  envVar: string | null;
}

export type SettingsValue = string | number | boolean | null;

export interface SettingsField {
  path: string;
  label: string;
  hint: string;
  kind: SettingsKind;
  options: string[];
  min: number | null;
  max: number | null;
  level: SettingsLevel;
  /** El valor efectivo; `null` en un secreto. */
  value: SettingsValue;
  default: SettingsValue;
  isDefault: boolean;
  restart: SettingsRestart;
  secret: SecretView | null;
  /** Por qué no se puede editar aquí, si es el caso. */
  locked: string | null;
}

export interface SettingsSection {
  id: string;
  title: string;
  intro: string;
  fields: SettingsField[];
}

export interface SettingsProvider {
  alias: string;
  isDefault: boolean;
  baseUrl: string | null;
  model: string;
  contextWindow: number | null;
  apiKey: SecretView;
}

/** Cómo se pinta y de qué nivel es cada campo de un provider. */
export interface ProviderFieldMeta {
  name: 'baseUrl' | 'model' | 'contextWindow' | 'apiKey';
  label: string;
  hint: string;
  kind: SettingsKind;
  min: number | null;
  max: number | null;
  level: SettingsLevel;
}

export interface SettingsCliOnly {
  title: string;
  /** Hay algo definido en el fichero. Nunca se dice qué. */
  present: boolean;
}

export interface SettingsView {
  configPath: string;
  state: 'ready' | 'readOnly';
  reason: string | null;
  /** `ok` · `missing` · `outdated` · `broken` · `newer`. */
  cli: string;
  defaultProvider: string | null;
  providers: SettingsProvider[];
  providerFields: ProviderFieldMeta[];
  sections: SettingsSection[];
  cliOnly: SettingsCliOnly[];
}

export interface SettingsChange {
  view: SettingsView;
  /** `false`: ya valía eso, no se escribió nada. */
  changed: boolean;
  restart: SettingsRestart | null;
}

export interface NewProviderInput {
  alias: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  makeDefault: boolean;
}

/** Lo que hay que decir para que un cambio surta efecto. */
export const RESTART_NOTES: Record<SettingsRestart, string> = {
  session: 'Se aplica en las sesiones nuevas.',
  daemon:
    'Para que se aplique, reinicia el daemon: `stratum daemon stop` (Desktop lo vuelve a arrancar al reconectar).',
  app: 'Vuelve a abrir Desktop para que se aplique.',
};
