import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Plan, PlanStep } from '../../agent/types.js';
import { PlanSteps } from './PlanSteps.js';
import { theme } from './theme.js';

interface Props {
  plan: Plan;
  onApprove: (plan: Plan) => void;
  onReject: () => void;
}

type EditMode = 'review' | 'edit' | 'editing-text';

let _newId = 0;
function freshId(): string {
  return `new-${Date.now()}-${_newId++}`;
}

/** Renumera ids secuenciales tras reordenar/borrar (mantiene status). */
function renumber(steps: PlanStep[]): PlanStep[] {
  return steps.map((s, i) => ({ ...s, id: `step-${i + 1}` }));
}

/**
 * Gate de aprobación del plan (Fase 2, UI §5.4). Bloquea el input hasta que el
 * usuario apruebe, edite o rechace. La edición es inline (fallback a $EDITOR de
 * la spec): ↑↓ navega, Enter edita el texto del paso, d borra, a añade, A aprueba.
 */
export function PlanApproval({ plan, onApprove, onReject }: Props) {
  const [steps, setSteps] = useState<PlanStep[]>(plan.steps);
  const [mode, setMode] = useState<EditMode>('review');
  const [focus, setFocus] = useState(0);
  const [draft, setDraft] = useState('');

  const current = (): Plan => ({ summary: plan.summary, steps: renumber(steps) });

  useInput(
    (input, key) => {
      const ch = input.toLowerCase();

      if (mode === 'review') {
        if (ch === 'a' || key.return) {
          onApprove(current());
        } else if (ch === 'e') {
          setMode('edit');
          setFocus(0);
        } else if (ch === 'r' || key.escape) {
          onReject();
        }
        return;
      }

      if (mode === 'edit') {
        if (key.upArrow) {
          setFocus((f) => (f - 1 + steps.length) % Math.max(steps.length, 1));
        } else if (key.downArrow) {
          setFocus((f) => (f + 1) % Math.max(steps.length, 1));
        } else if (key.return) {
          // Editar el texto del paso enfocado
          if (steps[focus]) {
            setDraft(steps[focus]!.title);
            setMode('editing-text');
          }
        } else if (ch === 'd') {
          // Borrar el paso enfocado
          setSteps((prev) => {
            const next = prev.filter((_, i) => i !== focus);
            return next;
          });
          setFocus((f) => Math.max(0, Math.min(f, steps.length - 2)));
        } else if (ch === 'a') {
          // Aprobar el plan editado
          onApprove(current());
        } else if (input === '+' || ch === 'n') {
          // Añadir un paso nuevo en blanco y editarlo
          const step: PlanStep = { id: freshId(), title: 'Nuevo paso', status: 'pending' };
          setSteps((prev) => {
            const next = [...prev];
            next.splice(focus + 1, 0, step);
            return next;
          });
          setFocus((f) => Math.min(f + 1, steps.length));
          setDraft('Nuevo paso');
          setMode('editing-text');
        } else if (key.escape) {
          setMode('review');
        }
        return;
      }
      // mode === 'editing-text' → el TextInput gestiona las teclas
    },
    { isActive: mode !== 'editing-text' },
  );

  const submitText = (value: string): void => {
    const v = value.trim();
    setSteps((prev) => prev.map((s, i) => (i === focus ? { ...s, title: v || s.title } : s)));
    setMode('edit');
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.borderSubtle}
      paddingX={1}
    >
      <Text color={theme.accent} bold>
        Plan propuesto
      </Text>
      <Text> </Text>
      <Text color={theme.textPrimary}>
        {'  '}
        {plan.summary}
      </Text>
      <Text> </Text>

      <PlanSteps steps={renumber(steps)} focusedIndex={mode !== 'review' ? focus : undefined} />
      <Text> </Text>

      {mode === 'review' && (
        <Text>
          {'  '}
          <Text color={theme.accent} bold>
            [ A ]
          </Text>
          <Text color={theme.textMuted}> aprobar </Text>
          <Text color="#22D3EE" bold>
            [ E ]
          </Text>
          <Text color={theme.textMuted}> editar </Text>
          <Text color={theme.error} bold>
            [ R ]
          </Text>
          <Text color={theme.textMuted}> rechazar</Text>
        </Text>
      )}

      {mode === 'edit' && (
        <Text color={theme.textDisabled}>
          {'  '}↑↓ navegar · Enter editar · d borrar · n añadir · A aprobar · Esc volver
        </Text>
      )}

      {mode === 'editing-text' && (
        <Box>
          <Text color={theme.accent}>{'  '}❯ </Text>
          <TextInput value={draft} onChange={setDraft} onSubmit={submitText} showCursor />
        </Box>
      )}
    </Box>
  );
}
