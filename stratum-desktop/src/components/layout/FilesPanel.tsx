import { useCallback, useEffect, useState } from 'react';
import {
  canOpen,
  errorMessage,
  formatBytes,
  listWorkspaceFiles,
  openOutput,
  restoreWorkspace,
  saveOutput,
  type FolderState,
  type ListedFile,
} from '../../ipc/files';
import { ICON, StrokeIcon } from '../chat/icons';

function FileRow({ cwd, file }: { cwd: string; file: ListedFile }) {
  const [note, setNote] = useState<{ tone: 'error' | 'muted'; text: string } | null>(null);
  const run = (p: Promise<unknown>, ok?: string) =>
    p
      .then((r) => ok && r !== false && setNote({ tone: 'muted', text: ok }))
      .catch((err) => setNote({ tone: 'error', text: errorMessage(err) }));
  return (
    <li className="file-row">
      <span className="file-row__icon" aria-hidden="true">
        <StrokeIcon d={ICON.file} />
      </span>
      <span className="file-row__name" title={file.path}>
        {file.path.split('/').slice(1).join('/')}
      </span>
      <span className="file-row__size">{formatBytes(file.size)}</span>
      <span className="file-row__actions">
        <button
          type="button"
          className="icon-button"
          aria-label="Guardar"
          title="Guardar como…"
          onClick={() => run(saveOutput(cwd, file.path), 'Guardado.')}
        >
          <StrokeIcon d={ICON.download} />
        </button>
        {canOpen(file.name) && (
          <button
            type="button"
            className="icon-button"
            aria-label="Abrir"
            title="Abrir"
            onClick={() => run(openOutput(cwd, file.path))}
          >
            <StrokeIcon d={ICON.external} />
          </button>
        )}
      </span>
      {note && (
        <span className="notice file-row__note" data-tone={note.tone}>
          {note.text}
        </span>
      )}
    </li>
  );
}

/**
 * Ficheros de la conversación activa: lo que subió el usuario (`inputs/`) y lo
 * que generó el agente (`outputs/`), con guardar y abrir. Rust los lista y
 * sirve; el webview solo ve rutas del workspace.
 */
export function FilesPanel({
  cwd,
  refreshKey,
}: {
  cwd: string;
  /** Cambia cuando puede haber ficheros nuevos (turno terminado, subida…). */
  refreshKey: string;
}) {
  const [files, setFiles] = useState<ListedFile[] | null>(null);
  const [folder, setFolder] = useState<FolderState>('active');
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(() => {
    setError(null);
    listWorkspaceFiles(cwd)
      .then((listing) => {
        setFolder(listing.state);
        setFiles(listing.files);
      })
      .catch((err) => {
        setFiles([]);
        setError(errorMessage(err));
      });
  }, [cwd]);

  const restore = () => {
    setRestoring(true);
    setError(null);
    restoreWorkspace(cwd)
      .then(load)
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setRestoring(false));
  };

  useEffect(() => {
    setFiles(null);
    load();
  }, [load, refreshKey]);

  const inputs = files?.filter((f) => f.area === 'inputs') ?? [];
  const outputs = files?.filter((f) => f.area === 'outputs') ?? [];

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Ficheros</h2>
        <button type="button" className="icon-button" aria-label="Recargar" title="Recargar" onClick={load}>
          <StrokeIcon d={ICON.refresh} />
        </button>
      </div>
      <div className="side-panel__body">
        {error && (
          <p className="notice" data-tone="error" role="alert">
            {error}
          </p>
        )}
        {folder === 'archived' && (
          <div className="notice" data-tone="muted" role="status">
            <p>
              Los ficheros de esta conversación están archivados por falta de uso. Se restauran
              solos al escribir o adjuntar.
            </p>
            <button type="button" className="button" disabled={restoring} onClick={restore}>
              {restoring ? 'Restaurando…' : 'Restaurar'}
            </button>
          </div>
        )}
        {folder === 'purged' && (
          <p className="notice" data-tone="muted" role="status">
            Los ficheros de esta conversación se eliminaron por antigüedad.
          </p>
        )}
        {files && files.length === 0 && !error && folder !== 'archived' && folder !== 'purged' && (
          <p className="side-panel__empty">
            Esta conversación no tiene ficheros. Adjunta uno con el botón o soltándolo sobre la
            ventana.
          </p>
        )}
        {[
          { title: 'Subidos', items: inputs },
          { title: 'Generados', items: outputs },
        ].map(
          (g) =>
            g.items.length > 0 && (
              <section key={g.title} className="conv-group" aria-label={g.title}>
                <h3 className="conv-group__title">{g.title}</h3>
                <ul className="file-list">
                  {g.items.map((f) => (
                    <FileRow key={f.path} cwd={cwd} file={f} />
                  ))}
                </ul>
              </section>
            ),
        )}
      </div>
    </div>
  );
}
