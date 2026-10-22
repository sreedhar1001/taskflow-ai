/**
 * app.js — TaskFlow AI frontend
 *
 * Responsibilities:
 *  - Submit tasks and open SSE stream
 *  - Render + update live Mermaid diagram as steps change
 *  - Render step timeline cards
 *  - Poll circuit breaker status
 *  - Load and display run history
 */

// ─── Mermaid init ─────────────────────────────────────────────────────────────
mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  themeVariables: {
    primaryColor: "#22263a",
    primaryBorderColor: "#6c63ff",
    primaryTextColor: "#e8eaf0",
    lineColor: "#6c63ff",
    secondaryColor: "#1a1d27",
    tertiaryColor: "#0f1117",
    background: "#0f1117",
    mainBkg: "#22263a",
    edgeLabelBackground: "#1a1d27",
    fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
  },
  flowchart: { curve: "basis", htmlLabels: true },
});

// ─── State ────────────────────────────────────────────────────────────────────
let currentRunId = null;
let currentEventSource = null;
let stepMap = {}; // stepId → step object

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const taskForm     = document.getElementById("task-form");
const goalInput    = document.getElementById("goal-input");
const submitBtn    = document.getElementById("submit-btn");
const runList      = document.getElementById("run-list");
const emptyState   = document.getElementById("empty-state");
const runView      = document.getElementById("run-view");
const runGoalTitle = document.getElementById("run-goal-title");
const runMeta      = document.getElementById("run-meta");
const retryBtn     = document.getElementById("retry-btn");
const phaseBanner  = document.getElementById("phase-banner");
const phaseText    = document.getElementById("phase-text");
const progressWrap = document.getElementById("progress-wrap");
const progressBar  = document.getElementById("progress-bar");
const mermaidWrap  = document.getElementById("mermaid-wrap");
const stepListEl   = document.getElementById("step-list");
const circuitBadge = document.getElementById("circuit-badge");

// ─── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((tc) => tc.classList.remove("active"));
    tab.classList.add("active");
    const panel = document.getElementById(`tab-${tab.dataset.tab}`);
    if (panel) panel.classList.add("active");
  });
});

// ─── Architecture diagram (static, on "How It Works" tab) ────────────────────
async function renderArchDiagram() {
  const def = `flowchart TD
    U["👤 User"] -->|"Submit goal"| FE["🌐 Frontend"]
    FE -->|"POST /api/tasks"| API["⚙️ Express API"]
    API -->|"INSERT run"| DB[("🗄️ SQLite DB")]
    API -->|"201 runId"| FE
    FE -->|"GET /api/runs/:id/stream"| SSE["📡 SSE Stream"]
    SSE -->|"Live events"| FE
    API -->|"Parse goal"| GM["🤖 Gemini AI"]
    GM -->|"Steps JSON"| API
    API -->|"Execute step 1..N"| GM
    GM -->|"Step output"| API
    API -->|"Retry on fail"| RT["🔁 Retry + Circuit Breaker"]
    RT -->|"Backoff"| GM
    API -->|"UPDATE step"| DB
    API -->|"step_update event"| SSE`;

  try {
    const { svg } = await mermaid.render("arch-static", def);
    document.getElementById("arch-diagram").innerHTML = svg;
  } catch (e) {
    document.getElementById("arch-diagram").textContent = "Diagram unavailable";
  }
}

// ─── Live run diagram ─────────────────────────────────────────────────────────
function buildRunDiagram(steps) {
  if (!steps || steps.length === 0) return null;

  const statusColors = {
    queued: "#2e3250",
    running: "#6c63ff",
    completed: "#00c48c",
    failed: "#ff5370",
    retrying: "#ffb340",
  };

  const safeId = (s) => `s${s.index !== undefined ? s.index : s.index_num}`;
  const safeName = (s) =>
    (s.name || "Step").replace(/["']/g, " ").substring(0, 28);

  let def = `flowchart LR\n`;
  def += `  USER["👤 Goal"] --> GEMINI["🤖 Gemini"]\n`;
  def += `  GEMINI --> S0\n`;

  steps.forEach((s, i) => {
    const id = safeId(s);
    const label = safeName(s);
    const status = s.status || "queued";
    const next = steps[i + 1] ? safeId(steps[i + 1]) : "OUT";

    def += `  ${id}["${label}"]\n`;
    def += `  style ${id} fill:${statusColors[status]},stroke:${statusColors[status]},color:#fff\n`;

    if (i < steps.length - 1) {
      def += `  ${id} --> ${next}\n`;
    } else {
      def += `  ${id} --> OUT["✅ Done"]\n`;
    }
  });

  // Mark failed steps with retry arrow
  steps.forEach((s) => {
    if (s.status === "failed" || s.status === "retrying") {
      const id = safeId(s);
      def += `  RETRY["🔁 Retry"] --> ${id}\n`;
      def += `  ${id} -.->|fail| RETRY\n`;
      def += `  style RETRY fill:#ffb340,stroke:#ffb340,color:#000\n`;
    }
  });

  return def;
}

let diagramKey = 0;

async function updateDiagram(steps) {
  const def = buildRunDiagram(steps);
  if (!def) {
    mermaidWrap.innerHTML = `<div style="color:var(--muted);font-size:0.85rem">Waiting for steps…</div>`;
    return;
  }

  diagramKey++;
  const id = `live-diagram-${diagramKey}`;

  try {
    const { svg } = await mermaid.render(id, def);
    mermaidWrap.innerHTML = svg;
  } catch (e) {
    // Diagram syntax error — skip silently
  }
}

// ─── Step cards ───────────────────────────────────────────────────────────────
function statusBadge(status) {
  return `<span class="step-status-badge badge-${status}">${status}</span>`;
}

function renderStepCard(step) {
  const idx = step.index !== undefined ? step.index : step.index_num;
  const status = step.status || "queued";
  const dur = step.duration_ms != null ? `${(step.duration_ms / 1000).toFixed(2)}s` : null;
  const attempts = step.attempts > 1 ? `${step.attempts} attempts` : null;

  const metaParts = [dur, attempts].filter(Boolean).join(" · ");

  const spinner = status === "running" || status === "retrying"
    ? `<span class="step-spinner"></span>` : "";

  const outputHtml =
    step.output
      ? `<div class="step-output">${escHtml(step.output)}</div>`
      : step.error
      ? `<div class="step-error">⚠ ${escHtml(step.error)}</div>`
      : "";

  return `
    <div class="step-card status-${status}" id="step-${step.id}">
      <div class="step-header">
        <span class="step-index">${idx + 1}</span>
        <span class="step-name">${escHtml(step.name || "Step")}</span>
        ${spinner}
        ${statusBadge(status)}
      </div>
      ${step.description ? `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.4rem">${escHtml(step.description)}</div>` : ""}
      ${metaParts ? `<div class="step-meta"><span>${metaParts}</span></div>` : ""}
      ${outputHtml}
    </div>`;
}

function upsertStepCard(step) {
  const existing = document.getElementById(`step-${step.id}`);
  const html = renderStepCard(step);
  if (existing) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    existing.replaceWith(tmp.firstElementChild);
  } else {
    stepListEl.insertAdjacentHTML("beforeend", html);
  }
}

// ─── Progress ─────────────────────────────────────────────────────────────────
function updateProgress(steps) {
  if (!steps || steps.length === 0) return;
  const done = steps.filter((s) => s.status === "completed" || s.status === "failed").length;
  const pct = Math.round((done / steps.length) * 100);
  progressBar.style.width = `${pct}%`;
  progressWrap.style.display = "block";
}

// ─── Show run view ────────────────────────────────────────────────────────────
function showRunView(run, steps) {
  emptyState.style.display = "none";
  runView.style.display = "flex";

  runGoalTitle.textContent = run.goal;
  const created = new Date(run.created_at).toLocaleString();
  runMeta.textContent = `Created ${created} · Status: ${run.status}`;

  retryBtn.style.display = run.status === "failed" ? "inline-flex" : "none";

  stepListEl.innerHTML = "";
  stepMap = {};

  if (steps && steps.length > 0) {
    steps.forEach((s) => {
      const normalized = {
        ...s,
        index: s.index !== undefined ? s.index : s.index_num,
      };
      stepMap[s.id] = normalized;
      upsertStepCard(normalized);
    });
    updateDiagram(Object.values(stepMap));
    updateProgress(Object.values(stepMap));
  }

  if (run.status === "running") {
    phaseBanner.style.display = "flex";
    phaseText.textContent = "Running…";
  } else {
    phaseBanner.style.display = "none";
  }
}

// ─── SSE ─────────────────────────────────────────────────────────────────────
function connectSSE(runId) {
  if (currentEventSource) currentEventSource.close();

  const es = new EventSource(`/api/runs/${runId}/stream`);
  currentEventSource = es;

  es.addEventListener("snapshot", (e) => {
    const { run, steps } = JSON.parse(e.data);
    showRunView(run, steps);
    if (run.status === "completed" || run.status === "failed") {
      es.close();
      loadRunList();
    }
  });

  es.addEventListener("phase", (e) => {
    const { message } = JSON.parse(e.data);
    phaseBanner.style.display = "flex";
    phaseText.textContent = message;
  });

  es.addEventListener("steps_defined", (e) => {
    const { steps } = JSON.parse(e.data);
    stepListEl.innerHTML = "";
    stepMap = {};
    steps.forEach((s) => {
      const normalized = { ...s, index: s.index };
      stepMap[s.id] = normalized;
      upsertStepCard(normalized);
    });
    updateDiagram(Object.values(stepMap));
  });

  es.addEventListener("step_update", (e) => {
    const data = JSON.parse(e.data);
    // Merge into stepMap
    const existing = stepMap[data.id] || {};
    stepMap[data.id] = { ...existing, ...data };
    upsertStepCard(stepMap[data.id]);
    updateDiagram(Object.values(stepMap));
    updateProgress(Object.values(stepMap));

    if (data.status === "running") {
      phaseBanner.style.display = "flex";
      phaseText.textContent = `Running: ${data.name}…`;
    }
  });

  es.addEventListener("run_update", (e) => {
    const { status } = JSON.parse(e.data);
    const run = { goal: runGoalTitle.textContent, status, created_at: new Date().toISOString() };
    const created = new Date(run.created_at).toLocaleString();
    runMeta.textContent = `Status: ${status}`;

    if (status === "completed") {
      phaseBanner.style.display = "none";
      progressBar.style.width = "100%";
      retryBtn.style.display = "none";
    } else if (status === "failed") {
      phaseBanner.style.display = "none";
      retryBtn.style.display = "inline-flex";
    }

    es.close();
    loadRunList();
  });

  es.onerror = () => {
    // SSE disconnected (server finished or network blip)
    es.close();
  };
}

// ─── Submit form ──────────────────────────────────────────────────────────────
taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = goalInput.value.trim();
  if (!goal) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(`Error: ${err.error}`);
      return;
    }

    const { runId } = await res.json();
    currentRunId = runId;
    goalInput.value = "";
    stepMap = {};
    stepListEl.innerHTML = "";

    // Switch to diagram tab
    document.querySelector("[data-tab='diagram']").click();

    connectSSE(runId);
    loadRunList();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "▶ Run Task";
  }
});

// ─── Retry button ─────────────────────────────────────────────────────────────
retryBtn.addEventListener("click", async () => {
  if (!currentRunId) return;
  retryBtn.disabled = true;
  retryBtn.textContent = "Retrying…";

  try {
    await fetch(`/api/runs/${currentRunId}/retry`, { method: "POST" });
    connectSSE(currentRunId);
  } finally {
    retryBtn.disabled = false;
    retryBtn.textContent = "↩ Retry Failed Steps";
  }
});

// ─── Run list ─────────────────────────────────────────────────────────────────
async function loadRunList() {
  try {
    const runs = await fetch("/api/runs").then((r) => r.json());
    runList.innerHTML = runs.map((r) => `
      <div class="run-item ${r.id === currentRunId ? "active" : ""}"
           onclick="selectRun('${r.id}')">
        <span class="status-dot dot-${r.status}"></span>
        <span class="run-goal" title="${escHtml(r.goal)}">${escHtml(r.goal)}</span>
      </div>`).join("");
  } catch (_) {}
}

async function selectRun(runId) {
  currentRunId = runId;
  stepMap = {};
  stepListEl.innerHTML = "";
  document.querySelector("[data-tab='diagram']").click();

  try {
    const data = await fetch(`/api/runs/${runId}`).then((r) => r.json());
    showRunView(data, data.steps || []);

    // Only open SSE if still running
    if (data.status === "running" || data.status === "queued") {
      connectSSE(runId);
    }
  } catch (_) {}

  loadRunList(); // refresh active highlight
}

// ─── Circuit breaker poll ─────────────────────────────────────────────────────
async function pollCircuit() {
  try {
    const s = await fetch("/api/circuit").then((r) => r.json());
    if (s.open) {
      circuitBadge.className = "circuit-badge open";
      const secs = Math.ceil((s.resetIn || 0) / 1000);
      circuitBadge.innerHTML = `<span>●</span> Circuit Open (resets in ${secs}s)`;
    } else {
      circuitBadge.className = "circuit-badge closed";
      circuitBadge.innerHTML = `<span>●</span> Circuit Closed`;
    }
  } catch (_) {}
}

// ─── Utils ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  await renderArchDiagram();
  await loadRunList();
  pollCircuit();
  setInterval(pollCircuit, 5000);
})();
