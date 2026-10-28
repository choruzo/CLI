/**
 * Replay de una sesión grabada (Eval-1): convierte la traza de una sesión real
 * en un escenario de `stratum eval`. Las respuestas que dio el modelo pasan a
 * ser el guion de `--mock` (petición n → paso n), y el escenario puntúa el
 * **mundo** que dejó la sesión (`workspace_expected`), no lo que dijo el agente.
 *
 * Solo se convierte lo que el modelo de guion puede reproducir tal cual. Lo que
 * no, es un error con su motivo, nunca un hueco rellenado: argumentos
 * recortados o redactados por la traza, errores y reintentos del provider (la
 * traza no guarda el código HTTP), llamadas del loop solapadas (sin orden fijo
 * por posición), y lo que contestó una persona (confirmaciones aprobadas,
 * preguntas, planes, steering), que `stratum run` sin terminal no repite.
 */
import { dirname } from 'path';
import { applyRecords, emptyTrace, originOf, type TraceStep } from '../trace/model.js';
import { isAuxiliaryOrigin, type TraceRecord } from '../trace/records.js';
import { ScenarioSchema, type Scenario, type ScriptStep } from './scenario.js';

export class ReplayError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`la traza no se puede reproducir:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

export interface ReplayScript {
  sessionId: string | null;
  /** cwd de la sesión grabada, si la cabecera lo trae. */
  cwd: string | null;
  input: string;
  followUps: string[];
  script: ScriptStep[];
  /** Lo que se cambió o se descartó al convertir, para quien importa. */
  notes: string[];
}

/** Marcas que deja `TraceRecorder.text` cuando no escribe el contenido entero. */
const TRUNCATED_RE = /\n… \[trace: \d+ more chars\]$/;
const OMITTED = '[trace: content omitted, redaction failed]';
const REDACTED_RE = /\[redacted: [^\]\r\n]*\]/;

/** Por qué una cadena de la traza no es el original, o null si lo es. */
function lossOf(text: string): string | null {
  if (TRUNCATED_RE.test(text)) return 'recortado por trace.maxFieldChars';
  if (text.includes(OMITTED)) return 'omitido (falló la redacción)';
  return null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reescribe las rutas absolutas bajo el cwd grabado como relativas: el replay
 * corre en un workspace temporal. `cwd/x` → `x` y `cwd` suelto → `.`. En una
 * ruta de Windows no cuentan mayúsculas ni el tipo de barra.
 */
export function relativizer(cwd: string | null): (value: unknown) => unknown {
  const trimmed = cwd?.replace(/[\\/]+$/, '') ?? '';
  if (!trimmed || dirname(trimmed) === trimmed) return (v) => v;
  const windows = /^[A-Za-z]:/.test(trimmed);
  const body = trimmed
    .split(/[\\/]+/)
    .map(escapeRe)
    .join('[\\\\/]+');
  const re = new RegExp(`${body}(?:[\\\\/]+|(?=$|[\\s"'\`;|&)]))`, windows ? 'gi' : 'g');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(re, (m) => (/[\\/]$/.test(m) ? '' : '.'));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk;
}

const isLoopCall = (s: TraceStep): boolean => {
  const origin = originOf(s);
  return origin === 'agent' || origin === 'subagent';
};

/** Las respuestas del modelo en una traza, como guion del modelo de guion. */
export function scriptFromTrace(records: readonly TraceRecord[]): ReplayScript {
  const problems: string[] = [];
  const notes: string[] = [];

  const metas = records.filter((r) => r.t === 'meta');
  if (metas.length > 1) {
    problems.push(
      `${metas.length} cabeceras: la sesión se reanudó en otro proceso, y el replay es un solo \`stratum run\``,
    );
  }
  const meta = metas[0];
  const cwd = meta?.cwd ?? null;
  const relativize = relativizer(cwd);

  const turns = records.flatMap((r) => (r.t === 'turn' ? [r.input] : []));
  if (turns.length === 0) problems.push('la traza no tiene ningún turno');
  turns.forEach((input, i) => {
    const loss = lossOf(input);
    if (loss) problems.push(`turno ${i + 1}: la entrada está ${loss}`);
    if (REDACTED_RE.test(input))
      problems.push(`turno ${i + 1}: la entrada tiene secretos redactados`);
  });

  const model = applyRecords(emptyTrace(), records);
  const dropped = new Map<string, number>();
  for (const s of model.steps) {
    const origin = originOf(s);
    if (origin && isAuxiliaryOrigin(origin)) {
      if (origin === 'context-compression') {
        problems.push(
          `paso ${s.n}: compresión de contexto (depende de la ventana del modelo, que en el replay es otra)`,
        );
      } else {
        dropped.set(origin, (dropped.get(origin) ?? 0) + 1);
      }
      continue;
    }
    if (s.kind === 'notice' && s.data.event === 'retry') {
      problems.push(`paso ${s.n}: reintento de una llamada al modelo`);
    }
    if (
      s.kind === 'notice' &&
      s.data.event === 'confirmation' &&
      (s.data.decision === 'approved' || s.data.decision === 'allow-all')
    ) {
      problems.push(`paso ${s.n}: confirmación aprobada por el usuario (${String(s.data.tool)})`);
    }
    if (
      s.kind === 'notice' &&
      s.data.event === 'inbox' &&
      s.data.phase === 'enqueue' &&
      s.data.type === 'user-message'
    ) {
      problems.push(`paso ${s.n}: mensaje del usuario con el agente trabajando (steering)`);
    }
    if (s.kind === 'user' && s.data.answers !== undefined && s.data.answers !== null) {
      problems.push(`paso ${s.n}: preguntas contestadas por el usuario`);
    }
    if (s.kind === 'context' && s.data.plan !== undefined) {
      problems.push(`paso ${s.n}: plan propuesto (necesita aprobación)`);
    }
  }
  for (const [origin, n] of dropped) {
    notes.push(`descartadas ${n} llamadas auxiliares de ${origin}: no forman parte del turno`);
  }

  const calls = model.steps.filter((s) => s.kind === 'model' && isLoopCall(s));
  if (calls.length === 0 && turns.length > 0) {
    problems.push('la traza no tiene ninguna llamada del agente al modelo');
  }
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    if (prev.end !== null && sorted[i]!.start < prev.end) {
      problems.push(
        `pasos ${prev.n} y ${sorted[i]!.n}: llamadas al modelo solapadas (subagentes en paralelo); el guion por posición no tiene un orden fijo`,
      );
      break;
    }
  }

  let rewritten = 0;
  let redactedText = 0;
  const script: ScriptStep[] = [];
  for (const s of sorted) {
    if (s.end === null) {
      problems.push(`paso ${s.n}: llamada al modelo sin cerrar (traza cortada)`);
      continue;
    }
    if (s.status !== 'ok') {
      problems.push(
        `paso ${s.n}: llamada al modelo con estado ${s.status}; la traza no guarda el error HTTP`,
      );
      continue;
    }
    const step: ScriptStep = {};
    for (const field of ['text', 'reasoning'] as const) {
      const value = s.data[field];
      if (typeof value !== 'string' || value === '') continue;
      const loss = lossOf(value);
      if (loss)
        problems.push(
          `paso ${s.n}: ${field === 'text' ? 'el texto' : 'el razonamiento'} está ${loss}`,
        );
      if (REDACTED_RE.test(value)) redactedText++;
      step[field] = value;
    }
    const raw = Array.isArray(s.data.toolCalls) ? (s.data.toolCalls as unknown[]) : [];
    const toolCalls: NonNullable<ScriptStep['toolCalls']> = [];
    for (const c of raw) {
      const { name, arguments: args } = (c ?? {}) as { name?: unknown; arguments?: unknown };
      const where = `paso ${s.n}, ${typeof name === 'string' ? name : 'tool'}`;
      if (typeof name !== 'string' || !name) {
        problems.push(`${where}: llamada sin nombre`);
        continue;
      }
      const text = typeof args === 'string' ? args : '';
      const loss = lossOf(text);
      if (loss) {
        problems.push(`${where}: los argumentos están ${loss}`);
        continue;
      }
      if (REDACTED_RE.test(text)) {
        problems.push(`${where}: los argumentos tienen secretos redactados`);
        continue;
      }
      let parsed: unknown = {};
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          problems.push(
            `${where}: los argumentos no son JSON (el modelo de guion no los puede repetir)`,
          );
          continue;
        }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        problems.push(`${where}: los argumentos no son un objeto`);
        continue;
      }
      const relative = relativize(parsed) as Record<string, unknown>;
      if (JSON.stringify(relative) !== JSON.stringify(parsed)) rewritten++;
      toolCalls.push({ name, args: relative });
    }
    if (toolCalls.length > 0) step.toolCalls = toolCalls;
    if (step.text === undefined && step.toolCalls === undefined) step.text = '';
    script.push(step);
  }
  if (rewritten > 0) {
    notes.push(`${rewritten} llamadas con rutas bajo el cwd grabado, reescritas como relativas`);
  }
  if (redactedText > 0) {
    notes.push(
      `${redactedText} respuestas con secretos redactados en el texto (se reproducen con la marca)`,
    );
  }

  if (problems.length > 0) throw new ReplayError(problems);
  return {
    sessionId: meta?.sessionId ?? null,
    cwd,
    input: turns[0]!,
    followUps: turns.slice(1),
    script,
    notes,
  };
}

export interface ReplayScenarioOptions {
  id: string;
  title?: string;
  /** Workspace de partida (`setup.files`). */
  setup: Record<string, string>;
  /** Workspace al terminar la sesión grabada. */
  expected: Record<string, string>;
}

/** Escenario de replay validado contra el schema, y su JSON listo para escribirse. */
export function scenarioFromTrace(
  records: readonly TraceRecord[],
  opts: ReplayScenarioOptions,
): { scenario: Scenario; json: string; notes: string[] } {
  const replay = scriptFromTrace(records);
  const session = replay.sessionId ?? 'sin id';
  const raw = {
    id: opts.id,
    group: 'replay',
    title: opts.title ?? `Replay de la sesión ${session}`,
    description:
      `Sesión ${session} reproducida desde su traza: ${replay.script.length} respuestas del ` +
      'modelo como guion. Corre sin modelo (--mock) y puntúa el workspace que dejó la sesión.',
    difficulty: 'basic',
    setup: { files: opts.setup },
    input: replay.input,
    ...(replay.followUps.length > 0 ? { followUps: replay.followUps } : {}),
    script: replay.script,
    expect: {
      description: 'El workspace queda como al terminar la sesión grabada.',
      checks: [{ type: 'workspace_expected', files: opts.expected, strict: true }],
    },
  };
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReplayError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
    );
  }
  const notes = [...replay.notes];
  notes.push(
    'la config de la sesión grabada (perfil, entornos, flags de `run`) no está en la traza: el replay usa la del runner',
  );
  // Se escribe lo que se construyó, no lo parseado: sin los defaults del schema.
  return { scenario: parsed.data, json: JSON.stringify(raw, null, 2) + '\n', notes };
}
