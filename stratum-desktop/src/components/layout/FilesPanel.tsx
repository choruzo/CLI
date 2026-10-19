import { useCallback, useEffect, useState } from 'react';
import {
  canOpen,
  errorMessage,
  formatBytes,
  listWorkspaceFiles,
  openOutput,
  saveOutput,
  type ListedFile,
} from '../../ipc/files';

function FileRow({ cwd, file }: { cwd: string; file: ListedFile }) {
  const [note, setNote] = useState<{ tone: 'error' | 'muted'; text: string } | null>(null);
  const run = (p: Promise<unknown>, ok?: string) =>
    p
      .then((r) => ok && r !== false && setNote({ tone: 'muted', text: ok }))
      .catch((err) => setNote({ tone: 'error', text: errorMessage(err) }));
  return (
    <li className="file-row">
      <span className="file-row__name" title={file.path}>
        {file.path.split('/').slice(1).join('/')}
      </span>
      <span className="file-row__size">{formatBytes(file.size)}</span>
      <span className="file-row__actions">
        <button
          type="button"
          className="button"
          onClick={() => run(saveOutput(cwd, file.path), 'Guardado.')}
        >
          Guardar
        </button>
        {canOpen(file.name) && (
          <button
            type="button"
            className="button"
            onClick={() => run(openOutput(cwd, file.path))}
          >
            Abrir
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listWorkspaceFiles(cwd)
      .then(setFiles)
      .catch((err) => {
        setFiles([]);
        setError(errorMessage(err));
      });
  }, [cwd]);

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
        <button type="button" className="button" onClick={load}>
          Recargar
        </button>
      </div>
      <div className="side-panel__body">
        {error && (
          <p className="notice" data-tone="error" role="alert">
            {error}
          </p>
        )}
        {files && files.length === 0 && !error && (
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
