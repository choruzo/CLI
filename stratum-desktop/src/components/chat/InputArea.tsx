import { useState, type KeyboardEvent } from 'react';
import type { Attachments } from '../../hooks/useAttachments';
import type { SentAttachment } from '../../hooks/conversation-reducer';
import { DraftChips } from './files/AttachmentChips';

/**
 * Entrada (D1 + adjuntos de D2): Enter envía, Shift+Enter salta de línea.
 * Mientras el asistente responde, el botón pasa a Detener (`cancel`). Los
 * ficheros se adjuntan con el botón o soltándolos sobre la ventana; se copian
 * al workspace en el acto, y no se puede enviar mientras alguno se copia. El
 * InputArea completo (slash-commands, autoexpansión) llega en D4.
 */
export function InputArea({
  disabled,
  generating,
  onSend,
  onCancel,
  attachments,
  placeholder = 'Escribe un mensaje…',
}: {
  /** Sin conexión o conversación sin abrir: no se puede enviar. */
  disabled: boolean;
  generating: boolean;
  onSend: (text: string, attachments: SentAttachment[]) => void;
  onCancel: () => void;
  /** Sin él (tests, sidecar sin workspaces), no hay botón de adjuntar. */
  attachments?: Attachments;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const ready = attachments?.items.filter((a) => a.status === 'ready' && a.path) ?? [];
  const hasContent = text.trim().length > 0 || ready.length > 0;
  const canSend = !disabled && !generating && !attachments?.busy && hasContent;

  const submit = () => {
    if (!canSend) return;
    onSend(
      text,
      ready.map((a) => ({ path: a.path!, name: a.name, size: a.size })),
    );
    setText('');
    attachments?.clear();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && generating) {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <form
      className="input-area"
      data-dragging={attachments?.dragging || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {attachments?.dragging && !disabled && (
        <div className="input-area__drop" aria-hidden="true">
          Suelta los ficheros para adjuntarlos
        </div>
      )}
      <div className="input-area__main">
        {attachments && <DraftChips items={attachments.items} onRemove={attachments.remove} />}
        {attachments?.error && (
          <p className="notice" data-tone="error" role="alert">
            {attachments.error}
          </p>
        )}
        <textarea
          className="input-area__text"
          aria-label="Mensaje para el asistente"
          rows={3}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="input-area__buttons">
        {attachments && (
          <button
            type="button"
            className="button"
            onClick={attachments.pick}
            disabled={disabled}
            aria-label="Adjuntar ficheros"
            title="Adjuntar ficheros"
          >
            Adjuntar
          </button>
        )}
        {generating ? (
          <button type="button" className="button" onClick={onCancel}>
            Detener
          </button>
        ) : (
          <button type="submit" className="button button--primary" disabled={!canSend}>
            Enviar
          </button>
        )}
      </div>
    </form>
  );
}
