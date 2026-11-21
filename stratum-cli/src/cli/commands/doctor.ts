import { homedir } from 'os';
import { Command } from 'commander';
import { StratumClient } from '../../client/client.js';
import { defaultEndpointDir, fileDiscovery } from '../../client/discovery.js';
import { bundledCatalog } from '../../connectors/active.js';
import { BoxManager } from '../../box/manager.js';
import { readTelegramFile } from '../../channels/telegram/store.js';
import { loadConfig } from '../../config/loader.js';
import type { StratumConfig } from '../../config/schema.js';
import { autostartStatus, defaultAutostartDeps } from '../../daemon/autostart.js';
import { doctorChecks, worstStatus, type DoctorFacts } from '../../doctor/checks.js';
import { connectorsFacts, modelFacts } from '../../doctor/collect.js';
import { companionDataDir } from '../../host/companion.js';
import type {
  ProtocolDoctorArea,
  ProtocolDoctorCheck,
  ProtocolDoctorReport,
  ProtocolDoctorStatus,
} from '../../protocol/index.js';
import { doctorReportSchema } from '../../protocol/schemas.js';
import { redactSecrets } from '../../security/redact-output.js';
import { locateLiveDaemon } from '../daemon-link.js';
import { cliVersion } from '../version.js';

/**
 * M23 — `stratum doctor [--json]`: el diagnóstico del asistente (daemon, caja,
 * conectores, Telegram, modelo y ficheros de datos). **Solo lee y nunca arregla
 * nada**: cada problema trae lo que puede hacer la persona.
 *
 * Con el daemon en marcha, el informe es el suyo (`doctor.run`, `observer`):
 * solo él sabe qué hace el canal, si la caja arrancó con él o qué vigilantes
 * están suspendidos. Sin daemon, la CLI mira lo que puede leer ella misma (la
 * CLI no depende del daemon) y lo dice.
 */

const SYMBOL: Record<ProtocolDoctorStatus, string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  off: '-',
};

const AREA_LABEL: Record<ProtocolDoctorArea, string> = {
  daemon: 'Daemon',
  box: 'Box',
  connectors: 'Connectors',
  telegram: 'Telegram',
  model: 'Model',
  data: 'Data',
};

export function formatDoctorReport(report: ProtocolDoctorReport, local: boolean): string {
  const lines: string[] = [];
  let area: ProtocolDoctorArea | null = null;
  for (const c of report.checks) {
    if (c.area !== area) {
      if (area !== null) lines.push('');
      area = c.area;
      lines.push(AREA_LABEL[c.area]);
    }
    lines.push(`  ${SYMBOL[c.status]} ${c.title}`);
    if (c.detail) lines.push(`      ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`      → ${c.fix}`);
  }
  const counts = (s: ProtocolDoctorStatus): number =>
    report.checks.filter((c) => c.status === s).length;
  lines.push('');
  const worst = worstStatus(report.checks);
  lines.push(
    worst === 'ok'
      ? 'Everything checked is fine.'
      : `${counts('fail')} failing, ${counts('warn')} warnings.`,
  );
  if (local) {
    lines.push(
      'Checked without the daemon: the Telegram channel, the box autostart and the watches were not checked.',
    );
  }
  return lines.join('\n');
}

/** Sin daemon: lo que la CLI puede leer por su cuenta. */
export async function localDoctorReport(opts: {
  config: StratumConfig;
  home: string;
  now: number;
  daemonRunning: boolean | null;
}): Promise<ProtocolDoctorReport> {
  const box = new BoxManager({ config: opts.config.box });
  const [boxStatus, connectorsBox, model, login] = await Promise.all([
    box.status(),
    box.connectorsStatus(),
    modelFacts({ config: opts.config, session: null, probe: true }),
    autostartStatus(defaultAutostartDeps())
      .then((s) => ({ enabled: s.enabled, detail: s.method }))
      .catch(() => null),
  ]);
  const clean = (t: string | undefined): string | null => (t ? redactSecrets(t).text : null);
  const daemonDir = defaultEndpointDir(opts.home);
  const telegram = readTelegramFile(daemonDir);
  const facts: DoctorFacts = {
    daemon: {
      running: opts.daemonRunning === false ? false : null,
      clientVersion: null,
      loginAutostart: login,
    },
    box: {
      enabled: opts.config.box.enabled,
      autostart: opts.config.box.autostart,
      desktop: boxStatus.desktop,
      status: {
        state: boxStatus.state,
        runtime: boxStatus.runtime,
        reason: clean(boxStatus.reason),
        outdated: boxStatus.outdated,
      },
      autostartRun: null,
    },
    connectors: connectorsFacts({
      catalog: bundledCatalog(),
      companionDir: companionDataDir(opts.home),
      secretsDir: daemonDir,
      box: {
        state: connectorsBox.state,
        reason: clean(connectorsBox.reason),
        outdated: connectorsBox.outdated,
      },
    }),
    telegram: {
      configEnabled: opts.config.channels?.telegram?.enabled ?? false,
      file:
        telegram.state === 'ok' || telegram.state === 'absent' || telegram.state === 'newer'
          ? telegram.state
          : 'invalid',
      paired: telegram.state === 'ok' ? telegram.file.paired.length : 0,
      live: null,
    },
    model,
    stores: null,
    watches: null,
  };
  return { checkedAt: opts.now, checks: doctorChecks(facts) };
}

async function daemonReport(): Promise<ProtocolDoctorReport | null> {
  const client = new StratumClient({
    discovery: fileDiscovery(),
    identity: { kind: 'cli', name: 'stratum doctor', version: cliVersion(), roles: ['observer'] },
    reconnect: false,
    requestTimeoutMs: 30_000,
  });
  try {
    await client.connect();
    const result = await client.request('doctor.run', {});
    return doctorReportSchema.parse(result.report);
  } catch {
    return null;
  } finally {
    client.close();
  }
}

/** Avisa de que el daemon está, pero no contestó (otro problema que contar). */
function unreachableCheck(): ProtocolDoctorCheck {
  return {
    id: 'daemon.running',
    area: 'daemon',
    status: 'fail',
    title: 'The daemon is running but did not answer',
    detail: 'It may be an older Stratum without doctor, or stuck.',
    fix: 'stratum daemon stop, then stratum daemon start',
  };
}

export const doctorCommand = new Command('doctor')
  .description(
    "Check the assistant's setup: daemon, box, connectors, Telegram and model (reads only, fixes nothing)",
  )
  .option('--json', 'output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const home = homedir();
    const found = await locateLiveDaemon();
    let report: ProtocolDoctorReport | null = null;
    let local = false;
    if (found.status === 'found') report = await daemonReport();
    if (!report) {
      local = true;
      report = await localDoctorReport({
        config: loadConfig(home),
        home,
        now: Date.now(),
        daemonRunning: found.status === 'found' ? null : false,
      });
      if (found.status === 'found') report.checks.unshift(unreachableCheck());
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ...report, local }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatDoctorReport(report, local)}\n`);
    }
    if (worstStatus(report.checks) === 'fail') process.exitCode = 1;
  });
