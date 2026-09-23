import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { ConversationView, type ConversationViewHandle } from './components/chat/ConversationView';
import { ReconnectBanner } from './components/chat/ReconnectBanner';
import type { CommandName } from './components/chat/commands';
import { ConversationsPanel } from './components/layout/ConversationsPanel';
import { FilesPanel } from './components/layout/FilesPanel';
import { MemoryPanel } from './components/layout/MemoryPanel';
import { OutlinePanel } from './components/layout/OutlinePanel';
import {
  Sidebar,
  loadSidebarState,
  saveSidebarState,
  togglePanel,
  type SidebarPanel,
  type SidebarState,
} from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { isBusy, needsAttention } from './hooks/conversations-store';
import { useConversations } from './hooks/useConversations';
import { useMemory } from './hooks/useMemory';
import { useConfig } from './hooks/useConfig';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { isOperational, useSidecar } from './hooks/useSidecar';

/** Los atajos también funcionan con el foco en el textarea o en un buscador. */
const GLOBAL = { enableOnFormTags: true, preventDefault: true } as const;

/**
 * D4: varias conversaciones con el asistente, sidebar (conversaciones, índice,
 * memoria global y ficheros), StatusBar e InputArea con slash-commands.
 * D5: panel de Ajustes sobre el `.stratumrc.json` global.
 */
export function App() {
  const sidecar = useSidecar();
  const conversations = useConversations(sidecar.status);
  const { active, state } = conversations;
  const connected = isOperational(sidecar);

  const [sidebar, setSidebar] = useState<SidebarState>(loadSidebarState);
  useEffect(() => saveSidebarState(sidebar), [sidebar]);
  const memory = useMemory(connected && sidebar.open && sidebar.panel === 'memory');

  const viewRef = useRef<ConversationViewHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [visibleTurn, setVisibleTurn] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [appNotice, setAppNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const config = useConfig(settingsOpen);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  // Cambiar de conversación: fuera la confirmación de /clear y foco al input.
  useEffect(() => {
    setConfirmClear(false);
    setVisibleTurn(null);
    viewRef.current?.focusInput();
  }, [active.conversationId]);

  const openPanel = useCallback((panel: SidebarPanel) => setSidebar({ open: true, panel }), []);

  const newConversation = useCallback(() => {
    conversations.newConversation();
    viewRef.current?.focusInput();
  }, [conversations]);

  const onCommand = useCallback(
    (name: CommandName, arg: string) => {
      switch (name) {
        case 'new':
          newConversation();
          return;
        case 'clear':
          setConfirmClear(true);
          return;
        case 'compact':
          conversations.compact();
          return;
        case 'model':
          if (arg) conversations.setModel(arg);
          else conversations.listModels();
          return;
        case 'memory':
          openPanel('memory');
          return;
        case 'settings':
          openSettings();
          return;
      }
    },
    [conversations, newConversation, openPanel, openSettings],
  );

  useHotkeys('ctrl+n, meta+n', newConversation, GLOBAL, [newConversation]);
  useHotkeys('ctrl+b, meta+b', () => setSidebar((s) => ({ ...s, open: !s.open })), GLOBAL);
  useHotkeys(
    'ctrl+k, meta+k',
    () => {
      openPanel('conversations');
      // El panel puede estar montándose: se enfoca en el siguiente frame.
      requestAnimationFrame(() => searchRef.current?.focus());
    },
    GLOBAL,
    [openPanel],
  );
  useHotkeys('ctrl+l, meta+l', () => active.opened && setConfirmClear(true), GLOBAL, [active.opened]);
  useHotkeys('ctrl+comma, meta+comma', openSettings, GLOBAL, [openSettings]);
  useHotkeys(
    'escape',
    () => {
      // Con Ajustes abierto, Esc es del panel (lo cierra).
      if (settingsOpen) return;
      if (confirmClear) setConfirmClear(false);
      else if (active.activeTurnId) active.cancel();
    },
    { enableOnFormTags: true },
    [settingsOpen, confirmClear, active.activeTurnId, active.cancel],
  );

  const { generating, queued, backgroundAttention } = useMemo(() => {
    let generating = 0;
    let queued = 0;
    let backgroundAttention = false;
    for (const [id, c] of Object.entries(state.byId)) {
      if (!c.activeTurnId) continue;
      const turn = c.messages.find((m) => m.role === 'agent' && m.turnId === c.activeTurnId);
      if (turn?.role === 'agent' && turn.status === 'queued') queued++;
      else generating++;
      if (id !== state.activeId && needsAttention(c)) backgroundAttention = true;
    }
    return { generating, queued, backgroundAttention };
  }, [state.byId, state.activeId]);

  // Refresco del panel de ficheros: cambia con cada turno terminado y subida.
  const filesKey = `${active.conversationId}:${active.messages.length}:${active.activeTurnId ?? ''}:${active.workspace?.sizeBytes ?? 0}:${active.workspace?.state ?? ''}`;

  const panel = (() => {
    switch (sidebar.panel) {
      case 'conversations':
        return (
          <ConversationsPanel
            ref={searchRef}
            list={conversations.list}
            loaded={state.listLoaded}
            activeId={state.activeId}
            draftId={conversations.draftId}
            byId={state.byId}
            onSelect={conversations.select}
            onNew={newConversation}
            onRename={conversations.rename}
            onDelete={conversations.remove}
            onPin={conversations.pinConversation}
          />
        );
      case 'outline':
        return (
          <OutlinePanel
            messages={active.messages}
            visibleTurnId={visibleTurn}
            onJump={(turnId) => viewRef.current?.jumpTo(turnId)}
          />
        );
      case 'memory':
        return <MemoryPanel memory={memory} />;
      case 'files':
        return (
          <FilesPanel
            conversationId={active.conversationId}
            workspace={active.workspace}
            refreshKey={filesKey}
          />
        );
    }
  })();

  return (
    <main className="app">
      <ReconnectBanner status={sidecar.status} onRestart={sidecar.restart} />
      {sidecar.errors.map((e) => (
        <section key={`${e.code}:${e.message}`} className="alert" role="alert" data-fatal={e.fatal}>
          <strong>
            {e.code === 'schema_incompatible' ? 'Configuración incompatible' : 'Error del agente'}
          </strong>
          <p>{e.message}</p>
        </section>
      ))}
      {appNotice && (
        <p className="notice notice--dismissable app__notice" data-tone="info" role="status">
          {appNotice}
          <button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={() => setAppNotice(null)}>
            ×
          </button>
        </p>
      )}

      <div className="app__body">
        <Sidebar
          state={sidebar}
          onToggle={(p) => setSidebar((s) => togglePanel(s, p))}
          onSettings={openSettings}
          badges={{ conversations: backgroundAttention }}
        >
          {panel}
        </Sidebar>
        <ConversationView
          key={active.conversationId}
          ref={viewRef}
          stream={active}
          connected={connected}
          onCommand={onCommand}
          onVisibleTurn={setVisibleTurn}
          models={conversations.models}
          onPickModel={conversations.setModel}
          onCloseModels={conversations.closeModels}
          confirmClear={confirmClear}
          onConfirmClear={() => {
            setConfirmClear(false);
            if (!isBusy(active)) conversations.clear();
            else setAppNotice('Espera a que termine la respuesta para vaciar la conversación.');
          }}
          onCancelClear={() => setConfirmClear(false)}
        />
      </div>

      <StatusBar
        sidecar={sidecar}
        stats={active.stats}
        workspace={active.workspace}
        generating={generating}
        queued={queued}
      />

      {settingsOpen && (
        <SettingsPanel
          config={config}
          connected={sidecar.status.state === 'connected'}
          onClose={() => {
            setSettingsOpen(false);
            viewRef.current?.focusInput();
          }}
          onOpenMemory={() => {
            setSettingsOpen(false);
            openPanel('memory');
          }}
        />
      )}
    </main>
  );
}
