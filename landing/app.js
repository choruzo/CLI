const milestones = [
  { id: "Hito 0", title: "Scaffolding", status: "done", date: "2026-05-27" },
  { id: "Hito 1", title: "Core Agent Loop", status: "done", date: "2026-05-28" },
  { id: "Hito 2", title: "Memory Layer 1", status: "done", date: "2026-06-11" },
  { id: "Hito 2.5", title: "Init ReAct Explorer", status: "done", date: "2026-06-11" },
  { id: "Hito 3", title: "Tools Day 1", status: "done", date: "2026-06-11" },
  { id: "Hito 3.5", title: "Provider & Model UX", status: "done", date: "2026-06-12" },
  { id: "Hito 4", title: "MCP Client", status: "done", date: "2026-06-15" },
  { id: "Hito 4.1", title: "MCP startup lazy/eager", status: "done", date: "2026-06-16" },
  { id: "Hito 5", title: "Memory Layers 2 y 3", status: "done", date: "2026-06-16" },
  { id: "Hito 6", title: "Multi-provider Polishing", status: "done", date: "2026-06-18" },
  { id: "Hito 7", title: "Plan & Execute Mode", status: "done", date: "2026-06-19" },
  { id: "Hito 8", title: "Multi-agent Foundation", status: "current", date: "Siguiente" },
  { id: "Hito 9", title: "SSH Nativo", status: "next", date: "Planificado" }
];

const futureExecutions = [
  {
    title: "Hito 8 · Multi-agent Foundation",
    detail: "Orquestador multi-agente, coordinación de subagentes y ejecución paralela controlada.",
    eta: "~10 días"
  },
  {
    title: "Hito 9 · SSH Nativo",
    detail: "Capa SSH robusta para ejecución remota, transferencia de archivos y flujos de infraestructura.",
    eta: "~7 días"
  },
  {
    title: "Hardening de release",
    detail: "Más automatización en release pipeline, validaciones y telemetría de calidad.",
    eta: "Iterativo"
  }
];

const COLORS = {
  accent: "#ffb800",
  cyan: "#31a2ff",
  green: "#26d07c",
  muted: "#94a3c7",
  grid: "#223456"
};

function getCommitType(subject = "") {
  const match = subject.toLowerCase().match(/^([a-z]+)(\(.+\))?!?:/);
  return match?.[1] || "other";
}

function toDayKey(dateStr) {
  return new Date(dateStr).toISOString().slice(0, 10);
}

function toMonthKey(dateStr) {
  return new Date(dateStr).toISOString().slice(0, 7);
}

function renderMilestones() {
  const root = document.getElementById("milestone-list");
  root.innerHTML = milestones
    .map(
      (m) => `
      <article class="milestone-item">
        <span class="chip ${m.status}">${m.status === "done" ? "Completado" : m.status === "current" ? "Actual" : "Siguiente"}</span>
        <h3>${m.id} · ${m.title}</h3>
        <p class="meta">${m.date}</p>
      </article>`
    )
    .join("");
}

function renderFuture() {
  const root = document.getElementById("future-list");
  root.innerHTML = futureExecutions
    .map(
      (f) => `
      <article class="future-item">
        <h3>${f.title}</h3>
        <p class="meta">${f.detail}</p>
        <p><strong>ETA:</strong> ${f.eta}</p>
      </article>`
    )
    .join("");
}

function setStatusCards(commits) {
  const done = milestones.filter((m) => m.status === "done").length;
  const current = milestones.find((m) => m.status === "current");
  const now = Date.now();
  const days30 = 30 * 24 * 60 * 60 * 1000;
  const commits30d = commits.filter((c) => now - new Date(c.date).getTime() <= days30).length;

  document.getElementById("general-status").textContent = `Activo · ${done}/${milestones.length} hitos cerrados`;
  document.getElementById("current-milestone").textContent = current
    ? `${current.id} · ${current.title}`
    : "No definido";
  document.getElementById("total-commits").textContent = String(commits.length);
  document.getElementById("commits-30d").textContent = String(commits30d);
}

function renderCommitTable(commits) {
  const tbody = document.getElementById("commit-table");
  const rows = commits.slice(0, 18).map((c) => {
    const date = new Date(c.date).toLocaleDateString("es-ES");
    return `<tr>
      <td>${date}</td>
      <td><code>${c.sha.slice(0, 8)}</code></td>
      <td>${c.author}</td>
      <td>${c.subject}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join("");
}

function baseChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: COLORS.muted } }
    },
    scales: {
      x: { ticks: { color: COLORS.muted }, grid: { color: COLORS.grid } },
      y: { ticks: { color: COLORS.muted }, grid: { color: COLORS.grid } }
    }
  };
}

function renderCharts(commits) {
  const byDay = new Map();
  const byMonth = new Map();
  const byType = new Map();

  commits.forEach((c) => {
    const day = toDayKey(c.date);
    const month = toMonthKey(c.date);
    const type = getCommitType(c.subject);
    byDay.set(day, (byDay.get(day) || 0) + 1);
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
    byType.set(type, (byType.get(type) || 0) + 1);
  });

  const dayLabels = [...byDay.keys()].sort().slice(-45);
  const dayValues = dayLabels.map((k) => byDay.get(k));
  const monthLabels = [...byMonth.keys()].sort();
  const monthValues = monthLabels.map((k) => byMonth.get(k));

  const typeLabels = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([k]) => k);
  const typeValues = typeLabels.map((k) => byType.get(k));

  const roadmapSummary = [
    milestones.filter((m) => m.status === "done").length,
    milestones.filter((m) => m.status === "current").length,
    milestones.filter((m) => m.status === "next").length
  ];

  new Chart(document.getElementById("dailyChart"), {
    type: "line",
    data: {
      labels: dayLabels,
      datasets: [{ label: "Commits", data: dayValues, borderColor: COLORS.cyan, backgroundColor: "rgba(49,162,255,.15)", fill: true, tension: 0.25 }]
    },
    options: baseChartOptions()
  });

  new Chart(document.getElementById("typeChart"), {
    type: "bar",
    data: {
      labels: typeLabels,
      datasets: [{ label: "Commits", data: typeValues, backgroundColor: [COLORS.accent, COLORS.cyan, COLORS.green, "#8b7dff", "#ff7a7a", "#7dd3fc", "#fbbf24"] }]
    },
    options: baseChartOptions()
  });

  new Chart(document.getElementById("roadmapChart"), {
    type: "doughnut",
    data: {
      labels: ["Completados", "Actual", "Siguientes"],
      datasets: [{ data: roadmapSummary, backgroundColor: [COLORS.green, COLORS.cyan, COLORS.accent] }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: COLORS.muted } } }
    }
  });

  new Chart(document.getElementById("monthlyChart"), {
    type: "bar",
    data: {
      labels: monthLabels,
      datasets: [{ label: "Commits/mes", data: monthValues, backgroundColor: COLORS.accent }]
    },
    options: baseChartOptions()
  });
}

async function init() {
  renderMilestones();
  renderFuture();

  const payload = window.__STRATUM_COMMITS__ || { commits: [] };
  const commits = payload.commits || [];
  setStatusCards(commits);
  renderCommitTable(commits);
  renderCharts(commits);
}

init();
