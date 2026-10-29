import { describe, expect, it } from 'vitest';
import { exportSession } from './export.js';
import type { SessionContext } from './types.js';
import { redactSecrets } from '../security/redact-output.js';

const TOKEN = 'sk-proj-abc123def456ghi789jkl012';
const redact = (t: string) => redactSecrets(t).text;

const session: SessionContext = {
  id: 'sess-1',
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T10:05:00.000Z',
  provider: 'local',
  model: 'qwen',
  project: '/repo',
  toolCallCount: 1,
  summary: 'arreglar el build',
  messages: [
    { role: 'system', content: 'eres Stratum' },
    { role: 'user', content: `mi clave es ${TOKEN}` },
    {
      role: 'assistant',
      content: 'miro el fichero',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'exec', arguments: `{"command":"echo ${TOKEN}"}` },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'exec', content: 'salida con ```backticks```' },
    { role: 'assistant', content: 'hecho' },
  ],
};

describe('exportSession', () => {
  it('JSON: la sesión entera, con mensajes y argumentos redactados', () => {
    const out = exportSession(session, 'json', redact);
    expect(out).not.toContain(TOKEN);
    const parsed = JSON.parse(out) as SessionContext;
    expect(parsed.id).toBe('sess-1');
    expect(parsed.messages).toHaveLength(5);
    expect(parsed.messages[1]!.content).toContain('[redacted:');
    expect(parsed.messages[2]!.tool_calls![0]!.function.arguments).toContain('[redacted:');
    // No muta la sesión de entrada.
    expect(session.messages[1]!.content).toContain(TOKEN);
  });

  it('Markdown: conversación legible sin system prompt ni secretos', () => {
    const out = exportSession(session, 'markdown', redact);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('eres Stratum');
    expect(out).toMatch(/^# Sesión sess-1/);
    expect(out).toContain('## Usuario');
    expect(out).toContain('**→ exec**');
    expect(out).toContain('**← exec**');
    // La salida con ``` va en una valla más larga y no rompe el documento.
    expect(out).toContain('````\nsalida con ```backticks```\n````');
  });
});
