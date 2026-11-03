/**
 * Bridge MCP tools → ToolDefinition (§12.8).
 *
 * Convierte el catálogo descubierto de un McpServerClient en ToolDefinitions
 * listos para registrar en el ToolRegistry. El naming sigue la convención
 * mcp__<server>__<tool> para cumplir el regex ^[a-zA-Z0-9_-]+$ que imponen
 * las APIs OpenAI-compatible (la barra / de §12.8 la sustituimos por __).
 */

import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult } from '../../agent/types.js';
import type { McpServerClient, McpToolInfo } from './client.js';
import type { StratumConfig } from '../../config/schema.js';
import { callEffects } from '../environments.js';

import { mcpToolName } from './names.js';

export { MCP_TOOL_NAME_MAX, mcpToolName, parseMcpToolName, sanitizeSegment } from './names.js';

// ---------------------------------------------------------------------------
// Content block → string
// ---------------------------------------------------------------------------

type Block = { type?: unknown; [k: string]: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Tamaño aproximado en bytes de un base64, para describir un binario sin volcarlo. */
function base64Bytes(data: unknown): string {
  if (typeof data !== 'string') return '';
  return `, ${Math.floor((data.replace(/=+$/, '').length * 3) / 4)} bytes`;
}

function flattenBlock(block: Block): string {
  switch (block.type) {
    case 'text':
      return typeof block['text'] === 'string' ? block['text'] : String(block['text'] ?? '');
    case 'image':
    case 'audio':
      return `[${block.type}: ${String(block['mimeType'] ?? 'unknown')}${base64Bytes(block['data'])}]`;
    case 'resource': {
      // Recurso embebido: `{ type: 'resource', resource: { uri, mimeType, text | blob } }`.
      // El texto ES el resultado (un fichero leído, un documento): perderlo
      // dejaba al modelo con solo la URI.
      const res = isRecord(block['resource']) ? block['resource'] : {};
      const uri = String(res['uri'] ?? 'unknown');
      if (typeof res['text'] === 'string') return `[resource: ${uri}]\n${res['text']}`;
      const mime = res['mimeType'] ? `, ${String(res['mimeType'])}` : '';
      return `[resource: ${uri}${mime}, binary${base64Bytes(res['blob'])}]`;
    }
    case 'resource_link': {
      const label = block['name'] ? ` (${String(block['name'])})` : '';
      return `[resource link: ${String(block['uri'] ?? 'unknown')}${label}]`;
    }
    default:
      return `[${String(block.type ?? 'unknown')}]`;
  }
}

/**
 * Aplana el resultado de una tool MCP a texto plano. Tolera un `content`
 * ausente o mal formado (un server defectuoso no debe tumbar la llamada) y,
 * sin bloques de contenido, recurre a `structuredContent`.
 */
export function flattenContent(content: unknown, structuredContent?: unknown): string {
  const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
  const text = blocks.map((b) => flattenBlock(b as Block)).join('\n');
  if (text.length > 0) return text;
  if (structuredContent !== undefined && structuredContent !== null) {
    try {
      return JSON.stringify(structuredContent, null, 2);
    } catch {
      return '[structured content]';
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// buildMcpTool
// ---------------------------------------------------------------------------

/**
 * Crea un ToolDefinition para una tool MCP concreta.
 *
 * El schema Zod es permisivo (Record<string,unknown>) porque el MCP server
 * valida los argumentos por su cuenta. El JSON Schema real del server se pasa
 * en rawParameters para que toToolSchemas() lo envíe al LLM sin conversión.
 */
export function buildMcpTool(
  serverClient: McpServerClient,
  mcpTool: McpToolInfo,
  opts: { confirmMutating?: boolean } = {},
): ToolDefinition {
  const registeredName = mcpToolName(serverClient.name, mcpTool.name);
  const displayName = `${serverClient.name}/${mcpTool.name}`;
  // Si el nombre registrado no deja leer el original (recortado o con hash),
  // la descripción lo dice: el modelo y el usuario hablan del nombre real.
  const renamed = registeredName !== `mcp__${serverClient.name}__${mcpTool.name}`;
  const description = renamed
    ? `${mcpTool.description}\n\n(MCP tool "${displayName}")`.trim()
    : mcpTool.description;
  const timeoutMs = serverClient.toolTimeout;

  return {
    name: registeredName,
    description,
    // Zod permisivo: validación real la hace el server
    schema: z.record(z.unknown()),
    // JSON Schema original del server, usado por toToolSchemas()
    rawParameters: mcpTool.inputSchema,
    // Sin esto el dispatcher aplicaba su default de 30 s y el SDK el suyo de
    // 60 s, ignorando la config: una tool MCP lenta se cortaba siempre.
    timeout: timeoutMs,
    // M17 — con `confirmMutating`, lo que no esté declarado de solo lectura se
    // confirma: `callEffects` decide (sin declarar, mutante sin target).
    ...(opts.confirmMutating
      ? {
          isDestructive: (input: unknown, ctx: { config: StratumConfig }) =>
            callEffects(registeredName, (input as Record<string, unknown>) ?? {}, ctx.config)
              .mutating,
        }
      : {}),

    async execute(params: unknown, ctx): Promise<ToolResult> {
      // Tool no disponible — devolver XML descriptivo (§12.8). No es un fallo
      // de la tool: no debe acercarla al límite que la deshabilita.
      if (serverClient.status !== 'connected') {
        const stateMsg =
          serverClient.status === 'disconnected' ? 'currently unavailable' : 'reconnecting...';
        const xml =
          `<tool_error>\n` +
          `  <tool>${displayName}</tool>\n` +
          `  <error>MCP server '${serverClient.name}' is ${stateMsg}</error>\n` +
          `  <suggestion>Try again in a few seconds or use the built-in tool instead.</suggestion>\n` +
          `</tool_error>`;
        return { ok: false, error: xml, recoverable: true, countsAsFailure: false };
      }

      try {
        const args = (params as Record<string, unknown>) ?? {};
        const result = await serverClient.callTool(mcpTool.name, args, ctx.signal, timeoutMs);
        const text = flattenContent(result.content, result.structuredContent);

        if (result.isError) {
          return {
            ok: false,
            error: text || `MCP tool '${displayName}' reported an error without details.`,
            recoverable: true,
          };
        }
        return { ok: true, output: text || '(the tool returned no content)' };
      } catch (err) {
        return {
          ok: false,
          error: describeCallError(err, serverClient.name, timeoutMs),
          recoverable: true,
        };
      }
    },
  };
}

/**
 * Error de una llamada que no llegó a devolver resultado. El cierre de la
 * conexión se dice aparte: la tool pudo ejecutarse antes de que el server
 * cayera, y el modelo no debe darla por no hecha y repetirla sin comprobar.
 */
function describeCallError(err: unknown, server: string, timeoutMs: number): string {
  if (err instanceof McpError && err.code === ErrorCode.ConnectionClosed) {
    return (
      `MCP server '${server}' closed the connection during the call (it may have crashed) ` +
      `and is reconnecting. The action may or may not have been performed: check its effect ` +
      `before retrying.`
    );
  }
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return `MCP tool call timed out after ${timeoutMs}ms.`;
  }
  return `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`;
}
