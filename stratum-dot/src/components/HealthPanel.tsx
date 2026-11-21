import { useCallback, useEffect, useRef, useState } from 'react';
import { describeCommandError } from '../app/actions';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import { useConnection } from '../stores/connectionStore';
import { revisionSkewNotice } from '../protocol/revision-skew';
import type { ProtocolDoctorArea, ProtocolDoctorCheck, ProtocolDoctorReport, ProtocolDoctorStatus } from '../protocol';
import { parseDoctorReport } from '../protocol/results';

interface Props {
  connected: boolean;
}

const AREA_LABELS: Record<ProtocolDoctorArea, string> = {
  daemon: 'Daemon',
  box: 'Box',
  connectors: 'Connectors',
  telegram: 'Telegram',
  model: 'Model',
  data: 'Data',
};

const STATUS_LABELS: Record<ProtocolDoctorStatus, string> = {
  ok: 'OK',
  warn: 'Warning',
  fail: 'Failing',
  off: 'Off',
};

/** Las comprobaciones agrupadas por área, en el orden en que llegan. */
export function groupChecksByArea(
  checks: ProtocolDoctorCheck[],
): Array<{ area: ProtocolDoctorArea; checks: ProtocolDoctorCheck[] }> {
  const groups: Array<{ area: ProtocolDoctorArea; checks: ProtocolDoctorCheck[] }> = [];
  for (const check of checks) {
    const group = groups.find((g) => g.area === check.area);
    if (group) group.checks.push(check);
    else groups.push({ area: check.area, checks: [check] });
  }
  return groups;
}

/** «Everything checked is fine.» o «N failing, M warnings.». */
export function healthSummary(checks: ProtocolDoctorCheck[]): string {
  const failing = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  if (failing === 0 && warnings === 0) return 'Everything checked is fine.';
  return `${failing} failing, ${warnings} warnings.`;
}

/**
 * M23 — la salud del asistente (`doctor.run`, `docs/protocol.md` §33): el
 * informe de diagnóstico del daemon, agrupado por área. **Solo lee**: el `fix`
 * es un texto para la persona, nunca un botón ni algo que Dot ejecute. Se pide
 * al abrir el panel y con *Check again*; una consulta sin respuesta se enseña
 * como error y no se repite sola.
 */
export function HealthPanel({ connected }: Props) {
  const native = useNative();
  const [report, setReport] = useState<ProtocolDoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // Una respuesta tardía de una petición anterior no pisa a la de una posterior.
  const sequence = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const parsed = parseDoctorReport(await native.doctorRun());
      if (!alive.current || mine !== sequence.current) return;
      if (!parsed) {
        setError('Could not run the check: the daemon answered in a way this version of Dot cannot read.');
        return;
      }
      setReport(parsed);
    } catch (err) {
      if (!alive.current || mine !== sequence.current) return;
      setError(`Could not run the check: ${describeCommandError(toCommandError(err))}`);
    } finally {
      if (alive.current && mine === sequence.current) setLoading(false);
    }
  }, [native]);

  // Al abrir el panel (y al recuperar la conexión). Después, solo con el botón.
  useEffect(() => {
    if (connected) void run();
  }, [connected, run]);

  const groups = report ? groupChecksByArea(report.checks) : [];
  // Desfase de revisión con el daemon: una fila local (no la manda el daemon).
  const connection = useConnection((s) => s.state);
  const skew = connection.kind === 'connected' ? revisionSkewNotice(connection.serverRevision, connection.serverVersion) : null;

  return (
    <section className="health-panel" aria-label="Health" data-health={report ? 'ready' : 'unknown'}>
      <div className="overview-head">
        <h2>Health</h2>
        <span className="controls">
          <button
            type="button"
            className="btn ghost small"
            disabled={!connected || loading}
            onClick={() => void run()}
            aria-label="Check again"
          >
            Check again
          </button>
        </span>
      </div>
      {!connected ? (
        <p className="muted small" role="status">
          Not connected to the Stratum daemon.
        </p>
      ) : loading ? (
        <p className="muted small" role="status">
          Checking…
        </p>
      ) : null}
      {error ? (
        <p className="note bad small" role="alert">
          {error}
        </p>
      ) : null}
      {report && !loading ? (
        <p className="small" data-e2e="health-summary">
          {healthSummary(report.checks)}{' '}
          <span className="muted">Checked at {new Date(report.checkedAt).toLocaleTimeString()}.</span>
        </p>
      ) : null}
      {skew ? (
        <div className="health-area" data-area="revision">
          <ul className="health-checks">
            <li className="health-check" data-check="revision.skew">
              <div className="row-top">
                <span className="health-status" data-status="warn" role="img" aria-label={STATUS_LABELS.warn} />
                <span className="health-title">{skew.title}</span>
              </div>
              <div className="muted small health-detail">{skew.body}</div>
            </li>
          </ul>
        </div>
      ) : null}
      {report
        ? groups.map((group) => (
            <div key={group.area} className="health-area" data-area={group.area}>
              <h3>{AREA_LABELS[group.area]}</h3>
              <ul className="health-checks">
                {group.checks.map((check) => (
                  <li key={check.id} className="health-check" data-check={check.id}>
                    <div className="row-top">
                      <span
                        className="health-status"
                        data-status={check.status}
                        role="img"
                        aria-label={STATUS_LABELS[check.status]}
                      />
                      <span className="health-title">{check.title}</span>
                    </div>
                    {check.detail ? <div className="muted small health-detail">{check.detail}</div> : null}
                    {check.status !== 'ok' && check.fix ? (
                      <div className="small health-fix">
                        <code>{check.fix}</code>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))
        : null}
    </section>
  );
}
