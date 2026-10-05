/**
 * Informes en texto de `stratum eval` y `stratum stats`. Funciones puras que
 * devuelven la cadena a imprimir; el JSON equivalente es el propio objeto.
 */
import chalk from 'chalk';
import { formatDuration, formatTokenCount } from '../trace/model.js';
import type {
  Comparison,
  MetricChange,
  ScenarioComparison,
  Tolerance,
  Verdict,
} from './compare.js';
import { COMPARABLE_METRICS } from './metrics.js';
import type { Distribution, EvalResult, GroupSummary, ScenarioResult } from './result.js';
import { DIFFICULTIES, liveTrajectoryChecks, type LoadedScenario } from './scenario.js';
import type { AggregateStats } from './stats.js';

const pct = (v: number | null): string => (v === null ? 'n/d' : `${(v * 100).toFixed(1)} %`);
const num = (v: number | null): string => (v === null ? 'n/d' : String(v));
const tok = (v: number | null): string => (v === null ? 'n/d' : formatTokenCount(Math.round(v)));
const dur = (v: number | null): string => (v === null ? 'n/d' : formatDuration(v));
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));

const STATUS = {
  pass: chalk.green('PASS '),
  fail: chalk.red('FAIL '),
  error: chalk.yellow('ERROR'),
  skip: chalk.gray('SKIP '),
};

function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((row) =>
    row
      .map((c, i) => (i === row.length - 1 ? c : pad(c, widths[i]!)))
      .join('  ')
      .trimEnd(),
  );
}

function scenarioLine(r: ScenarioResult, idWidth: number): string {
  const m = r.metrics;
  const cost = m
    ? `${dur(m.durationMs)} · ${tok(m.tokens)} tok · ${m.llmCalls} llm · ${m.toolCalls} tools` +
      (m.toolErrors ? ` · ${m.toolErrors} err` : '') +
      (m.policyBlocks ? ` · ${m.policyBlocks} bloq` : '') +
      (m.repeatedCalls ? ` · ${m.repeatedCalls} rep` : '')
    : '';
  const level = r.difficulty ? chalk.gray(LEVEL[r.difficulty]) : ' ';
  return `  ${STATUS[r.status]} ${level} ${pad(r.id, idWidth)}  ${chalk.gray(cost)}`.trimEnd();
}

/** Marca de dificultad en una línea de escenario. */
const LEVEL = { basic: '·', intermediate: '◆', adversarial: '▲' } as const;

/** Commit, sistema y fecha de una ejecución, en una línea. */
function provenance(result: EvalResult): string {
  const git = result.env?.git;
  return [
    git ? `commit ${git.commit}${git.dirty ? ' (con cambios sin commit)' : ''}` : null,
    git?.branch ? `rama ${git.branch}` : null,
    result.env ? `${result.env.os.platform} ${result.env.os.release}` : result.platform,
    `node ${result.node}`,
    result.startedAt.slice(0, 16).replace('T', ' '),
  ]
    .filter(Boolean)
    .join(' · ');
}

const dist = (d: Distribution | null, fmt: (v: number) => string): string =>
  d === null ? 'n/d' : `${fmt(d.mean)} (mediana ${fmt(d.median)})`;

function summaryLines(s: GroupSummary): string[] {
  const ran = s.total - s.skipped;
  return table([
    ['Task success rate', `${pct(s.successRate)}  (${s.passed}/${ran})`],
    ['Tool error rate', `${pct(s.toolErrorRate)}  (${s.toolErrors}/${s.toolCalls})`],
    ['Policy violation rate', `${pct(s.policyViolationRate)}  (${s.policyBlocks} bloqueos)`],
    ['Unsafe action rate', `${pct(s.unsafeActionRate)}  (${s.unsafeActions} acciones)`],
    [
      'Recovery success',
      `${pct(s.recovery.rate)}  (${s.recovery.recovered}/${s.recovery.withErrors} con fallos)`,
    ],
    ['Acciones repetidas', String(s.repeatedCalls)],
    ['Reintentos · confirmaciones', `${s.retries} · ${s.confirmations}`],
    ['Tokens hasta el éxito', dist(s.toSuccess.tokens, tok)],
    ['Tiempo hasta el éxito', dist(s.toSuccess.durationMs, dur)],
    ['Tool calls hasta el éxito', dist(s.toSuccess.toolCalls, (v) => v.toFixed(1))],
    ['Llamadas LLM hasta el éxito', dist(s.toSuccess.llmCalls, (v) => v.toFixed(1))],
  ]).map((l) => `  ${l}`);
}

export function formatEvalReport(result: EvalResult, dir?: string): string {
  const out: string[] = [];
  const head = [
    `stratum eval · ${result.runId}`,
    result.label,
    `v${result.stratumVersion}`,
    result.mode === 'mock' ? 'modelo de guion' : `${result.provider.name}/${result.provider.model}`,
    result.platform,
  ].filter(Boolean);
  out.push(chalk.bold(head.join(' · ')), chalk.gray(provenance(result)), '');

  const idWidth = Math.max(...result.scenarios.map((s) => s.id.length), 8);
  let group = '';
  for (const r of result.scenarios) {
    if (r.group !== group) {
      group = r.group;
      const g = result.summary.groups[r.group];
      out.push(chalk.bold(group) + (g ? chalk.gray(`  ${g.passed}/${g.total - g.skipped}`) : ''));
    }
    out.push(scenarioLine(r, idWidth));
    if (r.status !== 'pass' && r.reason) out.push(chalk.gray(`        ${r.reason.split('\n')[0]}`));
    for (const u of r.unsafeActions) {
      out.push(chalk.red(`        ⚠ acción insegura (paso ${u.step}): ${u.tool} ${u.input}`));
    }
  }

  const levels = DIFFICULTIES.flatMap((d) => {
    const s = result.summary.difficulties?.[d];
    return s ? [`${LEVEL[d]} ${d} ${s.passed}/${s.total - s.skipped}`] : [];
  });
  if (levels.length > 0) out.push('', chalk.gray(`Por dificultad: ${levels.join('  ')}`));

  out.push('', chalk.bold('Resumen'), ...summaryLines(result.summary.overall));
  if (dir) {
    out.push('', chalk.gray(`Artefacto: ${dir}`));
    const failed = result.scenarios.find((s) => s.status === 'fail' && s.trace);
    if (failed)
      out.push(chalk.gray(`Ver una traza: stratum auditor --file "${dir}/${failed.trace}"`));
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Comparación
// ---------------------------------------------------------------------------

const VERDICT: Record<Verdict | 'added' | 'removed', string> = {
  regression: chalk.red('▲ regresión'),
  improvement: chalk.green('▼ mejora'),
  same: chalk.gray('= igual'),
  added: chalk.gray('+ nuevo'),
  removed: chalk.gray('- no ejecutado'),
};

const RATES = new Set([
  'successRate',
  'toolErrorRate',
  'policyViolationRate',
  'unsafeActionRate',
  'recoveryRate',
]);

function value(metric: string, v: number): string {
  if (RATES.has(metric)) return pct(v);
  if (metric === 'durationMs' || metric === 'timeToSuccessMs') return dur(v);
  if (metric === 'tokens' || metric === 'tokensToSuccess') return tok(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function changeText(c: MetricChange): string {
  const rel =
    c.pct === null || RATES.has(c.metric)
      ? ''
      : ` (${c.pct > 0 ? '+' : ''}${(c.pct * 100).toFixed(0)} %)`;
  return `${c.metric} ${value(c.metric, c.base)} → ${value(c.metric, c.head)}${rel}`;
}

function toleranceText(metric: string, t: Tolerance): string {
  const parts: string[] = [];
  if (t.pct > 0) parts.push(`${Math.round(t.pct * 100)} %`);
  if (t.abs > 0) parts.push(value(metric, t.abs));
  return `${metric} ${parts.length > 0 ? parts.join(' y ') : 'sin margen'}`;
}

const runName = (r: Comparison['base']): string =>
  [
    r.baseline ? `baseline «${r.baseline}»` : (r.label ?? r.runId),
    `v${r.stratumVersion}`,
    r.commit,
    r.mode === 'mock' ? 'guion' : r.model,
    r.platform,
    r.startedAt.slice(0, 10),
  ]
    .filter(Boolean)
    .join(' · ');

export function formatComparison(cmp: Comparison): string {
  const out: string[] = [
    chalk.bold('stratum eval compare'),
    `  base     ${runName(cmp.base)}`,
    `  actual   ${runName(cmp.head)}`,
    ...cmp.notes.map((n) => chalk.yellow(`  ! ${n}`)),
  ];

  const byId = new Map(cmp.scenarios.map((s) => [s.id, s]));
  /** Un bloque del informe: los escenarios de un hallazgo, con lo que cambió. */
  const section = (
    title: string,
    ids: readonly string[],
    detail: (s: ScenarioComparison) => string[],
    color: (s: string) => string,
  ): void => {
    if (ids.length === 0) return;
    out.push('', color(chalk.bold(`${title} (${ids.length})`)));
    for (const id of ids) {
      const s = byId.get(id)!;
      out.push(`  ${id}${s.definitionChanged ? chalk.gray('  (escenario modificado)') : ''}`);
      for (const line of detail(s)) out.push(chalk.gray(`      ${line}`));
    }
  };
  const why = (s: ScenarioComparison): string[] => (s.reason ? [s.reason.split('\n')[0]!] : []);
  const moved =
    (category: MetricChange['category'], verdict: Verdict) =>
    (s: ScenarioComparison): string[] =>
      s.changes.filter((c) => c.category === category && c.verdict === verdict).map(changeText);
  const h = cmp.highlights;

  section('PASS → FAIL', h.passToFail, why, chalk.red);
  section('PASS → ERROR', h.passToError, why, chalk.red);
  section(
    'Nuevas acciones inseguras',
    h.newUnsafeActions,
    moved('safety', 'regression'),
    chalk.red,
  );
  section('Más bloqueos de política', h.morePolicyBlocks, moved('policy', 'regression'), chalk.red);
  section(
    'Regresiones de coste (tokens, tiempo, llamadas)',
    h.costRegressions,
    moved('cost', 'regression'),
    chalk.yellow,
  );
  section(
    'Regresiones de fiabilidad (errores, reintentos, repeticiones)',
    h.reliabilityRegressions,
    moved('reliability', 'regression'),
    chalk.yellow,
  );
  section(
    'Mejoras',
    h.improvements,
    (s) => [
      ...(s.transition === 'fail_to_pass' ? ['FAIL → PASS'] : []),
      ...(s.transition === 'error_to_pass' ? ['ERROR → PASS'] : []),
      ...s.changes.filter((c) => c.verdict === 'improvement').map(changeText),
    ],
    chalk.green,
  );
  section(
    'Siguen sin pasar, de otra manera',
    h.unresolved,
    (s) => [`${s.base} → ${s.head}`, ...why(s)],
    chalk.gray,
  );
  section('Nuevos (no estaban en la base)', h.added, (s) => [String(s.head)], chalk.gray);
  section('No ejecutados ahora', h.removed, () => [], chalk.gray);

  const found = cmp.scenarios.filter(
    (s) => s.verdict !== 'same' || s.transition === 'unresolved',
  ).length;
  if (found === 0) out.push('', '  Sin cambios por escenario por encima de las tolerancias.');

  if (cmp.difficulties.length > 0) {
    const cell = (c: { passed: number; ran: number } | null): string =>
      c ? `${c.passed}/${c.ran}` : '—';
    out.push('', chalk.bold('Éxito por dificultad'));
    out.push(
      ...table(cmp.difficulties.map((d) => [`  ${d.difficulty}`, cell(d.base), '→', cell(d.head)])),
    );
  }

  if (cmp.summary.length > 0) {
    // Sin veredicto: las medias se mueven con el ruido; lo que cuenta sale de los escenarios.
    out.push('', chalk.bold('Métricas agregadas') + chalk.gray('  (informativas)'));
    out.push(
      ...table(
        cmp.summary.map((c) => [
          `  ${c.metric}`,
          value(c.metric, c.base),
          '→',
          value(c.metric, c.head),
          c.verdict === 'same' ? '' : chalk.gray(c.verdict === 'regression' ? 'peor' : 'mejor'),
        ]),
      ),
    );
  }

  const same = cmp.scenarios.filter((s) => s.verdict === 'same').length;
  out.push(
    '',
    `${VERDICT[cmp.verdict]} — ${cmp.regressions} regresiones, ${cmp.improvements} mejoras, ` +
      `${same} sin cambios`,
    chalk.gray(
      `Tolerancias: ${COMPARABLE_METRICS.map((m) => toleranceText(m, cmp.tolerances[m])).join(' · ')}`,
    ),
  );
  return out.join('\n') + '\n';
}

/** Baselines guardados, uno por línea. */
export function formatBaselineList(baselines: readonly EvalResult[]): string {
  if (baselines.length === 0) return 'No hay baselines guardados.\n';
  const rows = baselines.map((r) => {
    const s = r.summary.overall;
    return [
      r.baseline?.name ?? '?',
      `${s.passed}/${s.total - s.skipped}`,
      r.mode === 'mock' ? 'guion' : `${r.provider.name}/${r.provider.model}`,
      `v${r.stratumVersion}`,
      r.env?.git ? r.env.git.commit + (r.env.git.dirty ? '+' : '') : '',
      r.platform,
      (r.baseline?.savedAt ?? r.startedAt).slice(0, 10),
      r.baseline?.note ?? '',
    ];
  });
  return table(rows).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Listado de escenarios y estadísticas
// ---------------------------------------------------------------------------

export function formatScenarioList(scenarios: readonly LoadedScenario[]): string {
  if (scenarios.length === 0) return 'No hay escenarios.\n';
  const rows = scenarios.map((s) => [
    s.group,
    s.difficulty,
    s.id,
    s.script ? 'guion' : 'live',
    s.requires?.platform ? s.requires.platform.join('/') : '',
    s.title,
  ]);
  return table(rows).join('\n') + '\n';
}

/** Avisos de escenarios cuyos criterios atan la trayectoria de un modelo real. */
export function scenarioWarnings(scenarios: readonly LoadedScenario[]): string[] {
  return scenarios.flatMap((s) =>
    liveTrajectoryChecks(s).map(
      (w) => `${s.id}: ${w}; márcalo con "mode": "mock" si solo vale para el guion`,
    ),
  );
}

export function formatStats(s: AggregateStats, top = 10): string {
  if (s.sessions === 0) return 'No hay trazas en ese rango.\n';
  const day = (t: number | null): string => (t === null ? '' : new Date(t).toLocaleDateString());
  const out: string[] = [
    chalk.bold(`stratum stats · ${s.sessions} sesiones · ${day(s.from)} – ${day(s.to)}`),
    chalk.gray('Calculado en local a partir de las trazas; nada sale de este equipo.'),
    '',
  ];
  const stops = Object.entries(s.stopReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  const c = s.confirmations;
  out.push(
    ...table([
      ['Turnos', `${s.turns}  (${stops || 'ninguno cerrado'})`],
      ['Turnos completados', pct(s.turnCompletionRate)],
      ['Tiempo activo', dur(s.durationMs)],
      ['Llamadas al modelo', `${s.llmCalls}  (${s.llmErrors} con error)`],
      ['Tokens', tok(s.tokens)],
      ['Tool calls', String(s.toolCalls)],
      ['Tool error rate', `${pct(s.toolErrorRate)}  (${s.toolErrors})`],
      [
        'Recovery success',
        `${pct(s.recovery.rate)}  (${s.recovery.recovered}/${s.recovery.turnsWithErrors} turnos con fallos)`,
      ],
      ['Policy violation rate', `${pct(s.policyViolationRate)}  (${num(s.policyBlocks)} bloqueos)`],
      [
        'Confirmaciones',
        c
          ? `${c.asked}  (${c.approved} aprobadas · ${c.denied} denegadas · ${c.blocked} bloqueadas)`
          : 'n/d',
      ],
      ['Reintentos · fallbacks', `${num(s.retries)} · ${s.providerFallbacks}`],
      ['Acciones repetidas', String(s.repeatedCalls)],
      ['Subagentes', `${s.subagents}  (${s.subagentFailures} fallidos)`],
      ['Errores fatales · compresiones', `${s.fatalErrors} · ${s.compressions}`],
      [
        'Media por turno',
        `${tok(s.perTurn.tokens)} tok · ${dur(s.perTurn.durationMs)} · ` +
          `${s.perTurn.toolCalls === null ? 'n/d' : s.perTurn.toolCalls.toFixed(1)} tools`,
      ],
    ]).map((l) => `  ${l}`),
  );
  if (s.runtimeSessions < s.sessions) {
    out.push(
      chalk.gray(
        `  (bloqueos, confirmaciones y reintentos: solo de las ${s.runtimeSessions} sesiones ` +
          'grabadas desde que la traza los registra)',
      ),
    );
  }

  if (s.tools.length > 0) {
    out.push('', chalk.bold('Herramientas'));
    out.push(
      ...table([
        ['  tool', 'llamadas', 'errores', 'bloqueadas', 'media'],
        ...s.tools
          .slice(0, top)
          .map((t) => [
            `  ${t.name}`,
            String(t.calls),
            String(t.errors),
            String(t.blocked),
            dur(t.meanMs),
          ]),
      ]),
    );
  }
  if (s.models.length > 0) {
    out.push('', chalk.bold('Modelos'));
    out.push(
      ...table([
        ['  modelo', 'llamadas', 'errores', 'tokens', 'tok/s'],
        ...s.models
          .slice(0, top)
          .map((m) => [
            `  ${m.model}`,
            String(m.calls),
            String(m.errors),
            tok(m.tokens),
            m.tokensPerSecond === null ? 'n/d' : m.tokensPerSecond.toFixed(1),
          ]),
      ]),
    );
  }
  return out.join('\n') + '\n';
}
