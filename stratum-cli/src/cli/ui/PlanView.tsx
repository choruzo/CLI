import React from 'react';
import { Box, Text } from 'ink';
import type { Plan } from '../../agent/types.js';
import { PlanSteps } from './PlanSteps.js';
import { theme } from './theme.js';

interface Props {
  plan: Plan;
}

/**
 * Vista compacta del plan durante la ejecución (Fase 3, UI §5.4). Se ancla
 * (pinned) bajo la <StatusBar> y actualiza el estado de cada paso conforme el
 * modelo llama a update_plan. Cabecera `Plan · N/total` con el contador de
 * pasos done/skipped sobre el total.
 */
export function PlanView({ plan }: Props) {
  const total = plan.steps.length;
  const finished = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderSubtle} paddingX={1}>
      <Text color={theme.textFaint}>
        Plan · {finished}/{total}
      </Text>
      <PlanSteps steps={plan.steps} />
    </Box>
  );
}
