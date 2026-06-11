import { describe, it, expect } from 'vitest';
import { INITIALIZE_PROMPT } from './initialize-prompt.js';

/**
 * Regresión F1: `String.prototype.replace(string, string)` solo sustituye la
 * primera ocurrencia. El prompt contiene `${path}` varias veces, así que la
 * sustitución debe hacerse con `replaceAll`.
 */
describe('INITIALIZE_PROMPT placeholder substitution', () => {
  const render = (cwd: string, focus?: string) =>
    INITIALIZE_PROMPT.replaceAll('${path}', cwd).replaceAll('$ARGUMENTS', focus?.trim() || '(none)');

  it('contains the ${path} placeholder more than once (precondition)', () => {
    const count = INITIALIZE_PROMPT.split('${path}').length - 1;
    expect(count).toBeGreaterThan(1);
  });

  it('resolves every ${path} occurrence', () => {
    const prompt = render('/home/user/project');
    expect(prompt).not.toContain('${path}');
    expect(prompt).toContain('/home/user/project/STRATUM.md');
  });

  it('resolves $ARGUMENTS', () => {
    expect(render('/x')).not.toContain('$ARGUMENTS');
    expect(render('/x')).toContain('(none)');
    expect(render('/x', 'focus on tests')).toContain('focus on tests');
  });
});
