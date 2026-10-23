import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';

/** Lo que `StratumAgent.planRevert` calcula antes de tocar nada (UX-1). */
export interface RevertPlanView {
  turns: number[];
  restore: string[];
  remove: string[];
  conflicts: string[];
  skipped: string[];
}

interface Props {
  plan: RevertPlanView;
  /** Qué no se deshace (`REVERT_SCOPE_NOTE`). */
  scopeNote: string;
  onConfirm: (force: boolean) => void;
  onCancel: () => void;
  /** Filas por lista antes de resumir con `+N`. */
  maxRows?: number;
}

function turnsTitle(turns: number[]): string {
  if (turns.length === 1) return `el turno ${turns[0]}`;
  const sorted = [...turns].sort((a, b) => a - b);
  return `los turnos ${sorted[0]}–${sorted.at(-1)} (${turns.length})`;
}

function FileRows({
  label,
  paths,
  color,
  labelColor,
  maxRows,
}: {
  label: string;
  paths: string[];
  color: string;
  labelColor: string;
  maxRows: number;
}) {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, maxRows);
  const hidden = paths.length - shown.length;
  return (
    <Box>
      <Box width={12} flexShrink={0}>
        <Text color={labelColor}>{label}</Text>
      </Box>
      <Box flexDirection="column">
        {shown.map((p) => (
          <Text key={p} color={color} wrap="truncate-start">
            {p}
          </Text>
        ))}
        {hidden > 0 && <Text color={theme.textDisabled}>+{hidden} más</Text>}
      </Box>
    </Box>
  );
}

/**
 * Confirmación de `/undo` y `/rewind` (UX-1). Enseña exactamente qué ficheros
 * vuelven atrás antes de tocar nada. Si alguno cambió después del turno
 * (conflicto), Enter no basta: deshacer pisaría ese cambio, así que hace falta
 * un gesto distinto (`f`). Es la misma idea que el `confirm-always`: lo que
 * puede perder trabajo no se aprueba por reflejo.
 */
export function RevertConfirm({ plan, scopeNote, onConfirm, onCancel, maxRows = 6 }: Props) {
  const hasConflicts = plan.conflicts.length > 0;
  const nothing = plan.restore.length === 0 && plan.remove.length === 0;

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'n') {
      onCancel();
      return;
    }
    if (nothing) {
      if (key.return) onCancel();
      return;
    }
    if (key.return && !hasConflicts) onConfirm(false);
    else if (input.toLowerCase() === 'f' && hasConflicts) onConfirm(true);
  });

  const border = hasConflicts ? theme.warning : theme.accent;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={border} paddingX={1}>
      <Text color={border} bold>
        ↶ Deshacer {turnsTitle(plan.turns)}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <FileRows
          label="restaurar"
          paths={plan.restore}
          color={theme.textResponse}
          labelColor={theme.textMuted}
          maxRows={maxRows}
        />
        <FileRows
          label="borrar"
          paths={plan.remove}
          color={theme.textResponse}
          labelColor={theme.textMuted}
          maxRows={maxRows}
        />
        <FileRows
          label="⚠ cambiado"
          paths={plan.conflicts}
          color={theme.warning}
          labelColor={theme.warning}
          maxRows={maxRows}
        />
        <FileRows
          label="sin copia"
          paths={plan.skipped}
          color={theme.textFaint}
          labelColor={theme.textFaint}
          maxRows={maxRows}
        />
        {nothing && <Text color={theme.textMuted}>No hay ficheros que devolver atrás.</Text>}
      </Box>
      {hasConflicts && (
        <Text color={theme.warning}>
          Los marcados con ⚠ se tocaron después del turno: deshacer pisaría esos cambios.
        </Text>
      )}
      {plan.skipped.length > 0 && (
        <Text color={theme.textFaint}>
          Los «sin copia» superaban el límite de tamaño y se quedan como están.
        </Text>
      )}
      <Text color={theme.textDisabled}>{scopeNote}</Text>
      <Box marginTop={1}>
        {nothing ? (
          <Text color={theme.textMuted}>Enter / Esc cerrar</Text>
        ) : hasConflicts ? (
          <Text color={theme.textMuted}>
            <Text color={theme.warning} bold>
              f
            </Text>{' '}
            deshacer igualmente · <Text bold>Esc</Text> cancelar
          </Text>
        ) : (
          <Text color={theme.textMuted}>
            <Text color={theme.accent} bold>
              Enter
            </Text>{' '}
            deshacer · <Text bold>Esc</Text> cancelar
          </Text>
        )}
      </Box>
    </Box>
  );
}
