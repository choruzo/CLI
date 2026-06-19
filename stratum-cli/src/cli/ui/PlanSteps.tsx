import React from 'react';
import { Box, Text } from 'ink';
import type { PlanStep, PlanStepStatus } from '../../agent/types.js';

/** Iconos y colores de estado de paso (UI §5.4, compartidos Fase 2 / Fase 3). */
const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: '○',
  in_progress: '◐',
  done: '✓',
  skipped: '⊘',
};

const STATUS_COLOR: Record<PlanStepStatus, string> = {
  pending: '#4B5563',
  in_progress: '#F59E0B',
  done: '#34D399',
  skipped: '#6B7280',
};

interface Props {
  steps: PlanStep[];
  /** Índice del paso enfocado en edición inline (resalta la línea). */
  focusedIndex?: number;
}

/**
 * Lista numerada de pasos con icono de estado. Render compartido entre
 * <PlanView> (Fase 3, compacto y pinned) y <PlanApproval> (Fase 2, gate).
 */
export function PlanSteps({ steps, focusedIndex }: Props) {
  return (
    <Box flexDirection="column">
      {steps.map((step, i) => {
        const icon = STATUS_ICON[step.status];
        const color = STATUS_COLOR[step.status];
        const focused = focusedIndex === i;
        return (
          <Box key={step.id}>
            <Text color={color} dimColor={step.status === 'skipped'}>
              {'  '}
              {icon}{' '}
            </Text>
            <Text color={focused ? '#F3F4F6' : '#9CA3AF'} bold={focused}>
              {focused ? '❯ ' : ''}
              {i + 1}. {step.title}
              {step.detail ? <Text color="#6B7280"> — {step.detail}</Text> : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
