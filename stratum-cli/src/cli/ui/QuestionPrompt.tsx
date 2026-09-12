import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { QuestionAnswer, QuestionItem } from '../../agent/types.js';
import { SelectList } from './components/SelectList.js';
import { theme } from './theme.js';

interface Props {
  questions: QuestionItem[];
  /** Respuestas de toda la tanda, en el mismo orden que `questions`. */
  onSubmit: (answers: QuestionAnswer[]) => void;
  /** El usuario omitió la tanda (Esc / Ctrl-C): el agente sigue con supuestos. */
  onCancel: () => void;
}

/** Valor centinela de la opción "escribir otra respuesta" del selector. */
const FREE_TEXT = '\u0000free-text';

/**
 * Tanda única de preguntas del agente (Hito 2.5, F7). Bloquea el input como los
 * demás gates (destructivo, aprobación de plan) y avanza pregunta a pregunta:
 * con opciones ↑↓/Enter, sin opciones (o eligiendo "otra respuesta") texto libre.
 * Esc omite toda la tanda.
 */
export function QuestionPrompt({ questions, onSubmit, onCancel }: Props) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswer[]>([]);
  const [freeText, setFreeText] = useState(false);
  const [draft, setDraft] = useState('');

  const current = questions[index];
  const typing = freeText || !current?.options || current.options.length === 0;

  // `optionId` viaja tal cual al loop: es el token opaco de la opción elegida
  // (§3 de gentle-pi). Sin él, el loop tendría que reconocer la etiqueta por
  // texto, y una etiqueta ambigua o reordenada se convertiría en otra elección.
  const advance = (answer: string, optionId?: string): void => {
    const next = [
      ...answers,
      {
        question: current?.question ?? '',
        answer: answer.trim(),
        ...(optionId ? { optionId } : {}),
      },
    ];
    if (index + 1 >= questions.length) {
      onSubmit(next);
      return;
    }
    setAnswers(next);
    setIndex(index + 1);
    setFreeText(false);
    setDraft('');
  };

  // Esc cancela la tanda entera. Con opciones lo gestiona <SelectList>; en modo
  // texto, el TextInput no ve Esc, así que se captura aquí.
  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: typing },
  );

  if (!current) return null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderAccent} paddingX={1}>
      <Text color={theme.accent} bold>
        Preguntas del agente
        <Text color={theme.textMuted} bold={false}>
          {'  ·  '}
          {index + 1}/{questions.length}
        </Text>
      </Text>
      <Text> </Text>
      <Text color={theme.textPrimary}>
        {'  '}
        {current.question}
      </Text>
      <Text> </Text>

      {typing ? (
        <>
          <Box>
            <Text color={theme.accent}>{'  '}❯ </Text>
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) => advance(v)}
              placeholder="tu respuesta"
              showCursor
            />
          </Box>
          <Text color={theme.textDisabled}>{'  '}Enter responder · Esc omitir las preguntas</Text>
        </>
      ) : (
        <>
          <SelectList
            items={[
              ...current.options!.map((o) => ({ label: o.label, value: o.id })),
              // "Escribir otra respuesta" solo cuando la pregunta lo admite:
              // con opciones y sin allowCustom, el dominio son las opciones y
              // el loop descartaría cualquier otra cosa.
              ...(current.allowCustom
                ? [{ label: '✎ Escribir otra respuesta…', value: FREE_TEXT }]
                : []),
            ]}
            onSelect={(item) => {
              if (item.value === FREE_TEXT) {
                setFreeText(true);
                setDraft('');
                return;
              }
              const option = current.options!.find((o) => o.id === item.value);
              if (option) advance(option.label, option.id);
            }}
            onCancel={onCancel}
          />
          <Text color={theme.textDisabled}>
            {'  '}↑↓ seleccionar · Enter responder · Esc omitir las preguntas
          </Text>
        </>
      )}
    </Box>
  );
}
