/**
 * Página del visor de trayectoria. Un único documento autocontenido (sin
 * build, sin red más allá del SSE de `server.ts`) que reconstruye los pasos a
 * partir de los `TraceRecord` y los pinta en un timeline por carriles, una
 * lista y un panel de detalle.
 *
 * Va en un template `String.raw`: dentro no puede haber ni acentos graves ni
 * `$` seguido de llave. Todo el contenido de la traza se pinta con
 * `textContent`, nunca como HTML: son prompts y salidas de tools.
 */
export const VIEWER_PAGE = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stratum · Trayectoria</title>
<style>
:root {
  --bg: #ffffff; --panel: #f6f7f9; --line: #e3e5ea; --text: #1d2129; --dim: #6b7280;
  --sel: #eceef2; --accent: #3b6fd4;
  --c-system: #8a8f98; --c-user: #6f8fe6; --c-context: #7fc08d; --c-notice: #d9a13b;
  --c-model: #c3b3df; --c-model-gen: #8f73c4; --c-tool: #e0903e; --c-subagent: #3aa7a0;
  --c-aux: #c9cdd6; --c-aux-gen: #7d8798;
  --c-error: #d6453d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171c; --panel: #1c1f26; --line: #2c303a; --text: #e6e8ec; --dim: #8b92a0;
    --sel: #252a34; --accent: #7ea2f0;
    --c-system: #777d88; --c-user: #6f8fe6; --c-context: #5fa873; --c-notice: #c9973a;
    --c-model: #6d5c94; --c-model-gen: #a48be0; --c-tool: #d98a3c; --c-subagent: #3aa7a0;
    --c-aux: #4a5262; --c-aux-gen: #9aa5b8;
    --c-error: #e2605a;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: flex; flex-direction: column; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.mono { font-family: ui-monospace, "Cascadia Code", Consolas, Menlo, monospace; }
header {
  display: flex; align-items: center; gap: 14px; padding: 10px 16px;
  border-bottom: 1px solid var(--line); flex-wrap: wrap;
}
header h1 { font-size: 15px; margin: 0; font-weight: 600; }
#session { color: var(--dim); font-size: 12px; }
#live { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; }
#live i { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); display: inline-block; }
#live.on i { background: #35b46a; }
.modes { display: flex; gap: 2px; margin-left: 8px; }
.modes button {
  border: 0; background: none; color: var(--dim); font: inherit; padding: 4px 10px;
  border-radius: 6px; cursor: pointer;
}
.modes button:hover { background: var(--sel); }
.modes button[aria-pressed="true"] { background: var(--sel); color: var(--text); font-weight: 600; }
#search {
  margin-left: auto; width: 240px; max-width: 100%; padding: 6px 10px; font: inherit;
  color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
}
#timeline { border-bottom: 1px solid var(--line); display: flex; padding: 8px 16px 10px 0; }
#lanenames { width: 96px; flex: none; color: var(--dim); font-size: 12px; text-align: right; padding-right: 10px; }
#lanenames div, .lane { height: 18px; margin: 4px 0; }
#lanenames div { line-height: 18px; }
#scroller { flex: 1; overflow-x: auto; overflow-y: hidden; }
#lanes { position: relative; min-width: 100%; }
.lane { position: relative; }
.blk {
  position: absolute; top: 2px; height: 14px; min-width: 3px; border-radius: 2px;
  cursor: pointer; overflow: hidden;
}
.blk .gen { position: absolute; top: 0; bottom: 0; right: 0; background: var(--c-model-gen); }
.blk.sel { outline: 2px solid var(--accent); outline-offset: 1px; z-index: 2; }
.blk.err { box-shadow: inset 0 0 0 2px var(--c-error); }
.blk.open { opacity: .65; }
.blk.dimmed { opacity: .18; }
.k-system { background: var(--c-system); } .k-user { background: var(--c-user); }
.k-context { background: var(--c-context); } .k-notice { background: var(--c-notice); }
.k-model { background: var(--c-model); } .k-tool { background: var(--c-tool); }
.k-subagent { background: var(--c-subagent); }
/* Llamada auxiliar (memoria, compresión): mismo carril que el modelo, otro color. */
.blk.aux { background: var(--c-aux); } .blk.aux .gen { background: var(--c-aux-gen); }
#tip {
  position: fixed; z-index: 10; pointer-events: none; display: none; max-width: 420px;
  background: #1f232b; color: #f1f3f6; padding: 8px 10px; border-radius: 6px; font-size: 12px;
  box-shadow: 0 4px 14px rgba(0,0,0,.3); white-space: pre-line;
}
main { flex: 1; display: flex; min-height: 0; }
#list { flex: 1; overflow-y: auto; min-width: 0; }
.row {
  display: flex; align-items: center; gap: 10px; padding: 7px 16px 7px 0; cursor: pointer;
  border-bottom: 1px solid var(--line); white-space: nowrap;
}
.row:hover { background: var(--panel); }
.row.sel { background: var(--sel); }
.row.hidden { display: none; }
.row .turn { width: 34px; flex: none; text-align: center; color: var(--accent); font-size: 11px; }
.row.child .turn { width: 62px; }
.row .ico {
  width: 24px; height: 24px; flex: none; border-radius: 6px; display: grid; place-items: center;
  font-size: 12px; color: #fff;
}
.row .lbl { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 60px; }
.row .res { overflow: hidden; text-overflow: ellipsis; flex: 1 1 0; color: var(--dim); min-width: 0; }
.row .dur { flex: none; color: var(--dim); font-size: 12px; margin-left: auto; }
.row.err .lbl { color: var(--c-error); }
#empty { padding: 40px 16px; color: var(--dim); text-align: center; }
#detail {
  width: 42%; min-width: 320px; max-width: 760px; border-left: 1px solid var(--line);
  display: none; flex-direction: column; min-height: 0;
}
#detail.on { display: flex; }
#dhead { display: flex; align-items: center; gap: 10px; padding: 12px 16px 6px; }
#dbadge { font-size: 11px; font-weight: 700; letter-spacing: .06em; padding: 2px 8px; border-radius: 4px; color: #fff; }
#dwhere { color: var(--dim); font-size: 12px; }
#dclose { margin-left: auto; border: 0; background: none; color: var(--dim); font-size: 20px; cursor: pointer; line-height: 1; }
#tabs { display: flex; gap: 18px; padding: 0 16px; border-bottom: 1px solid var(--line); }
#tabs button {
  border: 0; background: none; font: inherit; color: var(--dim); padding: 8px 0; cursor: pointer;
  border-bottom: 2px solid transparent;
}
#tabs button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
#dbody { flex: 1; overflow: auto; padding: 14px 16px; }
.kv { display: grid; grid-template-columns: 120px 1fr; gap: 6px 12px; margin: 0 0 14px; }
.kv dt { color: var(--dim); } .kv dd { margin: 0; overflow-wrap: anywhere; }
.sect { color: var(--dim); font-size: 12px; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .05em; }
pre {
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px;
  font-family: ui-monospace, "Cascadia Code", Consolas, Menlo, monospace;
}
.prose { white-space: pre-wrap; overflow-wrap: anywhere; }
footer {
  display: flex; gap: 22px; padding: 8px 16px; border-top: 1px solid var(--line);
  color: var(--dim); font-size: 12px; flex-wrap: wrap;
}
@media (max-width: 760px) {
  main { flex-direction: column; }
  #detail { width: 100%; max-width: none; min-width: 0; border-left: 0; border-top: 1px solid var(--line); height: 55%; }
  #lanenames { width: 70px; }
  #search { width: 100%; margin-left: 0; }
}
</style>
</head>
<body>
<header>
  <h1>Trayectoria</h1>
  <span id="session" class="mono">__SESSION_ID__</span>
  <span id="live"><i></i><span id="livetext">conectando…</span></span>
  <div class="modes" role="group" aria-label="Eje del timeline">
    <button data-mode="duration" aria-pressed="false">Duración</button>
    <button data-mode="turns" aria-pressed="false">Turnos</button>
    <button data-mode="calls" aria-pressed="true">Llamadas</button>
  </div>
  <input id="search" type="search" placeholder="Buscar" aria-label="Buscar en la trayectoria">
</header>
<section id="timeline" aria-label="Timeline">
  <div id="lanenames"><div>Entrada</div><div>Modelo</div><div>Herramientas</div></div>
  <div id="scroller"><div id="lanes"><div class="lane"></div><div class="lane"></div><div class="lane"></div></div></div>
</section>
<main>
  <div id="list"><div id="empty">Todavía no hay pasos en esta sesión.</div></div>
  <aside id="detail" aria-label="Detalle del paso">
    <div id="dhead"><span id="dbadge"></span><span id="dwhere" class="mono"></span><button id="dclose" aria-label="Cerrar detalle">×</button></div>
    <div id="tabs" role="tablist">
      <button role="tab" data-tab="summary" aria-selected="true">Resumen</button>
      <button role="tab" data-tab="preview" aria-selected="false">Vista previa</button>
      <button role="tab" data-tab="raw" aria-selected="false">Contenido sin procesar</button>
    </div>
    <div id="dbody"></div>
  </aside>
</main>
<footer id="stats"></footer>
<div id="tip"></div>
<script>
(function () {
  'use strict';

  var KINDS = {
    system: { label: 'SISTEMA', lane: 0, icon: '⚙', color: 'var(--c-system)' },
    user: { label: 'USUARIO', lane: 0, icon: '▶', color: 'var(--c-user)' },
    context: { label: 'CONTEXTO', lane: 0, icon: 'i', color: 'var(--c-context)' },
    notice: { label: 'AVISO', lane: 0, icon: '!', color: 'var(--c-notice)' },
    model: { label: 'MODELO', lane: 1, icon: '✦', color: 'var(--c-model-gen)' },
    tool: { label: 'HERRAMIENTA', lane: 2, icon: '⚒', color: 'var(--c-tool)' },
    subagent: { label: 'SUBAGENTE', lane: 2, icon: '⬡', color: 'var(--c-subagent)' }
  };
  var STATUS = { ok: 'Completado', error: 'Error', cancelled: 'Cancelado' };
  // Origen de una llamada al modelo (mismo criterio que trace/model.ts).
  var ORIGINS = ['agent', 'subagent', 'memory-extraction', 'context-compression', 'session-summary'];
  var ORIGIN_LABEL = {
    agent: 'agente', subagent: 'subagente', 'memory-extraction': 'extracción de memoria',
    'context-compression': 'compresión de contexto', 'session-summary': 'resumen de sesión'
  };
  var auxTracked = null;
  function originOf(s) {
    if (s.kind !== 'model') return null;
    var o = s.data.origin;
    if (typeof o === 'string' && ORIGINS.indexOf(o) >= 0) return o;
    return s.parent ? 'subagent' : 'agent';
  }
  function isAux(s) { var o = originOf(s); return o !== null && o !== 'agent' && o !== 'subagent'; }
  function isPrimary(s) { var o = originOf(s); return o === 'agent' || o === 'subagent'; }
  // Auxiliar lanzada con el turno ya cerrado: se pinta, pero no alarga el turno.
  function isBackground(s) {
    var t = turns[s.turn];
    return !!t && t.end !== null && s.start >= t.end && isAux(s);
  }

  var steps = [], byId = {}, turns = [], rows = {}, blocks = {};
  var selected = null, mode = 'calls', tab = 'summary', query = '';
  var live = false, opened = false, scheduled = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function fmtTime(ts) {
    var d = new Date(ts);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3);
  }
  function fmtDur(ms) {
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
    return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s';
  }
  function fmtTok(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(1) + 'K';
    return (n / 1e6).toFixed(2) + 'M';
  }
  function firstLine(text, max) {
    var s = String(text === undefined || text === null ? '' : text).replace(/^\s+/, '');
    var nl = s.indexOf('\n');
    if (nl >= 0) s = s.slice(0, nl);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function compact(value, max) {
    var s;
    try { s = JSON.stringify(value); } catch (e) { s = String(value); }
    if (s === undefined) s = '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function pretty(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }
  function endOf(s) { return s.end === null ? Date.now() : s.end; }

  // --- Reconstrucción de pasos a partir de los registros ---------------------

  function reset() {
    steps = []; byId = {}; turns = []; rows = {}; blocks = {}; selected = null; auxTracked = null;
    var list = $('list');
    list.textContent = '';
    list.appendChild(el('div', '', 'Todavía no hay pasos en esta sesión.')).id = 'empty';
    var lanes = $('lanes').children;
    for (var i = 0; i < lanes.length; i++) lanes[i].textContent = '';
    $('detail').className = '';
  }

  function ensureTurn(at) {
    if (turns.length === 0) turns.push({ at: at, end: null, stop: null, implicit: true });
    return turns.length - 1;
  }

  function addStep(r, closed) {
    if (byId[r.id]) return byId[r.id];
    var parent = r.parent && byId[r.parent] ? byId[r.parent] : null;
    var s = {
      id: r.id, kind: KINDS[r.kind] ? r.kind : 'notice', name: r.name || '', parent: r.parent || null,
      start: r.at, end: closed ? r.at : null, status: closed ? (r.status || 'ok') : null,
      firstToken: null, data: r.data || {}, turn: parent ? parent.turn : ensureTurn(r.at),
      n: steps.length + 1, hay: null, dirty: true
    };
    steps.push(s);
    byId[s.id] = s;
    return s;
  }

  function onRecord(r) {
    if (!r || typeof r !== 'object') return;
    var s, k;
    switch (r.t) {
      case 'meta':
        // Todas las cabeceras tienen que declararlo: una sesión reanudada desde una
        // versión anterior no registraba las auxiliares en su primera parte.
        k = r.caps && r.caps.indexOf('llm-origin') >= 0;
        auxTracked = auxTracked === null ? k : (auxTracked && k);
        break;
      case 'turn':
        // Lo que llegó antes del primer turno (el prompt del sistema) abrió un
        // turno implícito: es este mismo.
        if (turns.length === 1 && turns[0].implicit) turns[0].implicit = false;
        else turns.push({ at: r.at, end: null, stop: null });
        addStep({ id: 'turn-' + turns.length, at: r.at, kind: 'user', name: r.input, data: { content: r.input } }, true);
        break;
      case 'turn_end':
        if (turns.length) { turns[turns.length - 1].end = r.at; turns[turns.length - 1].stop = r.stopReason; }
        break;
      case 'begin': addStep(r, false); break;
      case 'point': addStep(r, true); break;
      case 'mark':
        s = byId[r.id];
        if (s && r.name === 'first_token') { s.firstToken = r.at; s.dirty = true; }
        break;
      case 'end':
        s = byId[r.id];
        if (!s) break;
        s.end = r.at; s.status = r.status || 'ok'; s.dirty = true; s.hay = null;
        if (r.data) for (k in r.data) if (Object.prototype.hasOwnProperty.call(r.data, k)) s.data[k] = r.data[k];
        break;
    }
    schedule();
  }

  // --- Texto de cada paso ----------------------------------------------------

  function label(s) {
    var d = s.data;
    if (s.kind === 'model') {
      if (isAux(s)) return ORIGIN_LABEL[originOf(s)] + (d.error ? ': ' + firstLine(d.error, 160) : (s.end === null ? '…' : ''));
      if (d.text) return firstLine(d.text, 200);
      if (d.reasoning) return firstLine(d.reasoning, 200);
      if (d.toolCalls && d.toolCalls.length) return 'Llama a ' + d.toolCalls.map(function (c) { return c.name; }).join(', ');
      if (d.error) return firstLine(d.error, 200);
      return s.end === null ? 'Generando…' : '(sin salida)';
    }
    if (s.kind === 'tool') return s.name + ' ' + (d.input !== undefined ? compact(d.input, 80) : '');
    if (s.kind === 'subagent') return '@' + s.name + ' ' + firstLine(d.task, 160);
    return firstLine(s.name, 200) || KINDS[s.kind].label;
  }
  function result(s) {
    var d = s.data;
    if (s.kind === 'tool') {
      if (d.error) return '→ ' + firstLine(d.error, 160);
      if (d.output !== undefined) return '→ ' + firstLine(d.output, 160);
      return s.end === null ? '→ en curso…' : '';
    }
    if (s.kind === 'subagent' && d.summary) return '→ ' + firstLine(d.summary, 160);
    if (isAux(s) && d.text) return '→ ' + firstLine(d.text, 160);
    return '';
  }
  function mainText(s) {
    var d = s.data;
    if (s.kind === 'model') return d.text || d.reasoning || '';
    if (s.kind === 'tool') return d.output !== undefined ? d.output : (d.error || '');
    if (s.kind === 'subagent') return d.summary || d.task || '';
    if (d.content !== undefined) return d.content;
    if (d.message !== undefined) return d.message;
    return '';
  }
  function haystack(s) {
    if (s.hay === null) s.hay = (s.name + ' ' + compact(s.data, 1e7)).toLowerCase();
    return s.hay;
  }
  function matches(s) { return !query || haystack(s).indexOf(query) >= 0; }

  // --- Timeline --------------------------------------------------------------

  function turnBounds(background) {
    var out = [], i;
    for (i = 0; i < turns.length; i++) out.push({ start: turns[i].at, end: turns[i].end === null ? turns[i].at : turns[i].end });
    for (i = 0; i < steps.length; i++) {
      var b = out[steps[i].turn];
      if (!b) continue;
      if (!background && isBackground(steps[i])) continue;
      var e = endOf(steps[i]);
      if (e > b.end) b.end = e;
      if (steps[i].start < b.start) b.start = steps[i].start;
    }
    return out;
  }

  function renderTimeline() {
    var lanes = $('lanes'), n = steps.length, i, s;
    var bounds = turnBounds(true), offsets = [], total = 0;
    for (i = 0; i < bounds.length; i++) {
      offsets.push(total);
      total += Math.max(bounds[i].end - bounds[i].start, 1);
    }
    lanes.style.width = mode === 'calls' ? Math.max(n * 18, 0) + 'px' : '';
    function x(t, turn) {
      var b = bounds[turn];
      if (!b) return 0;
      var span = Math.max(b.end - b.start, 1);
      var rel = Math.min(Math.max(t - b.start, 0), span);
      if (mode === 'turns') return (turn + rel / span) / bounds.length;
      return (offsets[turn] + rel) / total;
    }
    for (i = 0; i < n; i++) {
      s = steps[i];
      var b = blocks[s.id];
      if (!b) {
        b = el('div', 'blk k-' + s.kind);
        b.setAttribute('data-id', s.id);
        if (s.kind === 'model') b.appendChild(el('span', 'gen'));
        lanes.children[KINDS[s.kind].lane].appendChild(b);
        blocks[s.id] = b;
      }
      var x0, x1;
      if (mode === 'calls') { x0 = i / n; x1 = (i + 1) / n; }
      else { x0 = x(s.start, s.turn); x1 = x(endOf(s), s.turn); }
      b.style.left = (x0 * 100).toFixed(3) + '%';
      b.style.width = mode === 'calls' ? 'calc(' + ((x1 - x0) * 100).toFixed(3) + '% - 2px)' : Math.max((x1 - x0) * 100, 0).toFixed(3) + '%';
      var cls = 'blk k-' + s.kind;
      if (isAux(s)) cls += ' aux';
      if (s.id === selected) cls += ' sel';
      if (s.status === 'error') cls += ' err';
      if (s.end === null) cls += ' open';
      if (!matches(s)) cls += ' dimmed';
      b.className = cls;
      if (s.kind === 'model') {
        // Tramo oscuro: generación (desde el primer token). El claro es la espera.
        var e = endOf(s), dur = Math.max(e - s.start, 1);
        var gen = s.firstToken === null ? 0 : (e - s.firstToken) / dur;
        b.firstChild.style.width = (Math.min(Math.max(gen, 0), 1) * 100).toFixed(1) + '%';
      }
    }
  }

  // --- Lista -----------------------------------------------------------------

  function renderRow(s) {
    var row = rows[s.id];
    if (!row) {
      var list = $('list'), empty = $('empty');
      if (empty) empty.remove();
      var stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      row = el('div', 'row');
      row.setAttribute('data-id', s.id);
      row.appendChild(el('span', 'turn'));
      row.appendChild(el('span', 'ico'));
      row.appendChild(el('span', 'lbl'));
      row.appendChild(el('span', 'res mono'));
      row.appendChild(el('span', 'dur mono'));
      list.appendChild(row);
      rows[s.id] = row;
      if (stick && selected === null) list.scrollTop = list.scrollHeight;
    }
    var c = row.children;
    c[0].textContent = s.kind === 'user' && !s.parent && s.id.indexOf('turn-') === 0 ? '#' + (s.turn + 1) : '';
    c[1].textContent = isAux(s) ? '◇' : KINDS[s.kind].icon;
    c[1].style.background = isAux(s) ? 'var(--c-aux-gen)' : KINDS[s.kind].color;
    c[2].textContent = label(s);
    c[2].className = s.kind === 'tool' ? 'lbl mono' : 'lbl';
    c[3].textContent = result(s);
    c[4].textContent = s.end === null ? '…' : (s.end > s.start ? fmtDur(s.end - s.start) : '');
    var cls = 'row';
    if (s.parent) cls += ' child';
    if (s.id === selected) cls += ' sel';
    if (s.status === 'error') cls += ' err';
    if (!matches(s)) cls += ' hidden';
    row.className = cls;
  }

  // --- Detalle ---------------------------------------------------------------

  function kv(dl, key, value) {
    if (value === undefined || value === null || value === '') return;
    dl.appendChild(el('dt', '', key));
    dl.appendChild(el('dd', '', value));
  }
  function section(body, title, text, prose) {
    if (text === undefined || text === null || text === '') return;
    body.appendChild(el('div', 'sect', title));
    body.appendChild(el(prose ? 'div' : 'pre', prose ? 'prose' : '', pretty(text)));
  }

  function renderDetail() {
    var panel = $('detail'), s = selected === null ? null : byId[selected];
    if (!s) { panel.className = ''; return; }
    panel.className = 'on';
    var kind = KINDS[s.kind], d = s.data, body = $('dbody');
    $('dbadge').textContent = isAux(s) ? 'MODELO · AUXILIAR' : kind.label;
    $('dbadge').style.background = isAux(s) ? 'var(--c-aux-gen)' : kind.color;
    $('dwhere').textContent = 'Turno ' + (s.turn + 1) + ' · Paso ' + s.n + (s.parent ? ' · subagente' : '');
    var tabsEl = $('tabs').children;
    for (var i = 0; i < tabsEl.length; i++) tabsEl[i].setAttribute('aria-selected', String(tabsEl[i].getAttribute('data-tab') === tab));
    body.textContent = '';

    if (tab === 'raw') {
      body.appendChild(el('pre', '', pretty({
        id: s.id, kind: s.kind, name: s.name, parent: s.parent, start: s.start, end: s.end,
        firstToken: s.firstToken, status: s.status, data: d
      })));
      return;
    }
    if (tab === 'preview') {
      if (s.kind === 'model') {
        section(body, 'Razonamiento', d.reasoning, true);
        section(body, 'Respuesta', d.text, true);
        if (d.toolCalls) for (var j = 0; j < d.toolCalls.length; j++) {
          var args = d.toolCalls[j].arguments, parsed = args;
          try { parsed = JSON.parse(args); } catch (e) { /* argumentos que no parsean: tal cual */ }
          section(body, 'Llamada · ' + d.toolCalls[j].name, parsed);
        }
        section(body, 'Error', d.error);
      } else if (s.kind === 'tool') {
        section(body, 'Entrada', d.input);
        section(body, 'Salida', d.output);
        section(body, 'Error', d.error);
      } else if (s.kind === 'subagent') {
        section(body, 'Tarea', d.task, true);
        section(body, 'Resumen', d.summary, true);
        section(body, 'Ficheros', d.filesChanged && d.filesChanged.length ? d.filesChanged : '');
        section(body, 'Error', d.error);
      } else {
        var text = mainText(s);
        if (text) body.appendChild(el('div', 'prose', text));
        else body.appendChild(el('pre', '', pretty(d)));
      }
      if (!body.firstChild) body.appendChild(el('div', 'sect', 'Sin contenido'));
      return;
    }

    var dl = el('dl', 'kv');
    kv(dl, s.kind === 'tool' ? 'Herramienta' : s.kind === 'model' ? 'Modelo' : s.kind === 'subagent' ? 'Perfil' : 'Fuente', firstLine(s.name, 200));
    kv(dl, 'Estado', s.end === null ? 'En curso' : STATUS[s.status] || s.status);
    kv(dl, 'Inicio', fmtTime(s.start));
    kv(dl, 'Duración', fmtDur(endOf(s) - s.start));
    if (s.kind === 'model') {
      kv(dl, 'Origen', originOf(s) + ' (' + ORIGIN_LABEL[originOf(s)] + ')');
      kv(dl, 'Proveedor', d.provider);
      kv(dl, 'Iteración', d.iteration !== undefined ? d.iteration + 1 : null);
      kv(dl, 'Mensajes', d.messages);
      kv(dl, 'Tools ofrecidas', d.tools);
      if (s.firstToken !== null) kv(dl, 'Primer token', fmtDur(s.firstToken - s.start));
      var ov = isPrimary(s) ? overlapOf(s) : null;
      if (ov && (ov.active > 0 || ov.overlapping > 0 || ov.preceding > 0)) {
        // Relojes del cliente: dos peticiones en vuelo a la vez, no tiempo de cola del servidor.
        kv(dl, 'Auxiliares en curso al empezar', ov.active);
        kv(dl, 'Espera solapada con auxiliares', fmtDur(ov.overlapping));
        if (ov.preceding > 0) kv(dl, 'Auxiliares justo antes', fmtDur(ov.preceding));
      }
      var u = d.usage;
      if (u) {
        kv(dl, 'Tokens entrada', u.promptTokens);
        var read = cacheRead(u);
        if (read !== null) {
          kv(dl, 'Caché', read > 0 ? 'templada' : 'fría');
          kv(dl, 'Tokens de caché (leídos)', read);
          if (typeof u.promptTokens === 'number') {
            kv(dl, 'Tokens sin caché', Math.max(u.promptTokens - read, 0));
            if (u.promptTokens > 0) kv(dl, 'Acierto de caché', Math.round(Math.min(read, u.promptTokens) / u.promptTokens * 100) + '%');
          }
        } else kv(dl, 'Caché', 'no reportada por el backend');
        kv(dl, 'Tokens escritos en caché', u.cacheWriteTokens);
        var brk = cacheBreaks()[s.id];
        if (brk) kv(dl, 'Rotura de caché', BREAK_LABEL[brk.cause] + ' (' + brk.before + ' → ' + brk.after + ' tok)');
        kv(dl, 'Tokens salida', u.completionTokens);
        if (u.completionTokens && s.end !== null) {
          var gen = s.end - (s.firstToken === null ? s.start : s.firstToken);
          if (gen > 0) kv(dl, 'Velocidad', (u.completionTokens / (gen / 1000)).toFixed(1) + ' tok/s');
        }
      } else if (s.end !== null) kv(dl, 'Tokens', 'no reportados por el backend');
      var px = d.prefix;
      if (px && typeof px.chars === 'number') {
        if (typeof px.sharedChars === 'number' && px.chars > 0) {
          kv(dl, 'Prefijo repetido', Math.round(Math.min(px.sharedChars, px.chars) / px.chars * 100) + '% del prompt');
          if (px.diverged) kv(dl, 'Deja de coincidir en', DIVERGED_LABEL[px.diverged] + (px.diverged === 'history' && px.divergedAt !== undefined ? ' (mensaje ' + px.divergedAt + ')' : ''));
        } else kv(dl, 'Prefijo repetido', 'primera llamada: sin referencia');
        kv(dl, 'Huella system · tools', (px.system || '—') + ' · ' + (px.tools || '—'));
      }
    }
    if (s.kind === 'tool') {
      kv(dl, 'Ejecución', d.execMs !== undefined ? fmtDur(d.execMs) : null);
      if (d.recoverable !== undefined) kv(dl, 'Recuperable', d.recoverable ? 'sí' : 'no');
    }
    if (s.kind === 'subagent' && d.usage) {
      kv(dl, 'Resultado', d.result);
      kv(dl, 'Iteraciones', d.usage.iterations);
      kv(dl, 'Tokens', d.usage.tokens);
    }
    if (d.chars !== undefined) kv(dl, 'Caracteres', d.chars);
    body.appendChild(dl);
    var preview = s.kind === 'tool' && d.input !== undefined && d.output === undefined && !d.error ? pretty(d.input) : mainText(s);
    if (preview) {
      body.appendChild(el('div', 'sect', 'Vista previa'));
      var str = pretty(preview);
      body.appendChild(el('div', 'prose', str.length > 1200 ? str.slice(0, 1200) + '…' : str));
    }
  }

  // --- Caché de prompt (mismo cálculo que trace/model.ts) ----------------------

  var BREAK_LABEL = {
    tools: 'cambió la lista de tools', system: 'cambió el prompt del sistema',
    history: 'se reescribió el historial', compression: 'compresión de contexto',
    model: 'cambio de provider o modelo', backend: 'el backend reutilizó menos sin cambios en el prompt',
    unknown: 'causa no registrada'
  };
  var DIVERGED_LABEL = { tools: 'la lista de tools', system: 'el prompt del sistema', history: 'el historial' };

  // Tokens leídos de caché; null si el backend no los reportó (nunca se estima).
  function cacheRead(u) {
    if (!u) return null;
    var r = typeof u.cachedReadTokens === 'number' ? u.cachedReadTokens : u.cachedTokens;
    return typeof r === 'number' && r >= 0 ? r : null;
  }

  // Llamadas que leyeron de caché menos tokens que la anterior del mismo agente, por id.
  // Solo pérdidas que el backend demuestra: igual que cacheBreaks() de model.ts.
  function cacheBreaks() {
    var out = {}, last = {}, compressed = {}, i;
    for (i = 0; i < steps.length; i++) {
      var s = steps[i], scope = s.parent || '';
      if (s.kind === 'context' && s.name === 'Contexto comprimido') compressed[scope] = true;
      if (!isPrimary(s)) continue;
      var read = cacheRead(s.data.usage);
      if (read === null) continue;
      var prev = last[scope], px = s.data.prefix, was = compressed[scope] === true;
      compressed[scope] = false;
      last[scope] = { step: s, read: read };
      if (!prev) continue;
      if (px && typeof px.sharedChars !== 'number') continue;
      if (read >= prev.read) continue;
      var cause;
      if (prev.step.name !== s.name || prev.step.data.provider !== s.data.provider) cause = 'model';
      else if (!px) cause = was ? 'compression' : 'unknown';
      else if (px.diverged === 'tools') cause = 'tools';
      else if (px.diverged === 'system') cause = 'system';
      else if (px.diverged === 'history') cause = was ? 'compression' : 'history';
      else cause = 'backend';
      out[s.id] = { cause: cause, before: prev.read, after: read };
    }
    return out;
  }

  // --- Solape con llamadas auxiliares (mismo cálculo que trace/model.ts) ------

  function covered(intervals, from, to) {
    var clipped = [], i;
    for (i = 0; i < intervals.length; i++) {
      var a = Math.max(intervals[i][0], from), b = Math.min(intervals[i][1], to);
      if (b > a) clipped.push([a, b]);
    }
    clipped.sort(function (x, y) { return x[0] - y[0]; });
    var total = 0, cursor = from;
    for (i = 0; i < clipped.length; i++) {
      var st = Math.max(clipped[i][0], cursor);
      if (clipped[i][1] > st) { total += clipped[i][1] - st; cursor = clipped[i][1]; }
    }
    return total;
  }
  // Por id de cada llamada del loop: auxiliares en curso al empezar, espera solapada y auxiliares justo antes.
  function overlaps() {
    var out = {}, intervals = [], primary = [], i, j;
    for (i = 0; i < steps.length; i++) {
      if (isAux(steps[i])) intervals.push([steps[i].start, endOf(steps[i])]);
      else if (isPrimary(steps[i])) primary.push(steps[i]);
    }
    primary.sort(function (a, b) { return a.start - b.start; });
    var lastEnd = -Infinity;
    for (i = 0; i < primary.length; i++) {
      var s = primary[i], waitEnd = s.firstToken === null ? endOf(s) : s.firstToken, active = 0, preceding = 0;
      for (j = 0; j < intervals.length; j++) {
        var a = intervals[j][0], b = intervals[j][1];
        if (a <= s.start && b > s.start) active++;
        if (b <= s.start && b > lastEnd) preceding += b - a;
      }
      out[s.id] = { active: active, overlapping: covered(intervals, s.start, waitEnd), preceding: preceding };
      lastEnd = Math.max(lastEnd, endOf(s));
    }
    return out;
  }
  function overlapOf(s) { return overlaps()[s.id] || null; }

  // --- Pie -------------------------------------------------------------------

  function renderStats() {
    var prompt = 0, cached = 0, completion = 0, total = 0, genMs = 0, genTok = 0, calls = 0, tools = 0, active = 0, i;
    var reported = 0, cold = 0, warm = 0, ttftCold = 0, ttftColdN = 0, ttftWarm = 0, ttftWarmN = 0, pxChars = 0, pxShared = 0;
    var byOrigin = {}, aux = { calls: 0, errors: 0, ms: 0, usage: false, prompt: 0, cacheSeen: false, cachePrompt: 0, cached: 0 };
    for (i = 0; i < steps.length; i++) {
      var s = steps[i], u = s.data.usage;
      if (s.kind === 'tool') tools++;
      var origin = originOf(s);
      if (origin === null) continue;
      byOrigin[origin] = (byOrigin[origin] || 0) + 1;
      if (isAux(s)) {
        // Las auxiliares se cuentan aparte: ni son del turno ni comparten prompt con el agente.
        aux.calls++;
        if (s.status === 'error') aux.errors++;
        aux.ms += endOf(s) - s.start;
        if (u) {
          aux.usage = true; aux.prompt += u.promptTokens || 0;
          var ar = cacheRead(u);
          if (ar !== null && typeof u.promptTokens === 'number') { aux.cacheSeen = true; aux.cachePrompt += u.promptTokens; aux.cached += Math.min(ar, u.promptTokens); }
        }
        continue;
      }
      calls++;
      var px = s.data.prefix;
      if (px && typeof px.sharedChars === 'number' && typeof px.chars === 'number') { pxChars += px.chars; pxShared += Math.min(px.sharedChars, px.chars); }
      if (!u) continue;
      completion += u.completionTokens || 0;
      var read = cacheRead(u);
      if (read !== null && typeof u.promptTokens === 'number') {
        reported++; prompt += u.promptTokens; cached += Math.min(read, u.promptTokens);
        var ttft = s.firstToken === null ? null : Math.max(s.firstToken - s.start, 0);
        if (read > 0) { warm++; if (ttft !== null) { ttftWarm += ttft; ttftWarmN++; } }
        else { cold++; if (ttft !== null) { ttftCold += ttft; ttftColdN++; } }
      }
      total += u.totalTokens || ((u.promptTokens || 0) + (u.completionTokens || 0));
      if (u.completionTokens && s.end !== null) {
        var g = s.end - (s.firstToken === null ? s.start : s.firstToken);
        if (g > 0) { genMs += g; genTok += u.completionTokens; }
      }
    }
    var bounds = turnBounds(false);
    for (i = 0; i < bounds.length; i++) active += bounds[i].end - bounds[i].start;
    var realTurns = 0;
    for (i = 0; i < turns.length; i++) if (!turns[i].implicit) realTurns++;
    var breakdown = [];
    for (i = 0; i < ORIGINS.length; i++) if (byOrigin[ORIGINS[i]]) breakdown.push(ORIGINS[i] + ' ' + byOrigin[ORIGINS[i]]);
    var parts = [realTurns + ' turnos · ' + steps.length + ' pasos', 'LLM calls: ' + (calls + aux.calls) + (breakdown.length ? ' (' + breakdown.join(' · ') + ')' : '') + ' · ' + tools + ' tools'];
    if (aux.calls > 0) {
      var auxText = 'Auxiliares ' + fmtDur(aux.ms);
      if (aux.usage) auxText += ' · ' + fmtTok(aux.prompt) + ' tok entrada';
      if (aux.cacheSeen && aux.cachePrompt > 0) auxText += ' · caché ' + Math.round(aux.cached / aux.cachePrompt * 100) + '%';
      if (aux.errors > 0) auxText += ' · ' + aux.errors + (aux.errors === 1 ? ' fallo' : ' fallos');
      parts.push(auxText);
      var ovAll = overlaps(), ovMs = 0, ovN = 0, key2;
      for (key2 in ovAll) if (ovAll[key2].overlapping > 0) { ovMs += ovAll[key2].overlapping; ovN++; }
      if (ovN > 0) parts.push(ovN + (ovN === 1 ? ' llamada del agente' : ' llamadas del agente') + ' con auxiliar en curso (' + fmtDur(ovMs) + ' solapados)');
    } else if (auxTracked === false && calls > 0) parts.push('Auxiliares no registradas en esta traza');
    if (genMs > 0) parts.push((genTok / (genMs / 1000)).toFixed(0) + ' tok/s');
    if (total > 0) parts.push(fmtTok(total) + ' tok');
    if (reported > 0) {
      if (prompt > 0) parts.push('Acierto de caché ' + Math.round(cached / prompt * 100) + '% (' + fmtTok(cached) + ' de ' + fmtTok(prompt) + ')');
      parts.push(cold + ' frías · ' + warm + ' templadas');
      if (ttftColdN > 0 || ttftWarmN > 0) parts.push('TTFT ' + (ttftColdN > 0 ? fmtDur(ttftCold / ttftColdN) : 'n/d') + ' frío · ' + (ttftWarmN > 0 ? fmtDur(ttftWarm / ttftWarmN) : 'n/d') + ' templado');
      var nBreaks = 0, breaks = cacheBreaks(), key;
      for (key in breaks) nBreaks++;
      if (nBreaks > 0) parts.push(nBreaks + (nBreaks === 1 ? ' rotura de caché' : ' roturas de caché'));
    } else if (calls > 0) parts.push('Caché no reportada');
    if (pxChars > 0) parts.push('Prefijo estable ' + Math.round(pxShared / pxChars * 100) + '%');
    if (active > 0) parts.push('Tiempo activo ' + fmtDur(active));
    var foot = $('stats');
    foot.textContent = '';
    for (i = 0; i < parts.length; i++) foot.appendChild(el('span', '', parts[i]));
  }

  // --- Render ----------------------------------------------------------------

  function render(all) {
    scheduled = false;
    for (var i = 0; i < steps.length; i++) {
      if (all || steps[i].dirty || steps[i].end === null) { renderRow(steps[i]); steps[i].dirty = false; }
    }
    renderTimeline();
    renderDetail();
    renderStats();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(function () { render(false); });
  }
  function select(id) {
    selected = id;
    render(true);
    if (id !== null && rows[id]) rows[id].scrollIntoView({ block: 'nearest' });
  }
  function idFrom(target) {
    while (target && target !== document.body) {
      if (target.getAttribute && target.getAttribute('data-id')) return target.getAttribute('data-id');
      target = target.parentNode;
    }
    return null;
  }

  $('list').addEventListener('click', function (ev) { var id = idFrom(ev.target); if (id) select(id); });
  $('lanes').addEventListener('click', function (ev) { var id = idFrom(ev.target); if (id) select(id); });
  $('dclose').addEventListener('click', function () { select(null); });
  $('tabs').addEventListener('click', function (ev) {
    var t = ev.target.getAttribute && ev.target.getAttribute('data-tab');
    if (t) { tab = t; renderDetail(); }
  });
  document.querySelector('.modes').addEventListener('click', function (ev) {
    var m = ev.target.getAttribute && ev.target.getAttribute('data-mode');
    if (!m) return;
    mode = m;
    var btns = this.children;
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-mode') === m));
    renderTimeline();
  });
  $('search').addEventListener('input', function () { query = this.value.trim().toLowerCase(); render(true); });
  document.addEventListener('keydown', function (ev) {
    if (ev.target === $('search')) { if (ev.key === 'Escape') { $('search').value = ''; query = ''; render(true); } return; }
    if (ev.key === 'Escape') { select(null); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    var visible = steps.filter(matches);
    if (!visible.length) return;
    var idx = -1;
    for (var i = 0; i < visible.length; i++) if (visible[i].id === selected) idx = i;
    idx = ev.key === 'ArrowDown' ? Math.min(idx + 1, visible.length - 1) : Math.max(idx - 1, 0);
    ev.preventDefault();
    select(visible[idx].id);
  });

  var tip = $('tip');
  $('lanes').addEventListener('mousemove', function (ev) {
    var id = idFrom(ev.target), s = id ? byId[id] : null;
    if (!s) { tip.style.display = 'none'; return; }
    tip.textContent = (isAux(s) ? 'MODELO · AUXILIAR' : KINDS[s.kind].label) + ' · ' + firstLine(label(s), 60) + '\n' +
      fmtTime(s.start) + ' → ' + (s.end === null ? 'en curso' : fmtTime(s.end)) + '\n' +
      'Total ' + fmtDur(endOf(s) - s.start);
    tip.style.display = 'block';
    var w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(ev.clientX + 12, window.innerWidth - w - 8)) + 'px';
    tip.style.top = (ev.clientY + 16) + 'px';
  });
  $('lanes').addEventListener('mouseleave', function () { tip.style.display = 'none'; });

  // Los pasos abiertos crecen con el reloj.
  window.setInterval(function () {
    if (!live) return;
    for (var i = 0; i < steps.length; i++) if (steps[i].end === null) { schedule(); return; }
  }, 500);

  // --- Conexión --------------------------------------------------------------

  function setLive(on, text) {
    live = on;
    $('live').className = on ? 'on' : '';
    $('livetext').textContent = text;
  }
  var source = new EventSource('events');
  source.onopen = function () {
    // Cada conexión recibe el fichero desde el principio: tras reconectar se
    // parte de cero para no duplicar pasos.
    if (opened) reset();
    opened = true;
    setLive(true, 'en vivo');
    schedule();
  };
  source.onmessage = function (ev) {
    var rec;
    try { rec = JSON.parse(ev.data); } catch (e) { return; }
    onRecord(rec);
  };
  source.addEventListener('reset', function () { reset(); schedule(); });
  source.onerror = function () { setLive(false, 'desconectado — la sesión terminó o el visor se cerró'); };

  render(true);
})();
</script>
</body>
</html>
`;
