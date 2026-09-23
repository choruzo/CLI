import { describe, it, expect } from 'vitest';
import { readOnlyCommandVerdict } from './readonly-commands.js';

describe('readOnlyCommandVerdict — comandos que solo observan (Hito 17)', () => {
  it.each([
    'ls -la /var/log',
    'cat /etc/os-release',
    'tail -n 200 /var/log/syslog',
    'grep -rn "ERROR" /var/log/app | head -50',
    'ps aux | grep nginx',
    'df -h && free -m',
    'journalctl -u nginx --since "1 hour ago" --no-pager',
    'systemctl status nginx',
    'systemctl list-units --failed',
    'ss -tulpn',
    'ip addr show',
    'ip route',
    'dig +short example.com',
    'curl -sI https://example.com',
    'curl -s https://api.example.com/health',
    'wget -qO- https://example.com',
    'git status && git log --oneline -5',
    'git diff HEAD~1 -- src/',
    'git branch -a',
    'git remote -v',
    'kubectl get pods -n prod -o wide',
    "kubectl get pods -o jsonpath='{.items[*].metadata.name}'",
    'kubectl -n prod logs deploy/api --tail=100',
    'kubectl rollout status deploy/api',
    'kubectl config current-context',
    'docker ps -a',
    "docker ps --format '{{.Names}}'",
    'docker compose logs --tail 50 web',
    'docker image ls',
    'helm list -A',
    'terraform plan',
    'terraform state list',
    'aws ec2 describe-instances --region eu-west-1',
    'az vm list',
    'gcloud compute instances list',
    'sed -n "10,20p" config.yml',
    "awk '{print $1}' access.log | sort | uniq -c | sort -rn",
    'find /var/log -name "*.gz" -mtime +7',
    'sudo journalctl -xe',
    'timeout 5 ping -c 3 10.0.0.1',
    'cat app.log 2>&1 | tail -20',
    'ls missing 2>/dev/null',
    'Get-ChildItem C:\\Windows\\Logs | Select-Object -First 5',
    'Get-Service | Where-Object Status -eq Running',
    'Test-NetConnection example.com -Port 443',
    'ipconfig /all',
    'sc query wuauserv',
    'FOO=1 env',
    'echo hola',
  ])('read-only: %s', (cmd) => {
    expect(readOnlyCommandVerdict(cmd)).toEqual({ readOnly: true });
  });

  it.each([
    ['rm -f /tmp/x', 'rm'],
    ['echo hola > fichero.txt', 'redirection'],
    ['cat a >> b', 'redirection'],
    ['ls; rm -rf build', 'rm'],
    ['ls && touch x', 'touch'],
    ['cat file | tee copia', 'tee'],
    ['echo $(rm -rf /tmp/x)', 'substitution'],
    ['echo `id`', 'substitution'],
    ['python -c "import os"', 'python'],
    ['node -e "1"', 'node'],
    ['bash script.sh', 'bash'],
    ['./deploy.sh', 'deploy.sh'],
    ['sed -i "s/a/b/" f', 'sed -i'],
    ['sed "w out.txt" f', 'sed script'],
    ['awk \'{ system("rm x") }\' f', 'awk'],
    ['find . -name "*.tmp" -delete', 'find -delete'],
    ['find . -exec rm {} ;', 'find -exec'],
    ['curl -X POST https://api/x', 'POST'],
    ['curl -d @datos.json https://api/x', '-d'],
    ['curl -o salida.bin https://x', '-o'],
    ['wget https://x/file.tar.gz', 'wget'],
    ['systemctl restart nginx', 'restart'],
    ['service nginx stop', 'service'],
    ['ip link set eth0 down', 'ip link set'],
    ['sysctl -w net.ipv4.ip_forward=1', 'sysctl'],
    ['git push origin main', 'push'],
    ['git checkout -- .', 'checkout'],
    ['git branch -D feature', 'branch -D'],
    ["git -c core.pager='touch x' log", 'git -c'],
    ['kubectl delete pod api-1', 'delete'],
    ['kubectl apply -f deploy.yml', 'apply'],
    ['kubectl exec -it api -- sh', 'exec'],
    ['docker rm -f web', 'docker rm'],
    ['docker compose up -d', 'compose up'],
    ['helm upgrade api ./chart', 'helm upgrade'],
    ['terraform apply', 'apply'],
    ['terraform plan -out plan.bin', 'plan -out'],
    ['aws s3 cp a s3://b/', 'aws s3 cp'],
    ['sort -o out.txt in.txt', 'sort -o'],
    ['Remove-Item C:\\temp\\x', 'Remove-Item'],
    ['Stop-Service wuauserv', 'Stop-Service'],
    ['Get-ChildItem | ForEach-Object { Remove-Item $_ }', 'ForEach-Object'],
    ['Get-Process | Where-Object { $_.Kill() }', 'script block'],
    ['sc stop wuauserv', 'sc stop'],
    ['ipconfig /release', 'ipconfig'],
    ['cat <<EOF | sh', 'heredoc'],
    ['', 'empty'],
  ])('mutating: %s', (cmd) => {
    const verdict = readOnlyCommandVerdict(cmd);
    expect(verdict.readOnly).toBe(false);
    if (!verdict.readOnly) expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it('un envoltorio no esconde el comando real (sudo, xargs, env)', () => {
    expect(readOnlyCommandVerdict('sudo rm -rf /var/cache/x').readOnly).toBe(false);
    expect(readOnlyCommandVerdict('find . -name x | xargs rm').readOnly).toBe(false);
    expect(readOnlyCommandVerdict('env FOO=1 rm x').readOnly).toBe(false);
  });

  it('el motivo nombra el comando que no se reconoce', () => {
    const verdict = readOnlyCommandVerdict('ls && ./mi_script --deploy');
    expect(verdict).toEqual({
      readOnly: false,
      reason: '`mi_script` is not a known read-only command',
    });
  });

  it('un ">" dentro de comillas no es una redirección', () => {
    expect(readOnlyCommandVerdict('grep ">" index.html').readOnly).toBe(true);
    expect(readOnlyCommandVerdict("echo 'a > b'").readOnly).toBe(true);
  });
});
