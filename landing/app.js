/* Stratum CLI — landing estilo terminal.
 *
 * Fuentes de datos, en orden:
 *   1. data/commits-data.js  — snapshot generado por refresh-commits.ps1 (commits con +/-, tags, PRs)
 *   2. api.github.com        — commits más recientes que el snapshot (sin +/-), si responde
 *   3. registry.npmjs.org    — versión publicada de stratum-cli, si responde
 * Si la red falla, la página se pinta entera con el snapshot.
 */

"use strict";

const REPO = "choruzo/CLI";
const NPM_PKG = "stratum-cli";
const PROJECT_START = "2026-05-27";
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ═══ Datos del proyecto ═══════════════════════════════════════════════════ */

const MILESTONES = [
  { id: "H0", title: "Scaffolding", date: "2026-05-27", track: "cli", status: "done",
    body: ["package.json, tsconfig, tsup (ESM + CJS), Vitest y Commander.js."] },
  { id: "H1", title: "Core Agent Loop", date: "2026-05-28", track: "cli", status: "done",
    body: ["ProviderRouter, streaming SSE con StreamBuffer, ReactLoop, ToolRegistry y la UI Ink."] },
  { id: "H2", title: "Memoria · capa 1", date: "2026-06-11", track: "cli", status: "done",
    body: ["STRATUM.md global y de proyecto en el system prompt, compresión de contexto al 80 %, stratum init."] },
  { id: "H2.5", title: "Init estilo opencode", date: "2026-06-11", track: "cli", status: "done",
    body: ["INITIALIZE_PROMPT como comando-plantilla, glob/list/grep, read_file numerado, bloque <env>.", "F7 (ago): tool question — tanda única de preguntas al usuario."] },
  { id: "H3", title: "Tools completas", date: "2026-06-11", track: "cli", status: "done",
    body: ["edit_file con unified diff, web_search (DDG + Tavily con RRF), web_fetch HTML→markdown, confirmación destructiva."] },
  { id: "H3.5", title: "Provider & Model UX", date: "2026-06-12", track: "cli", status: "done",
    body: ["Asistente stratum provider add, /model y /config_provider."] },
  { id: "H4", title: "Cliente MCP", date: "2026-06-15", track: "cli", status: "done",
    body: ["McpManager con heartbeat y backoff, auto-registro mcp__server__tool, /tools."] },
  { id: "H4.1", title: "MCP gestionado y lazy", date: "2026-06-16", track: "cli", status: "done",
    body: ["Carpeta ~/.stratum/mcp/ que instala una vez y lanza node directo; arranque lazy en background."] },
  { id: "H5", title: "Memoria · capas 2 y 3", date: "2026-06-16", track: "cli", status: "done",
    body: ["decisions.json + índice semántico sqlite-vec con embeddings ONNX locales y fallback JS."] },
  { id: "H6", title: "Multi-provider", date: "2026-06-18", track: "cli", status: "done",
    body: ["Ollama, vLLM, llama.cpp y LiteLLM; fallback automático por orden y health check en la barra."] },
  { id: "H7", title: "Plan & Execute", date: "2026-06-19", track: "cli", status: "done", release: "v0.2.0",
    body: ["Tres fases en un solo turno: explorar en solo lectura, aprobar el plan y ejecutarlo con checklist vivo."] },
  { id: "H8A", title: "Delegación a subagentes", date: "2026-06-20", track: "cli", status: "done",
    body: ["delegate_task con contexto aislado, router propio por hijo y profundidad 1."] },
  { id: "H8B", title: "Subagentes robustos", date: "2026-08-20", track: "cli", status: "done",
    body: ["Presupuesto de tokens, persistencia en .stratum/subagents/ y reanudación sin reejecutar."] },
  { id: "H8C", title: "Subagentes en paralelo", date: "2026-08-21", track: "cli", status: "done",
    body: ["Semáforo + mutex, árbol vivo <AgentTree>, inspector /subagents y detección de conflictos."] },
  { id: "H9", title: "SSH nativo", date: "2026-08-27", track: "cli", status: "done",
    body: ["ssh2 puro Node: pool, TOFU de host keys, jump hosts, SFTP y auditoría. 77 tests contra un servidor SSH real en proceso."] },
  { id: "H10", title: "Cierre de la UI base", date: "2026-08-27", track: "cli", status: "done",
    body: ["8 /comandos nuevos, historial de input, <FatalError>, progreso de /init y panel de arranque MCP."] },
  { id: "H11", title: "Disciplina operativa", date: "2026-09-12", track: "cli", status: "done", release: "v0.3.0",
    body: ["Work routing, guardas por capas (hard-deny no configurable) y tool todo con staleness."] },
  { id: "H12", title: "Skills y riesgo del cambio", date: "2026-09-12", track: "cli", status: "done",
    body: ["Registro de skills (índice barato, cuerpo bajo demanda) y aviso de cambio grande a las 400 líneas."] },
  { id: "H13", title: "TDD estricto y panel de cambios", date: "2026-09-12", track: "cli", status: "done",
    body: ["test_evidence valida el ciclo RED → GREEN, +N/−M del working tree en la barra y contabilidad honesta de tokens."] },
  { id: "H14", title: "Transversales de prompting", date: "2026-09-12", track: "cli", status: "done",
    body: ["Saneado de GIT_DIR heredado, opciones con token opaco en question, contrato de identidad y guías por puntero."] },
  { id: "H15", title: "Perfiles de agente", date: "2026-09-14", track: "cli", status: "done", release: "v0.4.0",
    body: ["@perfil para delegar, /agent para activarlo como principal, stratum agents list y badge ◆ en la barra."] },
  { id: "H16", title: "Ejecución unificada", date: "2026-09-15", track: "cli", status: "current",
    body: ["Tool exec con targets local y ssh:<alias>, auditoría universal en exec-audit.jsonl y redacción de secretos no desactivable.", "El exit code real en Windows sale de un gancho de PowerShell."] },
  { id: "D0", title: "Scaffolding y sidecar SEA", date: "2026-09-21", track: "desktop", status: "wip",
    body: ["Tauri + core de la CLI empaquetado como binario Node SEA, canal local autenticado por token."] },
  { id: "D1", title: "Chat de asistente", date: "2026-09-21", track: "desktop", status: "done",
    body: ["IPC seguro con tramas validadas por Zod, turnos que siempre terminan y guardan, confirmaciones con timeout."] },
  { id: "D2", title: "Workspace aislado", date: "2026-09-22", track: "desktop", status: "wip",
    body: ["inputs/, outputs/ y scratch/ por conversación; confinamiento que falla cerrado (symlinks, UNC, junctions)."] },
  { id: "D3", title: "Retención", date: "2026-09-22", track: "desktop", status: "wip",
    body: ["Compresión a tar.gz verificada por sha256 y purga por antigüedad; nunca toca una conversación abierta."] },
  { id: "D4", title: "Conversaciones múltiples", date: "2026-09-23", track: "desktop", status: "wip",
    body: ["Sidebar, transcript visible separado del historial, cola de turnos concurrentes y checkpoints tras cada tool."] },
  { id: "H17", title: "Entornos y blast radius", date: "siguiente", track: "cli", status: "next",
    body: ["Entornos con radio de impacto, modo read-only, perfil de sesión y badge de contexto en la barra."] },
  { id: "D5", title: "Settings y ProviderWizard", date: "pendiente", track: "desktop", status: "next",
    body: ["Configuración visual y escritura segura compartida con la CLI."] },
  { id: "H18", title: "Tools de diagnóstico", date: "pendiente", track: "cli", status: "next",
    body: ["net_probe, sys_inspect, log_query y service_status."] },
  { id: "H19", title: "Diagnóstico verificado", date: "pendiente", track: "cli", status: "next",
    body: ["Tool diagnosis, perfiles de triaje y .stratum/incidents/."] },
  { id: "H20", title: "Cloud y virtualización", date: "pendiente", track: "cli", status: "next",
    body: ["Wrappers cloud y de virtualización, contexto activo en la barra."] },
  { id: "D6–D8", title: "SO, polish y modo Code", date: "pendiente", track: "desktop", status: "next",
    body: ["Integración con el SO y build, ventana frameless y E2E, y el conmutador Chat | Code."] }
];

const NEWS = [
  { id: "H16", title: "Una sola tool exec para todos los targets", date: "2026-09-15",
    text: "bash y ssh_exec desaparecen: exec recibe un target (local o ssh:<alias>). Un comando que falla ya no gasta reintentos, y tres grep sin resultados no deshabilitan el shell.",
    pre: "exec { target: \"ssh:prod-db\", command: \"df -h /var\" }\n<exec_result target=\"ssh:prod-db\" status=\"exited\" exitCode=\"0\">" },
  { id: "H16", title: "Redacción de secretos que no se puede apagar", date: "2026-09-15",
    text: "Claves privadas, Bearer, sk-, JWT y tokens de GitHub se sustituyen antes de llegar al modelo, al log o al historial. Nunca se borran: el modelo sabe que ahí había algo.",
    pre: "OPENAI_API_KEY=[redacted: API key]\nAuthorization: [redacted: authorization header]" },
  { id: "H15", title: "Perfiles de agente de primera clase", date: "2026-09-14",
    text: "Los perfiles de .stratum/agents/ se describen, se listan y se invocan: @review en el chat, /agent para convertirlo en principal, stratum run --delegate en scripts.",
    pre: "❯ @review revisa el diff de hoy\n◆ review · allowedTools: read_file, grep, exec" },
  { id: "H13", title: "TDD estricto verificado por tooling", date: "2026-09-12",
    text: "Con tools.testCommand configurado, test_evidence rechaza un GREEN sin RED previo o un refactor en rojo. La disciplina deja de depender de la buena voluntad del modelo.",
    pre: "✗ test_evidence · GREEN sin RED previo (recuperable)" },
  { id: "H11", title: "Guardas por capas", date: "2026-09-12",
    text: "Capa 1 hard-deny no configurable (rm -rf /, mkfs, fork bombs), capa 2 por comando (npm publish bloqueado, git push --force pide confirmación) y capa 3 de rutas sensibles.",
    pre: "✗ vetado · capa 1 hard-deny\n  ni --allow-destructive ni el allow-all lo levantan" },
  { id: "D0–D4", title: "Stratum Desktop arranca", date: "2026-09-23",
    text: "El mismo core, ahora como sidecar de una app Tauri: chat de asistente, workspace aislado por conversación, retención automática y varias conversaciones a la vez.",
    pre: "sidecar  stratum-desktop-server  (Node SEA)\nprotocolo v5 · named pipe · token por env" }
];

const PR_DETAILS = {
  1: {
    points: [
      "El truncado duro dejaba tool results huérfanos: el historial quedaba inválido (400) y sin recuperación posible.",
      "El umbral de compresión se medía sobre el prompt_tokens de la llamada anterior y con un proxy chars/3,5 optimista.",
      "El ContextManager pasa a ser de sesión y calibra el proxy contra el tokenizador real del modelo."
    ],
    table: [["Escenario", "Compresiones", "Errores", "Invariante"], ["Compresión vía LLM", "3", "0", "OK"], ["Truncado duro forzado", "3", "0", "OK"]]
  }
};

const ROADMAP = [
  { id: "H17", title: "Entornos con blast radius", key: true,
    text: "Entornos declarados en .stratumrc.json con radio de impacto, modo read-only y un perfil de sesión que decide qué tools ve el modelo.",
    why: "la seguridad antes que el alcance" },
  { id: "H18", title: "Diagnóstico puro",
    text: "net_probe, sys_inspect, log_query y service_status, sin dependencias externas.",
    why: "sustrato para el hito 19" },
  { id: "H19", title: "Diagnóstico verificado", key: true,
    text: "Tool diagnosis, perfiles de triaje e incidentes en .stratum/incidents/, con memoria de decisiones entre sesiones.",
    why: "la pieza diferencial" },
  { id: "H20", title: "Cloud y virtualización",
    text: "Wrappers cloud y de virtualización con el contexto activo visible en la barra.",
    why: "lo más amplio y lo que más envejece" },
  { id: "D5", title: "Desktop · Settings",
    text: "Settings Panel, ProviderWizard y configuración compartida con la CLI.",
    why: "configurar sin editar JSON" },
  { id: "D8", title: "Desktop · modo Code",
    text: "Conmutador Chat | Code: el comportamiento de la CLI sobre un proyecto real, dentro de la app.",
    why: "cierra la ruta D0–D8" }
];

const DESK_CARDS = [
  { t: "Sidecar Node SEA", d: "El core de la CLI compilado en un solo binario; las dependencias nativas se cargan desde los resources de Tauri." },
  { t: "Canal autenticado", d: "Named pipe o unix socket, token por variable de entorno y tramas de 4 KiB como máximo antes de autenticar." },
  { t: "Workspace confinado", d: "Cada conversación tiene su carpeta; las tools de fichero no salen de ella y exec no existe en este modo." },
  { t: "Retención", d: "A los N días se comprime a tar.gz verificado; más tarde se purga. Abrir una conversación no cuenta como uso." },
  { t: "Turnos en cola", d: "desktop.maxConcurrentTurns (2 por defecto) con cola FIFO; cancelar en cola ni siquiera llama al modelo." },
  { t: "Checkpoints", d: "Tras cada tool y cada 60 s; al reabrir, un turno que se quedó a medias aparece como interrumpido." }
];

/* ═══ Utilidades ═══════════════════════════════════════════════════════════ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n).toLocaleString("es-ES");
const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

function relTime(date) {
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return "hace un momento";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return `hace ${d} d`;
  return new Date(date).toLocaleDateString("es-ES");
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* modo privado o almacenamiento bloqueado: solo se pierde la preferencia */ }
  return null;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

function commitType(subject = "") {
  const m = subject.match(/^([a-z]+)(\(([^)]+)\))?!?:\s*(.*)$/i);
  return m ? { type: m[1].toLowerCase(), scope: m[3] || "", rest: m[4] } : { type: "other", scope: "", rest: subject };
}

function asciiBar(ratio, width) {
  const full = Math.max(0, Math.min(width, ratio * width));
  const whole = Math.floor(full);
  const parts = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const frac = parts[Math.round((full - whole) * 7)] || "";
  return "█".repeat(whole) + frac;
}

/* ═══ Logo ASCII (ANSI Shadow) ═════════════════════════════════════════════ */

const GLYPHS = {
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"]
};

// El logo se dibuja como SVG a partir de la rejilla de glifos: con texto, cada █
// deja juntas de subpíxel entre caracteres y el logo se ve rayado.
const LOGO_CELL = { w: 10, h: 17 };
const LOGO_LINKS = { "═": "lr", "║": "ud", "╗": "ld", "╔": "rd", "╝": "lu", "╚": "ru" };

function renderLogo() {
  const rows = [0, 1, 2, 3, 4, 5].map((i) => [..."STRATUM"].map((c) => GLYPHS[c][i]).join(""));
  const { w, h } = LOGO_CELL;
  const blocks = [];
  const lines = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const x0 = x * w;
      const y0 = y * h;
      if (ch === "█") {
        blocks.push(`M${x0} ${y0}h${w}v${h}h${-w}z`);
        return;
      }
      const links = LOGO_LINKS[ch];
      if (!links) return;
      // Línea doble: dos trazos paralelos desde el centro de la celda hacia cada lado enlazado
      const cx = x0 + w / 2;
      const cy = y0 + h / 2;
      const ox = w * 0.18;
      const oy = h * 0.12;
      for (const dir of links) {
        for (const s of [-1, 1]) {
          if (dir === "l") lines.push(`M${x0} ${cy + s * oy}H${cx + ox}`);
          if (dir === "r") lines.push(`M${cx - ox} ${cy + s * oy}H${x0 + w}`);
          if (dir === "u") lines.push(`M${cx + s * ox} ${y0}V${cy + oy}`);
          if (dir === "d") lines.push(`M${cx + s * ox} ${cy - oy}V${y0 + h}`);
        }
      }
    });
  });
  const W = rows[0].length * w;
  const H = rows.length * h;
  const logo = $("#logo");
  logo.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="STRATUM" preserveAspectRatio="xMinYMin meet">
    <path class="logo-shade" d="${lines.join("")}" fill="none" stroke-width="1.1" />
    <path class="logo-block" d="${blocks.join("")}" shape-rendering="crispEdges" />
  </svg>`;
  if (!REDUCED) logo.classList.add("draw");
}

/* ═══ Arranque del hero ════════════════════════════════════════════════════ */

async function bootSequence(state) {
  const boot = $("#boot");
  const add = (html, cls = "") => {
    const d = document.createElement("div");
    d.className = `boot-line ${cls}`;
    d.innerHTML = html;
    boot.appendChild(d);
    return d;
  };
  const steps = [
    [260, `<span class="dim">added 1 package in 3s</span>`],
    [220, `<span class="p">❯</span>stratum --version`],
    [180, () => `<span class="ok">${esc(state.version)}</span>`],
    [260, `<span class="p">❯</span>stratum run "¿qué ha cambiado esta semana?" --deny-destructive`],
    [360, `<span class="ok">✓</span> <b>exec</b> <span class="dim">│ 0.2s │ git log --since="1 week"</span>`],
    [300, () => {
      const last = state.commits[0];
      const what = last ? ` El último, ${relTime(last.date)}: «${esc(commitType(last.subject).rest)}».` : "";
      return `<span class="muted">${state.weekCommits} commits esta semana.${what}</span><span class="caret"></span>`;
    }]
  ];
  if (REDUCED) {
    steps.forEach(([, h]) => add(typeof h === "function" ? h() : h));
    return;
  }
  for (const [ms, h] of steps) {
    await sleep(ms);
    boot.querySelectorAll(".caret").forEach((c) => c.remove());
    add(typeof h === "function" ? h() : h);
  }
}

/* ═══ Datos: snapshot + red ════════════════════════════════════════════════ */

const state = {
  commits: [],
  tags: [],
  prs: [],
  version: "0.4.0",
  live: false,
  liveNew: 0,
  weekCommits: 0,
  generatedAt: null
};

function loadSnapshot() {
  const snap = window.__STRATUM_COMMITS__ || {};
  state.commits = (snap.commits || []).map((c) => ({ ...c }));
  state.tags = snap.tags || [];
  state.prs = snap.prs || [];
  state.generatedAt = snap.generatedAt;
  const last = state.tags.find((t) => /^v\d+\.\d+\.\d+$/.test(t.name));
  if (last) state.version = last.name.slice(1);
  computeDerived();
}

function computeDerived() {
  const week = Date.now() - 7 * 864e5;
  state.weekCommits = state.commits.filter((c) => new Date(c.date).getTime() >= week).length;
}

async function fetchJson(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function loadLive() {
  const known = new Set(state.commits.map((c) => c.sha));
  const [gh, npm] = await Promise.allSettled([
    fetchJson(`https://api.github.com/repos/${REPO}/commits?per_page=50`),
    fetchJson(`https://registry.npmjs.org/${NPM_PKG}/latest`)
  ]);
  let changed = false;
  if (gh.status === "fulfilled" && Array.isArray(gh.value)) {
    state.live = true;
    const fresh = gh.value
      .filter((c) => !known.has(c.sha))
      .map((c) => ({
        sha: c.sha,
        date: c.commit.author.date,
        author: c.commit.author.name,
        subject: c.commit.message.split("\n")[0],
        add: null, del: null, files: null,
        fresh: true
      }));
    if (fresh.length) {
      state.commits = [...fresh, ...state.commits].sort((a, b) => new Date(b.date) - new Date(a.date));
      state.liveNew = fresh.length;
      changed = true;
    }
  }
  if (npm.status === "fulfilled" && npm.value?.version) {
    state.version = npm.value.version;
    $("#k-version-src").textContent = "registry.npmjs.org";
    changed = true;
  }
  $("#k-version").textContent = state.version;
  $("#hero-version").textContent = state.version;
  const src = $("#source-line");
  if (state.live) {
    src.classList.add("live");
    src.innerHTML = `<span class="dot"></span> en vivo · api.github.com${state.liveNew ? ` · ${state.liveNew} commit(s) más recientes que el snapshot` : " · el snapshot está al día"}`;
  } else {
    src.innerHTML = `<span class="dot"></span> sin conexión con GitHub · snapshot del ${new Date(state.generatedAt).toLocaleString("es-ES")}`;
  }
  if (changed) {
    computeDerived();
    renderActivity();
    renderKpis();
  }
}

/* ═══ KPIs ═════════════════════════════════════════════════════════════════ */

function countUp(el, to, prefix = "") {
  if (REDUCED || !to) { el.textContent = prefix + fmt(to); return; }
  const start = performance.now();
  const dur = 900;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    el.textContent = prefix + fmt(Math.round(to * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderKpis() {
  const c = state.commits;
  const d30 = Date.now() - 30 * 864e5;
  countUp($("#k-commits"), c.length);
  $("#k-commits-30").textContent = `${c.filter((x) => new Date(x.date).getTime() >= d30).length} en 30 días`;
  countUp($("#k-add"), c.reduce((a, x) => a + (x.add || 0), 0), "+");
  $("#k-del").textContent = "−" + fmt(c.reduce((a, x) => a + (x.del || 0), 0));
  const days = Math.floor((Date.now() - new Date(PROJECT_START).getTime()) / 864e5);
  countUp($("#k-days"), days);
  updateLastCommit();
}

function updateLastCommit() {
  const last = state.commits[0];
  if (!last) return;
  $("#k-last").textContent = relTime(last.date);
  $("#k-last-sha").innerHTML = `<a href="https://github.com/${REPO}/commit/${last.sha}" target="_blank" rel="noreferrer">${last.sha.slice(0, 7)}</a> · ${esc(commitType(last.subject).type)}`;
}

/* ═══ Actividad ════════════════════════════════════════════════════════════ */

let commitLimit = 15;

function renderActivity() {
  renderHeatmap();
  renderTypeBars();
  renderMonthBars();
  renderCommits();
}

function renderHeatmap() {
  const byDay = new Map();
  state.commits.forEach((c) => byDay.set(dayKey(c.date), (byDay.get(dayKey(c.date)) || 0) + 1));
  const start = new Date(PROJECT_START + "T00:00:00");
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // lunes de esa semana
  const end = new Date();
  const max = Math.max(1, ...byDay.values());
  const cells = [];
  const first = new Date(PROJECT_START + "T00:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d);
    const n = byDay.get(k) || 0;
    if (d < first) { cells.push(`<i class="out"></i>`); continue; }
    const lvl = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
    cells.push(`<i class="l${lvl}" data-tip="${k} · ${n} commit${n === 1 ? "" : "s"}" title="${k} · ${n} commit${n === 1 ? "" : "s"}"></i>`);
  }
  $("#heat").innerHTML = cells.join("");
  $("#heat-range").textContent = `${PROJECT_START} → hoy · ${byDay.size} días activos`;
}

function renderBars(root, rows, width = 26) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  root.innerHTML = rows
    .map((r) => `<div class="bar-row"><span class="lbl">${esc(r.label)}</span><span class="fill">${asciiBar(r.n / max, width)}</span><span class="n">${esc(r.extra ?? fmt(r.n))}</span></div>`)
    .join("");
}

function renderTypeBars() {
  const m = new Map();
  state.commits.forEach((c) => {
    const t = commitType(c.subject).type;
    m.set(t, (m.get(t) || 0) + 1);
  });
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, n]) => ({ label, n }));
  renderBars($("#type-bars"), rows);
}

function renderMonthBars() {
  const m = new Map();
  state.commits.forEach((c) => {
    const k = dayKey(c.date).slice(0, 7);
    const e = m.get(k) || { n: 0, add: 0 };
    e.n += 1;
    e.add += c.add || 0;
    m.set(k, e);
  });
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const rows = [...m.entries()].sort().map(([k, e]) => ({
    label: `${names[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}`,
    n: e.n,
    extra: `${e.n} · +${fmt(e.add)}`
  }));
  renderBars($("#month-bars"), rows, 20);
}

function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
  return safe.replace(re, "<mark>$1</mark>");
}

function renderCommits() {
  const q = $("#commit-filter").value.trim();
  const list = q ? state.commits.filter((c) => c.subject.toLowerCase().includes(q.toLowerCase()) || c.sha.startsWith(q)) : state.commits;
  const shown = list.slice(0, commitLimit);
  $("#commits").innerHTML = shown.length
    ? shown.map((c) => {
        const t = commitType(c.subject);
        const subj = t.type === "other"
          ? highlight(c.subject, q)
          : `<span class="type">${esc(t.type)}</span>${t.scope ? `(<span class="scope">${esc(t.scope)}</span>)` : ""}: ${highlight(t.rest, q)}`;
        const ls = c.add == null ? `<span class="dim">api</span>` : `<span class="add">+${fmt(c.add)}</span> <span class="del">−${fmt(c.del)}</span>`;
        return `<li>
          <a class="sha" href="https://github.com/${REPO}/commit/${c.sha}" target="_blank" rel="noreferrer">${c.sha.slice(0, 7)}</a>
          <span class="when" title="${esc(new Date(c.date).toLocaleString("es-ES"))}">${relTime(c.date)}</span>
          <span class="subj">${subj}${c.fresh ? `<span class="new-badge">nuevo</span>` : ""}</span>
          <span class="ls">${ls}</span>
        </li>`;
      }).join("")
    : `<li><span class="dim">grep: sin coincidencias para «${esc(q)}»</span></li>`;
  $("#commits-more").hidden = list.length <= commitLimit;
  $("#commits-more").textContent = `-- más (${list.length - commitLimit}) --`;
}

/* ═══ Hitos ════════════════════════════════════════════════════════════════ */

const STATUS_LABEL = { done: "hecho", current: "actual", wip: "implementado · en verificación", next: "pendiente" };

function renderMilestones() {
  const cliDone = MILESTONES.filter((m) => m.track === "cli" && (m.status === "done" || m.status === "current")).length;
  const cliTotal = MILESTONES.filter((m) => m.track === "cli").length;
  // D6–D8 agrupa tres hitos
  const deskDone = MILESTONES.filter((m) => m.track === "desktop" && m.status !== "next").length;
  const deskTotal = 9;
  const barW = window.innerWidth < 640 ? 18 : 40;
  const bar = (a, b) => `${asciiBar(a / b, barW)}<span class="rest">${"░".repeat(Math.max(0, barW - Math.ceil((a / b) * barW)))}</span>`;
  $("#bar-cli").innerHTML = bar(cliDone, cliTotal);
  $("#num-cli").textContent = `${cliDone}/${cliTotal} hitos`;
  $("#bar-desktop").innerHTML = bar(deskDone, deskTotal);
  $("#num-desktop").textContent = `${deskDone}/${deskTotal} (D0–D8)`;

  const ordered = [...MILESTONES].reverse();
  $("#graph").innerHTML = ordered
    .map((m) => `<li class="${m.status} ${m.track}" data-track="${m.track}" data-status="${m.status}">
      <span class="rail"><span class="node"></span></span>
      <details ${m.status === "current" ? "open" : ""}>
        <summary>
          <span class="h-id">${esc(m.id)}</span>
          <span class="h-title">${esc(m.title)}</span>
          <span class="h-tag ${m.status}">${m.status === "next" ? esc(m.date) : STATUS_LABEL[m.status]}</span>
          ${m.release ? `<span class="h-tag current">${esc(m.release)}</span>` : ""}
          ${m.status === "next" ? "" : `<span class="h-date">${esc(m.date)}</span>`}
        </summary>
        <div class="h-body"><ul>${m.body.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>
      </details>
    </li>`)
    .join("");

  $$("#hito-filters .chip").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#hito-filters .chip").forEach((x) => x.classList.toggle("on", x === b));
      filterMilestones(b.dataset.f);
    })
  );
}

function filterMilestones(f) {
  $$("#graph li").forEach((li) => {
    const ok = f === "all" || (f === "next" ? li.dataset.status === "next" : li.dataset.track === f);
    li.classList.toggle("hidden", !ok);
  });
}

/* ═══ Novedades, PRs, roadmap, desktop ═════════════════════════════════════ */

function renderNews() {
  const rels = state.tags.filter((t) => !t.name.includes("beta"));
  $("#releases").innerHTML = rels
    .map((t, i) => `<span class="rel ${i === 0 ? "latest" : ""}"><b>${esc(t.name)}</b><span class="dim">${esc(t.date.slice(0, 10))}</span>${i === 0 ? `<span class="ok">latest</span>` : ""}</span>`)
    .join("");

  $("#news").innerHTML = NEWS.map((n) => {
    const hits = state.commits.filter((c) => c.subject.includes(n.id.replace("H", "Hito ")) || (n.id === "D0–D4" && /\(desktop\)/.test(c.subject)));
    const add = hits.reduce((a, c) => a + (c.add || 0), 0);
    return `<article class="news-card reveal">
      <header><span class="h-id">${esc(n.id)}</span><span>${esc(n.date)}</span></header>
      <h4>${esc(n.title)}</h4>
      <p>${esc(n.text)}</p>
      <pre class="pre">${esc(n.pre)}</pre>
      ${hits.length ? `<div class="stats">${hits.length} commit${hits.length > 1 ? "s" : ""} · <span class="add">+${fmt(add)}</span> líneas</div>` : ""}
    </article>`;
  }).join("");

  const prs = state.prs.length ? state.prs : [];
  $("#prs").innerHTML = prs.length
    ? prs.map((p) => {
        const det = PR_DETAILS[p.number];
        return `<article class="pr">
          <div class="pr-head">
            <a class="pr-num" href="${esc(p.url)}" target="_blank" rel="noreferrer">#${p.number}</a>
            <span class="pr-state">${esc(p.state.toLowerCase())}</span>
            <span class="pr-title">${esc(p.title)}</span>
          </div>
          <div class="pr-meta">${esc(p.headRefName)} → main · ${relTime(p.mergedAt || p.createdAt)} · <span class="add">+${fmt(p.additions)}</span> <span class="del">−${fmt(p.deletions)}</span></div>
          ${det ? `<ul>${det.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          <table><thead><tr>${det.table[0].map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${det.table.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
        </article>`;
      }).join("")
    : `<p class="dim">Sin PRs en el snapshot. Ejecuta refresh-commits.ps1 con gh autenticado.</p>`;
}

function renderRoadmap() {
  $("#roadmap-list").innerHTML = ROADMAP.map((r) => `<article class="road ${r.key ? "key" : ""} reveal">
    <header><span class="h-id">${esc(r.id)}</span><span class="dim">${r.key ? "★ clave" : "pendiente"}</span></header>
    <h4>${esc(r.title)}</h4><p>${esc(r.text)}</p><p class="why">${esc(r.why)}</p>
  </article>`).join("");
  $("#desk-grid").innerHTML = DESK_CARDS.map((c) => `<div class="desk-card reveal"><h4>${esc(c.t)}</h4><p>${esc(c.d)}</p></div>`).join("");
}

/* ═══ Demo interactiva ═════════════════════════════════════════════════════ */

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const planHtml = (st, done) => {
  const icon = { todo: `<span class="dim">○</span>`, run: `<span class="run">◐</span>`, ok: `<span class="ok">✓</span>` };
  const steps = [
    "Sustituir console.log por getLogger('cli') en run.ts y chat.ts",
    "Mismo cambio en memory.ts, sessions.ts y config.ts",
    "Exponer --log-level en los comandos que aún no lo tienen",
    "Ejecutar npm test y corregir lo que rompa"
  ];
  return `<div class="box accent"><span class="box-title">Plan · ${done}/4</span>\n${steps.map((s, i) => `${icon[st[i]]} ${i + 1}  ${esc(s)}`).join("\n")}</div>`;
};

const treeHtml = (a, b, final) => `<div class="box"><span class="box-title">Subagentes · ${final ? "2/2 completados" : "en curso"}</span>
${a}
${b}${final ? `\n<span class="dim">──────────────────────────────────────</span>\n<span class="dim">2 subagentes · 14.2k tokens · 6.4s</span>` : ""}</div>`;

const todoHtml = (s, n) => {
  const i = { o: `<span class="dim">○</span>`, r: `<span class="run">◐</span>`, k: `<span class="ok">✓</span>` };
  const t = ["Test de --json en sessions list", "Serializar SessionSummary", "Flag --json en el comando", "Documentar en --help"];
  return `<div class="box"><span class="box-title">Tareas · ${n}/4</span>\n${t.map((x, k) => `${i[s[k]]} ${esc(x)}`).join("\n")}</div>`;
};

const qHtml = (idx, sel, opts, title, n) => `<div class="box accent"><span class="box-title">? ${esc(title)}</span>  <span class="dim">${n}/2</span>
${opts.map((o, k) => (k === sel ? `<span class="sel">❯ ${esc(o)}</span>` : `  ${esc(o)}`)).join("\n")}
<span class="dim">↑↓ elegir · Enter confirmar · Esc omitir</span></div>`;

const tool = (name, meta, extra = "") => ({ tool: { name, meta, extra } });

const SCENARIOS = {
  plan: {
    label: "plan & execute",
    steps: [
      { you: "/plan migra el logger de console.log a src/logging en los comandos" },
      { mode: `<span class="badge plan">◑ PLAN</span>` },
      { bot: true },
      tool("glob", "src/cli/commands/**/*.ts", "14 ficheros"),
      tool("grep", "console\\.log", "23 coincidencias · 6 ficheros"),
      tool("read_file", "src/logging/index.ts", "118 líneas"),
      { id: "plan", html: planHtml(["todo", "todo", "todo", "todo"], 0), d: 300 },
      { line: `<span class="dim">[Enter] aprobar  [d] detalle  [n] rechazar  [A] aprobar todo</span>`, id: "gate" },
      { wait: 1400 },
      { upd: "gate", html: `<span class="ok">✓ plan aprobado</span> <span class="dim">— pasando a ejecución</span>` },
      { mode: `<span class="badge exec">▸ EXEC</span>` },
      { upd: "plan", html: planHtml(["run", "todo", "todo", "todo"], 0) },
      tool("edit_file", "src/cli/commands/run.ts", "+12 −9"),
      tool("edit_file", "src/cli/commands/chat.ts", "+8 −6"),
      { upd: "plan", html: planHtml(["ok", "run", "todo", "todo"], 1) },
      tool("edit_file", "src/cli/commands/memory.ts", "+5 −4"),
      { upd: "plan", html: planHtml(["ok", "ok", "run", "todo"], 2) },
      tool("edit_file", "src/cli/index.ts", "+3 −0"),
      { upd: "plan", html: planHtml(["ok", "ok", "ok", "run"], 3) },
      tool("exec", "npm test", "848 passed · 41.2s"),
      { upd: "plan", html: planHtml(["ok", "ok", "ok", "ok"], 4) },
      { stream: "Hecho: 23 console.log migrados a getLogger en 6 ficheros y --log-level disponible en todos los comandos. Los 848 tests siguen en verde." },
      { tokens: "18.4k", ctx: "31%" }
    ]
  },
  agents: {
    label: "subagentes",
    steps: [
      { you: "investiga por qué risk.ts cuenta mal los renombrados y arréglalo con un test" },
      { bot: true },
      { stream: "Lo reparto: un subagente investiga y otro prepara el test de regresión en paralelo." },
      { id: "tree", html: treeHtml(`<span class="run">◆</span> research#1 <span class="warn">▶</span> <span class="run">running</span>  <span class="dim">grep "=>" src/agent/risk.ts</span>`, `<span class="dim">◆ tdd#2        queued</span>`) },
      { wait: 1100 },
      { upd: "tree", html: treeHtml(`<span class="run">◆</span> research#1   <span class="run">running</span>  <span class="dim">read_file src/agent/risk.ts</span>`, `<span class="run">◆</span> tdd#2      <span class="warn">▶</span> <span class="run">running</span>  <span class="dim">exec npm test -- risk</span>`) },
      { wait: 1300 },
      { upd: "tree", html: treeHtml(`<span class="ok">✓</span> research#1   <span class="ok">completed</span> <span class="dim">3.1s · "a/{b => c}.ts no se expande"</span>`, `<span class="run">◆</span> tdd#2      <span class="warn">▶</span> <span class="run">running</span>  <span class="dim">test_evidence RED ✓</span>`) },
      { wait: 1200 },
      { upd: "tree", html: treeHtml(`<span class="ok">✓</span> research#1   <span class="ok">completed</span> <span class="dim">3.1s · "a/{b => c}.ts no se expande"</span>`, `<span class="ok">✓</span> tdd#2        <span class="ok">completed</span> <span class="dim">6.4s · test en rojo listo</span>`, true) },
      tool("edit_file", "src/agent/risk.ts", "+9 −2"),
      tool("exec", "npm test -- risk", "24 passed"),
      { stream: "parseNumstat no expandía la sintaxis de renombrado con llaves. Corregido; el test del subagente pasa de rojo a verde." },
      { tokens: "14.2k", ctx: "22%" }
    ]
  },
  exec: {
    label: "exec + ssh",
    steps: [
      { you: "mira cuánto disco queda en prod-db y limpia los logs viejos" },
      { bot: true },
      tool("exec", `<span class="run">⌗ prod-db</span> df -h /var`, "0.8s"),
      { line: `<span class="dim">Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1    50G   46G  4.0G  92% /var</span>` },
      tool("exec", `<span class="run">⌗ prod-db</span> find /var/log -name '*.gz' -mtime +30 | wc -l`, "1.1s → 312"),
      { line: `<div class="box accent"><span class="warn">⚠ confirmación requerida</span> <span class="dim">· ssh:prod-db tiene confirmAll</span>\n  find /var/log -name '*.gz' -mtime +30 -delete\n<span class="dim">[y] aprobar  [n] denegar  [!] permitir todo en la sesión</span></div>`, id: "conf" },
      { wait: 1500 },
      { upd: "conf", html: `<span class="ok">✓ aprobado</span> <span class="dim">· find /var/log -name '*.gz' -mtime +30 -delete</span>` },
      tool("exec", `<span class="run">⌗ prod-db</span> df -h /var`, "0.7s → 86%"),
      { stream: "Borrados 312 logs comprimidos de más de 30 días: /var pasa del 92 % al 86 %." },
      { you: "ya puestos, rm -rf / en el bastión para empezar de cero" },
      { bot: true },
      { tool: { name: "exec", meta: `<span class="run">⌗ bastion</span> rm -rf /`, fail: "vetado · capa 1 hard-deny" } },
      { line: `<span class="dim">  el veto es inapelable: ni --allow-destructive ni el allow-all de sesión lo levantan</span>` },
      { stream: "No lo voy a ejecutar, y aunque quisiera no podría. Si quieres reconstruir el bastión, preparo un plan con /plan." },
      { tokens: "6.1k", ctx: "9%" }
    ]
  },
  redact: {
    label: "redacción",
    steps: [
      { you: "comprueba que el deploy lee bien las credenciales de staging" },
      { bot: true },
      { line: `<div class="box accent"><span class="warn">⚠ ruta sensible</span> <span class="dim">· nivel confirm</span>\n  exec cat deploy/.env.staging\n<span class="dim">[y] aprobar  [n] denegar</span></div>`, id: "c1" },
      { wait: 1300 },
      { upd: "c1", html: `<span class="ok">✓ aprobado</span> <span class="dim">· cat deploy/.env.staging</span>` },
      tool("exec", "cat deploy/.env.staging", "0.1s"),
      { line: `<span class="dim">DATABASE_URL=postgres://app@db.staging:5432/app\nOPENAI_API_KEY=</span><span class="warn">[redacted: API key]</span><span class="dim">\nGITHUB_TOKEN=</span><span class="warn">[redacted: GitHub token]</span><span class="dim">\nLOG_LEVEL=info</span>` },
      { tool: { name: "read_file", meta: "~/.ssh/id_ed25519", fail: "vetado · ruta sensible (blocked)" } },
      { stream: "Las cuatro variables existen y tienen valor. Los secretos se sustituyeron antes de llegar a mí, al log y a la auditoría; la clave SSH ni siquiera se puede leer." },
      { tokens: "3.9k", ctx: "6%" }
    ]
  },
  tdd: {
    label: "todo + tdd",
    steps: [
      { you: "añade --json a stratum sessions list" },
      { bot: true },
      { id: "todo", html: todoHtml("rooo", 0) },
      tool("exec", "npm test -- sessions", "SAFETY NET · 31 passed"),
      { tool: { name: "test_evidence", meta: "GREEN", fail: "GREEN sin RED previo (recuperable)" } },
      tool("edit_file", "src/cli/commands/sessions.test.ts", "+22 −0"),
      { tool: { name: "exec", meta: "npm test -- sessions", fail: "1 failed · exit 1", soft: true } },
      tool("test_evidence", "RED", "falla por el motivo esperado"),
      { upd: "todo", html: todoHtml("kroo", 1) },
      tool("edit_file", "src/cli/commands/sessions.ts", "+14 −3"),
      { upd: "todo", html: todoHtml("kkro", 2) },
      tool("exec", "npm test -- sessions", "32 passed"),
      tool("test_evidence", "GREEN", "ciclo cerrado"),
      { upd: "todo", html: todoHtml("kkkk", 4) },
      { stream: "Listo: stratum sessions list --json devuelve un array con id, título, fecha y número de mensajes." },
      { tokens: "9.7k", ctx: "14%" }
    ]
  },
  question: {
    label: "question",
    steps: [
      { you: "prepara la release" },
      { bot: true },
      tool("exec", "git log v0.4.0..HEAD --oneline", "13 commits"),
      { id: "q", html: qHtml(0, 0, ["patch  (0.4.1)", "minor  (0.5.0)", "major  (1.0.0)"], "¿Qué tipo de release?", 1) },
      { wait: 700 },
      { upd: "q", html: qHtml(0, 1, ["patch  (0.4.1)", "minor  (0.5.0)", "major  (1.0.0)"], "¿Qué tipo de release?", 1) },
      { wait: 700 },
      { upd: "q", html: qHtml(1, 0, ["Sí, publicar", "No, solo el tag"], "¿Publicar en npm ahora?", 2) },
      { wait: 700 },
      { upd: "q", html: qHtml(1, 1, ["Sí, publicar", "No, solo el tag"], "¿Publicar en npm ahora?", 2) },
      { wait: 600 },
      { upd: "q", html: `<span class="ok">✓</span> <span class="dim">respuestas:</span> minor · solo el tag` },
      tool("exec", "npm version minor --no-git-tag-version", "0.5.0"),
      tool("edit_file", "CHANGELOG.md", "+18 −0"),
      { stream: "Preparada la 0.5.0 con el changelog. No publico en npm: cuando quieras, git tag v0.5.0 && git push --tags dispara el workflow." },
      { tokens: "5.2k", ctx: "8%" }
    ]
  }
};

const demo = {
  body: null,
  run: 0,
  paused: false,
  auto: true,
  current: "plan",
  visible: false,
  started: false,
  history: [],
  hIdx: -1
};

function termAppend(html, cls = "ln", id) {
  const d = document.createElement("div");
  d.className = cls;
  if (id) d.dataset.id = id;
  d.innerHTML = html;
  demo.body.appendChild(d);
  demo.body.scrollTop = demo.body.scrollHeight;
  return d;
}

async function waitFor(ms, run) {
  const end = performance.now() + ms;
  while (performance.now() < end || demo.paused) {
    if (run !== demo.run) throw new Error("cancelled");
    await sleep(Math.min(60, Math.max(10, end - performance.now())));
  }
  if (run !== demo.run) throw new Error("cancelled");
}

async function playScenario(name) {
  const sc = SCENARIOS[name];
  if (!sc) return;
  const run = ++demo.run;
  demo.current = name;
  $$("#scenario-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.s === name)));
  demo.body.innerHTML = "";
  $("#sb-mode").innerHTML = "";
  $("#sb-tokens").textContent = "0";
  $("#sb-ctx").textContent = "4%";
  const speed = REDUCED ? 0 : 1;
  try {
    for (const st of sc.steps) {
      if (st.you) {
        termAppend("You", "ln you");
        const ln = termAppend("");
        if (speed) {
          for (let i = 1; i <= st.you.length; i++) {
            ln.textContent = st.you.slice(0, i);
            await waitFor(18, run);
          }
        } else ln.textContent = st.you;
        await waitFor(350 * speed, run);
      } else if (st.bot) {
        termAppend("Stratum", "ln bot");
        await waitFor(250 * speed, run);
      } else if (st.mode !== undefined) {
        $("#sb-mode").innerHTML = st.mode;
      } else if (st.tool) {
        const t = st.tool;
        const ln = termAppend("", "ln tool");
        const dur = 500 + Math.random() * 500;
        const t0 = performance.now();
        let f = 0;
        while (speed && performance.now() - t0 < dur) {
          ln.innerHTML = `<span class="run">${SPIN[f++ % SPIN.length]}</span> <span class="name">${t.name}</span> <span class="meta">│ ${t.meta}</span>`;
          await waitFor(80, run);
        }
        const secs = (dur / 1000).toFixed(1);
        ln.innerHTML = t.fail
          ? `<span class="${t.soft ? "warn" : "err"}">✗</span> <span class="name">${t.name}</span> <span class="meta">│ ${t.meta} │</span> <span class="${t.soft ? "warn" : "err"}">${esc(t.fail)}</span>`
          : `<span class="ok">✓</span> <span class="name">${t.name}</span> <span class="meta">│ ${secs}s │ ${t.meta}${t.extra ? ` │ ${esc(t.extra)}` : ""}</span>`;
        await waitFor(120 * speed, run);
      } else if (st.upd) {
        const el = demo.body.querySelector(`[data-id="${st.upd}"]`);
        if (el) el.innerHTML = st.html;
        demo.body.scrollTop = demo.body.scrollHeight;
        await waitFor(250 * speed, run);
      } else if (st.html || st.line) {
        termAppend(st.html || st.line, "ln", st.id);
        await waitFor((st.d ?? 250) * speed, run);
      } else if (st.stream) {
        const ln = termAppend("");
        const words = st.stream.split(" ");
        for (let i = 1; i <= words.length; i++) {
          ln.innerHTML = esc(words.slice(0, i).join(" ")) + (i < words.length && speed ? `<span class="caret"></span>` : "");
          if (speed) await waitFor(40, run);
        }
        demo.body.scrollTop = demo.body.scrollHeight;
      } else if (st.wait) {
        await waitFor(st.wait * speed, run);
      } else if (st.tokens) {
        $("#sb-tokens").textContent = st.tokens;
        $("#sb-ctx").textContent = st.ctx;
      }
    }
    if (demo.auto) {
      await waitFor(4500, run);
      const keys = Object.keys(SCENARIOS);
      playScenario(keys[(keys.indexOf(name) + 1) % keys.length]);
    }
  } catch {
    /* escenario sustituido por otro */
  }
}

/* Comandos del prompt de la demo */
const COMMANDS = {
  help: () => `<span class="box-title">comandos de esta demo</span>
  <span class="p">demo</span> &lt;${Object.keys(SCENARIOS).join("|")}&gt;   reproducir un escenario
  <span class="p">hitos</span> [cli|desktop|next]      hitos del proyecto
  <span class="p">status</span>                        estado del repositorio
  <span class="p">log</span> [n]                       últimos commits
  <span class="p">grep</span> &lt;texto&gt;                  buscar en los commits
  <span class="p">roadmap</span>                       lo que viene
  <span class="p">install</span>                       cómo instalarlo
  <span class="p">theme</span> · <span class="p">crt</span> · <span class="p">clear</span> · <span class="p">whoami</span>
<span class="dim">prueba también algo destructivo: las guardas funcionan igual que en la CLI.</span>`,
  status: () => {
    const c = state.commits;
    return `versión    <span class="ok">${esc(state.version)}</span>
hito       16 ✓ ejecución unificada · siguiente: 17
commits    ${fmt(c.length)} <span class="dim">(${state.weekCommits} esta semana)</span>
líneas     <span class="add">+${fmt(c.reduce((a, x) => a + (x.add || 0), 0))}</span> <span class="del">−${fmt(c.reduce((a, x) => a + (x.del || 0), 0))}</span>
tests      848 ✓
desktop    D4 <span class="dim">(D0–D8)</span>
fuente     ${state.live ? `<span class="ok">● api.github.com</span>` : `<span class="dim">● snapshot</span>`}`;
  },
  hitos: (arg) => {
    const list = MILESTONES.filter((m) => !arg || (arg === "next" ? m.status === "next" : m.track === arg));
    if (!list.length) return `<span class="err">hitos: filtro desconocido «${esc(arg)}»</span> <span class="dim">(cli|desktop|next)</span>`;
    const ic = { done: `<span class="ok">✓</span>`, current: `<span class="warn">◆</span>`, wip: `<span class="run">◐</span>`, next: `<span class="dim">○</span>` };
    return list.map((m) => `${ic[m.status]} <span class="h-id">${esc(m.id.padEnd(7))}</span>${esc(m.title)} <span class="dim">${esc(m.date)}</span>`).join("\n");
  },
  log: (arg) => {
    const n = Math.min(30, Math.max(1, parseInt(arg, 10) || 8));
    return state.commits.slice(0, n).map((c) => `<span class="p">${c.sha.slice(0, 7)}</span> ${esc(c.subject)} <span class="dim">${relTime(c.date)}</span>`).join("\n");
  },
  grep: (arg) => {
    if (!arg) return `<span class="err">uso: grep &lt;texto&gt;</span>`;
    const hits = state.commits.filter((c) => c.subject.toLowerCase().includes(arg.toLowerCase()));
    if (!hits.length) return `<span class="dim">sin coincidencias (exit 1)</span>`;
    return hits.slice(0, 12).map((c) => `<span class="p">${c.sha.slice(0, 7)}</span> ${highlight(c.subject, arg)}`).join("\n") + (hits.length > 12 ? `\n<span class="dim">… ${hits.length - 12} más</span>` : "");
  },
  roadmap: () => ROADMAP.map((r) => `${r.key ? `<span class="warn">★</span>` : `<span class="dim">○</span>`} <span class="h-id">${esc(r.id.padEnd(4))}</span>${esc(r.title)} <span class="dim"># ${esc(r.why)}</span>`).join("\n"),
  install: () => `<span class="p">$</span> npm i -g stratum-cli
<span class="p">$</span> stratum provider add      <span class="dim"># asistente: Ollama, LiteLLM, vLLM, OpenAI…</span>
<span class="p">$</span> stratum chat
<span class="dim">requiere Node 22+</span>`,
  version: () => esc(state.version),
  whoami: () => `visitante <span class="dim">· permisos: solo lectura · destructivePolicy: deny</span>`,
  date: () => esc(new Date().toString()),
  ls: () => `STRATUM.md  stratum-cli/  stratum-desktop/  landing/  CLI-DOC/  README.md`,
  pwd: () => "/home/javi/CLI",
  theme: () => { toggleTheme(); return `tema: ${document.documentElement.dataset.theme}`; },
  crt: () => { document.documentElement.classList.toggle("no-crt"); return `crt: ${document.documentElement.classList.contains("no-crt") ? "off" : "on"}`; },
  exit: () => `<span class="dim">no puedes salir de una landing page. Pero puedes instalarlo: </span><span class="p">npm i -g stratum-cli</span>`
};

const HARD_DENY = /(^|[;&|]\s*)(sudo\s+)?(rm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\.)(\s|$)|mkfs|dd\s+.*of=\/dev|:\(\)\s*\{|chmod\s+-R\s+777|git\s+clean\s+-f)/i;

function runCommand(raw) {
  const input = raw.trim();
  if (!input) return;
  demo.auto = false;
  demo.started = true; // el autoplay ya no debe arrancar encima de lo que escriba
  demo.run++; // corta el escenario en curso
  $("#sb-mode").innerHTML = "";
  demo.history.unshift(input);
  demo.hIdx = -1;
  termAppend(`<span class="p">❯❯</span> ${esc(input)}`, "ln");
  const [cmd, ...rest] = input.replace(/^\//, "").split(/\s+/);
  const arg = rest.join(" ");
  if (cmd === "clear") { demo.body.innerHTML = ""; return; }
  if (HARD_DENY.test(input)) {
    termAppend(`<span class="err">✗</span> <span class="name">exec</span> <span class="meta">│ ${esc(input)} │</span> <span class="err">vetado · capa 1 hard-deny</span>\n<span class="dim">  inapelable: ni --allow-destructive ni el allow-all de sesión lo levantan</span>`, "ln tool");
    return;
  }
  if (/^(sudo|npm\s+publish|git\s+push\s+(-f|--force))/.test(input)) {
    termAppend(`<span class="warn">⚠</span> <span class="dim">capa 2 (tools.guardedCommands): esto pediría confirmación, y aquí la política es deny.</span>`, "ln");
    return;
  }
  if (cmd === "demo" || SCENARIOS[cmd]) {
    const name = SCENARIOS[cmd] ? cmd : arg;
    if (!SCENARIOS[name]) {
      termAppend(`<span class="err">demo: escenario desconocido «${esc(name)}»</span> <span class="dim">(${Object.keys(SCENARIOS).join(", ")})</span>`);
      return;
    }
    playScenario(name);
    return;
  }
  if (cmd === "stratum" && rest[0] === "--version") { termAppend(esc(state.version)); return; }
  const fn = COMMANDS[cmd];
  if (fn) { termAppend(fn(arg)); return; }
  termAppend(`Stratum`, "ln bot");
  termAppend(`<span class="muted">Esto es una demo estática y no hay un modelo al otro lado. Con </span><span class="p">npm i -g stratum-cli</span><span class="muted"> y tu provider (Ollama, LiteLLM…) esa pregunta tendría respuesta. Escribe </span><span class="p">help</span><span class="muted"> para ver lo que sí funciona aquí.</span>`);
}

function completions(prefix) {
  const words = [...Object.keys(COMMANDS), "demo", "clear", ...Object.keys(SCENARIOS).map((s) => `demo ${s}`), "hitos cli", "hitos desktop", "hitos next"];
  return [...new Set(words)].filter((w) => w.startsWith(prefix)).sort();
}

function initDemo() {
  demo.body = $("#term-body");
  $("#scenario-tabs").innerHTML = Object.entries(SCENARIOS)
    .map(([k, v]) => `<button type="button" role="tab" data-s="${k}" aria-selected="false">${esc(v.label)}</button>`)
    .join("");
  $$("#scenario-tabs button").forEach((b) => b.addEventListener("click", () => { demo.auto = true; playScenario(b.dataset.s); }));

  const pause = $("#demo-pause");
  pause.addEventListener("click", () => {
    demo.paused = !demo.paused;
    pause.setAttribute("aria-pressed", String(demo.paused));
    pause.textContent = demo.paused ? "▶ seguir" : "❚❚ pausa";
  });

  const input = $("#term-in");
  $("#term-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runCommand(input.value);
    input.value = "";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && demo.history.length) {
      e.preventDefault();
      demo.hIdx = Math.min(demo.history.length - 1, demo.hIdx + 1);
      input.value = demo.history[demo.hIdx];
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      demo.hIdx = Math.max(-1, demo.hIdx - 1);
      input.value = demo.hIdx < 0 ? "" : demo.history[demo.hIdx];
    } else if (e.key === "Tab" && input.value) {
      const opts = completions(input.value);
      if (opts.length === 1) { e.preventDefault(); input.value = opts[0] + " "; }
      else if (opts.length > 1) { e.preventDefault(); termAppend(`<span class="dim">${opts.map(esc).join("   ")}</span>`); }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      demo.body.innerHTML = "";
    }
  });

  // Solo arranca la reproducción automática cuando la demo entra en pantalla
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      demo.visible = en.isIntersecting;
      if (en.isIntersecting && !demo.started) {
        demo.started = true;
        playScenario("plan");
      }
    });
  }, { threshold: 0.25 });
  io.observe($("#term"));
}

/* ═══ Cabeceras tecleadas, tmux, tema, reloj ═══════════════════════════════ */

function initCommandHeaders() {
  const heads = $$(".cmd[data-cmd]");
  if (REDUCED) return;
  heads.forEach((h) => { h.textContent = ""; });
  const io = new IntersectionObserver((entries) => {
    entries.forEach(async (en) => {
      if (!en.isIntersecting || en.target.dataset.done) return;
      en.target.dataset.done = "1";
      const text = en.target.dataset.cmd;
      for (let i = 1; i <= text.length; i++) {
        en.target.innerHTML = esc(text.slice(0, i)) + `<span class="caret"></span>`;
        await sleep(22);
      }
      en.target.innerHTML = esc(text) + `<span class="caret"></span>`;
      setTimeout(() => en.target.querySelector(".caret")?.remove(), 1600);
    });
  }, { threshold: 0.6 });
  heads.forEach((h) => io.observe(h));
}

function initReveal() {
  const items = $$(".kpi, .panel, .news-card, .road, .desk-card, .shots figure, .pr, .desk");
  if (REDUCED) return;
  items.forEach((el) => el.classList.add("reveal"));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    });
  }, { threshold: 0.08 });
  items.forEach((el) => io.observe(el));
}

function initTmux() {
  const links = $$(".tmux-windows a");
  const map = new Map(links.map((a) => [a.dataset.win, a]));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        links.forEach((a) => a.classList.remove("active"));
        map.get(en.target.id)?.classList.add("active");
      }
    });
  }, { rootMargin: "-45% 0px -50% 0px" });
  ["status", "demo", "hitos", "novedades", "actividad", "desktop", "roadmap"].forEach((id) => { const s = document.getElementById(id); if (s) io.observe(s); });
}

function toggleTheme() {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
  storage("stratum-landing-theme", root.dataset.theme);
  $('meta[name="theme-color"]').setAttribute("content", root.dataset.theme === "light" ? "#f6f3ea" : "#0a0a0b");
}

function initTheme() {
  const saved = storage("stratum-landing-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  $("#theme-toggle").addEventListener("click", toggleTheme);
}

function initClock() {
  const tick = () => {
    const d = new Date();
    $("#clock").textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  tick();
  setInterval(() => { tick(); updateLastCommit(); }, 30000);
}

/* ═══ Lightbox y copiar ════════════════════════════════════════════════════ */

function initLightbox() {
  const lb = $("#lightbox");
  const img = $(".lightbox-img", lb);
  let opener = null;
  const close = () => { lb.hidden = true; img.src = ""; document.body.style.overflow = ""; opener?.focus(); };
  $$(".shot").forEach((b) =>
    b.addEventListener("click", () => {
      opener = b;
      img.src = b.dataset.full;
      img.alt = $("img", b).alt;
      lb.hidden = false;
      document.body.style.overflow = "hidden";
      $(".lightbox-close", lb).focus();
    })
  );
  lb.addEventListener("click", (e) => { if (e.target === lb || e.target === img || e.target.closest(".lightbox-close")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !lb.hidden) close(); });
}

function initCopy() {
  $$(".copy").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast("✓ copiado al portapapeles");
      } catch {
        toast("no se pudo copiar: selecciónalo a mano");
      }
    })
  );
}

/* ═══ Arranque ═════════════════════════════════════════════════════════════ */

function init() {
  initTheme();
  renderLogo();
  loadSnapshot();
  $("#k-version").textContent = state.version;
  $("#hero-version").textContent = state.version;
  if (state.generatedAt) $("#generated").textContent = `snapshot generado ${new Date(state.generatedAt).toLocaleString("es-ES")} · refresh-commits.ps1`;

  renderKpis();
  renderActivity();
  renderMilestones();
  renderNews();
  renderRoadmap();
  initDemo();
  initCommandHeaders();
  initReveal();
  initTmux();
  initClock();
  initLightbox();
  initCopy();

  $("#commit-filter").addEventListener("input", () => { commitLimit = 15; renderCommits(); });
  $("#commits-more").addEventListener("click", () => { commitLimit += 20; renderCommits(); });

  bootSequence(state);
  loadLive().catch(() => {
    $("#source-line").innerHTML = `<span class="dot"></span> sin conexión · snapshot local`;
  });
}

init();
