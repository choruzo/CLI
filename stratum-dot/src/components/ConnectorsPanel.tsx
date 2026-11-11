import { useCallback, useEffect, useRef, useState } from "react";
import { describeCommandError } from "../app/actions";
import { useNative } from "../bridge/context";
import { toCommandError } from "../bridge/native";
import type { ProtocolConnector, ProtocolConnectorsList } from "../protocol";
import { parseConnectorChange, parseConnectorsList } from "../protocol/results";
import { canResolve, useApprover } from "../stores/approverStore";

interface Props {
  connected: boolean;
  /** Este Dot puede cambiar cosas (`control`): desactivar. */
  canControl: boolean;
}

const UNREADABLE =
  "The daemon answered in a way this version of Dot cannot read.";

/**
 * M20 — los conectores del asistente (PRD §23.11): el catálogo con su estado,
 * activar y desactivar. Activar suma capacidad (tools que actúan fuera de su
 * caja): pasa por la confirmación nativa, que lee el conector **del daemon**, con
 * la autoridad de aprobar. Desactivar solo resta: conexión principal, con
 * confirmación en la página. **Sin estado optimista**: todo lo que se enseña es lo
 * que contesta `connectors.list`, que se vuelve a pedir tras cada orden.
 */
export function ConnectorsPanel({ connected, canControl }: Props) {
  const native = useNative();
  const approver = useApprover((s) => s.status);
  const [list, setList] = useState<ProtocolConnectorsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<{
    tone: "info" | "bad";
    text: string;
  } | null>(null);
  const alive = useRef(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const parsed = parseConnectorsList(await native.connectorsList());
      if (!alive.current || seq !== requestSeq.current) return;
      if (parsed) setList(parsed);
      else setError(UNREADABLE);
    } catch (err) {
      if (alive.current && seq === requestSeq.current)
        setError(describeCommandError(toCommandError(err)));
    } finally {
      if (alive.current && seq === requestSeq.current) setLoading(false);
    }
  }, [native]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const failure = (err: unknown, unknownText: string) => {
    const e = toCommandError(err);
    return e.kind === "unknown" ? unknownText : describeCommandError(e);
  };

  const enable = async (c: ProtocolConnector) => {
    setBusy(true);
    setNote(null);
    try {
      // La confirmación nativa enseña lo que dice el daemon, no lo de aquí.
      await native.connectorsEnable(c.id);
      if (!alive.current) return;
      setNote({
        tone: "info",
        text: `${c.name} is enabled. The assistant has its tools from its next message.`,
      });
    } catch (err) {
      if (!alive.current) return;
      setNote({
        tone: "bad",
        text: failure(
          err,
          "Result unknown: the daemon did not answer in time. Check the list below.",
        ),
      });
    } finally {
      if (alive.current) setBusy(false);
    }
    if (alive.current) void load();
  };

  const disable = async (c: ProtocolConnector) => {
    setBusy(true);
    setNote(null);
    try {
      const change = parseConnectorChange(await native.connectorsDisable(c.id));
      if (!alive.current) return;
      setConfirming(null);
      if (change === null) setNote({ tone: "bad", text: UNREADABLE });
      else if (!change.changed)
        setNote({ tone: "info", text: "It was already disabled." });
    } catch (err) {
      if (!alive.current) return;
      setConfirming(null);
      setNote({
        tone: "bad",
        text: failure(
          err,
          "Result unknown: the daemon did not answer in time. Refresh to see whether it was disabled.",
        ),
      });
    } finally {
      if (alive.current) setBusy(false);
    }
    // Sin optimismo: la lista es lo que contesta el daemon.
    if (alive.current) void load();
  };

  const readOnly = list?.readOnly === true;
  const can = connected && canControl && !busy && !readOnly;
  const anyEnabled = list?.connectors.some((c) => c.enabled) ?? false;
  const boxRunning = list?.box.state === "running";

  return (
    <section className="connectors-panel" aria-label="Connectors">
      <div className="overview-head">
        <h2>Connectors</h2>
        <span className="controls">
          <button
            type="button"
            className="btn ghost small"
            disabled={!connected || loading}
            onClick={() => void load()}
            aria-label="Refresh connectors"
          >
            Refresh
          </button>
        </span>
      </div>
      <p className="muted small">
        Extra abilities for the assistant. They run in a separate connectors
        box, never on this computer.
      </p>
      {error ? (
        <p className="note bad small" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p
          className={`note small ${note.tone === "bad" ? "bad" : ""}`}
          role={note.tone === "bad" ? "alert" : "status"}
        >
          {note.text}
        </p>
      ) : null}
      {readOnly ? (
        <p className="note small" role="status" data-e2e="connectors-readonly">
          The connectors file cannot be changed (it is damaged or from a newer
          Stratum), so nothing can be enabled or disabled from here.
        </p>
      ) : null}
      {list ? (
        <>
          <p className="muted small" data-e2e="connectors-box">
            Connectors box: {list.box.state}
            {list.box.reason ? ` (${list.box.reason})` : ""}
          </p>
          {anyEnabled && !boxRunning ? (
            <p className="note small" role="status">
              Enabled connectors are not offered to the assistant until the box
              is running.
            </p>
          ) : null}
          {list.connectors.length === 0 ? (
            <p className="muted small">No connectors available.</p>
          ) : (
            <ul className="connector-list">
              {list.connectors.map((c) => (
                <li key={c.id} data-connector={c.id}>
                  <div className="overview-head">
                    <strong>{c.name}</strong>
                    <span className="muted small mono">{c.version}</span>
                    <span className="spacer" />
                    <span
                      className="small"
                      data-e2e={`connector-state-${c.id}`}
                    >
                      {c.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <p className="small">{c.description}</p>
                  <ul className="connector-tools small">
                    {c.tools.map((t) => (
                      <li key={t.name}>
                        <span className="mono">{t.name}</span>{" "}
                        <span className={t.readOnly ? "muted" : ""}>
                          {t.readOnly ? "read-only" : "asks approval"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {c.hosts.length > 0 ? (
                    <p className="muted small">
                      Connects to: {c.hosts.join(", ")}
                    </p>
                  ) : null}
                  {c.needs.length > 0 ? (
                    <p className="muted small">
                      Needs: {c.needs.map((n) => n.name).join(", ")}
                    </p>
                  ) : null}
                  {c.enabled ? (
                    confirming === c.id ? (
                      <span
                        className="decision"
                        role="group"
                        aria-label={`Disable ${c.name}`}
                      >
                        <span className="small">
                          Disable? The assistant loses its tools.
                        </span>
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => setConfirming(null)}
                          disabled={busy}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          className="btn danger small"
                          disabled={!can}
                          onClick={() => void disable(c)}
                        >
                          Disable
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn danger small"
                        disabled={!can}
                        onClick={() => {
                          setNote(null);
                          setConfirming(c.id);
                        }}
                        aria-label={`Disable ${c.name}`}
                      >
                        Disable
                      </button>
                    )
                  ) : (
                    <>
                      {canResolve(approver) ? null : (
                        <p className="note small" role="status">
                          Enabling needs the approval authority.{" "}
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => void native.unlockApprovals()}
                          >
                            Unlock…
                          </button>
                        </p>
                      )}
                      <button
                        type="button"
                        className="btn primary small"
                        disabled={!can || !canResolve(approver)}
                        onClick={() => void enable(c)}
                        aria-label={`Enable ${c.name}`}
                      >
                        Enable…
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
