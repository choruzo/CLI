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
}: Props) {
  const subs = subagents ?? [];
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
      {isInit && <InitProgressBlock steps={initSteps ?? []} summary={initSummary} />}
      {thinkingBlocks?.map((t, i) => (
        <Box key={`think-${i}`} marginLeft={2}>
          <Text color={theme.textDisabled} dimColor wrap="truncate-end">
            ⊙ thinking {t.replace(/\s+/g, ' ').trim()}
          </Text>
        </Box>
      ))}
      {!isInit &&
        toolCalls.map((tc) => (
          <ToolCallBlock
            key={tc.id}
            state={tc}
            focused={focusedBlockId === tc.id}
            expanded={expandedBlockIds?.has(tc.id) ?? false}
          />
        ))}
      {/* Hito 8C: >1 subagente en el turno ⇒ árbol vivo; 1 solo ⇒ bloque plano (§5.6). */}
      {subs.length > 1 ? (
        <AgentTree
          nodes={subs}
          speakingId={speakingSubagentId}
          maxConcurrency={maxConcurrency ?? 1}
          focusedBlockId={focusedBlockId}
          expandedBlockIds={expandedBlockIds}
        />
      ) : (
        subs.map((sa) => (
          <SubagentBlock
            key={sa.id}
            state={sa}
            focused={focusedBlockId === sa.id}
            expanded={expandedBlockIds?.has(sa.id) ?? false}
          />
        ))
      )}
      {text &&
        (streaming ? <StreamingText text={text} streaming={true} /> : <MarkdownText text={text} />)}
    </Box>
  );
}
