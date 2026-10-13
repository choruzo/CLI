import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useOpenChat } from '../app/actions';
import { useNative } from '../bridge/context';
import type { OpenSessionRequest } from '../bridge/native';
import type { ProtocolAgent, ProtocolModel } from '../protocol';
import { parseAgents, parseModels } from '../protocol/results';
import { useUi } from '../stores/uiStore';

const modelKeyOf = (model: ProtocolModel): string => `${model.provider}/${model.id}`;

interface Props {
  /** Hay conexión y este Dot puede abrir sesiones. */
  canOpen: boolean;
  /** Cierra el formulario sin abrir nada. */
  onCancel(): void;
}

/**
 * Chat nuevo: una sesión **alojada en el daemon**. Todo es opcional —sin tocar
 * nada, el daemon usa su directorio y su configuración por defecto—, y lo que
 * se puede elegir (perfiles, modelos) es lo que el daemon dice que hay: Dot no
 * lee ninguna configuración.
 *
 * El directorio es un texto: quien comprueba que existe es el daemon.
 */
export function NewChat({ canOpen, onCancel }: Props) {
  const native = useNative();
  const open = useOpenChat();
  const [cwd, setCwd] = useState(() => useUi.getState().lastCwd);
  const [agent, setAgent] = useState('');
  /** `provider/id`: no un índice, que cambiaría de significado si la lista se recarga. */
  const [modelKey, setModelKey] = useState('');
  const [message, setMessage] = useState('');
  const [agents, setAgents] = useState<ProtocolAgent[]>([]);
  const [models, setModels] = useState<ProtocolModel[]>([]);
  const [modelsIncomplete, setModelsIncomplete] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const agentsRequest = useRef(0);

  useEffect(() => {
    alive.current = true;
    first.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  // Qué se puede elegir lo dice el daemon. Si no contesta, quedan los valores por defecto.
  useEffect(() => {
    if (!canOpen) return;
    void native
      .listModels()
      .then((raw) => {
        const list = parseModels(raw);
        if (!alive.current || !list) return;
        setModels(list.models);
        setModelsIncomplete(list.incomplete);
        // Un modelo elegido que ya no se ofrece vuelve al valor por defecto.
        setModelKey((key) => (list.models.some((m) => modelKeyOf(m) === key) ? key : ''));
      })
      .catch(() => undefined);
  }, [native, canOpen]);

  const loadAgents = (directory: string) => {
    if (!canOpen) return;
    const request = ++agentsRequest.current;
    void native
      .listAgents(directory.trim() || undefined)
      .then((raw) => {
        const list = parseAgents(raw);
        // Una respuesta de un directorio anterior no pisa a la del actual.
        if (!alive.current || !list || request !== agentsRequest.current) return;
        // Solo los que valen como agente principal de una sesión.
        const usable = list.filter((a) => a.mode !== 'subagent' && a.name !== 'general');
        setAgents(usable);
        // Un perfil de otro directorio que aquí no existe no se envía a escondidas.
        setAgent((name) => (usable.some((a) => a.name === name) ? name : ''));
      })
      .catch(() => undefined);
  };
  // Al abrir el formulario (y al recuperar la conexión); después, al salir del campo.
  useEffect(() => loadAgents(cwd), [canOpen]);

  const defaultModel = models.find((m) => m.default);

  const submit = async () => {
    if (creating || !canOpen) return;
    setError(null);
    setCreating(true);
    const chosen = models.find((m) => modelKeyOf(m) === modelKey);
    const request: OpenSessionRequest = {
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      ...(agent ? { agent } : {}),
      ...(chosen ? { provider: chosen.provider, model: chosen.id } : {}),
    };
    const outcome = await open(request, message, () => alive.current);
    if (!alive.current) return;
    setCreating(false);
    // Si no se abrió, no queda nada a medias: ni sesión en la lista ni selección.
    if (!outcome.ok) setError(outcome.message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <section className="detail newchat" aria-label="New chat">
      <button type="button" className="btn ghost back" onClick={onCancel} aria-label="Back to sessions">
        ← Sessions
      </button>
      <h2>New chat</h2>
      <p className="muted small">
        Starts a new session hosted by the Stratum daemon. It keeps running if you close Dot, and ends when the daemon
        stops.
      </p>
      <form
        className="newchat-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>Message</span>
          <textarea
            ref={first}
            rows={3}
            value={message}
            placeholder="Ask Stratum…"
            aria-label="First message"
            disabled={creating}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <label>
          <span>Directory</span>
          <input
            type="text"
            className="mono"
            value={cwd}
            placeholder="Daemon default (your home directory)"
            aria-label="Working directory"
            spellCheck={false}
            disabled={creating}
            onChange={(event) => setCwd(event.target.value)}
            onBlur={() => loadAgents(cwd)}
          />
        </label>
        <div className="newchat-row">
          <label>
            <span>Agent</span>
            <select value={agent} aria-label="Agent" disabled={creating} onChange={(event) => setAgent(event.target.value)}>
              <option value="">Default</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name} title={a.description}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select
              value={modelKey}
              aria-label="Model"
              disabled={creating}
              onChange={(event) => setModelKey(event.target.value)}
            >
              <option value="">Default{defaultModel ? ` (${defaultModel.id})` : ''}</option>
              {models.map((m) => (
                <option key={modelKeyOf(m)} value={modelKeyOf(m)}>
                  {m.id} · {m.provider}
                </option>
              ))}
            </select>
          </label>
        </div>
        {modelsIncomplete ? (
          <p className="muted small">Some providers did not answer: the model list may be incomplete.</p>
        ) : null}
        {error ? (
          <p className="note bad" role="alert">
            {error}
          </p>
        ) : null}
        <div className="controls">
          <button type="submit" className="btn primary" disabled={creating || !canOpen} aria-label="Start chat">
            {creating ? 'Creating…' : 'Start chat'}
          </button>
          {!canOpen ? <span className="muted small">Not connected to the Stratum daemon.</span> : null}
        </div>
      </form>
    </section>
  );
}
