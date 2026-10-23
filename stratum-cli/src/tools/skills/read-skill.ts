import { readFileSync } from 'fs';
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { splitFrontmatter } from '../../agent/frontmatter.js';

export const READ_SKILL_TOOL = 'read_skill';

const schema = z.object({
  name: z.string().min(1).describe('Name of the skill, exactly as listed in the # Skills index'),
});

/**
 * Cuerpo de una skill, por su nombre. Es la única forma de leer una skill: el
 * índice del system prompt ya no lleva rutas. Solo sirve las del registro que
 * la sesión descubrió al arrancar (`ToolContext.skills`) — un conjunto cerrado
 * elegido por el runtime, no por el modelo —, así que no acepta rutas ni pasa
 * por `confinePath`: el asistente, confinado a su carpeta, lee igualmente las
 * skills de serie del paquete. Un nombre que no está en el registro es un
 * error, nunca un intento con otra ruta.
 */
export const readSkillTool: ToolDefinition = {
  name: READ_SKILL_TOOL,
  description:
    'Load the full instructions of a skill listed in the # Skills section, by its name. ' +
    'Use it before starting work that matches the skill trigger, then follow what it says. ' +
    'Only skills in that index can be loaded.',
  schema,
  destructive: false,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { name } = schema.parse(params);
    const skills = ctx.skills;
    const entry = skills?.resolve(name);
    if (!skills || !entry) {
      const available = skills?.entries.map((e) => e.name) ?? [];
      return {
        ok: false,
        error:
          available.length > 0
            ? `Unknown skill '${name}'. Available skills: ${available.join(', ')}.`
            : 'This session has no skills.',
        recoverable: true,
      };
    }
    let raw: string;
    try {
      raw = readFileSync(entry.path, 'utf-8');
    } catch {
      return {
        ok: false,
        error: `The skill '${entry.name}' could not be read (it may have been removed since the session started).`,
        recoverable: false,
      };
    }
    const body = splitFrontmatter(raw).body.trim();
    return { ok: true, output: `# Skill: ${entry.name}\n\n${body}` };
  },
};
