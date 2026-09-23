import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { Attachments } from '../../hooks/useAttachments';
import type { SentAttachment } from '../../hooks/conversation-reducer';
import { DraftChips } from './files/AttachmentChips';
import { matchCommands, parseCommand, type CommandName, type SlashCommand } from './commands';

/** Alto máximo del textarea antes de hacer scroll (px). */
const MAX_HEIGHT = 240;

export interface InputAreaHandle {
  focus: () => void;
}

/**
 * Entrada del chat (D1 + adjuntos de D2 + D4): Enter envía, Shift+Enter salta
 * de línea y el textarea crece con el texto. Escribir `/` abre el menú de
 * comandos (↑↓ para elegir, Enter o Tab para completar, Escape para cerrar).
 * Mientras el asistente responde, el botón pasa a Detener (`cancel`).
 */
export const InputArea = forwardRef<
  InputAreaHandle,
  {
    /** Sin conexión o conversación sin abrir: no se puede enviar. */
    disabled: boolean;
    generating: boolean;
    onSend: (text: string, attachments: SentAttachment[]) => void;
    onCancel: () => void;
    /** Un slash-command válido; sin él, no hay menú de comandos. */
    onCommand?: (name: CommandName, arg: string) => void;
    /** Sin él (tests, sidecar sin workspaces), no hay botón de adjuntar. */
    attachments?: Attachments;
    placeholder?: string;
  }
>(function InputArea(
  { disabled, generating, onSend, onCancel, onCommand, attachments, placeholder = 'Escribe un mensaje…' },
  ref,
) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  // Autoexpansión: el alto sigue al contenido hasta MAX_HEIGHT.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // `scrollHeight` no incluye el borde, y con `border-box` sí cuenta en la altura.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, MAX_HEIGHT)}px`;
  }, [text]);

  const matches = onCommand && !menuClosed ? matchCommands(text) : null;
  const menu = matches && matches.length > 0 ? matches : null;
  useEffect(() => setSelected(0), [menu?.length]);

  const ready = attachments?.items.filter((a) => a.status === 'ready' && a.path) ?? [];
  const hasContent = text.trim().length > 0 || ready.length > 0;
  const isCommand = onCommand !== undefined && parseCommand(text) !== null;
  const canSend =
    !disabled && (isCommand || (!generating && !attachments?.busy && hasContent));

  const runCommand = (name: CommandName, arg: string) => {
    setText('');
    setCommandError(null);
    onCommand?.(name, arg);
  };

  const submit = () => {
    if (!canSend) return;
    const parsed = onCommand ? parseCommand(text) : null;
    if (parsed) {
      if (!parsed.ok) {
        setCommandError(parsed.error);
        return;
      }
      runCommand(parsed.name, parsed.arg);
      return;
    }
    onSend(
      text,
      ready.map((a) => ({ path: a.path!, name: a.name, size: a.size })),
    );
    setText('');
    attachments?.clear();
  };

  const choose = (cmd: SlashCommand) => {
    if (cmd.args) {
      setText(`/${cmd.name} `);
      setMenuClosed(true);
      textareaRef.current?.focus();
    } else {
      runCommand(cmd.name, '');
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menu) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((i) => (i + delta + menu.length) % menu.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const cmd = menu[Math.min(selected, menu.length - 1)]!;
        // Enter sobre un comando ya escrito entero lo ejecuta tal cual (`/model`
        // sin argumento abre el selector); Tab siempre completa.
        if (e.key === 'Enter' && text.trim().toLowerCase() === `/${cmd.name}`) runCommand(cmd.name, '');
        else choose(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenuClosed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && generating) {
      e.preventDefault();
      e.stopPropagation();
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
      {menu && (
        <ul className="slash-menu" role="listbox" aria-label="Comandos">
          {menu.map((cmd, i) => (
            <li
              key={cmd.name}
              role="option"
              aria-selected={i === selected}
              className="slash-menu__item"
              onMouseDown={(e) => {
                e.preventDefault();
                choose(cmd);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="slash-menu__name">
                /{cmd.name}
                {cmd.args && <span className="slash-menu__args"> {cmd.args}</span>}
              </span>
              <span className="slash-menu__description">{cmd.description}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="input-area__main">
        {attachments && <DraftChips items={attachments.items} onRemove={attachments.remove} />}
        {attachments?.error && (
          <p className="notice" data-tone="error" role="alert">
            {attachments.error}
          </p>
        )}
        {commandError && (
          <p className="notice" data-tone="warning" role="alert">
            {commandError}
          </p>
        )}
        <textarea
          ref={textareaRef}
          className="input-area__text"
          aria-label="Mensaje para el asistente"
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setMenuClosed(false);
            setCommandError(null);
          }}
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
        {generating && !isCommand ? (
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
});
