import { describe, it, expect } from 'vitest';
import {
  questionTool,
  parseQuestionInput,
  formatQuestionAnswers,
  MAX_QUESTIONS,
  MAX_OPTIONS,
} from './question.js';

describe('tool question — schema (Hito 2.5, F7)', () => {
  it('acepta una tanda con opciones y otra libre', () => {
    const parsed = questionTool.schema.safeParse({
      questions: [
        { question: '¿Qué entrypoint es el real?', options: ['src/index.ts', 'src/cli.ts'] },
        { question: '¿Comando de test?' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rechaza tandas vacías o por encima del tope', () => {
    expect(questionTool.schema.safeParse({ questions: [] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ question: `p${i}` }));
    expect(questionTool.schema.safeParse({ questions: tooMany }).success).toBe(false);
  });

  it('execute fuera del loop falla de forma no recuperable', async () => {
    const res = await questionTool.execute({}, {} as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.recoverable).toBe(false);
  });
});

describe('parseQuestionInput', () => {
  it('normaliza formas laxas del modelo', () => {
    const items = parseQuestionInput({
      questions: [
        '  Pregunta suelta  ',
        { question: 'Con opciones', options: [' a ', '', 'b'] },
        { question: '   ' },
        { question: 'Sin opciones', options: [] },
      ],
    });
    expect(items).toEqual([
      { question: 'Pregunta suelta' },
      { question: 'Con opciones', options: ['a', 'b'] },
      { question: 'Sin opciones' },
    ]);
  });

  it('corta en los topes de preguntas y opciones', () => {
    const items = parseQuestionInput({
      questions: Array.from({ length: 10 }, (_, i) => ({
        question: `p${i}`,
        options: Array.from({ length: 10 }, (_, j) => `o${j}`),
      })),
    });
    expect(items).toHaveLength(MAX_QUESTIONS);
    expect(items[0]!.options).toHaveLength(MAX_OPTIONS);
  });

  it('devuelve lista vacía si no hay preguntas utilizables', () => {
    expect(parseQuestionInput({})).toEqual([]);
    expect(parseQuestionInput({ questions: 'no' })).toEqual([]);
    expect(parseQuestionInput({ questions: [{ question: '' }] })).toEqual([]);
  });
});

describe('formatQuestionAnswers', () => {
  const qs = [{ question: '¿A o B?' }, { question: '¿Comando?' }];

  it('empareja respuestas por pregunta', () => {
    const out = formatQuestionAnswers(qs, [
      { question: '¿Comando?', answer: 'npm test' },
      { question: '¿A o B?', answer: 'A' },
    ]);
    expect(out).toContain('<question>¿A o B?</question>');
    expect(out).toContain('<answer>A</answer>');
    expect(out).toContain('<answer>npm test</answer>');
    expect(out).not.toContain('unavailable');
  });

  it('sin respuestas instruye a continuar sin volver a preguntar', () => {
    const out = formatQuestionAnswers(qs, null);
    expect(out).toContain('unavailable="true"');
    expect(out).toContain('No vuelvas a llamar');
  });

  it('trata todas-vacías como no disponible', () => {
    const out = formatQuestionAnswers(qs, [
      { question: '¿A o B?', answer: '  ' },
      { question: '¿Comando?', answer: '' },
    ]);
    expect(out).toContain('unavailable="true"');
  });
});
