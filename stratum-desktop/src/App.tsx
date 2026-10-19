import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import {
  closeSession,
  control,
  listModels,
  loadOlder,
  selectSession,
  sendMessage,
  setModel,
  startConversation,
} from './client/actions';
import { startBridge } from './client/bridge';
import { protocolStore } from './client/protocol-store';
import { useStore } from './client/store';
import { uiActions, uiStore } from './client/ui-store';
import {
  ConversationView,
  type ConversationViewHandle,
  type SessionStream,
} from './components/chat/ConversationView';
import type { ModelsOffer } from './components/chat/ModelPicker';
import type { CommandName } from './components/chat/commands';
import { ConnectionBanner } from './components/layout/ConnectionIndicator';
import { FilesPanel } from './components/layout/FilesPanel';
import { OutlinePanel } from './components/layout/OutlinePanel';
import { SessionContextPanel } from './components/layout/SessionContextPanel';
import { SessionsPanel } from './components/layout/SessionsPanel';
import { SettingsPanel } from './components/layout/SettingsPanel';
import {
  Sidebar,
  loadSidebarState,
  saveSidebarState,
  togglePanel,
  type SidebarPanel,
  type SidebarState,
} from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { TitleBar } from './components/layout/TitleBar';
import { UpdateBanner } from './components/layout/UpdateBanner';
import { StartupFailure } from './components/onboarding/StartupFailure';
import { TurnWatch } from './hooks/turn-notifications';
import { useUpdates } from './hooks/useUpdates';
import { tauriBridge, type DesktopPrefs, type NativeBridge } from './ipc/native';
import { notify } from './ipc/os';
import { chatMessages, composerMode, draftComposer, hasOlder } from './view/chat';
import { sessionItems, sessionTitle } from './view/sessions';

/** Preferencia de la interfaz: el aviso de conversaciones antiguas ya se cerró. */
const LEGACY_NOTICE_KEY = 'stratum.desktop.legacyNoticeHidden';

/** Los atajos también funcionan con el foco en el textarea o en un buscador. */
const GLOBAL = { enableOnFormTags: true, preventDefault: true } as const;

/**
 * Stratum Desktop (M12): un cliente de `stratumd`, hermano de la CLI y de Dot.
 *
 *   Stratum Protocol → protocol-store → vista derivada (`view/`) → esta UI
 *
 * Aquí no hay runtime, ni registro de sesiones, ni estado autoritativo: la
 * lista sale de la foto de conjunto, la conversación de la foto de la sesión
 * que se mira (más `sessions.history` bajo demanda), y cada acción es una
 * petición al daemon que se ve **cuando el daemon la publica**.
 */
export function App({ native = tauriBridge }: { native?: NativeBridge }) {
  const protocol = useStore(protocolStore, (s) => s);
  const ui = useStore(uiStore, (s) => s);
  const { connection, overview, focused, history } = protocol;
  const connected = connection.kind === 'connected';

  useEffect(() => {
    let stop: (() => void) | null = null;
    let disposed = false;
    startBridge(native)
      .then((s) => (disposed ? s() : (stop = s)))
      .catch((err) => console.error('desktop: bridge failed', err));
    return () => {
      disposed = true;
      stop?.();
    };
  }, [native]);

  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const [legacyHidden, setLegacyHidden] = useState(() => {
    try {
      return localStorage.getItem(LEGACY_NOTICE_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    native.prefs().then(setPrefs).catch(() => undefined);
  }, [native]);

  const [sidebar, setSidebar] = useState<SidebarState>(loadSidebarState);
  useEffect(() => saveSidebarState(sidebar), [sidebar]);
  const openPanel = useCallback((panel: SidebarPanel) => setSidebar({ open: true, panel }), []);

  const viewRef = useRef<ConversationViewHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [visibleTurn, setVisibleTurn] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ModelsOffer | null>(null);

  // Llegó a conectar alguna vez: si no, un fallo ocupa la ventana.
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (connected) setEverConnected(true);
  }, [connected]);

  const updates = useUpdates(connected && prefs !== null, prefs?.updatesAutoCheck ?? false);

  const items = useMemo(() => sessionItems(overview), [overview]);
  const selectedId = ui.selectedId;
  const selected = selectedId ? (overview.sessions.find((s) => s.id === selectedId) ?? null) : null;
  const snapshot = focused?.sessionId === selectedId ? (focused?.snapshot ?? null) : null;
  const olderMessages = history?.sessionId === selectedId ? history.older : [];

  // Notificaciones (D6) de las sesiones de Desktop: de la foto de conjunto.
  const watch = useRef(new TurnWatch());
  useEffect(() => {
    if (!connected) {
      watch.current.reset();
      return;
    }
    if (!prefs?.notifications.enabled) return;
    for (const req of watch.current.onOverview(overview, Date.now(), prefs.notifications.minSeconds)) {
      const session = overview.sessions.find((s) => s.id === req.sessionId);
      const title = session ? sessionTitle(session) : 'Stratum';
      const body = req.kind === 'turn' ? 'Respuesta lista.' : 'La sesión espera tu respuesta.';
      void notify(title, body, req.sessionId === selectedId);
    }
  }, [overview, connected, prefs, selectedId]);

  const stream: SessionStream = useMemo(() => {
    const pending = ui.pending;
    const sessionNotices = ui.notices.filter((n) => n.sessionId === selectedId || n.sessionId === null);
    if (!selectedId) {
      return {
        sessionId: '',
        cwd: null,
        loaded: true,
        messages: [],
        activeTurnId: null,
        todos: [],
        composer: draftComposer(connection),
        sending: pending.some((p) => p.kind === 'new-chat'),
        hasOlder: false,
        loadingOlder: false,
        historyError: null,
        waiting: { approvals: 0, questions: 0, plans: 0 },
        controls: [],
        notices: sessionNotices,
      };
    }
    const count = (list: { sessionId: string }[]) => list.filter((r) => r.sessionId === selectedId).length;
    return {
      sessionId: selectedId,
      cwd: snapshot?.session.agent === 'assistant' ? snapshot.session.cwd : null,
      loaded: snapshot !== null,
      messages: snapshot ? chatMessages(olderMessages, snapshot) : [],
      activeTurnId: snapshot?.session.currentRunId ?? null,
      todos: snapshot?.todos ?? [],
      composer: composerMode(connection, snapshot),
      sending: pending.some((p) => p.kind === 'send' && p.sessionId === selectedId),
      hasOlder: snapshot ? hasOlder(snapshot, history?.sessionId === selectedId ? history.hasMore : null) : false,
      loadingOlder: history?.sessionId === selectedId && history.loading,
      historyError: history?.sessionId === selectedId ? history.error : null,
      waiting: snapshot
        ? { approvals: snapshot.approvals.length, questions: snapshot.questions.length, plans: snapshot.plans.length }
        : { approvals: count(overview.approvals), questions: count(overview.questions), plans: count(overview.plans) },
      controls: pending.flatMap((p) =>
        p.kind === 'control' && p.sessionId === selectedId && p.action !== 'steer' ? [p.action] : [],
      ),
      notices: sessionNotices,
    };
  }, [selectedId, snapshot, olderMessages, connection, ui.pending, ui.notices, history, overview]);

  // Cambiar de sesión: fuera el selector de modelos y foco al input.
  useEffect(() => {
    setModels(null);
    setVisibleTurn(null);
    viewRef.current?.focusInput();
  }, [selectedId]);

  const newConversation = useCallback(() => {
    selectSession(native, null);
    viewRef.current?.focusInput();
  }, [native]);

  const onSend = useCallback(
    (text: string, attachments: { path: string }[]) => {
      if (!selectedId) return startConversation(native, text);
      const mode = stream.composer.kind === 'steer' ? 'steer' : 'ask';
      return sendMessage(native, {
        sessionId: selectedId,
        cwd: stream.cwd,
        mode,
        text,
        attachments: attachments.map((a) => a.path),
      });
    },
    [native, selectedId, stream.composer.kind, stream.cwd],
  );

  const runControl = useCallback(
    (action: 'pause' | 'resume' | 'cancel') => {
      if (!selectedId || !stream.activeTurnId) return;
      void control(native, selectedId, action, stream.activeTurnId);
    },
    [native, selectedId, stream.activeTurnId],
  );
  const cancel = useCallback(() => runControl('cancel'), [runControl]);

  const onCommand = useCallback(
    (name: CommandName, arg: string) => {
      switch (name) {
        case 'new':
          newConversation();
          return;
        case 'model':
          if (!selectedId || !selected) return;
          if (arg) void setModel(native, selectedId, arg);
          else
            void listModels(native).then((list) => {
              if (!list) return;
              setModels({
                models: list.models.filter((m) => m.provider === selected.provider).map((m) => m.id),
                current: selected.model,
                ...(list.incomplete ? { error: 'algún provider no contestó' } : {}),
              });
            });
          return;
        case 'context':
          openPanel('memory');
          return;
        case 'settings':
          setSettingsOpen(true);
          return;
      }
    },
    [native, newConversation, openPanel, selectedId, selected],
  );

  useHotkeys('ctrl+n, meta+n', newConversation, GLOBAL, [newConversation]);
  useHotkeys('ctrl+b, meta+b', () => setSidebar((s) => ({ ...s, open: !s.open })), GLOBAL);
  useHotkeys(
    'ctrl+k, meta+k',
    () => {
      openPanel('conversations');
      requestAnimationFrame(() => searchRef.current?.focus());
    },
    GLOBAL,
    [openPanel],
  );
  useHotkeys('ctrl+comma, meta+comma', () => setSettingsOpen(true), GLOBAL);
  useHotkeys(
    'escape',
    () => {
      if (settingsOpen) return;
      if (models) setModels(null);
      else if (stream.activeTurnId) cancel();
    },
    { enableOnFormTags: true },
    [settingsOpen, models, stream.activeTurnId, cancel],
  );

  const working = useMemo(() => overview.sessions.filter((s) => s.currentRunId !== null).length, [overview]);
  const closing = useMemo(
    () => new Set(ui.pending.flatMap((p) => (p.kind === 'close' ? [p.sessionId] : []))),
    [ui.pending],
  );
  const filesKey = `${selectedId}:${snapshot?.seq ?? 0}:${stream.activeTurnId ?? ''}`;
  const contextKey = `${selectedId}:${stream.activeTurnId ?? 'idle'}`;
  const gone = selectedId !== null && protocol.listed && connected && !selected;

  const panel = (() => {
    switch (sidebar.panel) {
      case 'conversations':
        return (
          <SessionsPanel
            ref={searchRef}
            items={items}
            listed={protocol.listed}
            selectedId={selectedId}
            creating={ui.pending.some((p) => p.kind === 'new-chat')}
            closing={closing}
            onSelect={(id) => selectSession(native, id)}
            onNew={newConversation}
            onClose={(id) => void closeSession(native, id)}
          />
        );
      case 'outline':
        return (
          <OutlinePanel
            messages={stream.messages}
            visibleTurnId={visibleTurn}
            onJump={(turnId) => viewRef.current?.jumpTo(turnId)}
          />
        );
      case 'memory':
        return <SessionContextPanel native={native} sessionId={selected ? selectedId : null} refreshKey={contextKey} />;
      case 'files':
        return stream.cwd ? (
          <FilesPanel cwd={stream.cwd} refreshKey={filesKey} />
        ) : (
          <div className="side-panel">
            <div className="side-panel__body">
              <p className="side-panel__empty">
                Esta sesión no tiene carpeta de ficheros de Desktop (solo las conversaciones del
                asistente la tienen).
              </p>
            </div>
          </div>
        );
    }
  })();

  if (!everConnected && (connection.kind === 'error' || connection.kind === 'incompatible')) {
    return (
      <div className="window">
        <TitleBar />
        <StartupFailure
          message={
            connection.kind === 'error'
              ? connection.message
              : `El daemon de Stratum habla la versión ${connection.daemonProtocol ?? '?'} del protocolo y Desktop la ${connection.clientProtocol}.`
          }
          onRetry={() => void native.retry()}
        />
      </div>
    );
  }

  return (
    <div className="window">
      <a
        className="skip-link"
        href="#chat-input"
        onClick={(e) => {
          e.preventDefault();
          viewRef.current?.focusInput();
        }}
      >
        Ir al mensaje
      </a>
      <TitleBar title={selected ? sessionTitle(selected) : selectedId ? null : 'Conversación nueva'} />
      <main className="app">
        <ConnectionBanner state={connection} onRetry={() => void native.retry()} />
        <UpdateBanner updates={updates} />
        {prefs && prefs.legacyConversations > 0 && !legacyHidden && (
          <p className="notice notice--dismissable app__notice" data-tone="info" role="status">
            Tienes {prefs.legacyConversations} conversación(es) de la versión anterior de Desktop. Para
            seguir con ellas, impórtalas una vez con <code>stratum desktop import</code>.
            <button
              type="button"
              className="icon-button"
              aria-label="Cerrar aviso"
              onClick={() => {
                setLegacyHidden(true);
                try {
                  localStorage.setItem(LEGACY_NOTICE_KEY, '1');
                } catch {
                  /* sin almacenamiento: volverá a salir */
                }
              }}
            >
              ×
            </button>
          </p>
        )}
        {ui.notices
          .filter((n) => n.sessionId !== null && n.sessionId !== selectedId)
          .slice(-1)
          .map((n) => (
            <p key={n.id} className="notice notice--dismissable app__notice" data-tone={n.tone} role="status">
              {n.text}
              <button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={() => uiActions.dismiss(n.id)}>
                ×
              </button>
            </p>
          ))}

        <div className="app__body">
          <Sidebar
            state={sidebar}
            onToggle={(p) => setSidebar((s) => togglePanel(s, p))}
            onSettings={() => setSettingsOpen(true)}
            badges={{ conversations: items.some((i) => i.waiting > 0 && i.id !== selectedId) }}
          >
            {panel}
          </Sidebar>
          {gone ? (
            <section className="conversation" aria-label="Conversación">
              <p className="conversation__loading" role="status">
                Esta sesión ya no existe o no está disponible.{' '}
                <button type="button" className="button" onClick={newConversation}>
                  Empezar otra
                </button>
              </p>
            </section>
          ) : (
            <ConversationView
              key={selectedId ?? 'new'}
              ref={viewRef}
              stream={stream}
              onSend={onSend}
              onCancel={cancel}
              onControl={runControl}
              onLoadOlder={() => selectedId && void loadOlder(native, selectedId)}
              onDismissNotice={uiActions.dismiss}
              onCommand={onCommand}
              onVisibleTurn={setVisibleTurn}
              models={models}
              onPickModel={(m) => {
                setModels(null);
                if (selectedId) void setModel(native, selectedId, m);
              }}
              onCloseModels={() => setModels(null)}
            />
          )}
        </div>

        <StatusBar connection={connection} session={snapshot?.session ?? selected} working={working} />

        {settingsOpen && (
          <SettingsPanel
            prefs={prefs}
            updates={updates}
            onOpenConfig={() => native.openConfig()}
            onClose={() => {
              setSettingsOpen(false);
              viewRef.current?.focusInput();
            }}
          />
        )}
      </main>
    </div>
  );
}
