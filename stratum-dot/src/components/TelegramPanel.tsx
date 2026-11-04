import { useCallback, useEffect, useRef, useState } from "react";
import { describeCommandError } from "../app/actions";
import { useNative } from "../bridge/context";
import { toCommandError } from "../bridge/native";
import type {
  ProtocolTelegramPaired,
  ProtocolTelegramStatus,
} from "../protocol";
import {
  parseChannelsStatus,
  parsePairBegin,
  parseUnpair,
} from "../protocol/results";
import { canResolve, useApprover } from "../stores/approverStore";

interface Props {
  connected: boolean;
  /** Este Dot puede cambiar cosas (`control`): pedir un código, desemparejar. */
  canControl: boolean;
  /** Cada cuánto se consulta el estado mientras se empareja (tests: menos). */
  pollMs?: number;
}

const UNREADABLE =
  "The daemon answered in a way this version of Dot cannot read.";
const POLL_MS = 2_000;

/** Lo que dice cada estado del canal cuando no está escuchando. */
const NOT_RUNNING: Record<
  Exclude<ProtocolTelegramStatus["state"], "running">,
  string
> = {
  "not-configured":
    "Not set up. Create a bot with @BotFather in Telegram and run “stratum channels telegram setup” in a terminal.",
  disabled:
    "Turned off. “stratum channels telegram setup” in a terminal turns it on again.",
  invalid:
    "Its settings file is not valid, so it stays off. Run “stratum channels telegram setup” again.",
  newer:
    "Its settings were written by a newer Stratum; this one does not read them.",
  unauthorized:
    "Telegram rejects the bot. Run “stratum channels telegram setup” again with a new one.",
};

const who = (p: { name: string; username?: string; userId: number }) =>
  `${p.name}${p.username ? ` (@${p.username})` : ""} · id ${p.userId}`;

/**
 * M18 — el canal de Telegram (PRD §23.11): con qué bot, quién está emparejado y
 * emparejar uno nuevo. Configurar el bot no es de aquí (se teclea en una
 * terminal). Emparejar va en dos pasos: el código lo manda la persona al bot
 * desde su chat, y el candidato que eso deja se confirma en la ventana nativa
 * (que lo lee del daemon) con la autoridad de aprobar. **Sin estado optimista**:
 * todo lo que se enseña es lo que contesta `channels.status`, que solo se
 * consulta al abrir el panel, mientras se empareja y tras cada orden.
 */
export function TelegramPanel({
  connected,
  canControl,
  pollMs = POLL_MS,
}: Props) {
  const native = useNative();
  const approver = useApprover((s) => s.status);
  const [status, setStatus] = useState<ProtocolTelegramStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState<{
    code: string;
    link: string;
    expiresAt: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
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
      const parsed = parseChannelsStatus(await native.channelsStatus());
      if (!alive.current || seq !== requestSeq.current) return;
      if (parsed) setStatus(parsed);
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

  // Mientras se empareja, y solo entonces, se mira si llegó el código al bot.
  useEffect(() => {
    if (!code || !connected) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [code, connected, load, pollMs]);

  // El daemon ya contó este emparejamiento al menos una vez (si no, un estado de
  // antes de pedir el código lo daría por anulado).
  const [sawPairing, setSawPairing] = useState(false);
  useEffect(() => {
    if (code && status?.pairing) setSawPairing(true);
  }, [code, status]);
  useEffect(() => {
    if (!code) setSawPairing(false);
  }, [code]);

  const expired = code !== null && Date.now() >= code.expiresAt;
  const candidate = code ? (status?.pairing?.candidate ?? null) : null;
  // El código se anuló en el daemon (otro código, cinco fallos, reinicio).
  const cancelled =
    code !== null && sawPairing && status?.pairing === null && !busy;

  const failure = (err: unknown, unknownText: string) => {
    const e = toCommandError(err);
    return e.kind === "unknown" ? unknownText : describeCommandError(e);
  };

  const begin = async () => {
    setBusy(true);
    setNote(null);
    try {
      const parsed = parsePairBegin(await native.channelsPairBegin());
      if (!alive.current) return;
      if (parsed) setCode(parsed);
      else setNote({ tone: "bad", text: UNREADABLE });
    } catch (err) {
      if (!alive.current) return;
      setNote({
        tone: "bad",
        text: failure(
          err,
          "Result unknown: the daemon did not answer in time. Try again in a moment.",
        ),
      });
    } finally {
      if (alive.current) setBusy(false);
    }
    if (alive.current) void load();
  };

  const pair = async (userId: number) => {
    setBusy(true);
    setNote(null);
    try {
      // La confirmación nativa enseña lo que dice el daemon, no lo de aquí.
      await native.channelsPairConfirm(userId);
      if (!alive.current) return;
      setCode(null);
      setNote({
        tone: "info",
        text: "Paired. That chat can now talk to the assistant.",
      });
    } catch (err) {
      if (!alive.current) return;
      setNote({
        tone: "bad",
        text: failure(
          err,
          "Result unknown: the daemon did not answer in time. Check the paired chats below.",
        ),
      });
    } finally {
      if (alive.current) setBusy(false);
    }
    if (alive.current) void load();
  };

  const unpair = async (p: ProtocolTelegramPaired) => {
    setBusy(true);
    setNote(null);
    try {
      const removed = parseUnpair(await native.channelsUnpair(p.userId));
      if (!alive.current) return;
      setConfirming(null);
      if (removed === null) setNote({ tone: "bad", text: UNREADABLE });
      else if (!removed)
        setNote({ tone: "info", text: "It was already unpaired." });
    } catch (err) {
      if (!alive.current) return;
      setConfirming(null);
      setNote({
        tone: "bad",
        text: failure(
          err,
          "Result unknown: the daemon did not answer in time. Refresh to see whether it was unpaired.",
        ),
      });
    } finally {
      if (alive.current) setBusy(false);
    }
    // Sin optimismo: la lista es lo que contesta el daemon.
    if (alive.current) void load();
  };

  const can = connected && canControl && !busy;
  const running = status?.state === "running";

  return (
    <section className="telegram-panel" aria-label="Telegram">
      <div className="overview-head">
        <h2>Telegram</h2>
        <span className="controls">
          <button
            type="button"
            className="btn ghost small"
            disabled={!connected || loading}
            onClick={() => void load()}
            aria-label="Refresh Telegram"
          >
            Refresh
          </button>
        </span>
      </div>
      <p className="muted small">
        Talk to the assistant and approve its requests from a paired Telegram
        chat.
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
      {status && !running ? (
        <p className="muted small" data-e2e="telegram-state">
          {
            NOT_RUNNING[
              status.state as Exclude<
                ProtocolTelegramStatus["state"],
                "running"
              >
            ]
          }
        </p>
      ) : null}
      {status && running ? (
        <>
          <p className="small" data-e2e="telegram-state">
            Listening as <span className="mono">@{status.bot?.username}</span>
          </p>
          {status.lastError ? (
            <p className="note small" role="status">
              Telegram is not answering ({status.lastError.kind}); retrying.{" "}
              {status.lastError.message}
            </p>
          ) : null}
          {status.paired.length === 0 ? (
            <p className="muted small">No chat is paired yet.</p>
          ) : (
            <ul className="telegram-paired">
              {status.paired.map((p) => (
                <li key={p.userId} data-user={p.userId}>
                  <span className="small">{who(p)}</span>
                  <span className="spacer" />
                  {confirming === p.userId ? (
                    <span
                      className="decision"
                      role="group"
                      aria-label={`Unpair ${p.name}`}
                    >
                      <span className="small">
                        Unpair? It will no longer reach the assistant.
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
                        onClick={() => void unpair(p)}
                      >
                        Unpair
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn danger small"
                      disabled={!can}
                      onClick={() => {
                        setNote(null);
                        setConfirming(p.userId);
                      }}
                      aria-label={`Unpair ${p.name}`}
                    >
                      Unpair
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {code ? (
            <div
              className="telegram-pairing"
              role="group"
              aria-label="Pair a Telegram chat"
            >
              {expired || cancelled ? (
                <p className="small" role="status">
                  {expired
                    ? "The code expired."
                    : "That code is no longer valid."}{" "}
                  Ask for another one to pair a chat.
                </p>
              ) : candidate ? (
                <>
                  <p className="small" data-e2e="telegram-candidate">
                    {who(candidate)} sent the code.
                  </p>
                  <p className="muted small">
                    Pairing lets that account talk to the assistant and approve
                    its requests from Telegram. Dot asks you to confirm it in
                    its own window.
                  </p>
                  {canResolve(approver) ? null : (
                    <p className="note small" role="status">
                      Pairing needs the approval authority.{" "}
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
                    onClick={() => void pair(candidate.userId)}
                  >
                    Pair…
                  </button>
                </>
              ) : (
                <>
                  <p className="small">
                    On the phone where you use Telegram, open:
                  </p>
                  <p className="mono small" data-e2e="telegram-link">
                    {code.link}
                  </p>
                  <p className="muted small">
                    Or send <span className="mono">/start {code.code}</span> to{" "}
                    <span className="mono">@{status.bot?.username}</span>. It
                    works once, until{" "}
                    {new Date(code.expiresAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    .
                  </p>
                  <p className="muted small" role="status">
                    Waiting for it…
                  </p>
                </>
              )}
              <div className="controls">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setCode(null)}
                  disabled={busy}
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn small"
              disabled={!can}
              onClick={() => void begin()}
            >
              Pair a chat
            </button>
          )}
        </>
      ) : null}
    </section>
  );
}
