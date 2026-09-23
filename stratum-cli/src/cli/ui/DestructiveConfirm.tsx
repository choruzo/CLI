import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';

interface Props {
  toolName: string;
  description: string;
  /**
   * Hito 17 — confirmación con nombre: para aprobar hay que teclear este texto
   * (el alias del target). Sin él, la confirmación de siempre (S/N/!).
   */
  confirmPhrase?: string;
  /** Hito 17 — entorno del target que se va a cambiar. */
  environment?: { name: string; tier: 'production' | 'staging' | 'development' };
  /** Hito 17 — entorno `confirm-always`: no se ofrece «permitir todo». */
  forced?: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onAllowAll: () => void;
}

/** ¿Coincide lo tecleado con la frase? Exacto salvo espacios de los bordes. */
export function typedPhraseMatches(typed: string, phrase: string): boolean {
  return typed.trim() === phrase;
}

function tierColor(tier: string | undefined): string {
  if (tier === 'production') return theme.error;
  if (tier === 'staging') return theme.warning;
  return theme.accent;
}

/**
 * Bloque de confirmación para operaciones destructivas (UI spec §12).
 * Se renderiza entre el área de conversación y el input; el input queda
 * bloqueado hasta que el usuario responda.
 *
 * S / Y / Enter → aprobar · N / Esc → cancelar · ! → permitir todo en la sesión
 *
 * Hito 17 — con `confirmPhrase` (entorno con `confirmation: typed`) no hay
 * atajo: se teclea el alias y Enter. Es la diferencia entre aprobar por
 * reflejo y aprobar sabiendo dónde.
 */
export function DestructiveConfirm({
  description,
  confirmPhrase,
  environment,
  forced,
  onApprove,
  onDeny,
  onAllowAll,
}: Props) {
  const [typed, setTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const typedMode = confirmPhrase !== undefined;

  useInput((input, key) => {
    if (typedMode) {
      if (key.escape) onDeny();
      return;
    }
    const ch = input.toLowerCase();
    if (ch === 's' || ch === 'y' || key.return) {
      onApprove();
    } else if (ch === 'n' || key.escape) {
      onDeny();
    } else if (input === '!' && !forced) {
      onAllowAll();
    }
  });

  const color = environment ? tierColor(environment.tier) : theme.accent;
  const title = environment
    ? `⚠ Cambio en ${environment.name} (${environment.tier})`
    : '⚠ Operación destructiva';

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={color} paddingX={1} marginTop={0}>
      <Text color={color} bold>
        {title}
      </Text>
      <Text> </Text>
      <Text color={theme.textPrimary} wrap="truncate-end">
        {'  '}
        {description}
      </Text>
      <Text> </Text>
      {typedMode ? (
        <>
          <Box>
            <Text color={theme.textMuted}>{'  '}Escribe </Text>
            <Text color={color} bold>
              {confirmPhrase}
            </Text>
            <Text color={theme.textMuted}> para confirmar (Esc cancela): </Text>
            <TextInput
              value={typed}
              onChange={(v) => {
                setTyped(v);
                setMismatch(false);
              }}
              onSubmit={(v) => {
                if (typedPhraseMatches(v, confirmPhrase)) onApprove();
                else setMismatch(true);
              }}
            />
          </Box>
          {mismatch && (
            <Text color={theme.error}>
              {'  '}No coincide. Escribe exactamente «{confirmPhrase}», o Esc para cancelar.
            </Text>
          )}
        </>
      ) : (
        <Text>
          {'  '}
          <Text color={theme.textMuted}>¿Continuar? </Text>
          <Text color={theme.accent} bold>
            [ S ]
          </Text>
          <Text color={theme.textMuted}> continuar </Text>
          <Text color={theme.error} bold>
            [ N ]
          </Text>
          <Text color={theme.textMuted}> cancelar</Text>
          {!forced && (
            <>
              <Text color={theme.warning} bold>
                {' '}
                [ ! ]
              </Text>
              <Text color={theme.textMuted}> permitir todo</Text>
            </>
          )}
        </Text>
      )}
    </Box>
  );
}
