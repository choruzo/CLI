import { useState } from 'react';
import type { QuestionAnswer, QuestionItem } from '../../../../stratum-cli/src/agent/events';

/**
 * Tanda única de preguntas del agente (tool `question`). Mismas reglas de
 * dominio cerrado que la CLI (`<QuestionPrompt>` de Ink): una opción se
 * devuelve por su token opaco (`optionId`), y el texto libre solo se ofrece si
 * la pregunta no tiene opciones o declara `allowCustom`. El loop vuelve a
 * validar las respuestas contra el envelope original, así que la UI no puede
 * colar una respuesta fuera del dominio aunque quisiera.
 */

interface Draft {
  optionId?: string;
  custom: string;
}

export function allowsText(q: QuestionItem): boolean {
  return !q.options || q.options.length === 0 || q.allowCustom === true;
}

export function buildAnswers(questions: QuestionItem[], drafts: Draft[]): QuestionAnswer[] {
  const answers: QuestionAnswer[] = [];
  questions.forEach((q, i) => {
    const d = drafts[i];
    const option = d?.optionId ? q.options?.find((o) => o.id === d.optionId) : undefined;
    if (option) {
      answers.push({ question: q.question, answer: option.label, optionId: option.id });
    } else if (allowsText(q) && d?.custom.trim()) {
      answers.push({ question: q.question, answer: d.custom.trim() });
    }
  });
  return answers;
}

interface QuestionPromptProps {
  questions: QuestionItem[];
  onSubmit: (answers: QuestionAnswer[] | null) => void;
}

export function QuestionPrompt({ questions, onSubmit }: QuestionPromptProps) {
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ custom: '' })));
  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const answers = buildAnswers(questions, drafts);

  return (
    <section className="question-prompt" aria-label="Preguntas del asistente">
      {questions.map((q, i) => (
        <fieldset key={i} className="question-prompt__item">
          <legend className="question-prompt__question">{q.question}</legend>
          {q.options && q.options.length > 0 && (
            <div className="question-prompt__options" role="radiogroup" aria-label={q.question}>
              {q.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={drafts[i]?.optionId === o.id}
                  className="chip"
                  onClick={() => update(i, { optionId: o.id, custom: '' })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {allowsText(q) && (
            <input
              className="question-prompt__input"
              type="text"
              aria-label={`Respuesta: ${q.question}`}
              placeholder={q.options?.length ? 'Otra respuesta…' : 'Tu respuesta…'}
              value={drafts[i]?.custom ?? ''}
              onChange={(e) => update(i, { custom: e.target.value, optionId: undefined })}
            />
          )}
        </fieldset>
      ))}
      <div className="question-prompt__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={answers.length === 0}
          onClick={() => onSubmit(answers)}
        >
          Responder
        </button>
        <button type="button" className="button" onClick={() => onSubmit(null)}>
          Omitir
        </button>
      </div>
    </section>
  );
}
