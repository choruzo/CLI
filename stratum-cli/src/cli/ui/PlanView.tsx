import React from 'react';
import { Box, Text } from 'ink';
import type { Plan } from '../../agent/types.js';
import { PlanSteps } from './PlanSteps.js';
import { theme } from './theme.js';

interface Props {
  plan: Plan;
  maxSteps?: number;
}

/**
 * Vista compacta del plan durante la ejecución (Fase 3, UI §5.4). Se ancla
 * (pinned) bajo la <StatusBar> y actualiza el estado de cada paso conforme el
 * modelo llama a update_plan. Cabecera `Plan · N/total` con el contador de
 * pasos done/skipped sobre el total.
 */
export function PlanView({ plan, maxSteps = 5 }: Props) {
  const total = plan.steps.length;
  const finished = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const activeIndex = plan.steps.findIndex((s) => s.status === 'in_progress');
  const start =
    plan.steps.length <= maxSteps
      ? 0
      : activeIndex >= 0
        ? Math.min(activeIndex, plan.steps.length - maxSteps)
        : Math.min(Math.max(0, finished - 1), plan.steps.length - maxSteps);
  const visible = plan.steps.slice(start, start + maxSteps);
  const hidden = plan.steps.length - visible.length;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderSubtle} paddingX={1}>
      <Text color={theme.textFaint}>
        Plan · {finished}/{total}
      </Text>
      <PlanSteps steps={visible} />
      {hidden > 0 && <Text color={theme.textDisabled}> … {hidden} pasos fuera de vista</Text>}
    </Box>
  );
}
