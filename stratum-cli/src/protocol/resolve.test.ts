import { describe, expect, it } from 'vitest';
import {
  channelAnswerable,
  channelApprovable,
  checkApprovalResolution,
  checkChannelResolution,
  checkQuestionAnswers,
} from './resolve.js';

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

  it('concesión (M17): solo con approve y una solicitud grantable, nunca forzada ni con frase', () => {
    const grant = { minutes: 30 as const };
    expect(checkApprovalResolution({ grantable: true }, 'approve', undefined, grant)).toBeNull();
    expect(checkApprovalResolution({ grantable: true }, 'deny', undefined, grant)?.path).toBe(
      'grant',
    );
    expect(checkApprovalResolution({ grantable: true }, 'allow-all', undefined, grant)?.path).toBe(
      'grant',
    );
    expect(checkApprovalResolution({}, 'approve', undefined, grant)?.path).toBe('grant');
    expect(checkApprovalResolution({ grantable: false }, 'approve', undefined, grant)?.path).toBe(
      'grant',
    );
    expect(
      checkApprovalResolution({ grantable: true, forced: true }, 'approve', undefined, grant)?.path,
    ).toBe('grant');
    expect(
      checkApprovalResolution({ grantable: true, confirmPhrase: 'p' }, 'approve', 'p', grant)?.path,
    ).toBe('grant');
    // Sin concesión, nada cambia aunque la solicitud la admita.
    expect(checkApprovalResolution({ grantable: true }, 'approve', undefined)).toBeNull();
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

describe('M18 (A9) — qué vale desde un canal', () => {
  const tool = { kind: 'tool' as const, forced: false };
  const approval = (a: Parameters<typeof channelApprovable>[0]) => ({
    kind: 'approval' as const,
    approval: a,
  });

  it('aprobar una vez solo una tool sin forzar, sin frase y que no sea host key', () => {
    expect(channelApprovable(tool)).toBe(true);
    expect(channelApprovable({ ...tool, forced: true })).toBe(false);
    expect(channelApprovable({ ...tool, confirmPhrase: 'prod' })).toBe(false);
    expect(channelApprovable({ kind: 'host-key', forced: false })).toBe(false);
  });

  it('denegar vale siempre; allow-all, frase y concesión nunca', () => {
    const forced = approval({ ...tool, forced: true });
    expect(checkChannelResolution(forced, { kind: 'approval', decision: 'deny' })).toBeNull();
    expect(
      checkChannelResolution(forced, { kind: 'approval', decision: 'approve' }),
    ).not.toBeNull();
    expect(
      checkChannelResolution(approval(tool), { kind: 'approval', decision: 'approve' }),
    ).toBeNull();
    expect(
      checkChannelResolution(approval(tool), { kind: 'approval', decision: 'allow-all' }),
    ).not.toBeNull();
    expect(
      checkChannelResolution(approval({ ...tool, confirmPhrase: 'x' }), {
        kind: 'approval',
        decision: 'approve',
        phrase: 'x',
      }),
    ).not.toBeNull();
    expect(
      checkChannelResolution(approval(tool), {
        kind: 'approval',
        decision: 'approve',
        grant: { minutes: 10 },
      }),
    ).not.toBeNull();
  });

  it('preguntas: una sola, con opciones, eligiendo una opción; planes, nunca', () => {
    const one = [{ question: '¿Cuál?', options: [{ id: 'a', label: 'A' }] }];
    expect(channelAnswerable(one)).toBe(true);
    expect(channelAnswerable([{ question: '¿Qué?' }])).toBe(false);
    expect(channelAnswerable([...one, ...one])).toBe(false);
    const q = { kind: 'question' as const, questions: one };
    expect(
      checkChannelResolution(q, {
        kind: 'question',
        answers: [{ question: '¿Cuál?', answer: '', optionId: 'a' }],
      }),
    ).toBeNull();
    expect(
      checkChannelResolution(q, {
        kind: 'question',
        answers: [{ question: '¿Cuál?', answer: 'A' }],
      }),
    ).not.toBeNull();
    expect(checkChannelResolution(q, { kind: 'question', answers: null })).not.toBeNull();
    expect(checkChannelResolution({ kind: 'plan' }, { kind: 'plan' })).not.toBeNull();
  });
});
