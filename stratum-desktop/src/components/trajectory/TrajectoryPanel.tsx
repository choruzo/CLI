import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CACHE_BREAK_LABEL,
  KIND_LABEL,
  LANE_NAMES,
  cacheBreaks,
  formatClock,
  formatDuration,
  formatTokenCount,
  firstLine,
  layoutTimeline,
  prefixOf,
  prettyValue,
  stepLabel,
  stepMatches,
  stepResult,
  stepText,
  tokensPerSecond,
  toolCallsOf,
  traceStats,
  usageOf,
  type CacheBreak,
  type TimelineMode,
  type TraceModel,
  type TraceStep,
} from '../../../../stratum-cli/src/trace/model';
import type { TraceKind } from '../../../../stratum-cli/src/trace/records';
import type { Trajectory } from '../../hooks/useTrajectory';

const MODES: Array<{ id: TimelineMode; label: string }> = [
  { id: 'duration', label: 'Duración' },
  { id: 'turns', label: 'Turnos' },
  { id: 'calls', label: 'Llamadas' },
];

type DetailTab = 'summary' | 'preview' | 'raw';
const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'summary', label: 'Resumen' },
  { id: 'preview', label: 'Vista previa' },
  { id: 'raw', label: 'Sin procesar' },
];

const ICON: Record<TraceKind, string> = {
  system: '⚙',
  user: '▶',
  context: 'i',
  notice: '!',
  model: '✦',
  tool: '⚒',
  subagent: '⬡',
};

const STATUS_LABEL = { ok: 'Completado', error: 'Error', cancelled: 'Cancelado' } as const;

/** Reloj que solo corre mientras hay pasos abiertos: sus barras crecen con él. */
function useNowWhile(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Timeline({
  model,
  mode,
  now,
  selected,
  query,
  onSelect,
}: {
  model: TraceModel;
  mode: TimelineMode;
  now: number;
  selected: string | null;
  query: string;
  onSelect: (id: string) => void;
}) {
  const blocks = useMemo(() => layoutTimeline(model, mode, now), [model, mode, now]);
  const [tip, setTip] = useState<{ step: TraceStep; x: number; y: number } | null>(null);
  const width = mode === 'calls' ? `max(100%, ${model.steps.length * 14}px)` : '100%';
  return (
    <div className="trajectory__timeline">
      <div className="trajectory__lane-names" aria-hidden="true">
        {LANE_NAMES.map((name) => (
          <div key={name}>{name}</div>
        ))}
      </div>
      <div className="trajectory__scroller" onMouseLeave={() => setTip(null)}>
        <div className="trajectory__lanes" style={{ width }}>
          {[0, 1, 2].map((lane) => (
            <div key={lane} className="trajectory__lane">
              {blocks.map((b, i) => {
                if (b.lane !== lane) return null;
                const step = model.steps[i];
                return (
                  <button
                    key={b.id}
                    type="button"
                    className="trajectory__block"
                    data-kind={step.kind}
                    data-selected={b.id === selected || undefined}
                    data-error={step.status === 'error' || undefined}
                    data-open={step.end === null || undefined}
                    data-dimmed={!stepMatches(step, query) || undefined}
                    style={{ left: `${b.x * 100}%`, width: `${b.w * 100}%` }}
                    aria-label={`${KIND_LABEL[step.kind]}: ${stepLabel(step)}`}
                    onClick={() => onSelect(b.id)}
                    onMouseMove={(e) => setTip({ step, x: e.clientX, y: e.clientY })}
                  >
                    {step.kind === 'model' && (
                      <span className="trajectory__gen" style={{ width: `${b.gen * 100}%` }} />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {tip && (
        <div
          className="trajectory__tip"
          role="tooltip"
          style={{ left: Math.max(8, tip.x - 150), top: tip.y + 16 }}
        >
          <strong>{KIND_LABEL[tip.step.kind]}</strong> · {firstLine(stepLabel(tip.step), 60)}
          <br />
          {formatClock(tip.step.start)} →{' '}
          {tip.step.end === null ? 'en curso' : formatClock(tip.step.end)}
          <br />
          Total {formatDuration((tip.step.end ?? now) - tip.step.start)}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function Section({ title, value, prose }: { title: string; value: unknown; prose?: boolean }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <>
      <h4 className="trajectory__section">{title}</h4>
      {prose ? (
        <div className="trajectory__prose">{prettyValue(value)}</div>
      ) : (
        <pre className="trajectory__pre">{prettyValue(value)}</pre>
      )}
    </>
  );
}

function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const DIVERGED_LABEL = {
  tools: 'la lista de tools',
  system: 'el prompt del sistema',
  history: 'el historial',
} as const;

const percent = (part: number, whole: number): string =>
  `${Math.round((Math.min(part, whole) / whole) * 100)}%`;

function Detail({
  step,
  now,
  cacheBreak,
  onClose,
}: {
  step: TraceStep;
  now: number;
  /** La rotura de caché de este paso, si reutilizó menos que la llamada anterior. */
  cacheBreak?: CacheBreak;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('summary');
  const d = step.data;
  const usage = usageOf(step);
  const speed = tokensPerSecond(step);
  const prefix = prefixOf(step);

  let body: ReactNode;
  if (tab === 'raw') {
    body = <pre className="trajectory__pre">{prettyValue(step)}</pre>;
  } else if (tab === 'preview') {
    if (step.kind === 'model') {
      body = (
        <>
          <Section title="Razonamiento" value={d.reasoning} prose />
          <Section title="Respuesta" value={d.text} prose />
          {toolCallsOf(step).map((c, i) => (
            <Section key={i} title={`Llamada · ${c.name}`} value={parseArgs(c.arguments)} />
          ))}
          <Section title="Error" value={d.error} />
        </>
      );
    } else if (step.kind === 'tool') {
      body = (
        <>
          <Section title="Entrada" value={d.input} />
          <Section title="Salida" value={d.output} />
          <Section title="Error" value={d.error} />
        </>
      );
    } else if (step.kind === 'subagent') {
      body = (
        <>
          <Section title="Tarea" value={d.task} prose />
          <Section title="Resumen" value={d.summary} prose />
          <Section title="Error" value={d.error} />
        </>
      );
    } else {
      const text = stepText(step);
      body = text ? (
        <div className="trajectory__prose">{text}</div>
      ) : (
        <pre className="trajectory__pre">{prettyValue(d)}</pre>
      );
    }
  } else {
    const preview =
      step.kind === 'tool' && d.output === undefined && !d.error && d.input !== undefined
        ? prettyValue(d.input)
        : stepText(step);
    body = (
      <>
        <dl className="trajectory__fields">
          <Field
            label={
              step.kind === 'tool'
                ? 'Herramienta'
                : step.kind === 'model'
                  ? 'Modelo'
                  : step.kind === 'subagent'
                    ? 'Perfil'
                    : 'Fuente'
            }
            value={firstLine(step.name, 200)}
          />
          <Field
            label="Estado"
            value={step.end === null ? 'En curso' : step.status ? STATUS_LABEL[step.status] : ''}
          />
          <Field label="Inicio" value={formatClock(step.start)} />
          <Field label="Duración" value={formatDuration((step.end ?? now) - step.start)} />
          {step.kind === 'model' && (
            <>
              <Field label="Proveedor" value={d.provider as string | undefined} />
              <Field label="Mensajes" value={d.messages as number | undefined} />
              <Field label="Tools ofrecidas" value={d.tools as number | undefined} />
              {step.firstToken !== null && (
                <Field label="Primer token" value={formatDuration(step.firstToken - step.start)} />
              )}
              {usage ? (
                <>
                  <Field label="Tokens entrada" value={usage.promptTokens} />
                  {usage.cachedReadTokens === undefined ? (
                    <Field label="Caché" value="no reportada por el backend" />
                  ) : (
                    <>
                      <Field label="Caché" value={usage.cachedReadTokens > 0 ? 'templada' : 'fría'} />
                      <Field label="Tokens de caché (leídos)" value={usage.cachedReadTokens} />
                      <Field label="Tokens sin caché" value={usage.uncachedPromptTokens} />
                      {usage.cacheHitRate !== undefined && (
                        <Field
                          label="Acierto de caché"
                          value={`${Math.round(usage.cacheHitRate * 100)}%`}
                        />
                      )}
                    </>
                  )}
                  <Field label="Tokens escritos en caché" value={usage.cacheWriteTokens} />
                  {cacheBreak && (
                    <Field
                      label="Rotura de caché"
                      value={`${CACHE_BREAK_LABEL[cacheBreak.cause]} (${cacheBreak.cachedBefore} → ${cacheBreak.cachedAfter} tok)`}
                    />
                  )}
                  <Field label="Tokens salida" value={usage.completionTokens} />
                  {speed !== null && <Field label="Velocidad" value={`${speed.toFixed(1)} tok/s`} />}
                </>
              ) : (
                step.end !== null && <Field label="Tokens" value="no reportados por el backend" />
              )}
              {prefix && prefix.chars > 0 && (
                <>
                  <Field
                    label="Prefijo repetido"
                    value={
                      prefix.sharedChars === undefined
                        ? 'primera llamada: sin referencia'
                        : `${percent(prefix.sharedChars, prefix.chars)} del prompt`
                    }
                  />
                  {prefix.diverged && (
                    <Field
                      label="Deja de coincidir en"
                      value={
                        DIVERGED_LABEL[prefix.diverged] +
                        (prefix.diverged === 'history' && prefix.divergedAt !== undefined
                          ? ` (mensaje ${prefix.divergedAt})`
                          : '')
                      }
                    />
                  )}
                </>
              )}
            </>
          )}
          {step.kind === 'tool' && typeof d.execMs === 'number' && (
            <Field label="Ejecución" value={formatDuration(d.execMs)} />
          )}
          {typeof d.chars === 'number' && <Field label="Caracteres" value={d.chars} />}
        </dl>
        {preview && (
          <Section
            title="Vista previa"
            value={preview.length > 1200 ? `${preview.slice(0, 1200)}…` : preview}
            prose
          />
        )}
      </>
    );
  }

  return (
    <section className="trajectory__detail" aria-label="Detalle del paso">
      <header className="trajectory__detail-head">
        <span className="trajectory__badge" data-kind={step.kind}>
          {KIND_LABEL[step.kind]}
        </span>
        <span className="trajectory__where">
          Turno {step.turn + 1} · Paso {step.n}
          {step.parent ? ' · subagente' : ''}
        </span>
        <button type="button" className="icon-button" aria-label="Cerrar detalle" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="trajectory__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="trajectory__detail-body" role="tabpanel">
        {body}
      </div>
    </section>
  );
}

/**
 * Panel de trayectoria: todo lo que hizo el agente en la conversación —lo que
 * entró al modelo, cada llamada y cada herramienta— en un timeline por
 * carriles, una lista y el detalle de cada paso. Anclado a la derecha del chat;
 * lo abre y lo cierra el botón de la barra de estado (Ctrl+J).
 */
export function TrajectoryPanel({
  trajectory,
  onClose,
}: {
  trajectory: Trajectory;
  onClose: () => void;
}) {
  const { model, loaded } = trajectory;
  const [mode, setMode] = useState<TimelineMode>('calls');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const hasOpen = useMemo(() => model.steps.some((s) => s.end === null), [model]);
  const now = useNowWhile(hasOpen);
  const stats = useMemo(() => traceStats(model, now), [model, now]);
  const breaks = useMemo(() => new Map(cacheBreaks(model).map((b) => [b.id, b])), [model]);
  const needle = query.trim().toLowerCase();

  const selectedStep = selected !== null ? model.steps[model.index[selected]] : undefined;

  // Sigue el final de la lista mientras el usuario no haya subido ni elegido un paso.
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current && selected === null) el.scrollTop = el.scrollHeight;
  }, [model.steps.length, selected]);

  return (
    <aside className="trajectory" aria-label="Trayectoria">
      <header className="trajectory__head">
        <h2 className="trajectory__title">Trayectoria</h2>
        <div className="trajectory__modes" role="group" aria-label="Eje del timeline">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={mode === m.id}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <input
          className="trajectory__search"
          type="search"
          placeholder="Buscar"
          aria-label="Buscar en la trayectoria"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Ocultar trayectoria"
          title="Ocultar trayectoria (Ctrl+J)"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <Timeline
        model={model}
        mode={mode}
        now={now}
        selected={selected}
        query={needle}
        onSelect={setSelected}
      />

      <div
        className="trajectory__list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {model.steps.length === 0 && (
          <p className="trajectory__empty">
            {loaded ? 'Todavía no hay pasos en esta conversación.' : 'Cargando la trayectoria…'}
          </p>
        )}
        {model.steps.map((s) => {
          if (!stepMatches(s, needle)) return null;
          const result = stepResult(s);
          return (
            <button
              key={s.id}
              type="button"
              className="trajectory__row"
              data-selected={s.id === selected || undefined}
              data-error={s.status === 'error' || undefined}
              data-child={s.parent !== null || undefined}
              onClick={() => setSelected(s.id)}
            >
              <span className="trajectory__turn">
                {s.kind === 'user' && s.id.startsWith('turn-') ? `#${s.turn + 1}` : ''}
              </span>
              <span className="trajectory__icon" data-kind={s.kind} aria-hidden="true">
                {ICON[s.kind]}
              </span>
              <span className="trajectory__label" data-mono={s.kind === 'tool' || undefined}>
                {stepLabel(s)}
              </span>
              {result && <span className="trajectory__result">{result}</span>}
              <span className="trajectory__dur">
                {s.end === null ? '…' : s.end > s.start ? formatDuration(s.end - s.start) : ''}
              </span>
            </button>
          );
        })}
      </div>

      {selectedStep && (
        <Detail
          step={selectedStep}
          now={now}
          cacheBreak={breaks.get(selectedStep.id)}
          onClose={() => setSelected(null)}
        />
      )}

      <footer className="trajectory__stats">
        <span>
          {stats.turns} turnos · {stats.steps} pasos
        </span>
        {stats.tokensPerSecond !== null && <span>{stats.tokensPerSecond.toFixed(0)} tok/s</span>}
        {stats.totalTokens > 0 && <span>{formatTokenCount(stats.totalTokens)} tok</span>}
        {stats.cache ? (
          <>
            {stats.cache.hitRate !== null && (
              <span title="Tokens de entrada servidos de la caché del backend">
                caché {Math.round(stats.cache.hitRate * 100)}% (
                {formatTokenCount(stats.cache.cachedReadTokens)} de{' '}
                {formatTokenCount(stats.cache.promptTokens)})
              </span>
            )}
            <span>
              {stats.cache.coldCalls} frías · {stats.cache.warmCalls} templadas
            </span>
            {(stats.cache.ttftColdMs !== null || stats.cache.ttftWarmMs !== null) && (
              <span>
                TTFT{' '}
                {stats.cache.ttftColdMs === null ? 'n/d' : formatDuration(stats.cache.ttftColdMs)}{' '}
                frío ·{' '}
                {stats.cache.ttftWarmMs === null ? 'n/d' : formatDuration(stats.cache.ttftWarmMs)}{' '}
                templado
              </span>
            )}
            {stats.cache.breaks > 0 && (
              <span>
                {stats.cache.breaks} {stats.cache.breaks === 1 ? 'rotura' : 'roturas'} de caché
              </span>
            )}
          </>
        ) : (
          stats.modelCalls > 0 && <span>caché no reportada</span>
        )}
        {stats.prefixStability !== null && (
          <span title="Parte del prompt que repite el de la llamada anterior, medida en el cliente">
            prefijo estable {Math.round(stats.prefixStability * 100)}%
          </span>
        )}
        {stats.activeMs > 0 && <span>{formatDuration(stats.activeMs)} activo</span>}
      </footer>
    </aside>
  );
}
