import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { ToolCallBlock, type ToolCallState } from './ToolCallBlock.js';
import { SubagentBlock, type SubagentBlockState } from './SubagentBlock.js';
import { AgentTree } from './AgentTree.js';
import { StreamingText } from './StreamingText.js';
import { MarkdownText } from './MarkdownText.js';
import { InitProgressBlock, type InitStep } from './InitProgressBlock.js';

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
  /** Bloques `⊙ thinking` (§11). Solo llegan con `/debug` activo. */
  thinkingBlocks?: string[];
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
  const hiddenActions = toolCalls.length + subs.length - visibleToolCalls.length - visibleSubs.length;
  const isInit = initSteps !== undefined || initSummary !== undefined;
  const hasContent =
    toolCalls.length > 0 || subs.length > 0 || text || isInit || thinkingBlocks?.length;
  if (!hasContent) return null;

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
      {(streaming ? thinkingBlocks?.slice(-2) : thinkingBlocks)?.map((t, i) => (
        <Box key={`think-${i}`} marginLeft={2}>
          <Text color={theme.textDisabled} dimColor wrap="truncate-end">
            ⊙ thinking {t.replace(/\s+/g, ' ').trim()}
          </Text>
        </Box>
      ))}
      {!isInit &&
        visibleToolCalls.map((tc) => (
          <ToolCallBlock
            key={tc.id}
            state={tc}
            focused={focusedBlockId === tc.id}
            expanded={expandedBlockIds?.has(tc.id) ?? false}
            now={now}
          />
        ))}
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
    </Box>
  );
}
