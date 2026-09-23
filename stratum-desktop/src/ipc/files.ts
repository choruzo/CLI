import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { WorkspaceFileInfo } from '../../../stratum-cli/src/desktop/protocol';

export type { WorkspaceFileInfo };

/**
 * Ficheros de la conversación (D2), vía los comandos de `src-tauri/src/files.rs`.
 *
 * El webview nunca maneja rutas del disco del usuario: el diálogo y el drag &
 * drop los recibe Rust, que devuelve *candidatos* con un id opaco; para
 * adjuntarlos se nombra ese id. De vuelta solo llegan rutas del workspace
 * (`inputs/informe.pdf`, `outputs/resumen.csv`).
 */

/** Un fichero elegido por el usuario, antes de copiarlo. */
export interface Candidate {
  id: string;
  name: string;
  size: number;
  /** Motivo por el que no se puede adjuntar (límite, carpeta…): no se copia. */
  error?: string;
}

/** Resultado de copiar un candidato al workspace. */
export interface Attached {
  id: string;
  name: string;
  /** Ruta en el workspace; ausente si falló. */
  path?: string;
  size: number;
  error?: string;
}

export type Preview =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'unsupported'; reason: string };

export const EVENT_DRAG = 'attachments://drag';
export const EVENT_DROPPED = 'attachments://dropped';

export function pickAttachments(): Promise<Candidate[]> {
  return invoke<Candidate[]>('attachments_pick');
}

export function addAttachments(conversationId: string, ids: string[]): Promise<Attached[]> {
  return invoke<Attached[]>('attachments_add', { conversationId, ids });
}

export function discardAttachment(conversationId: string, path: string): Promise<void> {
  return invoke('attachments_discard', { conversationId, path });
}

/** «Guardar como…» de `outputs/` o `inputs/`. `false` si el usuario canceló el diálogo. */
export function saveOutput(conversationId: string, path: string): Promise<boolean> {
  return invoke<boolean>('output_save', { conversationId, path });
}

export function openOutput(conversationId: string, path: string): Promise<void> {
  return invoke('output_open', { conversationId, path });
}

export function previewOutput(conversationId: string, path: string): Promise<Preview> {
  return invoke<Preview>('output_preview', { conversationId, path });
}

/** Un fichero de `inputs/` u `outputs/` (espejo de `ListedFile` en `workspace.rs`). */
export interface ListedFile {
  path: string;
  name: string;
  size: number;
  area: 'inputs' | 'outputs';
  modifiedMs: number;
}

export function listWorkspaceFiles(conversationId: string): Promise<ListedFile[]> {
  return invoke<ListedFile[]>('workspace_files', { conversationId });
}

/** «Descargar todo (.zip)»: `inputs/` y `outputs/`. `false` si el usuario canceló. */
export function exportWorkspace(conversationId: string): Promise<boolean> {
  return invoke<boolean>('workspace_export', { conversationId });
}

export function onDragState(cb: (active: boolean) => void): Promise<UnlistenFn> {
  return listen<{ active: boolean }>(EVENT_DRAG, (e) => cb(e.payload.active === true));
}

export function onDropped(cb: (candidates: Candidate[]) => void): Promise<UnlistenFn> {
  return listen<Candidate[]>(EVENT_DROPPED, (e) =>
    cb(Array.isArray(e.payload) ? e.payload.filter(isCandidate) : []),
  );
}

function isCandidate(v: unknown): v is Candidate {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.name === 'string' && typeof c.size === 'number';
}

const ext = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/**
 * Espejo de `OPENABLE_EXTENSIONS` en `workspace.rs`, solo para decidir si se
 * muestra «Abrir». Quien decide de verdad es Rust.
 */
const OPENABLE = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'pdf', 'png',
  'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf',
]);
const PREVIEWABLE = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'png', 'jpg',
  'jpeg', 'gif', 'webp', 'bmp',
]);

export const canOpen = (name: string): boolean => OPENABLE.has(ext(name));
export const canPreview = (name: string): boolean => PREVIEWABLE.has(ext(name));
export const previewFormat = (name: string): 'markdown' | 'csv' | 'tsv' | 'plain' => {
  const e = ext(name);
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'csv') return 'csv';
  if (e === 'tsv') return 'tsv';
  return 'plain';
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
