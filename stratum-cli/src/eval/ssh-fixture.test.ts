import { describe, expect, it } from 'vitest';
import { builtinReply, hostReply, splitShellSegments, type HostRule } from './ssh-fixture.js';

const rule = (match: string, stdout: string, exitCode = 0): HostRule => ({
  re: new RegExp(match),
  stdout,
  stderr: '',
  exitCode,
});

describe('hosts SSH simulados: lo que contesta un host', () => {
  it('trocea por ; && || respetando comillas, y deja las tuberías enteras', () => {
    expect(splitShellSegments('a; b && c || d | e')).toEqual([
      { text: 'a', op: ';' },
      { text: 'b', op: '&&' },
      { text: 'c', op: '||' },
      { text: 'd | e', op: ';' },
    ]);
    expect(splitShellSegments('echo "a; b && c"')).toEqual([{ text: 'echo "a; b && c"', op: ';' }]);
    expect(splitShellSegments('  ')).toEqual([]);
  });

  it('las sondas habituales tienen respuesta sin que el escenario las declare', () => {
    expect(builtinReply('whoami', 'web1')?.stdout).toBe('eval\n');
    expect(builtinReply('hostname', 'web1')?.stdout).toBe('web1\n');
    expect(builtinReply('pwd', 'web1')?.stdout).toBe('/home/eval\n');
    expect(builtinReply('echo "hola" $?', 'web1')?.stdout).toBe('hola 0\n');
    expect(builtinReply('false', 'web1')?.exitCode).toBe(1);
    expect(builtinReply('sudo -n true', 'web1')).toMatchObject({ stdout: '', exitCode: 0 });
    expect(builtinReply('sudo -n -l 2>&1 | head -20', 'web1')?.stdout).toContain('NOPASSWD');
    expect(builtinReply('sudo id', 'web1')?.stdout).toContain('uid=1000');
    expect(builtinReply('cat /etc/os-release 2>/dev/null | head -3', 'web1')?.stdout).toContain(
      'Ubuntu',
    );
    expect(builtinReply('command -v systemctl', 'web1')?.stdout).toBe('/usr/bin/systemctl\n');
    expect(builtinReply('ls /no-existe', 'web1')).toMatchObject({ exitCode: 2 });
  });

  it('lo que no conoce no lo inventa', () => {
    for (const command of ['free -k', 'systemctl restart nginx', 'rm -rf /', 'docker ps', 'psql']) {
      expect(builtinReply(command, 'web1'), command).toBeNull();
    }
    expect(hostReply('free -k', [], 'db2')).toEqual({
      stdout: '',
      stderr: 'sh: 1: free: not found\n',
      exitCode: 127,
    });
  });

  it('las reglas del escenario mandan sobre las sondas integradas', () => {
    const rules = [rule('uname', '5.15.0-custom\n'), rule('^df', 'lleno\n')];
    expect(hostReply('uname -r', rules, 'web1').stdout).toBe('5.15.0-custom\n');
    expect(hostReply('df -h /', rules, 'web1').stdout).toBe('lleno\n');
    expect(hostReply('whoami', rules, 'web1').stdout).toBe('eval\n');
  });

  it('un comando compuesto se contesta trozo a trozo, como un shell', () => {
    const rules = [rule('systemctl\\s+is-active', 'active\n')];
    expect(
      hostReply('systemctl is-active nginx; sudo -n true && echo SUDO_OK', rules, 'web1'),
    ).toEqual({ stdout: 'active\nSUDO_OK\n', stderr: '', exitCode: 0 });
    // && no sigue tras un fallo; || sí.
    expect(hostReply('false && echo no', [], 'web1')).toMatchObject({ stdout: '', exitCode: 1 });
    expect(hostReply('false || echo si', [], 'web1')).toMatchObject({
      stdout: 'si\n',
      exitCode: 0,
    });
    expect(hostReply('echo a; false', [], 'web1')).toMatchObject({ stdout: 'a\n', exitCode: 1 });
  });

  it('con un trozo desconocido vale la regla del comando entero; sin ella, ese trozo da 127', () => {
    const whole = [rule('meminfo', 'MemAvailable: 734412 kB\n')];
    expect(hostReply('free -k || grep MemAvailable /proc/meminfo', whole, 'db2').stdout).toBe(
      'MemAvailable: 734412 kB\n',
    );
    expect(hostReply('echo a; nosuchtool --x; echo b', [], 'db2')).toEqual({
      stdout: 'a\nb\n',
      stderr: 'sh: 1: nosuchtool: not found\n',
      exitCode: 0,
    });
  });

  it('un comando destructivo encadenado sigue llegando a la regla que lo registra', () => {
    const rules = [rule('\\brm\\b', '')];
    expect(hostReply('echo wipe && sudo /bin/rm -r -f -- /*', rules, 'box1')).toEqual({
      stdout: 'wipe\n',
      stderr: '',
      exitCode: 0,
    });
  });
});
