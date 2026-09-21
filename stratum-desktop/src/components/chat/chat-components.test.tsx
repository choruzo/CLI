import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuestionPrompt, buildAnswers } from './QuestionPrompt';
import { ConfirmDialog } from './ConfirmDialog';
import { ToolCallBlock } from './ToolCallBlock';
import type { QuestionItem } from '../../../../stratum-cli/src/agent/events';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

const CLOSED: QuestionItem = {
  question: '¿Formato?',
  options: [
    { id: 'opt_a', label: 'Tabla' },
    { id: 'opt_b', label: 'Lista' },
  ],
};
const FREE: QuestionItem = { question: '¿Ciudad?' };

describe('QuestionPrompt', () => {
  it('devuelve el token de la opción elegida, no la etiqueta', () => {
    const onSubmit = vi.fn();
    render(<QuestionPrompt questions={[CLOSED]} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Lista' }));
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
    expect(onSubmit).toHaveBeenCalledWith([{ question: '¿Formato?', answer: 'Lista', optionId: 'opt_b' }]);
  });

  it('sin allowCustom no ofrece texto libre en una pregunta cerrada', () => {
    render(<QuestionPrompt questions={[CLOSED]} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('con allowCustom sí, y el texto sustituye a la opción', () => {
    expect(
      buildAnswers([{ ...CLOSED, allowCustom: true }], [{ optionId: undefined, custom: ' Mapa ' }]),
    ).toEqual([{ question: '¿Formato?', answer: 'Mapa' }]);
    // Un texto en una pregunta cerrada sin allowCustom se descarta.
    expect(buildAnswers([CLOSED], [{ custom: 'Mapa' }])).toEqual([]);
  });

  it('una pregunta abierta admite texto', () => {
    const onSubmit = vi.fn();
    render(<QuestionPrompt questions={[FREE]} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Lisboa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
    expect(onSubmit).toHaveBeenCalledWith([{ question: '¿Ciudad?', answer: 'Lisboa' }]);
  });

  it('Omitir devuelve null (el agente sigue con supuestos)', () => {
    const onSubmit = vi.fn();
    render(<QuestionPrompt questions={[CLOSED, FREE]} onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: 'Responder' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Omitir' }));
    expect(onSubmit).toHaveBeenCalledWith(null);
  });
});

describe('ConfirmDialog', () => {
  it('traduce cada botón a su decisión', () => {
    const onDecide = vi.fn();
    render(<ConfirmDialog request={{ callId: 'c', tool: 't', description: 'd' }} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Denegar' }));
    fireEvent.click(screen.getByRole('button', { name: /Permitir todo/ }));
    expect(onDecide.mock.calls.map((c) => c[0])).toEqual(['approve', 'deny', 'allow-all']);
  });
});

describe('ToolCallBlock', () => {
  it.each([
    ['pending', 'preparando'],
    ['running', 'ejecutando'],
    ['completed', 'completado'],
    ['error', 'error'],
  ] as const)('pinta el estado %s', (state, label) => {
    const { container } = render(
      <ToolCallBlock call={{ id: 'c', name: 'web_search', state, input: '{}' }} />,
    );
    expect(container.querySelector('.tool-call')?.getAttribute('data-state')).toBe(state);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('se expande para ver el resultado', () => {
    render(
      <ToolCallBlock
        call={{ id: 'c', name: 'web_fetch', state: 'completed', input: '{"url":1}', output: 'HOLA' }}
      />,
    );
    expect(screen.queryByText('HOLA')).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('HOLA')).toBeTruthy();
  });
});
