import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { useSpinnerFrame } from './spinner.js';
import type { McpManager } from '../../tools/mcp/manager.js';

const POLL_MS = 100;

type ServerPhase = 'connecting' | 'connected' | 'failed' | 'timeout';

interface ServerRow {
  name: string;
  phase: ServerPhase;
  /** ms transcurridos hasta que el server dejó de estar 'connecting'. */
  elapsedMs?: number;
}

interface Props {
  manager: McpManager;
  /** `startupTimeout` por server, para distinguir un timeout de un fallo. */
  timeouts: Record<string, number>;
  /** Se invoca una sola vez, cuando ningún server sigue conectando. */
  onAllSettled: () => void;
}

function StatusIcon({ phase }: { phase: ServerPhase }) {
  const frame = useSpinnerFrame(phase === 'connecting');
  if (phase === 'connecting') return <Text color={theme.accent}>{frame}</Text>;
  if (phase === 'connected') return <Text color={theme.success}>✓</Text>;
  return <Text color={theme.error}>✗</Text>;
}

/**
 * Panel de arranque de MCP servers (UI §14).
 *
 * Solo se monta cuando `mcp.startup === 'eager'`: con el modo `lazy` (default
 * desde el Hito 4.1) la conexión va en background y el banner no debe esperar
 * a nada. El prompt y los tips se retrasan hasta `onAllSettled`.
 *
 * La fuente de verdad es el estado de los clientes del manager; el
 * `startupTimeout` lo aplica el propio `McpServerClient`, aquí solo se
 * etiqueta el resultado.
 */
export function MCPStartup({ manager, timeouts, onAllSettled }: Props) {
  const startedAt = useRef(Date.now());
  const settledRef = useRef(false);
  const [rows, setRows] = useState<ServerRow[]>(() =>
    manager.getClients().map((c) => ({ name: c.name, phase: 'connecting' as const })),
  );

  useEffect(() => {
    const iv = setInterval(() => {
      const elapsed = Date.now() - startedAt.current;

      setRows((prev) => {
        const byName = new Map(prev.map((r) => [r.name, r]));
        const next = manager.getClients().map((client): ServerRow => {
          const known = byName.get(client.name);
          // Ya resuelto: conservar la fase y la duración de entonces.
          if (known && known.phase !== 'connecting') return known;

          if (client.status === 'connected') {
            return { name: client.name, phase: 'connected', elapsedMs: elapsed };
          }
          if (client.status === 'disconnected') {
            const limit = timeouts[client.name];
            const phase: ServerPhase =
              limit !== undefined && elapsed >= limit ? 'timeout' : 'failed';
            return { name: client.name, phase, elapsedMs: elapsed };
          }
          return { name: client.name, phase: 'connecting' };
        });
        return next;
      });
    }, POLL_MS);

    return () => clearInterval(iv);
  }, [manager, timeouts]);

  useEffect(() => {
    if (settledRef.current) return;
    if (rows.length === 0 || rows.every((r) => r.phase !== 'connecting')) {
      settledRef.current = true;
      onAllSettled();
    }
  }, [rows, onAllSettled]);

  const width = Math.max(0, ...rows.map((r) => r.name.length));

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color={theme.textFaint} dimColor>
        Conectando servicios...
      </Text>
      {rows.map((row) => (
        <Box key={row.name}>
          <StatusIcon phase={row.phase} />
          <Text color={theme.textMuted}> {row.name.padEnd(width)}</Text>
          <Text color={theme.textFaint} dimColor>
            {'  '}
            {row.phase === 'connecting' && '(conectando...)'}
            {row.phase === 'connected' && `(${row.elapsedMs}ms)`}
            {row.phase === 'failed' && '(no disponible)'}
            {row.phase === 'timeout' && '(timeout)'}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
