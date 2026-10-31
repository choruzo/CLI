import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { describeRoutineError, refreshRoutines, routineFieldOf, type RoutineField } from '../app/routines';
import { useNative } from '../bridge/context';
import { toCommandError, type RoutineLimitsInput, type RoutinePatchInput } from '../bridge/native';
import type { ProtocolModel, ProtocolRoutine, ProtocolRoutineFire } from '../protocol';
import { parseModels, parseRoutine, parseRoutineRun } from '../protocol/results';
import { preview } from '../protocol/view';
import { useRoutines } from '../stores/routineStore';

interface Props {
  connected: boolean;
  /** Este Dot puede cambiar cosas (`control`): crear, editar, borrar y disparar. */
  canControl: boolean;
  /** Abre la sesión de una rutina en el detalle, como cualquier otra. */
  onOpenSession(sessionId: string): void;
}

const SCHEDULE_HELP =
  'An interval (30m, 2h, 1d) or a 5-field cron expression such as 0 9 * * 1-5. Cron runs in local time.';

const FIRE_TEXT: Record<ProtocolRoutineFire['outcome'], string> = {
  started: 'Started.',
  'skipped-busy': 'Skipped: the previous run was still going.',
  missed: 'Missed: the daemon was not running at that time.',
  'failed-to-start': 'Could not start.',
};

const STATUS_TEXT: Record<string, string> = {
  completed: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function fireText(fire: ProtocolRoutineFire): string {
  const base = FIRE_TEXT[fire.outcome];
  return fire.outcome === 'failed-to-start' && fire.error ? `${base} ${fire.error}` : base;
}

const when = (ms: number) => new Date(ms).toLocaleString();

/**
 * M16 — las rutinas del asistente (PRD §23.5): lo que contesta `routines.list`,
 * y crear, editar, activar, disparar y borrar. **Sin estado optimista**: lo que
 * se ve es la lista o la respuesta de la mutación; una mutación sin respuesta es
 * «Result unknown» y no se repite sola. El planificador vive en el daemon.
 */
export function RoutinesPanel({ connected, canControl, onOpenSession }: Props) {
  const native = useNative();
  const routines = useRoutines((s) => s.routines);
  const readOnly = useRoutines((s) => s.readOnly);
  const disabled = useRoutines((s) => s.disabled);
  const loading = useRoutines((s) => s.loading);
  const error = useRoutines((s) => s.error);
  /** `'new'`, el id de la que se edita, o nada. */
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { tone: 'info' | 'bad'; text: string }>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Al abrir la vista (y al recuperar la conexión). Después, solo por los motivos de `app/routines.ts`.
  useEffect(() => {
    if (connected) void refreshRoutines(native);
  }, [native, connected]);

  const note = (id: string, tone: 'info' | 'bad', text: string | null) =>
    setNotes((prev) => {
      const next = { ...prev };
      if (text === null) delete next[id];
      else next[id] = { tone, text };
      return next;
    });

  const canChange = connected && canControl && !readOnly && !disabled && busy === null;

  /** Una mutación sobre una rutina: pedirla, enseñar lo que contesta y releer la lista. */
  const mutate = async (id: string, label: string, run: () => Promise<void>) => {
    setBusy(id);
    note(id, 'info', null);
    try {
      await run();
    } catch (err) {
      if (alive.current) note(id, 'bad', `${label}: ${describeRoutineError(toCommandError(err))}`);
    } finally {
      if (alive.current) setBusy(null);
    }
    if (alive.current) void refreshRoutines(native);
  };

  const runNow = (routine: ProtocolRoutine) =>
    mutate(routine.id, 'Run now', async () => {
      const answer = parseRoutineRun(await native.routinesRun(routine.id));
      if (!alive.current) return;
      if (!answer) {
        note(routine.id, 'bad', 'The daemon answered in a way this version of Dot cannot read.');
        return;
      }
      useRoutines.getState().upsert(answer.routine);
      note(routine.id, answer.fire.outcome === 'started' ? 'info' : 'bad', fireText(answer.fire));
    });

  const toggle = (routine: ProtocolRoutine) =>
    mutate(routine.id, routine.enabled ? 'Disable' : 'Enable', async () => {
      const updated = parseRoutine(await native.routinesUpdate(routine.id, { enabled: !routine.enabled }));
      if (!alive.current) return;
      if (updated) useRoutines.getState().upsert(updated);
      else note(routine.id, 'bad', 'The daemon answered in a way this version of Dot cannot read.');
    });

  const remove = (routine: ProtocolRoutine) =>
    mutate(routine.id, 'Delete', async () => {
      const removed = parseRoutine(await native.routinesRemove(routine.id));
      if (!alive.current) return;
      setConfirming(null);
      if (removed) useRoutines.getState().drop(removed.id);
      else note(routine.id, 'bad', 'The daemon answered in a way this version of Dot cannot read.');
    });

  return (
    <section className="routines-panel" aria-label="Routines" data-routines={routines ? routines.length : 'unknown'}>
      <div className="overview-head">
        <h2>Routines</h2>
        <span className="controls">
          <button
            type="button"
            className="btn ghost small"
            disabled={!connected || loading}
            onClick={() => void refreshRoutines(native)}
            aria-label="Refresh the routines"
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn small"
            disabled={!canChange || editing !== null}
            onClick={() => setEditing('new')}
          >
            New routine
          </button>
        </span>
      </div>
      <p className="muted small">
        Things the assistant does on its own, at a time or at intervals. Each routine has its own conversation. They only
        run while the Stratum daemon does.
      </p>
      {disabled ? (
        <p className="note small" role="note">
          {error}
        </p>
      ) : error ? (
        <p className="note bad small" role="alert">
          {error}
        </p>
      ) : null}
      {readOnly ? (
        <p className="note small" role="note" data-e2e="routines-read-only">
          The routines file was written by a newer Stratum or is damaged: you can see the routines, not change them.
        </p>
      ) : null}
      {editing === 'new' ? (
        <RoutineForm
          key="new"
          routine={null}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refreshRoutines(native);
          }}
        />
      ) : null}
      {routines === null && !error && connected ? (
        <p className="muted small" role="status">
          Loading routines…
        </p>
      ) : null}
      {routines !== null && routines.length === 0 && !disabled ? (
        <p className="muted small" data-e2e="routines-empty">
          No routines yet.
        </p>
      ) : null}
      <ul className="routines">
        {(routines ?? []).map((routine) =>
          editing === routine.id ? (
            <li key={routine.id} className="routine" data-routine={routine.id}>
              <RoutineForm
                routine={routine}
                onCancel={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  void refreshRoutines(native);
                }}
              />
            </li>
          ) : (
            <li
              key={routine.id}
              className="routine"
              data-routine={routine.id}
              data-enabled={routine.enabled ? 'yes' : 'no'}
            >
              <div className="row-top">
                <strong className="row-title">{routine.name}</strong>
                <span className={routine.enabled ? 'tone-ok small' : 'tone-muted small'}>
                  {routine.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="muted small mono" title="Schedule">
                {routine.schedule}
              </div>
              {routine.origin === 'agent' ? (
                <div className="muted small" data-e2e="routine-origin">
                  Proposed by the assistant
                </div>
              ) : null}
              <div className="small" data-e2e="routine-next">
                Next:{' '}
                {!routine.enabled ? 'not scheduled (disabled)' : routine.nextFireAt ? when(routine.nextFireAt) : '—'}
              </div>
              {routine.running ? (
                <div className="pending small" role="status">
                  Running now
                </div>
              ) : null}
              {routine.scheduleError ? (
                <p className="note bad small" role="alert">
                  {routine.scheduleError}
                </p>
              ) : null}
              {routine.lastResult ? (
                <div className="small" data-e2e="routine-result">
                  Last run:{' '}
                  <span className={routine.lastResult.status === 'completed' ? 'tone-ok' : 'tone-bad'}>
                    {STATUS_TEXT[routine.lastResult.status] ?? routine.lastResult.status}
                  </span>
                  {routine.lastResult.endedAt ? ` · ${when(routine.lastResult.endedAt)}` : ''}
                  {routine.lastResult.summary ? (
                    <div className="muted routine-summary">{preview(routine.lastResult.summary, 160)}</div>
                  ) : null}
                </div>
              ) : null}
              {routine.lastFire && routine.lastFire.outcome !== 'started' ? (
                <div className="muted small" data-e2e="routine-fire">
                  Last attempt ({when(routine.lastFire.at)}): {fireText(routine.lastFire)}
                </div>
              ) : null}
              {notes[routine.id] ? (
                <p
                  className={`note small ${notes[routine.id]!.tone === 'bad' ? 'bad' : ''}`}
                  role={notes[routine.id]!.tone === 'bad' ? 'alert' : 'status'}
                >
                  {notes[routine.id]!.text}
                </p>
              ) : null}
              {confirming === routine.id ? (
                <div className="decision" role="group" aria-label={`Delete ${routine.name}`}>
                  <span className="small">Delete “{routine.name}” and its conversation?</span>
                  <span className="spacer" />
                  <button type="button" className="btn small" onClick={() => setConfirming(null)} disabled={busy !== null}>
                    Keep
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    disabled={!canChange}
                    onClick={() => void remove(routine)}
                  >
                    Delete routine
                  </button>
                </div>
              ) : (
                <div className="controls">
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={!canChange}
                    onClick={() => void runNow(routine)}
                    aria-label={`Run ${routine.name} now`}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!canChange}
                    onClick={() => void toggle(routine)}
                    aria-label={`${routine.enabled ? 'Disable' : 'Enable'} ${routine.name}`}
                  >
                    {routine.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!canChange || editing !== null}
                    onClick={() => setEditing(routine.id)}
                    aria-label={`Edit ${routine.name}`}
                  >
                    Edit
                  </button>
                  {routine.sessionId ? (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => onOpenSession(routine.sessionId!)}
                      aria-label={`Open the conversation of ${routine.name}`}
                    >
                      Open
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn danger small"
                    disabled={!canChange}
                    onClick={() => setConfirming(routine.id)}
                    aria-label={`Delete ${routine.name}`}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

type FieldErrors = Partial<Record<RoutineField, string>>;

/** Un número entero opcional de un campo de texto: vacío = sin tope; algo que no es un entero = error. */
function optionalInteger(text: string): number | undefined | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 'invalid';
}

/** Crear o editar una rutina. Los errores del daemon se pintan junto a su campo. */
function RoutineForm({
  routine,
  onCancel,
  onSaved,
}: {
  /** `null`: una nueva. */
  routine: ProtocolRoutine | null;
  onCancel(): void;
  onSaved(): void;
}) {
  const native = useNative();
  const [name, setName] = useState(routine?.name ?? '');
  const [schedule, setSchedule] = useState(routine?.schedule ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [model, setModel] = useState(routine?.model ?? '');
  const [maxIterations, setMaxIterations] = useState(
    routine?.limits?.maxIterations !== undefined ? String(routine.limits.maxIterations) : '',
  );
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    routine?.limits?.timeoutMinutes !== undefined ? String(routine.limits.timeoutMinutes) : '',
  );
  const [models, setModels] = useState<ProtocolModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Qué modelos hay lo dice el daemon; sin lista, queda el modelo por defecto.
  useEffect(() => {
    void native
      .listModels()
      .then((raw) => {
        const list = parseModels(raw);
        if (alive.current && list) setModels(list.models);
      })
      .catch(() => undefined);
  }, [native]);

  const fail = useCallback((err: unknown) => {
    const error = toCommandError(err);
    const field = routineFieldOf(error);
    if (field) setFieldErrors({ [field]: error.message });
    else setFormError(describeRoutineError(error));
  }, []);

  const submit = async () => {
    if (saving) return;
    setFormError(null);
    const errors: FieldErrors = {};
    if (!name.trim()) errors.name = 'Give the routine a name.';
    if (!schedule.trim()) errors.schedule = 'Say when it runs.';
    if (!prompt.trim()) errors.prompt = 'Say what the assistant should do.';
    const iterations = optionalInteger(maxIterations);
    const minutes = optionalInteger(timeoutMinutes);
    if (iterations === 'invalid') errors.maxIterations = 'Enter a whole number.';
    if (minutes === 'invalid') errors.timeoutMinutes = 'Enter a whole number.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || iterations === 'invalid' || minutes === 'invalid') return;

    const limits: RoutineLimitsInput = {
      ...(iterations !== undefined ? { maxIterations: iterations } : {}),
      ...(minutes !== undefined ? { timeoutMinutes: minutes } : {}),
    };
    const hasLimits = Object.keys(limits).length > 0;
    setSaving(true);
    try {
      let saved: ProtocolRoutine | null;
      if (routine === null) {
        saved = parseRoutine(
          await native.routinesAdd({
            name: name.trim(),
            schedule: schedule.trim(),
            prompt,
            ...(model ? { model } : {}),
            ...(hasLimits ? { limits } : {}),
          }),
        );
      } else {
        const patch: RoutinePatchInput = {};
        if (name.trim() !== routine.name) patch.name = name.trim();
        if (schedule.trim() !== routine.schedule) patch.schedule = schedule.trim();
        if (prompt !== routine.prompt) patch.prompt = prompt;
        if (model !== (routine.model ?? '')) {
          if (model) patch.model = model;
          else patch.clearModel = true;
        }
        if (iterations !== routine.limits?.maxIterations || minutes !== routine.limits?.timeoutMinutes) {
          if (hasLimits) patch.limits = limits;
          else patch.clearLimits = true;
        }
        if (Object.keys(patch).length === 0) {
          setFormError('Nothing changed.');
          setSaving(false);
          return;
        }
        saved = parseRoutine(await native.routinesUpdate(routine.id, patch));
      }
      if (!alive.current) return;
      if (!saved) {
        setFormError('The daemon answered in a way this version of Dot cannot read. Check the list.');
        setSaving(false);
        return;
      }
      useRoutines.getState().upsert(saved);
      onSaved();
    } catch (err) {
      if (!alive.current) return;
      fail(err);
      setSaving(false);
    }
  };

  const idPrefix = routine?.id ?? 'new';
  const err = (field: RoutineField) =>
    fieldErrors[field] ? (
      <span className="field-error small" role="alert" id={`${idPrefix}-${field}-error`}>
        {fieldErrors[field]}
      </span>
    ) : null;

  return (
    <form
      className="newchat-form routine-form"
      aria-label={routine ? `Edit ${routine.name}` : 'New routine'}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>Name</span>
        <input
          type="text"
          value={name}
          aria-label="Name"
          aria-invalid={fieldErrors.name ? true : undefined}
          disabled={saving}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        {err('name')}
      </label>
      <label>
        <span>Schedule</span>
        <input
          type="text"
          className="mono"
          value={schedule}
          aria-label="Schedule"
          aria-invalid={fieldErrors.schedule ? true : undefined}
          placeholder="30m, 2h, 1d or 0 9 * * 1-5"
          spellCheck={false}
          disabled={saving}
          onChange={(event) => setSchedule(event.target.value)}
        />
        <span className="muted small">{SCHEDULE_HELP}</span>
        {err('schedule')}
      </label>
      <label>
        <span>What to do</span>
        <textarea
          rows={4}
          value={prompt}
          aria-label="Prompt"
          aria-invalid={fieldErrors.prompt ? true : undefined}
          disabled={saving}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {err('prompt')}
      </label>
      <label>
        <span>Model</span>
        <select value={model} aria-label="Model" disabled={saving} onChange={(event) => setModel(event.target.value)}>
          <option value="">Default</option>
          {/* Un modelo guardado que la lista ya no trae sigue siendo elegible: no se pierde en silencio. */}
          {model && !models.some((m) => m.id === model) ? <option value={model}>{model}</option> : null}
          {models.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={m.id}>
              {m.id} · {m.provider}
            </option>
          ))}
        </select>
        {err('model')}
      </label>
      <div className="newchat-row">
        <label>
          <span>Max iterations</span>
          <input
            type="text"
            inputMode="numeric"
            value={maxIterations}
            aria-label="Max iterations"
            placeholder="1–200"
            disabled={saving}
            onChange={(event) => setMaxIterations(event.target.value)}
          />
          {err('maxIterations')}
        </label>
        <label>
          <span>Time limit (minutes)</span>
          <input
            type="text"
            inputMode="numeric"
            value={timeoutMinutes}
            aria-label="Time limit in minutes"
            placeholder="1–1440"
            disabled={saving}
            onChange={(event) => setTimeoutMinutes(event.target.value)}
          />
          {err('timeoutMinutes')}
        </label>
      </div>
      {formError ? (
        <p className="note bad small" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="controls">
        <button type="submit" className="btn primary small" disabled={saving}>
          {saving ? 'Saving…' : routine ? 'Save changes' : 'Create routine'}
        </button>
        <button type="button" className="btn small" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
