import { useState, type KeyboardEvent } from 'react';

/**
 * Entrada básica (D1): Enter envía, Shift+Enter salta de línea. Mientras el
 * asistente responde, el botón pasa a Detener (`cancel`). El InputArea completo
 * (adjuntos, slash-commands, autoexpansión) llega en D4.
 */
export function InputArea({
  disabled,
  generating,
  onSend,
  onCancel,
  placeholder = 'Escribe un mensaje…',
}: {
  /** Sin conexión o conversación sin abrir: no se puede enviar. */
  disabled: boolean;
  generating: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const canSend = !disabled && !generating && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
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
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
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
      {generating ? (
        <button type="button" className="button" onClick={onCancel}>
          Detener
        </button>
      ) : (
        <button type="submit" className="button button--primary" disabled={!canSend}>
          Enviar
        </button>
      )}
    </form>
  );
}
