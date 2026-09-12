import { describe, it, expect } from 'vitest';
import {
  questionTool,
  parseQuestionInput,
  formatQuestionAnswers,
  resolveQuestionAnswers,
  MAX_QUESTIONS,
  MAX_OPTIONS,
} from './question.js';
import type { QuestionItem } from '../agent/types.js';

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
    expect(items.map((i) => i.question)).toEqual([
      'Pregunta suelta',
      'Con opciones',
      'Sin opciones',
    ]);
    expect(items[0]!.options).toBeUndefined();
    expect(items[1]!.options!.map((o) => o.label)).toEqual(['a', 'b']);
    expect(items[2]!.options).toBeUndefined();
    // Cada opción lleva su propio token y ninguno codifica el ordinal.
    const ids = items[1]!.options!.map((o) => o.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^opt_[a-z0-9]{6}$/);
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

describe('resolveQuestionAnswers — dominio cerrado y token opaco', () => {
  function closed(allowCustom = false): QuestionItem {
    const [item] = parseQuestionInput({
      questions: [
        { question: '¿Entrypoint?', options: ['src/index.ts', 'src/cli.ts'], allowCustom },
      ],
    });
    return item!;
  }

  it('acepta el token de una opción y canoniza a su etiqueta', () => {
    const q = closed();
    const chosen = q.options![1]!;
    const { answers, rejections } = resolveQuestionAnswers(
      [q],
      // El gate devuelve el token; la etiqueta que traiga es irrelevante.
      [{ question: q.question, answer: 'lo que sea', optionId: chosen.id }],
    );
    expect(rejections).toEqual([]);
    expect(answers).toEqual([{ question: q.question, answer: 'src/cli.ts', optionId: chosen.id }]);
  });

  it('rechaza un token que no está en el envelope', () => {
    const q = closed();
    const { answers, rejections } = resolveQuestionAnswers(
      [q],
      [{ question: q.question, answer: 'src/cli.ts', optionId: 'opt_zzzzzz' }],
    );
    expect(answers).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.reason).toContain('opt_zzzzzz');
  });

  it('acepta texto que coincide exactamente con una etiqueta y le pone su token', () => {
    const q = closed();
    const { answers, rejections } = resolveQuestionAnswers(
      [q],
      [{ question: q.question, answer: '  SRC/CLI.TS  ' }],
    );
    expect(rejections).toEqual([]);
    expect(answers[0]!.answer).toBe('src/cli.ts');
    expect(answers[0]!.optionId).toBe(q.options![1]!.id);
  });

  it('rechaza texto fuera del dominio cuando no hay allowCustom', () => {
    const q = closed();
    const { answers, rejections } = resolveQuestionAnswers(
      [q],
      [{ question: q.question, answer: 'src/main.ts' }],
    );
    expect(answers).toEqual([]);
    expect(rejections[0]!.reason).toContain('no coincide con ninguna');
  });

  it('con allowCustom sí acepta texto fuera del dominio', () => {
    const q = closed(true);
    const { answers, rejections } = resolveQuestionAnswers(
      [q],
      [{ question: q.question, answer: 'src/main.ts' }],
    );
    expect(rejections).toEqual([]);
    expect(answers[0]).toEqual({ question: q.question, answer: 'src/main.ts' });
  });

  it('una respuesta vacía es omisión, no rechazo', () => {
    const q = closed();
    const { answers, rejections } = resolveQuestionAnswers(
      [q],
      [{ question: q.question, answer: '   ' }],
    );
    expect(answers).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it('las etiquetas duplicadas se colapsan al construir el envelope', () => {
    // Sin esto, resolver por texto sería ambiguo por construcción.
    const [item] = parseQuestionInput({
      questions: [{ question: '¿Cuál?', options: ['Sí', ' sí ', 'SÍ', 'No'] }],
    });
    expect(item!.options!.map((o) => o.label)).toEqual(['Sí', 'No']);
  });

  it('sin opciones, el texto libre pasa tal cual', () => {
    const q: QuestionItem = { question: '¿Comando de tests?' };
    const { answers } = resolveQuestionAnswers(
      [q],
      [{ question: q.question, answer: ' npm test ' }],
    );
    expect(answers[0]!.answer).toBe('npm test');
    expect(answers[0]!.optionId).toBeUndefined();
  });

  it('el tool result explica el descarte y no lo aproxima', () => {
    const q = closed();
    const out = formatQuestionAnswers(
      [q, { question: '¿Algo más?' }],
      [
        { question: q.question, answer: 'src/main.ts' },
        { question: '¿Algo más?', answer: 'no' },
      ],
    );
    expect(out).toContain('respuesta descartada');
    expect(out).not.toContain('src/main.ts');
    expect(out).toContain('<answer>no</answer>');
    // Queda una pregunta sin resolver: el agente debe seguir con supuestos.
    expect(out).toContain('No repitas la tanda en este turno');
  });

  it('si todo se descarta, el resultado es "no disponible" con el motivo', () => {
    const q = closed();
    const out = formatQuestionAnswers([q], [{ question: q.question, answer: 'otra cosa' }]);
    expect(out).toContain('unavailable="true"');
    expect(out).toContain('fuera del dominio');
  });
});
