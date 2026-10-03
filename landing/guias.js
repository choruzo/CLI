/* Stratum — página de guías. Independiente de app.js: aquí no hay demo ni datos del repo. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

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

/* ═══ Tema y reloj (misma preferencia que la landing) ══════════════════════ */

function applyThemeColor() {
  const light = document.documentElement.dataset.theme === "light";
  $('meta[name="theme-color"]').setAttribute("content", light ? "#f6f3ea" : "#0a0a0b");
}

function initTheme() {
  const root = document.documentElement;
  const saved = storage("stratum-landing-theme");
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  applyThemeColor();
  $("#theme-toggle").addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    storage("stratum-landing-theme", root.dataset.theme);
    applyThemeColor();
  });
}

function initClock() {
  const tick = () => {
    const d = new Date();
    $("#clock").textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  tick();
  setInterval(tick, 30000);
}

/* ═══ Bloques de código: botón de copiar ═══════════════════════════════════ */

function initCodeCopy() {
  $$(".code").forEach((block) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tbtn code-copy";
    btn.textContent = "⧉ copiar";
    btn.setAttribute("aria-label", "Copiar el bloque de código");
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("pre", block).textContent);
        toast("✓ copiado al portapapeles");
      } catch {
        toast("no se pudo copiar: selecciónalo a mano");
      }
    });
    block.prepend(btn);
  });
}

/* ═══ Navegación: ventana tmux e índice activos ════════════════════════════ */

function observeActive(targets, linkFor) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const link = linkFor(en.target.id);
      if (!link) return;
      $$(".active", link.closest("ul, nav")).forEach((a) => a.classList.remove("active"));
      link.classList.add("active");
    });
  }, { rootMargin: "-45% 0px -50% 0px" });
  targets.forEach((t) => io.observe(t));
}

function initNav() {
  observeActive($$(".doc-part"), (id) => $(`.tmux-windows a[data-win="${id}"]`));
  observeActive($$(".doc-sec, #problemas"), (id) => $(`.toc a[href="#${id}"]`));
}

/* ═══ Descargas de Desktop: última release `desktop-v*` ════════════════════ */

// Los enlaces del HTML apuntan a una versión concreta y funcionan sin red;
// si la API responde, se sustituyen por los de la release más reciente.
async function initDownloads() {
  const res = await fetch("https://api.github.com/repos/choruzo/CLI/releases?per_page=30");
  if (!res.ok) return;
  const release = (await res.json()).find((r) => !r.draft && /^desktop-v\d/.test(r.tag_name));
  if (!release) return;
  const version = release.tag_name.replace(/^desktop-v/, "");
  const previous = $("#desk-version").textContent;
  const asset = (suffix) => release.assets.find((a) => a.name.endsWith(suffix))?.browser_download_url;
  const links = { "#dl-exe": "-setup.exe", "#dl-msi": ".msi", "#dl-deb": ".deb", "#dl-appimage": ".AppImage" };
  for (const [sel, suffix] of Object.entries(links)) {
    const url = asset(suffix);
    if (url) $(sel).href = url;
  }
  $("#dl-all").href = release.html_url;
  $("#desk-version").textContent = version;
  // Los nombres de fichero de los ejemplos llevan la versión dentro.
  if (version !== previous) {
    $$("#desktop-instalacion pre code").forEach((c) => { c.textContent = c.textContent.replaceAll(`_${previous}_`, `_${version}_`); });
  }
}

initTheme();
initClock();
initCodeCopy();
initNav();
initDownloads().catch(() => { /* sin red o límite de la API: valen los enlaces fijos */ });
