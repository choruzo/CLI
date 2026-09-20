import React from 'react';
import { Box, Text } from 'ink';
import type { PlanStep } from '../../agent/types.js';
import type { TodoItem } from '../../agent/todo.js';
import { TODO_VISIBLE_ROWS, isTodoOpen } from '../../agent/todo.js';
import { PlanSteps } from './PlanSteps.js';
import { theme } from './theme.js';

interface Props {
  items: TodoItem[];
  /** Turnos con tareas abiertas y sin que el modelo tocara la lista. */
  stale: number;
  maxSteps?: number;
}

/**
 * Panel compacto de la lista de tareas (Hito 11, UI §5.9). Mismo lenguaje
 * visual que <PlanView>: se ancla bajo la <StatusBar> y reutiliza <PlanSteps>,
 * porque el vocabulario de estado es el mismo (`○ ◐ ✓ ⊘`) y dos juegos de
 * iconos para lo mismo confundirían al usuario.
 *
 * Cuando la lista no cabe en `TODO_VISIBLE_ROWS`, las tareas terminadas colapsan
 * a un contador: lo que importa es lo que queda abierto.
 */
export function TodoView({ items, stale, maxSteps = TODO_VISIBLE_ROWS }: Props) {
  if (items.length === 0) return null;

  const total = items.length;
  const open = items.filter(isTodoOpen);
  const finished = total - open.length;
  const collapse = total > TODO_VISIBLE_ROWS && finished > 0;
  const candidates = collapse ? open : items;
  const visible = candidates.slice(0, maxSteps);
  const hidden = candidates.length - visible.length;

  const steps: PlanStep[] = visible.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
  }));

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderSubtle} paddingX={1}>
      <Box>
        <Text color={theme.textFaint}>
          Todo · {finished}/{total}
        </Text>
        {stale > 0 && (
          <Text color={theme.warning}>
            {'  '}⚠ {stale} turno{stale === 1 ? '' : 's'} sin actualizar
          </Text>
        )}
      </Box>
      <PlanSteps steps={steps} />
      {hidden > 0 && <Text color={theme.textDisabled}> … {hidden} tareas fuera de vista</Text>}
      {collapse && <Text color={theme.textDisabled}> ✓ {finished} completadas</Text>}
    </Box>
  );
}
