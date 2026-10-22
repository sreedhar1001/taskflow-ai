/**
 * server.js — Express API server for TaskFlow AI
 *
 * Routes:
 *   POST /api/tasks          — Submit a new task/goal
 *   GET  /api/runs           — List recent runs
 *   GET  /api/runs/:id       — Get run + steps
 *   GET  /api/runs/:id/stream — SSE stream of live step events
 *   GET  /api/circuit        — Circuit breaker status
 *   POST /api/runs/:id/retry — Retry a failed run's failed steps
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const db = require("./db");
const gemini = require("./gemini");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── SSE client registry ──────────────────────────────────────────────────────
// Map<runId, Set<Response>>
const sseClients = new Map();

function getClients(runId) {
  if (!sseClients.has(runId)) sseClients.set(runId, new Set());
  return sseClients.get(runId);
}

function broadcast(runId, event, data) {
  const clients = getClients(runId);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (_) {
      clients.delete(res);
    }
  }
}

// ─── Run executor ─────────────────────────────────────────────────────────────

async function executeRun(runId) {
  const run = db.getRun(runId);
  if (!run) return;

  db.updateRun(runId, { status: "running" });
  broadcast(runId, "run_update", { status: "running" });

  // ── Phase 1: Parse goal into steps ──────────────────────────────────────────
  broadcast(runId, "phase", {
    phase: "parsing",
    message: "Asking Gemini to break down your goal…",
  });

  let parsedSteps;
  try {
    parsedSteps = await gemini.parseGoalIntoSteps(run.goal);
  } catch (err) {
    db.updateRun(runId, {
      status: "failed",
      finished_at: new Date().toISOString(),
    });
    broadcast(runId, "run_update", {
      status: "failed",
      error: err.message,
    });
    return;
  }

  // Create step rows
  const stepIds = [];
  for (let i = 0; i < parsedSteps.length; i++) {
    const sid = uuidv4();
    stepIds.push(sid);
    db.createStep(sid, runId, i, parsedSteps[i].name, parsedSteps[i].description);
  }

  // Tell the frontend about all steps so the diagram can render
  broadcast(runId, "steps_defined", {
    steps: parsedSteps.map((s, i) => ({
      id: stepIds[i],
      index: i,
      name: s.name,
      description: s.description,
      status: "queued",
    })),
  });

  // ── Phase 2: Execute each step ───────────────────────────────────────────────
  const previousOutputs = [];
  let allSucceeded = true;

  for (let i = 0; i < parsedSteps.length; i++) {
    const sid = stepIds[i];
    const step = parsedSteps[i];
    const startTs = new Date().toISOString();

    db.updateStep(sid, { status: "running", started_at: startTs, attempts: 1 });
    broadcast(runId, "step_update", {
      id: sid,
      index: i,
      status: "running",
      name: step.name,
    });

    const onRetry = (attempt, err, delay) => {
      db.updateStep(sid, { status: "retrying", attempts: attempt + 1 });
      broadcast(runId, "step_update", {
        id: sid,
        index: i,
        status: "retrying",
        attempt: attempt + 1,
        error: err.message,
        retryIn: delay,
      });
    };

    try {
      const { text, attempts } = await gemini.executeStep(
        step.name,
        step.description,
        run.goal,
        previousOutputs,
        onRetry
      );

      const endTs = new Date().toISOString();
      const durationMs = new Date(endTs) - new Date(startTs);

      db.updateStep(sid, {
        status: "completed",
        output: text,
        attempts,
        finished_at: endTs,
        duration_ms: durationMs,
      });

      broadcast(runId, "step_update", {
        id: sid,
        index: i,
        status: "completed",
        output: text,
        durationMs,
        attempts,
      });

      previousOutputs.push(text);
    } catch (err) {
      const endTs = new Date().toISOString();
      const durationMs = new Date(endTs) - new Date(startTs);

      db.updateStep(sid, {
        status: "failed",
        error: err.message,
        attempts: err.attempts || MAX_RETRIES,
        finished_at: endTs,
        duration_ms: durationMs,
      });

      broadcast(runId, "step_update", {
        id: sid,
        index: i,
        status: "failed",
        error: err.message,
        durationMs,
      });

      allSucceeded = false;
      previousOutputs.push(`[FAILED: ${err.message}]`);
    }
  }

  // ── Phase 3: Finalize run ────────────────────────────────────────────────────
  const finalStatus = allSucceeded ? "completed" : "failed";
  db.updateRun(runId, {
    status: finalStatus,
    finished_at: new Date().toISOString(),
  });
  broadcast(runId, "run_update", { status: finalStatus });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/tasks — submit a new goal
app.post("/api/tasks", (req, res) => {
  const { goal } = req.body;
  if (!goal || !goal.trim()) {
    return res.status(400).json({ error: "goal is required" });
  }

  const runId = uuidv4();
  db.createRun(runId, goal.trim());

  // Fire and forget; clients follow via SSE
  executeRun(runId).catch((err) =>
    console.error(`[run ${runId}] unhandled error:`, err)
  );

  res.status(201).json({ runId });
});

// GET /api/runs — list recent runs
app.get("/api/runs", (_req, res) => {
  res.json(db.listRuns());
});

// GET /api/runs/:id — get run + steps
app.get("/api/runs/:id", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  const steps = db.getStepsForRun(run.id);
  res.json({ ...run, steps });
});

// GET /api/runs/:id/stream — SSE live events
app.get("/api/runs/:id/stream", (req, res) => {
  const { id } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state immediately so reconnecting clients catch up
  const run = db.getRun(id);
  if (run) {
    const steps = db.getStepsForRun(id);
    res.write(
      `event: snapshot\ndata: ${JSON.stringify({ run, steps })}\n\n`
    );
  }

  getClients(id).add(res);

  // Heartbeat every 20s to keep connection alive through proxies
  const hb = setInterval(() => res.write(": heartbeat\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(hb);
    getClients(id).delete(res);
  });
});

// POST /api/runs/:id/retry — re-run failed steps only
app.post("/api/runs/:id/retry", async (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.status === "running") {
    return res.status(409).json({ error: "Run is already in progress" });
  }

  // Reset failed steps to queued and re-run the whole executor
  // (executor skips already-completed steps by checking status)
  const steps = db.getStepsForRun(run.id);
  for (const s of steps) {
    if (s.status === "failed") {
      db.updateStep(s.id, {
        status: "queued",
        error: null,
        output: null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        attempts: 0,
      });
    }
  }

  db.updateRun(run.id, { status: "queued", finished_at: null });
  res.json({ message: "Retry started", runId: run.id });

  executeRunRetry(run.id).catch((err) =>
    console.error(`[run ${run.id}] retry error:`, err)
  );
});

// Retry executor — only re-runs steps that are queued (failed ones reset above)
async function executeRunRetry(runId) {
  const run = db.getRun(runId);
  db.updateRun(runId, { status: "running" });
  broadcast(runId, "run_update", { status: "running", retry: true });

  const steps = db.getStepsForRun(runId);
  const completedOutputs = steps
    .filter((s) => s.status === "completed")
    .sort((a, b) => a.index_num - b.index_num)
    .map((s) => s.output || "");

  const previousOutputs = [...completedOutputs];
  let allSucceeded = true;

  for (const step of steps) {
    if (step.status === "completed") continue; // skip already done

    const startTs = new Date().toISOString();
    db.updateStep(step.id, { status: "running", started_at: startTs, attempts: 1 });
    broadcast(runId, "step_update", {
      id: step.id,
      index: step.index_num,
      status: "running",
      name: step.name,
    });

    const onRetry = (attempt, err, delay) => {
      db.updateStep(step.id, { status: "retrying", attempts: attempt + 1 });
      broadcast(runId, "step_update", {
        id: step.id,
        index: step.index_num,
        status: "retrying",
        attempt: attempt + 1,
        error: err.message,
        retryIn: delay,
      });
    };

    try {
      const { text, attempts } = await gemini.executeStep(
        step.name,
        step.description,
        run.goal,
        previousOutputs,
        onRetry
      );
      const endTs = new Date().toISOString();
      const durationMs = new Date(endTs) - new Date(startTs);
      db.updateStep(step.id, {
        status: "completed",
        output: text,
        attempts,
        finished_at: endTs,
        duration_ms: durationMs,
      });
      broadcast(runId, "step_update", {
        id: step.id,
        index: step.index_num,
        status: "completed",
        output: text,
        durationMs,
        attempts,
      });
      previousOutputs.push(text);
    } catch (err) {
      const endTs = new Date().toISOString();
      const durationMs = new Date(endTs) - new Date(startTs);
      db.updateStep(step.id, {
        status: "failed",
        error: err.message,
        finished_at: endTs,
        duration_ms: durationMs,
      });
      broadcast(runId, "step_update", {
        id: step.id,
        index: step.index_num,
        status: "failed",
        error: err.message,
        durationMs,
      });
      allSucceeded = false;
      previousOutputs.push(`[FAILED: ${err.message}]`);
    }
  }

  const finalStatus = allSucceeded ? "completed" : "failed";
  db.updateRun(runId, { status: finalStatus, finished_at: new Date().toISOString() });
  broadcast(runId, "run_update", { status: finalStatus });
}

// GET /api/circuit — circuit breaker status
app.get("/api/circuit", (_req, res) => {
  res.json(gemini.getCircuitStatus());
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  await db.init();
  app.listen(PORT, () => {
    console.log(`\n🚀 TaskFlow AI running at http://localhost:${PORT}`);
    console.log(`   GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? "✅ set" : "❌ missing — set it in .env"}\n`);
  });
})();
