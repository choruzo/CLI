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
  /** Plegado (`Ctrl+T`, `/todo`): una sola línea con el progreso y la tarea en curso. */
  collapsed?: boolean;
}

/**
 * Panel compacto de la lista de tareas (Hito 11, UI §5.9). Mismo lenguaje
 * visual que <PlanView>: se ancla encima del input y reutiliza <PlanSteps>,
 * porque el vocabulario de estado es el mismo (`○ ◐ ✓ ⊘`) y dos juegos de
 * iconos para lo mismo confundirían al usuario.
 *
 * Cuando la lista no cabe en `TODO_VISIBLE_ROWS`, las tareas terminadas colapsan
 * a un contador: lo que importa es lo que queda abierto.
 */
export function TodoView({ items, stale, maxSteps = TODO_VISIBLE_ROWS, collapsed = false }: Props) {
  if (items.length === 0) return null;

  const total = items.length;
  const open = items.filter(isTodoOpen);
  const finished = total - open.length;

  // Plegado no desaparece: la lista sigue ahí y se ve cuánto queda y en qué está.
  if (collapsed) {
    const current = items.find((item) => item.status === 'in_progress') ?? open[0];
    return (
      <Box paddingX={1}>
        <Text color={theme.textFaint} wrap="truncate-end">
          ▸ Todo · {finished}/{total}
          {current && <Text color={theme.warning}> · ◐ </Text>}
          {current && <Text color={theme.textMuted}>{current.title}</Text>}
          {stale > 0 && <Text color={theme.warning}> · ⚠</Text>}
          <Text color={theme.textDisabled}> · ctrl+t desplegar</Text>
        </Text>
      </Box>
    );
  }
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
      <Box justifyContent="space-between">
        <Box>
          <Text color={theme.textFaint}>
            ▾ Todo · {finished}/{total}
          </Text>
          {stale > 0 && (
            <Text color={theme.warning}>
              {'  '}⚠ {stale} turno{stale === 1 ? '' : 's'} sin actualizar
            </Text>
          )}
        </Box>
        <Text color={theme.textDisabled}>ctrl+t ocultar</Text>
      </Box>
      <PlanSteps steps={steps} />
      {hidden > 0 && <Text color={theme.textDisabled}> … {hidden} tareas fuera de vista</Text>}
      {collapse && <Text color={theme.textDisabled}> ✓ {finished} completadas</Text>}
    </Box>
  );
}
