import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { applyTerminalBackground } from './terminal-background.js';

function fakeOut(isTTY: boolean) {
  const writes: string[] = [];
  return { isTTY, writes, write: (chunk: string) => writes.push(chunk) };
}

describe('applyTerminalBackground', () => {
  it('pide el color con OSC 11 y lo devuelve con OSC 111 una sola vez', () => {
    const out = fakeOut(true);
    const proc = new EventEmitter();
    const restore = applyTerminalBackground(out, '#000000', proc as never);
    expect(out.writes).toEqual(['\x1b]11;#000000\x07']);
    restore();
    proc.emit('exit');
    expect(out.writes).toEqual(['\x1b]11;#000000\x07', '\x1b]111\x07']);
    expect(proc.listenerCount('exit')).toBe(0);
  });

  it('restaura al salir el proceso aunque nadie llame a restore', () => {
    const out = fakeOut(true);
    const proc = new EventEmitter();
    applyTerminalBackground(out, '#101010', proc as never);
    proc.emit('exit');
    expect(out.writes.at(-1)).toBe('\x1b]111\x07');
  });

  it('sin TTY o con `terminal` no escribe nada', () => {
    const pipe = fakeOut(false);
    applyTerminalBackground(pipe, '#000000', new EventEmitter() as never)();
    const tty = fakeOut(true);
    applyTerminalBackground(tty, 'terminal', new EventEmitter() as never)();
    expect([...pipe.writes, ...tty.writes]).toEqual([]);
  });
});
