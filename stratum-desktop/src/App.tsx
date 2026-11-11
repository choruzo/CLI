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
import { moveBrowser, normalizeAddress } from './client/browser';
import { startBridge } from './client/bridge';
import {
  cancelJob,
  listProfiles,
  pickProjectFolder,
  setAgent,
  setReadOnly,
  setSessionProfile,
  startCodeConversation,
  type AgentProfile,
} from './client/code-actions';
import { protocolStore } from './client/protocol-store';
import { useStore } from './client/store';
import { traceActions, traceStore } from './client/trace-store';
import { uiActions, uiStore } from './client/ui-store';
import {
  CHAT_INTRO,
  CODE_INTRO,
  ConversationView,
  type ConversationViewHandle,
  type SessionStream,
} from './components/chat/ConversationView';
import type { ModelChoice, ModelsOffer } from './components/chat/ModelPicker';
import { imageRequest, type CommandName } from './components/chat/commands';
import { PendingRequests } from './components/chat/PendingRequests';
import { BrowserPanel, loadRightPanel, saveRightPanel, type RightPanel } from './components/browser/BrowserPanel';
import { ChangesPanel } from './components/code/ChangesPanel';
import { CodeBar, GENERAL_AGENT } from './components/code/CodeBar';
import { JobsPanel } from './components/code/JobsPanel';
import { SetupPanel } from './components/code/SetupPanel';
import { ProjectPicker } from './components/code/ProjectPicker';
import { ConnectionBanner } from './components/layout/ConnectionIndicator';
import { FilesPanel } from './components/layout/FilesPanel';
import { ModeSwitch } from './components/layout/ModeSwitch';
import { MIN_CONVERSATION_WIDTH, ResizeHandle, useStoredWidth } from './components/layout/ResizeHandle';
import { OutlinePanel } from './components/layout/OutlinePanel';
import { SessionContextPanel } from './components/layout/SessionContextPanel';
import { SessionsPanel } from './components/layout/SessionsPanel';
import { SettingsPanel } from './components/layout/SettingsPanel';
import {
  CHAT_PANELS,
  CODE_PANELS,
  SIDEBAR_PANEL_MAX,
  SIDEBAR_PANEL_MIN,
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
import { TrajectoryPanel } from './components/trajectory/TrajectoryPanel';
import { TurnWatch } from './hooks/turn-notifications';
import { useChanges } from './hooks/useChanges';
import { useUpdates } from './hooks/useUpdates';
import { tauriBridge, type DesktopPrefs, type NativeBridge } from './ipc/native';
import { notify } from './ipc/os';
import type { ModelList } from './protocol/results';
import { chatMessages, composerMode, draftComposer, hasOlder } from './view/chat';
import { pendingOf } from './view/interactions';
import {
  loadLastProject,
  loadMode,
  modeOfAgent,
  modeOfSession,
  recentProjects,
  saveLastProject,
  saveMode,
  type AppMode,
} from './view/mode';
import { sessionItems, sessionTitle } from './view/sessions';

/** Preferencia de la interfaz: el aviso de conversaciones antiguas ya se cerró. */
const LEGACY_NOTICE_KEY = 'stratum.desktop.legacyNoticeHidden';

/** Límites del ancho del panel de trayectoria (por defecto, el 40 % del CSS). */
const TRAJECTORY_MIN = 320;
const TRAJECTORY_MAX = 1400;
/** Ancho del raíl de iconos del sidebar (`.sidebar__rail`). */
const RAIL_WIDTH = 44;

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

  // Panel de trayectoria: se recuerda abierto o cerrado (comodidad de la interfaz).
  // Paneles de la derecha (trayectoria, navegador): uno a la vez, para que a la
  // conversación le quede sitio. Se recuerda cuál estaba abierto.
  const [rightPanel, setRightPanel] = useState<RightPanel | null>(loadRightPanel);
  useEffect(() => saveRightPanel(rightPanel), [rightPanel]);
  const toggleRight = useCallback((panel: RightPanel) => setRightPanel((open) => (open === panel ? null : panel)), []);
  const trajectoryOpen = rightPanel === 'trajectory';
  const browserOpen = rightPanel === 'browser';
  const trace = useStore(traceStore, (s) => s);

  // Anchos de los paneles laterales, a gusto del usuario (comodidad de la interfaz).
  // El tope real depende de la ventana: a la conversación siempre le queda sitio.
  const [sidebarWidth, setSidebarWidth] = useStoredWidth('stratum.sidebar.width', SIDEBAR_PANEL_MIN, SIDEBAR_PANEL_MAX);
  const [trajectoryWidth, setTrajectoryWidth] = useStoredWidth(
    'stratum.trajectory.width',
    TRAJECTORY_MIN,
    TRAJECTORY_MAX,
  );
  const [browserWidth, setBrowserWidth] = useStoredWidth('stratum.browser.width', TRAJECTORY_MIN, TRAJECTORY_MAX);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Hasta dónde puede crecer un panel sin dejar a la conversación por debajo de su mínimo. */
  const roomFor = useCallback((selector: string, hardMax: number) => {
    const body = bodyRef.current;
    if (!body) return hardMax;
    const others = Array.from(body.children)
      .filter((el) => !el.matches(`${selector}, .conversation, .resize-handle`))
      .reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
    return Math.min(hardMax, body.getBoundingClientRect().width - others - MIN_CONVERSATION_WIDTH);
  }, []);

  const viewRef = useRef<ConversationViewHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [visibleTurn, setVisibleTurn] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ModelsOffer | null>(null);
  // Lo elegido para las conversaciones nuevas (`null`: lo de la config) y la
  // última lista de modelos, para la etiqueta del composer.
  const [draftModel, setDraftModel] = useState<ModelChoice | null>(null);
  const [catalog, setCatalog] = useState<ModelList | null>(null);

  // Llegó a conectar alguna vez: si no, un fallo ocupa la ventana.
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (connected) setEverConnected(true);
  }, [connected]);

  const updates = useUpdates(connected && prefs !== null, prefs?.updatesAutoCheck ?? false);

  const allItems = useMemo(() => sessionItems(overview), [overview]);
  const selectedId = ui.selectedId;
  const selected = selectedId ? (overview.sessions.find((s) => s.id === selectedId) ?? null) : null;
  const snapshot = focused?.sessionId === selectedId ? (focused?.snapshot ?? null) : null;

  // Modo de la interfaz (Chat | Código). Con una sesión a la vista manda ella
  // (su agente dice de qué modo es); sin sesión, lo que eligió la persona.
  const [mode, setMode] = useState<AppMode>(loadMode);
  useEffect(() => saveMode(mode), [mode]);
  const lastByMode = useRef<Record<AppMode, string | null>>({ chat: null, code: null });
  const selectedMode = selected ? modeOfSession(selected) : null;
  useEffect(() => {
    if (!selectedMode || !selectedId) return;
    lastByMode.current[selectedMode] = selectedId;
    setMode(selectedMode);
  }, [selectedMode, selectedId]);
  const items = useMemo(() => allItems.filter((i) => modeOfAgent(i.agent) === mode), [allItems, mode]);
  const otherWaiting = useMemo(
    () => allItems.some((i) => modeOfAgent(i.agent) !== mode && i.waiting > 0),
    [allItems, mode],
  );

  // Sesión de código nueva: carpeta del proyecto y perfil, hasta el primer mensaje.
  const [project, setProject] = useState<string | null>(loadLastProject);
  const [draftAgent, setDraftAgent] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const recent = useMemo(() => recentProjects(overview), [overview]);
  const chooseProject = useCallback((cwd: string) => {
    setProject(cwd);
    saveLastProject(cwd);
  }, []);
  const pickProject = useCallback(() => {
    setPicking(true);
    void pickProjectFolder(native)
      .then((cwd) => cwd && chooseProject(cwd))
      .finally(() => setPicking(false));
  }, [native, chooseProject]);

  /** La sesión de código que se mira (su foto, o la de conjunto mientras llega). */
  const codeSession = mode === 'code' && selected && selectedMode === 'code' ? (snapshot?.session ?? selected) : null;
  const profilesCwd = mode === 'code' ? (codeSession?.cwd ?? (selectedId ? null : project)) : null;
  useEffect(() => {
    setProfiles(null);
    if (!connected || mode !== 'code') return;
    let alive = true;
    void listProfiles(native, profilesCwd).then((list) => alive && setProfiles(list));
    return () => {
      alive = false;
    };
  }, [native, connected, mode, profilesCwd]);
  const olderMessages = history?.sessionId === selectedId ? history.older : [];

  useEffect(() => {
    if (connected) void listModels(native, true).then((list) => list && setCatalog(list));
  }, [native, connected]);

  // Lo que dice el botón del composer: lo de la sesión, o lo que usará la nueva.
  const currentModel: ModelChoice | null = useMemo(() => {
    const session = snapshot?.session ?? selected;
    if (selectedId) return session ? { provider: session.provider, model: session.model } : null;
    if (draftModel) return draftModel;
    const fallback = catalog?.models.find((m) => m.default);
    return fallback ? { provider: fallback.provider, model: fallback.id } : null;
  }, [selectedId, snapshot, selected, draftModel, catalog]);

  const openModels = useCallback(() => {
    setModels({ models: catalog?.models ?? null, current: currentModel });
    void listModels(native).then((list) => {
      if (list) setCatalog(list);
      // Solo si sigue abierto: cerrarlo mientras se pedía gana.
      setModels((open) => {
        if (!open) return open;
        if (!list) return { ...open, models: open.models ?? [] };
        const error = list.incomplete ? 'Algún provider no contestó: la lista puede estar incompleta.' : undefined;
        return { ...open, models: list.models, ...(error ? { error } : {}) };
      });
    });
  }, [native, catalog, currentModel]);

  const pickModel = useCallback(
    (choice: ModelChoice) => {
      setModels(null);
      if (!selectedId) {
        setDraftModel(choice);
        return;
      }
      const provider = currentModel && choice.provider !== currentModel.provider ? choice.provider : undefined;
      void setModel(native, selectedId, choice.model, provider);
    },
    [native, selectedId, currentModel],
  );

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
        controls: [],
        notices: sessionNotices,
      };
    }
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
      controls: pending.flatMap((p) =>
        p.kind === 'control' && p.sessionId === selectedId && p.action !== 'steer' ? [p.action] : [],
      ),
      notices: sessionNotices,
    };
  }, [selectedId, snapshot, olderMessages, connection, ui.pending, ui.notices, history]);

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

  const switchMode = useCallback(
    (next: AppMode) => {
      if (next === mode) return;
      setMode(next);
      // Vuelve a lo último que se miraba en ese modo, si sigue existiendo.
      const last = lastByMode.current[next];
      const known = last !== null && overview.sessions.some((s) => s.id === last && modeOfSession(s) === next);
      selectSession(native, known ? last : null);
      const panels = next === 'code' ? CODE_PANELS : CHAT_PANELS;
      setSidebar((s) => (panels.includes(s.panel) ? s : { ...s, panel: 'conversations' }));
    },
    [native, mode, overview.sessions],
  );

  const onSend = useCallback(
    (text: string, attachments: { path: string; pasted?: boolean }[], opts: { plan?: boolean } = {}) => {
      if (!selectedId && mode === 'code') {
        if (!project) {
          uiActions.notify(null, 'warning', 'Elige primero la carpeta del proyecto en la que trabajará el agente.');
          return Promise.resolve({ restore: true });
        }
        return startCodeConversation(native, text, {
          cwd: project,
          ...(draftAgent ? { agent: draftAgent } : {}),
          ...(draftModel ?? {}),
        }, opts);
      }
      if (!selectedId) return startConversation(native, text, draftModel ?? undefined);
      const sendMode = stream.composer.kind === 'steer' ? 'steer' : 'ask';
      return sendMessage(native, {
        sessionId: selectedId,
        cwd: stream.cwd,
        mode: sendMode,
        ...(opts.plan && sendMode === 'ask' ? { plan: true } : {}),
        text,
        attachments: attachments.filter((a) => !a.pasted).map((a) => a.path),
        pasted: attachments.filter((a) => a.pasted).map((a) => a.path),
      });
    },
    [native, selectedId, stream.composer.kind, stream.cwd, draftModel, mode, project, draftAgent],
  );

  const runControl = useCallback(
    (action: 'pause' | 'resume' | 'cancel') => {
      if (!selectedId || !stream.activeTurnId) return;
      void control(native, selectedId, action, stream.activeTurnId);
    },
    [native, selectedId, stream.activeTurnId],
  );
  const cancel = useCallback(() => runControl('cancel'), [runControl]);

  // Reconfigurar una sesión de código (perfil, solo lectura) y deshacer piden
  // que esté en reposo y alojada en el daemon.
  const codeLock: string | null = !codeSession
    ? null
    : !connected
      ? 'Sin conexión con Stratum.'
      : codeSession.host.kind === 'peer'
        ? 'Esta sesión la aloja una terminal: se configura desde ella.'
        : stream.activeTurnId !== null
          ? 'Se podrá cambiar cuando acabe el turno en marcha.'
          : ui.pending.some((p) => p.kind === 'set-model' && p.sessionId === selectedId)
            ? 'Aplicando el cambio…'
            : null;
  // Los cambios del proyecto se releen al empezar y al acabar cada turno.
  const changesState = useChanges(
    native,
    connected && codeSession ? selectedId : null,
    `${stream.activeTurnId ?? 'idle'}:${snapshot?.run?.id ?? ''}`,
  );
  const changesSummary = changesState.changes?.ok ? changesState.changes.value : null;
  const jobs = useMemo(() => (codeSession ? (snapshot?.jobs ?? []) : []), [codeSession, snapshot]);
  const runningJobs = jobs.filter((j) => j.status === 'running').length;

  const onCommand = useCallback(
    (name: CommandName, arg: string) => {
      switch (name) {
        case 'new':
          newConversation();
          return;
        case 'model':
          // `/model nombre`: otro modelo del provider actual; sin nombre, el selector.
          if (!arg) openModels();
          else if (selectedId) void setModel(native, selectedId, arg);
          else if (currentModel) setDraftModel({ provider: currentModel.provider, model: arg });
          else openModels();
          return;
        case 'context':
          openPanel('memory');
          return;
        case 'settings':
          setSettingsOpen(true);
          return;
        case 'imagen':
          if (!prefs?.imageGeneration) {
            return (
              'La generación de imágenes no está configurada: añade una sección imageGeneration ' +
              '(provider y model de imágenes) a la config global y reinicia Stratum Desktop.'
            );
          }
          void onSend(imageRequest(arg), []);
          return;
        case 'plan':
          if (stream.activeTurnId) return 'Hay un turno en marcha: pide el plan cuando acabe.';
          if (!selectedId && !project) return 'Elige primero la carpeta del proyecto.';
          void onSend(arg, [], { plan: true });
          return;
        case 'agent': {
          if (!arg) {
            const names = [GENERAL_AGENT, ...(profiles ?? []).map((p) => p.name).filter((n) => n !== GENERAL_AGENT)];
            return `Perfiles: ${names.join(', ')}. Escribe /agent y el nombre, o usa el selector «Perfil».`;
          }
          const agent = arg === GENERAL_AGENT ? null : arg;
          if (!selectedId) setDraftAgent(agent);
          else if (codeLock) return codeLock;
          else void setAgent(native, selectedId, agent);
          return;
        }
        case 'readonly':
          if (!codeSession || !selectedId) return 'Abre primero una sesión de código.';
          if (codeLock) return codeLock;
          void setReadOnly(native, selectedId, !codeSession.readOnly);
          return;
        case 'profile':
          if (!codeSession || !selectedId) return 'Abre primero una sesión de código.';
          if (arg) {
            if (codeLock) return codeLock;
            void setSessionProfile(native, selectedId, arg.toLowerCase());
          }
          openPanel('setup');
          return;
        case 'tools':
        case 'env':
        case 'plugins':
          if (!codeSession) return 'Abre primero una sesión de código.';
          openPanel('setup');
          return;
        case 'changes':
        case 'undo':
          openPanel('changes');
          return;
        case 'jobs':
          openPanel('jobs');
          return;
        case 'browser': {
          // Con dirección, además de abrir el panel se va a ella (solo local: lo dice el daemon).
          const target = arg ? normalizeAddress(arg) : null;
          if (arg && !target) return 'Escribe una dirección http(s), por ejemplo /browser localhost:3000.';
          if (target && !selectedId) return 'Abre primero una sesión: el navegador es de la sesión.';
          if (target && stream.activeTurnId) return 'El agente está trabajando: el navegador es suyo hasta que acabe el turno.';
          setRightPanel('browser');
          if (target && selectedId) {
            void moveBrowser(native, selectedId, 'goto', target).then(
              (r) => !r.ok && uiActions.notify(selectedId, 'warning', r.message),
            );
          }
          return;
        }
      }
    },
    [
      native,
      newConversation,
      openPanel,
      selectedId,
      openModels,
      currentModel,
      prefs,
      onSend,
      profiles,
      codeSession,
      codeLock,
      stream.activeTurnId,
      project,
    ],
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
  useHotkeys('ctrl+1, meta+1', () => switchMode('chat'), GLOBAL, [switchMode]);
  useHotkeys('ctrl+2, meta+2', () => switchMode('code'), GLOBAL, [switchMode]);
  useHotkeys('ctrl+j, meta+j', () => toggleRight('trajectory'), GLOBAL, [toggleRight]);
  useHotkeys('ctrl+shift+b, meta+shift+b', () => toggleRight('browser'), GLOBAL, [toggleRight]);
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
  // El montaje se relee cuando cambia algo que lo decide, y al acabar cada turno.
  const setupKey = codeSession
    ? [
        codeSession.sessionProfile,
        codeSession.agent,
        codeSession.readOnly,
        codeSession.model,
        codeSession.state,
        stream.activeTurnId ?? 'idle',
      ].join(':')
    : '';
  const knownSessions = useMemo(() => new Set(overview.sessions.map((s) => s.id)), [overview.sessions]);
  const gone = selectedId !== null && protocol.listed && connected && !selected;

  // La traza solo se pide con el panel abierto, conectado y una sesión que el daemon
  // conoce. Al perder la conexión se suelta (y se vacía); al volver, la primera tanda
  // trae `reset` y es la autoridad.
  const traceTarget = trajectoryOpen && connected && selected ? selectedId : null;
  useEffect(() => {
    traceActions.follow(traceTarget);
    void native.traceSession(traceTarget).catch(() => undefined);
  }, [native, traceTarget]);

  const panels = mode === 'code' ? CODE_PANELS : CHAT_PANELS;
  const activePanel = panels.includes(sidebar.panel) ? sidebar.panel : 'conversations';
  const panel = (() => {
    switch (activePanel) {
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
            mode={mode}
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
        return (
          <SessionContextPanel
            native={native}
            sessionId={selected ? selectedId : null}
            refreshKey={contextKey}
            connected={connected}
            knownSessions={knownSessions}
            onOpenSession={(id) => selectSession(native, id)}
            assistant={mode === 'chat'}
          />
        );
      case 'changes':
        return (
          <ChangesPanel
            native={native}
            sessionId={codeSession ? selectedId : null}
            state={changesState}
            connected={connected}
            undoBlocked={codeLock}
          />
        );
      case 'setup':
        return (
          <SetupPanel
            native={native}
            sessionId={codeSession ? selectedId : null}
            refreshKey={setupKey}
            connected={connected}
            locked={codeLock}
            activeTarget={codeSession?.activeTarget ?? null}
            activeEnvironment={codeSession?.environment?.name ?? null}
            onProfile={(profile) => selectedId && void setSessionProfile(native, selectedId, profile)}
          />
        );
      case 'jobs':
        return (
          <JobsPanel
            jobs={jobs}
            hasSession={codeSession !== null}
            onCancel={
              connected && selectedId && codeSession?.host.kind === 'daemon'
                ? (jobId) => void cancelJob(native, selectedId, jobId)
                : undefined
            }
          />
        );
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
      <TitleBar
        title={
          selected ? sessionTitle(selected) : selectedId ? null : mode === 'code' ? 'Sesión de código nueva' : 'Conversación nueva'
        }
        modes={
          <ModeSwitch mode={mode} onChange={switchMode} badges={{ [mode === 'chat' ? 'code' : 'chat']: otherWaiting }} />
        }
      />
      <main className="app">
        <ConnectionBanner state={connection} onRetry={() => void native.retry()} />
        <UpdateBanner updates={updates} />
        {prefs && prefs.legacyConversations > 0 && !legacyHidden && (
          <p className="notice notice--dismissable app__notice" data-tone="info" role="status">
            {/* Un solo hijo de texto: en un flex, cada nodo suelto sería una columna. */}
            <span className="notice__text">
              Tienes {prefs.legacyConversations} conversación(es) de la versión anterior de Desktop. Para
              seguir con ellas, impórtalas una vez con <code>stratum desktop import</code>.
            </span>
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

        <div className="app__body" ref={bodyRef}>
          <Sidebar
            state={{ ...sidebar, panel: activePanel }}
            panels={panels}
            onToggle={(p) => setSidebar((s) => togglePanel({ ...s, panel: activePanel }, p))}
            onSettings={() => setSettingsOpen(true)}
            trajectory={{ open: trajectoryOpen, onToggle: () => toggleRight('trajectory') }}
            browser={{ open: browserOpen, onToggle: () => toggleRight('browser') }}
            badges={{ conversations: items.some((i) => i.waiting > 0 && i.id !== selectedId) }}
            resize={{
              width: sidebarWidth,
              // El raíl es del propio sidebar: se descuenta del sitio que queda.
              max: () => roomFor('.sidebar', SIDEBAR_PANEL_MAX + RAIL_WIDTH) - RAIL_WIDTH,
              onResize: setSidebarWidth,
            }}
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
              mode={mode}
              intro={mode === 'code' ? CODE_INTRO : CHAT_INTRO}
              header={
                mode !== 'code' ? undefined : codeSession && selectedId ? (
                  <CodeBar
                    cwd={codeSession.cwd}
                    agent={codeSession.agent}
                    readOnly={codeSession.readOnly}
                    profiles={profiles}
                    changes={changesSummary}
                    runningJobs={runningJobs}
                    locked={codeLock !== null}
                    lockedReason={codeLock ?? undefined}
                    onAgent={(agent) => void setAgent(native, selectedId, agent)}
                    onReadOnly={(readOnly) => void setReadOnly(native, selectedId, readOnly)}
                    onOpenChanges={() => openPanel('changes')}
                    onOpenJobs={() => openPanel('jobs')}
                  />
                ) : !selectedId ? (
                  <ProjectPicker
                    project={project}
                    recent={recent}
                    profiles={profiles}
                    agent={draftAgent ?? GENERAL_AGENT}
                    picking={picking}
                    disabled={!connected || ui.pending.some((p) => p.kind === 'new-chat')}
                    onPick={pickProject}
                    onProject={chooseProject}
                    onAgent={setDraftAgent}
                  />
                ) : undefined
              }
              models={models}
              onPickModel={pickModel}
              onCloseModels={() => setModels(null)}
              pending={
                <PendingRequests items={pendingOf(snapshot)} snapshot={snapshot} connected={connected} native={native} />
              }
              model={
                connected
                  ? {
                      label: currentModel ? `${currentModel.provider} · ${currentModel.model}` : 'Modelo',
                      onOpen: () => (models ? setModels(null) : openModels()),
                      disabled: stream.activeTurnId !== null || ui.pending.some((p) => p.kind === 'set-model'),
                    }
                  : undefined
              }
            />
          )}
          {trajectoryOpen && (
            <ResizeHandle
              edge="left"
              label="Ancho del panel de trayectoria"
              min={TRAJECTORY_MIN}
              max={() => roomFor('.trajectory', TRAJECTORY_MAX)}
              width={trajectoryWidth}
              onResize={setTrajectoryWidth}
              onReset={() => setTrajectoryWidth(null)}
            />
          )}
          {trajectoryOpen && (
            <TrajectoryPanel
              key={selectedId ?? 'none'}
              width={trajectoryWidth}
              trajectory={trace}
              hasSession={selected !== null}
              connected={connected}
              onClose={() => setRightPanel(null)}
            />
          )}
          {browserOpen && (
            <ResizeHandle
              edge="left"
              label="Ancho del panel del navegador"
              min={TRAJECTORY_MIN}
              max={() => roomFor('.browser', TRAJECTORY_MAX)}
              width={browserWidth}
              onResize={setBrowserWidth}
              onReset={() => setBrowserWidth(null)}
            />
          )}
          {browserOpen && (
            <BrowserPanel
              native={native}
              sessionId={selected ? selectedId : null}
              connected={connected}
              running={stream.activeTurnId !== null}
              width={browserWidth}
              onClose={() => setRightPanel(null)}
            />
          )}
        </div>

        <StatusBar connection={connection} session={snapshot?.session ?? selected} working={working} />

        {settingsOpen && (
          <SettingsPanel
            native={native}
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
