import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { ToolCallBlock, type ToolCallState } from './ToolCallBlock.js';
import { SubagentBlock, type SubagentBlockState } from './SubagentBlock.js';
import { AgentTree } from './AgentTree.js';
import { StreamingText } from './StreamingText.js';
import { MarkdownText } from './MarkdownText.js';
import { InitProgressBlock, type InitStep } from './InitProgressBlock.js';
import { reasoningPreview } from './reasoning-preview.js';
import { ToolGroupBlock } from './ToolGroupBlock.js';
import { groupToolCalls, type Verbosity } from './tool-groups.js';
import { turnUsageParts, type UsageView } from './telemetry-format.js';

interface Props {
  text: string;
  toolCalls: ToolCallState[];
  /** Bloques de subagente delegados en el turno (Hito 8A). */
  subagents?: SubagentBlockState[];
  /** Subagente que emitió el evento más reciente (Hito 8C, marcador ▶ del árbol). */
  speakingSubagentId?: string | null;
  /** maxConcurrency del turno de delegación (Hito 8C, cabecera del árbol). */
  maxConcurrency?: number;
  streaming: boolean;
  /** id del tool call block enfocado con Tab (si pertenece a este mensaje). */
  focusedBlockId?: string | null;
  /** ids de bloques con output expandido (Space). */
  expandedBlockIds?: ReadonlySet<string>;
  /** Pasos de `/init` (§5.2); presente solo en el turno que ejecuta `/init`. */
  initSteps?: InitStep[];
  /** Resumen de `/init` una vez terminado: colapsa el bloque de progreso. */
  initSummary?: string;
  /** Bloques de razonamiento (§11). */
  thinkingBlocks?: string[];
  /** El último bloque sigue llegando: se pinta su cola en vivo. */
  thinkingOpen?: boolean;
  /** `/debug`: el razonamiento entero; sin él, una línea plegada por bloque. */
  debug?: boolean;
  /**
   * `/verbosity` (UX-3). Solo afecta al turno cerrado: el vivo se pinta siempre
   * igual, porque es el que el usuario está siguiendo.
   */
  verbosity?: Verbosity;
  /** Uso del turno cerrado (UX-3): una línea al pie. */
  usage?: UsageView;
  /** Reloj único de la conversación; evita intervalos por bloque. */
  now?: number;
  /** Límites de la región viva para que Ink no reescriba todo el scrollback. */
  liveTextLines?: number;
  liveColumns?: number;
  liveActionLimit?: number;
}

/**
 * Turno del agente. Dual-mode (§5.3): <StreamingText> mientras streaming=true,
 * <MarkdownText> (marked + Ink) al recibir `done`. Ambos reciben el mismo
 * `text`, el swap ocurre en el mismo tick que la desaparición del cursor.
 */
export function AgentMessage({
  text,
  toolCalls,
  subagents,
  speakingSubagentId,
  maxConcurrency,
  streaming,
  focusedBlockId,
  expandedBlockIds,
  initSteps,
  initSummary,
  thinkingBlocks,
  thinkingOpen = false,
  debug = false,
  verbosity = 'standard',
  usage,
  now = Date.now(),
  liveTextLines = 12,
  liveColumns = 80,
  liveActionLimit = 6,
}: Props) {
  const subs = subagents ?? [];
  const visibleSubs = streaming ? subs.slice(-liveActionLimit) : subs;
  const remainingLiveActions = Math.max(0, liveActionLimit - visibleSubs.length);
  const visibleToolCalls = streaming
    ? remainingLiveActions > 0
      ? toolCalls.slice(-remainingLiveActions)
      : []
    : toolCalls;
  const hiddenActions =
    toolCalls.length + subs.length - visibleToolCalls.length - visibleSubs.length;
  const isInit = initSteps !== undefined || initSummary !== undefined;
  const hasContent =
    toolCalls.length > 0 || subs.length > 0 || text || isInit || thinkingBlocks?.length;
  if (!hasContent) return null;
  // Turno cerrado: `compact` y `standard` agrupan lo exploratorio; `verbose` lo
  // enseña todo, también el razonamiento entero. `compact` además lo pliega.
  const grouped = !streaming && verbosity !== 'verbose';
  const hideThinking = verbosity === 'compact';
  const showAllThinking = debug || verbosity === 'verbose';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.accent} bold>
        Stratum
      </Text>
      {/* `/init` (§5.2): sus tool calls se representan como pasos del bloque de
          progreso, no como <ToolCallBlock> sueltos. */}
      {isInit && (
        <InitProgressBlock
          steps={streaming ? (initSteps ?? []).slice(-liveActionLimit) : (initSteps ?? [])}
          summary={initSummary}
          now={now}
        />
      )}
      {(streaming ? thinkingBlocks?.slice(-2) : hideThinking ? [] : thinkingBlocks)?.map(
        (t, i, shown) => (
          <ThinkingLine
            key={`think-${i}`}
            text={t}
            live={streaming && thinkingOpen && i === shown.length - 1}
            debug={showAllThinking}
          />
        ),
      )}
      {!isInit &&
        (grouped
          ? groupToolCalls(visibleToolCalls).map((row) =>
              row.kind === 'group' ? (
                <ToolGroupBlock
                  key={row.id}
                  calls={row.calls}
                  detail={verbosity !== 'compact'}
                  columns={liveColumns}
                />
              ) : (
                <ToolCallBlock
                  key={row.call.id}
                  state={row.call}
                  focused={focusedBlockId === row.call.id}
                  expanded={expandedBlockIds?.has(row.call.id) ?? false}
                  now={now}
                />
              ),
            )
          : visibleToolCalls.map((tc) => (
              <ToolCallBlock
                key={tc.id}
                state={tc}
                focused={focusedBlockId === tc.id}
                expanded={expandedBlockIds?.has(tc.id) ?? false}
                now={now}
              />
            )))}
      {streaming && hiddenActions > 0 && (
        <Text color={theme.textDisabled} dimColor>
          … {hiddenActions} acción{hiddenActions === 1 ? '' : 'es'} anterior
          {hiddenActions === 1 ? '' : 'es'} fijada{hiddenActions === 1 ? '' : 's'} en el scrollback
        </Text>
      )}
      {/* Hito 8C: >1 subagente en el turno ⇒ árbol vivo; 1 solo ⇒ bloque plano (§5.6). */}
      {visibleSubs.length > 1 ? (
        <AgentTree
          nodes={visibleSubs}
          speakingId={speakingSubagentId}
          maxConcurrency={maxConcurrency ?? 1}
          focusedBlockId={focusedBlockId}
          expandedBlockIds={expandedBlockIds}
          now={now}
        />
      ) : (
        visibleSubs.map((sa) => (
          <SubagentBlock
            key={sa.id}
            state={sa}
            focused={focusedBlockId === sa.id}
            expanded={expandedBlockIds?.has(sa.id) ?? false}
            now={now}
          />
        ))
      )}
      {text &&
        (streaming ? (
          <StreamingText
            text={text}
            streaming={true}
            now={now}
            maxVisibleLines={liveTextLines}
            columns={liveColumns}
          />
        ) : (
          <MarkdownText text={text} />
        ))}
      {!streaming && usage && <TurnUsageLine usage={usage} compact={verbosity === 'compact'} />}
    </Box>
  );
}

/**
 * Una línea por bloque de razonamiento (UX-3). Plegada enseña el último párrafo
 * terminado (`reasoningPreview`), en cursiva y apagada: se lee de un vistazo y no
 * compite con la respuesta. Con `/debug`, el bloque entero.
 */
function ThinkingLine({ text, live, debug }: { text: string; live: boolean; debug: boolean }) {
  if (debug) {
    return (
      <Box marginLeft={2}>
        <Text color={theme.textDisabled} dimColor wrap="wrap">
          ⊙ thinking {text.replace(/\s+/g, ' ').trim()}
        </Text>
      </Box>
    );
  }
  const { preview, words } = reasoningPreview(text, live);
  const head = live ? '⊙ razonando' : '⊙ razonó';
  const count = `${words} palabra${words === 1 ? '' : 's'}`;
  return (
    <Box marginLeft={2}>
      <Text color={theme.textDisabled} wrap="truncate-end">
        <Text color={live ? theme.textFaint : theme.textDisabled}>{head}</Text>
        <Text dimColor> · {count}</Text>
        {preview ? (
          <Text color={theme.textFaint} italic>
            {'  '}
            {preview}
          </Text>
        ) : (
          <Text dimColor>{live ? '…' : ' · /debug para verlo'}</Text>
        )}
      </Text>
    </Box>
  );
}

/**
 * Pie del turno (UX-3): lo que costó, en una línea apagada. Va pegado al final
 * de la respuesta y por debajo de ella en jerarquía; el coste, si lo hay, un
 * punto más claro porque es el número que se busca.
 */
function TurnUsageLine({ usage, compact }: { usage: UsageView; compact: boolean }) {
  const parts = turnUsageParts(usage, compact);
  if (parts.length === 0) return null;
  const cost = usage.costUsd !== undefined ? parts.at(-1) : undefined;
  const rest = cost ? parts.slice(0, -1) : parts;
  return (
    <Box marginTop={0}>
      <Text color={theme.textDisabled} wrap="truncate-end">
        {'─ '}
        {rest.join(' · ')}
        {cost && (
          <Text color={theme.textFaint}>
            {rest.length > 0 ? ' · ' : ''}
            {cost}
          </Text>
        )}
      </Text>
    </Box>
  );
}
