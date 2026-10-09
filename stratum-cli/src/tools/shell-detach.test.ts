import { describe, it, expect } from 'vitest';
import { commandVeto, shellDetachConfirmReason, shellDetachReason } from './guards.js';

describe('shellDetachReason — procesos que se desligan de la sesión', () => {
  const detaches = [
    'sleep 100 &',
    'npm run dev > /dev/null 2>&1 &',
    'nohup ./server.sh',
    'nohup node server.js > out.log 2>&1 &',
    'sudo nohup ./server.sh',
    '/usr/bin/nohup ./server.sh',
    'setsid ./daemon',
    'node server.js & disown',
    'cd app && npm start &',
    'sh -c "sleep 100 &"',
    'bash -lc "nohup ./run.sh"',
    'Start-Process node server.js',
    'Start-Process -FilePath node -ArgumentList server.js -WindowStyle Hidden',
    'saps notepad',
    'start node server.js',
    'cmd /c start /b node server.js',
    'pwsh -Command "Start-Process node server.js"',
    'Start-Job -ScriptBlock { npm test }',
    'npm test &',
    'screen -dmS build make',
    'tmux new-session -d -s build make',
    'systemd-run --user ./job.sh',
  ];
  for (const command of detaches) {
    it(`detecta: ${command}`, () => {
      expect(shellDetachReason(command)).not.toBeNull();
    });
  }

  const fine = [
    'npm test',
    'npm start',
    'systemctl start nginx',
    'docker start web',
    'make && make install',
    'ls 2>&1',
    'cmd > out.log 2>&1',
    'build &> build.log',
    'echo hi >&2',
    'make |& tee log',
    '& "C:\\Program Files\\Git\\bin\\git.exe" status',
    'if ($x) { & $cmd }',
    '$out = & git status',
    'git log; & npm test',
    'git commit -m "fix a & b"',
    "echo 'run in background with &'",
    'grep -r nohup docs/',
    'echo start',
    'curl "https://example.com/?a=1&b=2"',
    'a & b & wait',
    '(sleep 1 &) ; wait',
    'Start-Job { npm test } | Wait-Job | Receive-Job',
    'tmux ls',
    'screen -ls',
  ];
  for (const command of fine) {
    it(`deja pasar: ${command}`, () => {
      expect(shellDetachReason(command)).toBeNull();
    });
  }
});

describe('shellDetach en commandVeto', () => {
  it('bloquea por defecto en el target local y remite a background:true', () => {
    const veto = commandVeto('nohup ./server.sh &', undefined, 'local');
    expect(veto).toContain('outside the session');
    expect(veto).toContain('background:true');
  });

  it('no se aplica a un host remoto: allí no hay JobManager que saltarse', () => {
    expect(commandVeto('nohup ./server.sh &', undefined, 'ssh:web')).toBeNull();
  });

  it('es configurable como el resto de la capa 2', () => {
    expect(commandVeto('sleep 9 &', { shellDetach: 'allow' }, 'local')).toBeNull();
    expect(commandVeto('sleep 9 &', { shellDetach: 'confirm' }, 'local')).toBeNull();
    expect(
      shellDetachConfirmReason('sleep 9 &', { shellDetach: 'confirm' }, 'local'),
    ).not.toBeNull();
    expect(shellDetachConfirmReason('sleep 9 &', undefined, 'local')).toBeNull();
    expect(shellDetachConfirmReason('sleep 9 &', { shellDetach: 'confirm' }, 'ssh:web')).toBeNull();
  });

  it('sigue vetando lo catastrófico antes que nada', () => {
    expect(commandVeto('rm -rf / &', undefined, 'local')).toContain('non-negotiable');
  });
});
