/**
 * Bridge MCP tools → ToolDefinition (§12.8).
 *
 * Convierte el catálogo descubierto de un McpServerClient en ToolDefinitions
 * listos para registrar en el ToolRegistry. El naming sigue la convención
 * mcp__<server>__<tool> para cumplir el regex ^[a-zA-Z0-9_-]+$ que imponen
 * las APIs OpenAI-compatible (la barra / de §12.8 la sustituimos por __).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult } from '../../agent/types.js';
import type { McpServerClient, McpToolInfo } from './client.js';

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/**
 * Longitud máxima de un nombre de función en las APIs OpenAI-compatible. Un
 * nombre más largo no rechaza solo esa tool: el backend devuelve 400 a la
 * petición entera, y ninguna tool vuelve a funcionar.
 */
export const MCP_TOOL_NAME_MAX = 64;

/** Sanitiza un segmento (nombre de server o tool) a [a-zA-Z0-9_-]. */
export function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6);
}

/**
 * Segmento de un nombre registrado. Si sanitizar pierde información (`a.b` y
 * `a_b` darían lo mismo) se añade un hash del original: el nombre no depende
 * de qué otras tools haya, así que es estable entre arranques y dos originales
 * distintos no colisionan.
 */
function nameSegment(raw: string): string {
  const clean = sanitizeSegment(raw);
  return clean === raw && raw.length > 0 ? clean : `${clean}_${shortHash(raw)}`;
}

/**
 * Genera el nombre registrado en ToolRegistry para una tool MCP:
 * `mcp__<server>__<tool>`, con los segmentos que no son ya válidos marcados
 * con un hash y recortado a {@link MCP_TOOL_NAME_MAX} (con un hash del par
 * original para que dos nombres largos con el mismo principio no colisionen).
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const name = `mcp__${nameSegment(serverName)}__${nameSegment(toolName)}`;
  if (name.length <= MCP_TOOL_NAME_MAX) return name;
  const suffix = `_${shortHash(`${serverName}\u0000${toolName}`)}`;
  return name.slice(0, MCP_TOOL_NAME_MAX - suffix.length) + suffix;
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
export function buildMcpTool(serverClient: McpServerClient, mcpTool: McpToolInfo): ToolDefinition {
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
