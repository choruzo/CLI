import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { ALT_SCREEN_ENTER, ALT_SCREEN_LEAVE, createAltScreen } from './alt-screen.js';

function setup(isTTY = true) {
  const direct: string[] = [];
  const out = { isTTY, write: (s: string) => direct.push(s) };
  const proc = new EventEmitter() as unknown as NodeJS.Process;
  return { direct, proc, screen: createAltScreen(out, proc) };
}

describe('pantalla alternativa', () => {
  it('escribe por el writer de Ink y no repite', () => {
    const { direct, screen } = setup();
    const ink: string[] = [];
    const write = (s: string) => void ink.push(s);
    screen.enter(write);
    screen.enter(write);
    expect(screen.active).toBe(true);
    screen.leave(write);
    screen.leave(write);
    expect(ink).toEqual([ALT_SCREEN_ENTER, ALT_SCREEN_LEAVE]);
    expect(direct).toEqual([]);
  });

  it('sin terminal no hace nada', () => {
    const { direct, screen } = setup(false);
    screen.enter();
    screen.leave();
    expect(direct).toEqual([]);
  });

  it('al salir el proceso con la vista abierta, devuelve la pantalla normal', () => {
    const { direct, proc, screen } = setup();
    screen.enter();
    (proc as unknown as EventEmitter).emit('exit');
    expect(direct.at(-1)).toBe(ALT_SCREEN_LEAVE);
    expect(screen.active).toBe(false);
  });
});
