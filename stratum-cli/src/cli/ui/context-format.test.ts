import { describe, it, expect } from 'vitest';
import { formatContextReport, type ContextView } from './context-format.js';
import type { ContextBreakdown } from '../../agent/context-builder.js';

function breakdown(over: Partial<ContextBreakdown> = {}): ContextBreakdown {
  const b = {
    window: 131072,
    reserveOutput: 8192,
    usableInput: 122880,
    system: 2400,
    tools: 5600,
    globalMemory: 0,
    projectMemory: 800,
    sessionMemory: 0,
    recent: 11200,
    activeMessages: 7,
    estimated: true as const,
    ...over,
  };
  return {
    ...b,
    input: b.system + b.tools + b.globalMemory + b.projectMemory + b.sessionMemory + b.recent,
  };
}

function view(over: Partial<ContextView> = {}): ContextView {
  return {
    usage: { used: 14000, max: 131072, pct: 11, estimated: true },
    breakdown: breakdown(),
    reduceAt: { kind: 'compress', fraction: 0.8 },
    messages: 8,
    toolCalls: 3,
    spend: '4200 (reportado por el provider)',
    provider: 'nan / glm5.3-flash',
    ...over,
  };
}

describe('formatContextReport', () => {
  it('desglosa la entrada con ~ y porcentaje sobre el total', () => {
    const text = formatContextReport(view());
    expect(text).toMatch(/sistema\s+~2\.4K\s+12%/);
    expect(text).toMatch(/tools\s+~5\.6K\s+28%/);
    expect(text).toMatch(/memoria proyecto\s+~800\s+4%/);
    expect(text).toMatch(/conversación\s+~11K\s+56%\s+7 mensajes/);
    expect(text).toMatch(/total entrada\s+~20K\s+de 123K útiles \(reserva de salida 8\.2K\)/);
    expect(text).toContain('comprime al 80% de la ventana');
  });

  it('omite las capas de memoria que no existen en la sesión', () => {
    const text = formatContextReport(view({ breakdown: breakdown({ projectMemory: 0 }) }));
    expect(text).not.toContain('memoria');
  });

  it('con memoria de sesión dice cuándo compacta y la muestra', () => {
    const text = formatContextReport(
      view({
        breakdown: breakdown({ sessionMemory: 1500, globalMemory: 300 }),
        reduceAt: { kind: 'compact', fraction: 0.7 },
      }),
    );
    expect(text).toContain('compacta a la memoria de sesión al 70% de la entrada útil');
    expect(text).toMatch(/memoria sesión\s+~1\.5K/);
    expect(text).toMatch(/memoria global\s+~300/);
  });

  it('distingue el contexto reportado del estimado', () => {
    expect(formatContextReport(view())).toContain('origen         estimado (chars/3.5)');
    expect(formatContextReport(view())).toContain('contexto       ~14000 / 131072 (11%)');
    const reported = formatContextReport(
      view({ usage: { used: 21000, max: 131072, pct: 16, estimated: false } }),
    );
    expect(reported).toContain('origen         reportado por el provider');
    expect(reported).toContain('contexto       21000 / 131072 (16%)');
  });

  it('una capa diminuta no sale como 0%', () => {
    const text = formatContextReport(view({ breakdown: breakdown({ projectMemory: 10 }) }));
    expect(text).toMatch(/memoria proyecto\s+~10\s+<1%/);
  });

  it('un solo mensaje en singular', () => {
    const text = formatContextReport(view({ breakdown: breakdown({ activeMessages: 1 }) }));
    expect(text).toContain('1 mensaje');
    expect(text).not.toContain('1 mensajes');
  });
});
