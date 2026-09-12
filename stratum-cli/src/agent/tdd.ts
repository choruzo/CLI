/**
 * Hito 13 — Ciclo TDD estricto con evidencia obligatoria (P3 de `gentle-pi`).
 *
 * Módulo puro. Un agente al que se le pide «escribe tests» tiende a escribirlos
 * DESPUÉS del código y a darlos por buenos en cuanto pasan, que es exactamente
 * cuando no prueban nada. El ciclo obliga a que cada fase deje una prueba de
 * que ocurrió, y el registro la valida:
 *
 *   SAFETY NET → RED → GREEN → TRIANGULATE → REFACTOR
 *
 * Las tres reglas que hacen el trabajo (adaptadas del `strict-tdd.md` original
 * de Alan Buscaglia, MIT — ver CLI-DOC/Investigacion/gentle-pi.md §2):
 *
 *  1. **SAFETY NET antes de tocar nada existente.** Se corre la suite del
 *     fichero y se captura el baseline. Si ya falla algo, se PARA y se reporta
 *     como fallo preexistente; arreglarlo de paso borra la línea base que
 *     demuestra que no rompiste tú nada.
 *  2. **Un RED que pasa no es un RED.** Si el test nuevo pasa antes de escribir
 *     el código, o no prueba lo que crees o la funcionalidad ya existía.
 *  3. **TRIANGULATE es obligatorio salvo argumento explícito.** Con un solo
 *     caso, devolver la constante correcta pasa el test. El segundo caso, con
 *     entradas distintas, es lo que fuerza a escribir la lógica de verdad.
 *
 * El estado vive en el historial (snapshot completo en cada tool result), igual
 * que la lista de `todo`: reanudar una sesión no necesita store en disco.
 */
import type { Message } from './types.js';

export type TddPhase = 'safety_net' | 'red' | 'green' | 'triangulate' | 'refactor';

export type TddOutcome = 'pass' | 'fail';

export const TDD_PHASES: readonly TddPhase[] = [
  'safety_net',
  'red',
  'green',
  'triangulate',
  'refactor',
];

export interface TddEntry {
  /** Tarea a la que pertenece la evidencia. Normalizada para agrupar. */
  task: string;
  phase: TddPhase;
  /** Comando de test ejecutado (el del fichero relevante, no la suite entera). */
  command?: string;
  outcome: TddOutcome;
  /** Qué se observó: «5 passing», «1 failing: expected 3, got undefined»… */
  evidence: string;
  /** Solo en `triangulate` cuando se omite: por qué era legítimo omitirla. */
  skipReason?: string;
}

export interface TddRecordInput {
  task?: string;
  phase?: string;
  command?: string;
  outcome?: string;
  evidence?: string;
  skipReason?: string;
}

export interface TddApplyResult {
  entries: TddEntry[];
  /** Avisos para el modelo: no bloquean, enseñan. */
  notes: string[];
}

/** Error recuperable: el modelo puede corregir la llamada y reintentar. */
export class TddError extends Error {}

/** Tope de entradas conservadas: la evidencia vieja no aporta y ocupa contexto. */
export const MAX_TDD_ENTRIES = 40;

// ---------------------------------------------------------------------------
// Detección de aserciones prohibidas
// ---------------------------------------------------------------------------

/**
 * Aserciones que pasan siempre o no prueban comportamiento. La lista es del
 * original y se sostiene sola: una tautología no falla nunca, un
 * `toBeDefined()` a secas solo comprueba que existe algo, y una clase CSS no es
 * una aserción sobre lo que el código hace.
 */
const BANNED_ASSERTIONS: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /expect\s*\(\s*(true|1)\s*\)\s*\.\s*(?:to)?[Bb]e(?:Truthy)?\s*\(\s*(true)?\s*\)/,
    why: 'tautología: `expect(true).toBe(true)` no puede fallar',
  },
  {
    pattern: /expect\s*\([^)]*\)\s*\.\s*toBeDefined\s*\(\s*\)\s*$/m,
    why: 'aserción solo-de-tipo: `toBeDefined()` a secas no dice qué valor esperabas',
  },
  {
    pattern: /expect\s*\([^)]*\)\s*\.\s*toEqual\s*\(\s*\[\s*\]\s*\)/,
    why: 'colección vacía sin justificar por qué debe estar vacía',
  },
  {
    pattern: /toHaveClass\s*\(|className\s*\)\s*\.\s*to(?:Be|Equal|Contain)/,
    why: 'un nombre de clase CSS nunca es una aserción de comportamiento',
  },
];

/** Devuelve los motivos por los que la evidencia contiene aserciones prohibidas. */
export function findBannedAssertions(text: string): string[] {
  return BANNED_ASSERTIONS.filter((b) => b.pattern.test(text)).map((b) => b.why);
}

/**
 * Umbrales de la regla de mocks: ≤3 sano · 4-6 revisar · 7+ capa equivocada.
 * El corolario práctico es *Extract-Before-Mock*: si lo que quieres probar es
 * una transformación de datos, sácala a una función pura y pruébala sin mocks.
 */
export const MOCK_LIMITS = { healthy: 3, review: 6 } as const;

export function mockCountNote(mocks: number): string | null {
  if (mocks <= MOCK_LIMITS.healthy) return null;
  if (mocks <= MOCK_LIMITS.review) {
    return `${mocks} mocks: revisa si el test está en la capa adecuada.`;
  }
  return (
    `${mocks} mocks: estás testeando en la capa equivocada. Extrae la lógica a una ` +
    'función pura y pruébala sin mocks (Extract-Before-Mock).'
  );
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

function normalizeTask(task: string): string {
  return task.trim().replace(/\s+/g, ' ');
}

function coercePhase(raw: unknown): TddPhase {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if ((TDD_PHASES as readonly string[]).includes(value)) return value as TddPhase;
  throw new TddError(`Fase desconocida "${String(raw)}". Usa una de: ${TDD_PHASES.join(', ')}.`);
}

function coerceOutcome(raw: unknown): TddOutcome {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (value === 'pass' || value === 'passing' || value === 'green') return 'pass';
  if (value === 'fail' || value === 'failing' || value === 'red') return 'fail';
  throw new TddError(`outcome debe ser "pass" o "fail" (recibido: "${String(raw)}").`);
}

/**
 * Valida una entrada nueva contra las anteriores DE LA MISMA TAREA y la añade.
 * Función pura: devuelve una lista nueva. Lanza `TddError` cuando la evidencia
 * contradice el ciclo — que es justo el punto de la tool: el modelo no puede
 * declarar GREEN sin haber pasado por RED.
 */
export function applyTddRecord(current: TddEntry[], input: TddRecordInput): TddApplyResult {
  const notes: string[] = [];

  const task = normalizeTask(input.task ?? '');
  if (!task) throw new TddError('record necesita `task`: a qué unidad de trabajo pertenece.');

  const phase = coercePhase(input.phase);
  const evidence = (input.evidence ?? '').trim();
  const skipReason = (input.skipReason ?? '').trim();

  // Triangulación omitida: es la única entrada que puede no traer observación,
  // porque no se ejecutó nada. A cambio, exige el argumento por escrito.
  const isSkip = phase === 'triangulate' && skipReason.length > 0;
  if (!evidence && !isSkip) {
    throw new TddError(
      'record necesita `evidence`: qué observaste al ejecutar los tests ' +
        '(p.ej. "5 passing" o "1 failing: expected 3, got undefined").',
    );
  }

  const outcome = isSkip ? 'pass' : coerceOutcome(input.outcome);
  const previous = current.filter((e) => e.task === task);
  const phases = new Set(previous.map((e) => e.phase));

  switch (phase) {
    case 'safety_net':
      if (outcome === 'fail') {
        notes.push(
          'La línea base ya falla. Eso es un fallo PREEXISTENTE: repórtalo al usuario y para. ' +
            'No lo arregles de paso — es la prueba de que no lo rompiste tú.',
        );
      }
      break;

    case 'red':
      if (outcome !== 'fail') {
        throw new TddError(
          'Un RED que pasa no es un RED. Si el test nuevo pasa antes de escribir el código, ' +
            'o no está probando lo que crees o la funcionalidad ya existe. Revísalo y vuelve a registrarlo.',
        );
      }
      break;

    case 'green': {
      if (!phases.has('red')) {
        throw new TddError(
          `No hay un RED registrado para "${task}". Escribe primero el test que falla y ` +
            'regístralo con phase "red"; un GREEN sin RED previo no demuestra nada.',
        );
      }
      if (outcome !== 'pass') {
        throw new TddError('Un GREEN con tests en rojo no es un GREEN. Arregla y vuelve a medir.');
      }
      const suspicious = detectFalseGreen(evidence);
      if (suspicious) notes.push(suspicious);
      break;
    }

    case 'triangulate':
      if (!phases.has('green')) {
        throw new TddError(
          `No hay un GREEN registrado para "${task}". Triangular es añadir un segundo caso ` +
            'sobre algo que ya pasa.',
        );
      }
      if (isSkip) {
        notes.push(`Triangulation skipped: ${skipReason}`);
      } else if (outcome !== 'pass') {
        throw new TddError(
          'El segundo caso falla: la implementación estaba hardcodeada para el primero. ' +
            'Arregla la lógica antes de seguir.',
        );
      }
      break;

    case 'refactor':
      if (!phases.has('green')) {
        throw new TddError(
          `No hay un GREEN registrado para "${task}": no se refactoriza sobre rojo.`,
        );
      }
      if (!phases.has('triangulate')) {
        notes.push(
          'Estás refactorizando sin haber triangulado. Con un solo caso, la implementación ' +
            'puede seguir hardcodeada. Añade un segundo caso o registra por qué no aplica.',
        );
      }
      if (outcome !== 'pass') {
        throw new TddError('Un refactor deja los tests en verde. Revierte o arregla.');
      }
      break;
  }

  const banned = findBannedAssertions(evidence);
  for (const why of banned) notes.push(`Aserción prohibida — ${why}.`);

  const entry: TddEntry = {
    task,
    phase,
    command: (input.command ?? '').trim() || undefined,
    outcome,
    evidence: evidence || `(omitida: ${skipReason})`,
    skipReason: skipReason || undefined,
  };

  const entries = [...current, entry];
  return { entries: entries.slice(-MAX_TDD_ENTRIES), notes };
}

/**
 * Falsos GREEN: el test pasa sin haber ejercitado el código. Los tres casos son
 * del original y son los que más se repiten en la práctica.
 */
function detectFalseGreen(evidence: string): string | null {
  const text = evidence.toLowerCase();
  if (/\b0\s+(?:tests?|assertions?|passing|passed)\b|no tests? (?:found|ran)/.test(text)) {
    return 'El resultado dice 0 tests ejecutados: eso no es un GREEN, es un test que no corrió.';
  }
  if (/\bskipped\b|\btodo\b|\bpending\b/.test(text) && !/\d+\s+pass/.test(text)) {
    return 'Los tests aparecen como skipped/pending: no se ejecutó el code path.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serialización: el snapshot viaja en el tool result
// ---------------------------------------------------------------------------

/** Tabla de evidencia por tarea, que es como se pidió en el informe. */
export function formatTddSnapshot(entries: TddEntry[], notes: string[] = []): string {
  const rows = entries.map((e) => {
    const command = e.command ? ` cmd="${e.command}"` : '';
    return `  | ${e.task} | ${e.phase} | ${e.outcome} |${command} ${e.evidence}`;
  });
  const body = entries.length === 0 ? '  (sin evidencia registrada)' : rows.join('\n');
  const noteLines = notes.length > 0 ? `\n  note: ${notes.join(' ')}` : '';
  const open = openTasks(entries);
  const openAttr = open.length > 0 ? ` open="${open.join(',')}"` : '';
  return `<tdd_evidence count="${entries.length}"${openAttr}>\n${body}${noteLines}\n</tdd_evidence>`;
}

const SNAPSHOT_ROW =
  /^\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*(pass|fail)\s*\|\s*(?:cmd="([^"]*)")?\s*(.*)$/;

/** Inverso de `formatTddSnapshot`. `null` si el texto no es un snapshot. */
export function parseTddSnapshot(text: string): TddEntry[] | null {
  if (!text.includes('<tdd_evidence')) return null;
  const entries: TddEntry[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.includes('<tdd_evidence')) {
      inside = true;
      continue;
    }
    if (line.includes('</tdd_evidence>')) break;
    if (!inside) continue;
    const match = SNAPSHOT_ROW.exec(line);
    if (!match) continue;
    entries.push({
      task: match[1]!,
      phase: match[2] as TddPhase,
      outcome: match[3] as TddOutcome,
      command: match[4] || undefined,
      evidence: (match[5] ?? '').trim(),
    });
  }
  return entries;
}

/** Reconstruye el registro al reanudar: gana el último snapshot del historial. */
export function rehydrateTdd(messages: Message[], toolName: string): TddEntry[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'tool' || msg.name !== toolName || !msg.content) continue;
    const parsed = parseTddSnapshot(msg.content);
    if (parsed) return parsed;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Inyección en el system prompt
// ---------------------------------------------------------------------------

export const TDD_BLOCK_START = '<!-- stratum:tdd:start -->';
export const TDD_BLOCK_END = '<!-- stratum:tdd:end -->';

/** Tareas cuyo ciclo no ha llegado a un cierre válido (GREEN + triangulación). */
export function openTasks(entries: TddEntry[]): string[] {
  const byTask = new Map<string, Set<TddPhase>>();
  for (const e of entries) {
    const set = byTask.get(e.task) ?? new Set<TddPhase>();
    set.add(e.phase);
    byTask.set(e.task, set);
  }
  return [...byTask.entries()]
    .filter(([, phases]) => !(phases.has('green') && phases.has('triangulate')))
    .map(([task]) => task);
}

/**
 * Bloque que se reinyecta en el system prompt antes de cada iteración, con el
 * mismo razonamiento que el de `todo`: la descripción estática de la tool no
 * basta para que un modelo pequeño mantenga la disciplina a lo largo del turno.
 * Cadena vacía cuando no hay nada abierto.
 */
export function buildTddInjection(entries: TddEntry[]): string {
  const open = openTasks(entries);
  if (open.length === 0) return '';

  const lines = open.map((task) => {
    const phases = entries.filter((e) => e.task === task).map((e) => e.phase);
    const next = nextPhase(phases);
    return `- ${task} — registrado: ${[...new Set(phases)].join(' → ')} · siguiente: ${next}`;
  });

  return `# TDD cycle in progress
These tasks have TDD evidence recorded but no complete cycle yet:
${lines.join('\n')}

Do not declare the work finished until each task reaches GREEN and either triangulates or records
an explicit reason to skip triangulation. Record every phase with the \`test_evidence\` tool as it
happens — evidence written after the fact is not evidence.`;
}

function nextPhase(phases: TddPhase[]): TddPhase {
  const seen = new Set(phases);
  if (!seen.has('red')) return 'red';
  if (!seen.has('green')) return 'green';
  if (!seen.has('triangulate')) return 'triangulate';
  return 'refactor';
}

/**
 * Refresca el bloque dentro del mensaje `system` entre marcadores. Idempotente
 * y superviviente a la compresión, igual que el de `todo`. Devuelve true si el
 * mensaje cambió.
 */
export function applyTddToSystemMessage(messages: Message[], block: string): boolean {
  const system = messages[0];
  if (!system || system.role !== 'system' || typeof system.content !== 'string') return false;

  const current = system.content;
  const start = current.indexOf(TDD_BLOCK_START);
  const end = current.indexOf(TDD_BLOCK_END);
  const wrapped = block ? `${TDD_BLOCK_START}\n${block}\n${TDD_BLOCK_END}` : '';

  let next: string;
  if (start !== -1 && end !== -1 && end > start) {
    const before = current.slice(0, start).replace(/\n+$/, '');
    const after = current.slice(end + TDD_BLOCK_END.length).replace(/^\n+/, '');
    next = wrapped
      ? `${before}\n\n${wrapped}${after ? `\n\n${after}` : ''}`
      : `${before}${after ? `\n\n${after}` : ''}`;
  } else {
    if (!wrapped) return false;
    next = `${current}\n\n${wrapped}`;
  }

  if (next === current) return false;
  messages[0] = { ...system, content: next };
  return true;
}

/**
 * Registro de evidencia de la sesión. Vive en `StratumAgent` (como la lista de
 * `todo`) porque el ciclo abarca varios turnos del loop.
 */
export class TddLedger {
  private entries: TddEntry[] = [];

  get snapshot(): TddEntry[] {
    return [...this.entries];
  }

  replace(entries: TddEntry[]): void {
    this.entries = [...entries];
  }

  clear(): void {
    this.entries = [];
  }

  /** Aplica una entrada. Propaga `TddError` para que el loop lo devuelva como tool_error. */
  record(input: TddRecordInput): TddApplyResult {
    const result = applyTddRecord(this.entries, input);
    this.entries = result.entries;
    return result;
  }

  injection(): string {
    return buildTddInjection(this.entries);
  }
}
