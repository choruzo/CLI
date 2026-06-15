/**
 * Bridge MCP tools → ToolDefinition (§12.8).
 *
 * Convierte el catálogo descubierto de un McpServerClient en ToolDefinitions
 * listos para registrar en el ToolRegistry. El naming sigue la convención
 * mcp__<server>__<tool> para cumplir el regex ^[a-zA-Z0-9_-]+$ que imponen
 * las APIs OpenAI-compatible (la barra / de §12.8 la sustituimos por __).
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../../agent/types.js';
import type { McpServerClient, McpToolInfo } from './client.js';

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/** Sanitiza un segmento (nombre de server o tool) a [a-zA-Z0-9_-]. */
export function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Genera el nombre registrado en ToolRegistry para una tool MCP. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
}

/** Parsea un nombre mcp__server__tool. Devuelve null si no tiene el prefijo. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep === -1) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

// ---------------------------------------------------------------------------
// Content block → string
// ---------------------------------------------------------------------------

/** Aplana los ContentBlocks MCP a una cadena de texto plano. */
export function flattenContent(content: { type: string; [k: string]: unknown }[]): string {
  return content
    .map((block) => {
      if (block.type === 'text') return String(block['text'] ?? '');
      if (block.type === 'image') return `[image: ${String(block['mimeType'] ?? 'unknown')}]`;
      if (block.type === 'resource') return `[resource: ${String(block['uri'] ?? 'unknown')}]`;
      return `[${block.type}]`;
    })
    .join('\n');
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
export function buildMcpTool(serverClient: McpServerClient, mcpTool: McpToolInfo): ToolDefinition {
  const registeredName = mcpToolName(serverClient.name, mcpTool.name);

  return {
    name: registeredName,
    description: mcpTool.description,
    // Zod permisivo: validación real la hace el server
    schema: z.record(z.unknown()),
    // JSON Schema original del server, usado por toToolSchemas()
    rawParameters: mcpTool.inputSchema,

    async execute(params: unknown, ctx): Promise<ToolResult> {
      // Tool no disponible — devolver XML descriptivo (§12.8)
      if (serverClient.status !== 'connected') {
        const displayName = `${serverClient.name}/${mcpTool.name}`;
        const stateMsg =
          serverClient.status === 'reconnecting' ? 'reconnecting...' : 'currently unavailable';
        const xml =
          `<tool_error>\n` +
          `  <tool>${displayName}</tool>\n` +
          `  <error>MCP server '${serverClient.name}' is ${stateMsg}</error>\n` +
          `  <suggestion>Try again in a few seconds or use the built-in tool instead.</suggestion>\n` +
          `</tool_error>`;
        return { ok: false, error: xml, recoverable: true };
      }

      try {
        const args = (params as Record<string, unknown>) ?? {};
        const result = await serverClient.callTool(mcpTool.name, args, ctx.signal);

        if (result.isError) {
          const errorText = flattenContent(result.content);
          return { ok: false, error: errorText, recoverable: true };
        }

        const output = flattenContent(result.content);
        return { ok: true, output };
      } catch (err) {
        return {
          ok: false,
          error: `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        };
      }
    },
  };
}
