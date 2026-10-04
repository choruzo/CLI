/**
 * Informes en texto de `stratum eval` y `stratum stats`. Funciones puras que
 * devuelven la cadena a imprimir; el JSON equivalente es el propio objeto.
 */
import chalk from 'chalk';
import { formatDuration, formatTokenCount } from '../trace/model.js';
import type { Comparison, MetricChange, Verdict } from './compare.js';
import type { Distribution, EvalResult, GroupSummary, ScenarioResult } from './result.js';
import type { LoadedScenario } from './scenario.js';
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
  return `  ${STATUS[r.status]} ${pad(r.id, idWidth)}  ${chalk.gray(cost)}`.trimEnd();
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
  out.push(chalk.bold(head.join(' · ')), '');

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

export function formatComparison(cmp: Comparison): string {
  const name = (r: Comparison['base']): string =>
    `${r.label ?? r.runId} (v${r.stratumVersion}, ${r.mode === 'mock' ? 'guion' : r.model})`;
  const out: string[] = [
    chalk.bold(`stratum eval compare · ${name(cmp.base)} → ${name(cmp.head)}`),
    ...cmp.notes.map((n) => chalk.yellow(`  ! ${n}`)),
    '',
  ];

  const moved = cmp.scenarios.filter((s) => s.verdict !== 'same');
  if (moved.length === 0) out.push('  Sin cambios por escenario por encima de los umbrales.');
  for (const s of moved) {
    const status = s.base !== s.head ? `  ${s.base ?? '—'} → ${s.head ?? '—'}` : '';
    out.push(`  ${VERDICT[s.verdict]}  ${s.id}${status}`);
    for (const c of s.changes) {
      const mark = c.verdict === 'regression' ? chalk.red('+') : chalk.green('-');
      out.push(`      ${mark} ${changeText(c)}`);
    }
  }

  if (cmp.summary.length > 0) {
    out.push('', chalk.bold('Métricas agregadas'));
    out.push(
      ...table(
        cmp.summary.map((c) => [
          `  ${c.metric}`,
          value(c.metric, c.base),
          '→',
          value(c.metric, c.head),
          c.verdict === 'same' ? '' : VERDICT[c.verdict],
        ]),
      ),
    );
  }

  const same = cmp.scenarios.length - moved.length;
  out.push(
    '',
    `${VERDICT[cmp.verdict]} — ${cmp.regressions} regresiones, ${cmp.improvements} mejoras, ` +
      `${same} sin cambios (umbral ${Math.round(cmp.thresholds.relative * 100)} %, ` +
      `tiempo ${Math.round(cmp.thresholds.timeRelative * 100)} %)`,
  );
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Listado de escenarios y estadísticas
// ---------------------------------------------------------------------------

export function formatScenarioList(scenarios: readonly LoadedScenario[]): string {
  if (scenarios.length === 0) return 'No hay escenarios.\n';
  const rows = scenarios.map((s) => [
    s.group,
    s.id,
    s.script ? 'guion' : 'live',
    s.requires?.platform ? s.requires.platform.join('/') : '',
    s.title,
  ]);
  return table(rows).join('\n') + '\n';
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
