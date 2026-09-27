import { EventEmitter } from 'events';
import type { Interface } from 'readline';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { askLine } from './readline-prompt.js';

/** Lo mínimo de `readline.Interface` que usa `askLine`. */
class FakeRl extends EventEmitter {
  answer: ((a: string) => void) | null = null;
  question(_prompt: string, cb: (a: string) => void): void {
    this.answer = cb;
  }
  close(): void {
    this.emit('close');
  }
}

afterEach(() => vi.restoreAllMocks());

describe('askLine (§12.12)', () => {
  it('devuelve lo que se escribe', async () => {
    const rl = new FakeRl();
    const pending = askLine(rl as unknown as Interface, '> ');
    rl.answer?.('s');
    await expect(pending).resolves.toBe('s');
  });

  it('Ctrl+C resuelve null y lo reenvía al proceso como SIGINT', async () => {
    const rl = new FakeRl();
    const emit = vi
      .spyOn(process, 'emit')
      .mockImplementation((() => true) as unknown as typeof process.emit);
    const pending = askLine(rl as unknown as Interface, '> ');
    rl.emit('SIGINT');
    await expect(pending).resolves.toBeNull();
    expect(emit).toHaveBeenCalledWith('SIGINT');
  });

  it('un cierre sin respuesta (EOF) resuelve null en vez de quedarse esperando', async () => {
    const rl = new FakeRl();
    const pending = askLine(rl as unknown as Interface, '> ');
    rl.close();
    await expect(pending).resolves.toBeNull();
  });
});
