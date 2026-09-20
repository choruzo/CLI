import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { spinnerFrameAt } from './spinner.js';

export type InitStepStatus = 'running' | 'completed' | 'failed' | 'note';

export interface InitStep {
  /** Identidad estable del paso: los upserts de `INIT_STEP` casan por aquí. */
  id: string;
  label: string;
  status: InitStepStatus;
  /** Texto corto a la derecha del paso (resultado, aviso…). */
  detail?: string;
}

/**
 * Bloque de progreso de `/init` (UI §5.2).
 *
 * Mientras corre se pinta una caja con un paso por operación del agente; al
 * terminar colapsa a una única línea de resumen más el tip.
 *
 * Nota: la spec original describía un `InitAgent` que emitía `InitEvent`s con
 * un sub-prompt de conflicto de merge. Esa arquitectura se descartó en el
 * Hito 2.5 — `/init` es un comando-plantilla que ejecuta el agente general, y
 * la escritura de STRATUM.md ya pasa por el gate destructivo de `write_file`.
 * Este componente presenta los eventos reales de ese flujo.
 */
interface Props {
  steps: InitStep[];
  /** Presente solo cuando `/init` ha terminado: colapsa el bloque. */
  summary?: string;
  now?: number;
}

function StepIcon({ status, now }: { status: InitStepStatus; now: number }) {
  if (status === 'running') return <Text color={theme.accent}>{spinnerFrameAt(now)}</Text>;
  if (status === 'completed') return <Text color={theme.success}>✓</Text>;
  if (status === 'failed') return <Text color={theme.error}>✗</Text>;
  return <Text color={theme.textDisabled}>·</Text>;
}

export function InitProgressBlock({ steps, summary, now = Date.now() }: Props) {
  if (summary) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.textResponse}>{summary}</Text>
        </Box>
        <Text color={theme.textFaint} dimColor>
          {'  '}Tip: edita STRATUM.md para añadir instrucciones permanentes al agente.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderSubtle} paddingX={1}>
      <Text color={theme.textFaint} dimColor>
        Escaneando proyecto
      </Text>
      {steps.map((step) => (
        <Box key={step.id}>
          <StepIcon status={step.status} now={now} />
          <Text color={theme.textMuted}> {step.label}</Text>
          {step.detail && (
            <Text color={theme.textFaint} dimColor wrap="truncate-end">
              {'  '}
              {step.detail}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
