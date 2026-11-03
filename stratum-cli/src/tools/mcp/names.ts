/**
 * Nombres registrados de las tools MCP (§12.8): `mcp__<server>__<tool>`. Sin el
 * SDK de MCP: lo usan también `callEffects` (M17, tools declaradas de solo
 * lectura) y quien solo necesite reconocer el nombre.
 */
import { createHash } from 'node:crypto';

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
