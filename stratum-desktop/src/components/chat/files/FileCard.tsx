import { useState } from 'react';
import {
  canOpen,
  canPreview,
  errorMessage,
  formatBytes,
  openOutput,
  previewFormat,
  previewOutput,
  saveOutput,
  type Preview,
  type WorkspaceFileInfo,
} from '../../../ipc/files';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';
import { parseDelimited } from './csv';

/** Tipo legible a partir del mime: lo que se ve en la tarjeta. */
export function kindLabel(file: WorkspaceFileInfo): string {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase() : '';
  if (file.mime.startsWith('image/')) return `Imagen ${ext}`.trim();
  if (file.mime === 'text/csv') return 'CSV';
  if (file.mime === 'text/markdown') return 'Markdown';
  if (file.mime === 'application/pdf') return 'PDF';
  return ext || 'Fichero';
}

function PreviewBody({ name, preview }: { name: string; preview: Preview }) {
  if (preview.kind === 'unsupported') {
    return <p className="notice">{preview.reason}</p>;
  }
  if (preview.kind === 'image') {
    return <img className="file-card__image" src={preview.dataUrl} alt={`Vista previa de ${name}`} />;
  }
  const format = previewFormat(name);
  const truncated = preview.truncated && (
    <p className="notice">Vista previa recortada: guarda el fichero para verlo entero.</p>
  );
  if (format === 'markdown') {
    return (
      <>
        <div className="file-card__markdown">
          <MarkdownRenderer text={preview.text} />
        </div>
        {truncated}
      </>
    );
  }
  if (format === 'csv' || format === 'tsv') {
    const rows = parseDelimited(preview.text, format === 'csv' ? ',' : '\t');
    const [head, ...body] = rows;
    return (
      <>
        <div className="file-card__table-wrap">
          <table className="file-card__table">
            {head && (
              <thead>
                <tr>
                  {head.map((cell, i) => (
                    <th key={i}>{cell}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {truncated}
      </>
    );
  }
  return (
    <>
      <pre className="tool-call__pre">{preview.text}</pre>
      {truncated}
    </>
  );
}

/**
 * Tarjeta de un fichero que el agente dejó en `outputs/` (D2): nombre, tamaño y
 * tipo, con «Guardar como…», «Abrir» (solo tipos inertes) y vista previa.
 */
export function FileCard({
  conversationId,
  file,
}: {
  conversationId: string;
  file: WorkspaceFileInfo;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ tone: 'error' | 'muted'; text: string } | null>(null);

  const run = (action: () => Promise<unknown>, done?: string) => {
    setStatus(null);
    action()
      .then((result) => {
        if (done && result !== false) setStatus({ tone: 'muted', text: done });
      })
      .catch((err) => setStatus({ tone: 'error', text: errorMessage(err) }));
  };

  const togglePreview = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!preview) {
      previewOutput(conversationId, file.path)
        .then(setPreview)
        .catch((err) => setPreview({ kind: 'unsupported', reason: errorMessage(err) }));
    }
  };

  return (
    <div className="file-card">
      <div className="file-card__row">
        <span className="file-card__icon" aria-hidden="true">
          ▤
        </span>
        <span className="file-card__meta">
          <span className="file-card__name">{file.name}</span>
          <span className="file-card__detail">
            {kindLabel(file)} · {formatBytes(file.size)}
          </span>
        </span>
        <span className="file-card__actions">
          {canPreview(file.name) && (
            <button type="button" className="button" aria-expanded={open} onClick={togglePreview}>
              {open ? 'Ocultar' : 'Vista previa'}
            </button>
          )}
          {canOpen(file.name) && (
            <button
              type="button"
              className="button"
              onClick={() => run(() => openOutput(conversationId, file.path))}
            >
              Abrir
            </button>
          )}
          <button
            type="button"
            className="button button--primary"
            onClick={() => run(() => saveOutput(conversationId, file.path), 'Guardado.')}
          >
            Guardar como…
          </button>
        </span>
      </div>
      {status && (
        <p className="notice" data-tone={status.tone} role={status.tone === 'error' ? 'alert' : undefined}>
          {status.text}
        </p>
      )}
      {open && (
        <div className="file-card__preview">
          {preview ? <PreviewBody name={file.name} preview={preview} /> : <p className="notice">Cargando…</p>}
        </div>
      )}
    </div>
  );
}
