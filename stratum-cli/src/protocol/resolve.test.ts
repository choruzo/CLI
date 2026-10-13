import { describe, expect, it } from 'vitest';
import { checkApprovalResolution, checkQuestionAnswers } from './resolve.js';

describe('qué respuestas valen', () => {
  it('aprobación: denegar vale siempre; allow-all no en forzadas ni con frase; la frase, exacta', () => {
    expect(checkApprovalResolution({}, 'approve', undefined)).toBeNull();
    expect(checkApprovalResolution({}, 'allow-all', undefined)).toBeNull();
    expect(
      checkApprovalResolution({ forced: true, confirmPhrase: 'p' }, 'deny', undefined),
    ).toBeNull();
    expect(checkApprovalResolution({ forced: true }, 'allow-all', undefined)?.path).toBe(
      'decision',
    );
    expect(checkApprovalResolution({ confirmPhrase: 'p' }, 'allow-all', 'p')?.path).toBe(
      'decision',
    );
    expect(checkApprovalResolution({ forced: true }, 'approve', undefined)).toBeNull();
    expect(checkApprovalResolution({ confirmPhrase: 'prod' }, 'approve', undefined)?.path).toBe(
      'phrase',
    );
    expect(checkApprovalResolution({ confirmPhrase: 'prod' }, 'approve', 'Prod')?.path).toBe(
      'phrase',
    );
    expect(checkApprovalResolution({ confirmPhrase: 'prod' }, 'approve', ' prod')?.path).toBe(
      'phrase',
    );
    expect(checkApprovalResolution({ confirmPhrase: 'prod' }, 'approve', 'prod')).toBeNull();
  });

  it('preguntas: una por pregunta, del dominio de la pregunta, y nada se aproxima', () => {
    const questions = [
      {
        question: '¿A?',
        options: [
          { id: 'o1', label: 'uno' },
          { id: 'o2', label: 'dos' },
          { id: 'o3', label: 'dos' },
        ],
      },
      { question: '¿B?', options: [{ id: 'o4', label: 'x' }], allowCustom: true },
      { question: '¿C?' },
    ];
    const a = (answer: string, optionId?: string) => ({
      question: 'lo que diga el cliente',
      answer,
      ...(optionId ? { optionId } : {}),
    });
    expect(checkQuestionAnswers(questions, null)).toEqual({ ok: true, answers: null });
    expect(checkQuestionAnswers(questions, [a('uno')]).ok).toBe(false);
    // Por token, por etiqueta única, texto libre donde se admite.
    expect(checkQuestionAnswers(questions, [a('', 'o2'), a('otra cosa'), a('libre')])).toEqual({
      ok: true,
      answers: [
        { question: '¿A?', answer: 'dos', optionId: 'o2' },
        { question: '¿B?', answer: 'otra cosa' },
        { question: '¿C?', answer: 'libre' },
      ],
    });
    expect(checkQuestionAnswers(questions, [a('uno'), a('x'), a('z')])).toMatchObject({
      ok: true,
      answers: [{ optionId: 'o1' }, { optionId: 'o4' }, { answer: 'z' }],
    });
    // Etiqueta ambigua, opción inexistente, fuera del dominio, vacía.
    for (const bad of [
      [a('dos'), a('x'), a('z')],
      [a('', 'o9'), a('x'), a('z')],
      [a('tres'), a('x'), a('z')],
      [a('Uno'), a('x'), a('z')],
      [a('uno'), a('x'), a('  ')],
    ]) {
      expect(checkQuestionAnswers(questions, bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
