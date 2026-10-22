/**
 * gemini.js — Gemini client with retry logic and circuit breaker
 *
 * Retry: up to MAX_RETRIES attempts with exponential backoff
 * Circuit Breaker: opens after FAILURE_THRESHOLD consecutive failures,
 *   resets after RESET_TIMEOUT_MS
 */

const { GoogleGenAI } = require("@google/genai");

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.8-flash";

// ─── Retry config ─────────────────────────────────────────────────────────────
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const FAILURE_THRESHOLD = 3;
const RESET_TIMEOUT_MS = 30_000;

let consecutiveFailures = 0;
let circuitOpenAt = null;

function isCircuitOpen() {
  if (circuitOpenAt === null) return false;
  if (Date.now() - circuitOpenAt > RESET_TIMEOUT_MS) {
    // Half-open: allow one test request
    circuitOpenAt = null;
    consecutiveFailures = 0;
    return false;
  }
  return true;
}

function recordSuccess() {
  consecutiveFailures = 0;
  circuitOpenAt = null;
}

function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    circuitOpenAt = Date.now();
  }
}

function getCircuitStatus() {
  return {
    open: isCircuitOpen(),
    consecutiveFailures,
    circuitOpenAt,
    resetIn: circuitOpenAt
      ? Math.max(0, RESET_TIMEOUT_MS - (Date.now() - circuitOpenAt))
      : null,
  };
}

// ─── Core call with retry ─────────────────────────────────────────────────────

/**
 * Call Gemini with automatic retry + circuit breaker.
 * @param {string} prompt
 * @param {object} [options] — extra options passed to interactions.create
 * @param {function} [onRetry] — called with (attempt, error) before each retry
 * @returns {{ text: string, attempts: number }}
 */
async function callGemini(prompt, options = {}, onRetry) {
  if (isCircuitOpen()) {
    const status = getCircuitStatus();
    throw Object.assign(
      new Error(
        `Circuit breaker OPEN. Too many AI failures. Resets in ${Math.ceil(
          status.resetIn / 1000
        )}s`
      ),
      { code: "CIRCUIT_OPEN", circuitStatus: status }
    );
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const interaction = await client.interactions.create({
        model: MODEL,
        input: prompt,
        store: false, // no need to retain conversation history per step
        ...options,
      });
      recordSuccess();
      return { text: interaction.output_text || "", attempts: attempt };
    } catch (err) {
      lastError = err;
      recordFailure();

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        if (onRetry) onRetry(attempt, err, delay);
        await sleep(delay);
      }
    }
  }

  throw Object.assign(lastError, { attempts: MAX_RETRIES });
}

/**
 * Parse a user goal into an ordered list of subtasks.
 * Returns an array of { name, description } objects (max 6 steps).
 */
async function parseGoalIntoSteps(goal) {
  const prompt = `You are a productivity assistant. Break the following goal into 3-6 concrete, actionable steps that an AI can execute one by one. Return ONLY a valid JSON array, no markdown, no explanation.

Goal: "${goal}"

Format:
[
  { "name": "Step name (short)", "description": "What this step does" },
  ...
]`;

  const { text } = await callGemini(prompt);

  // Strip any accidental markdown fences
  const clean = text.replace(/```json|```/gi, "").trim();
  try {
    const steps = JSON.parse(clean);
    if (!Array.isArray(steps)) throw new Error("Not an array");
    return steps.slice(0, 6).map((s) => ({
      name: String(s.name || "Step"),
      description: String(s.description || ""),
    }));
  } catch {
    // Fallback: single generic step
    return [{ name: "Execute Goal", description: goal }];
  }
}

/**
 * Execute a single step using Gemini.
 * @param {string} stepName
 * @param {string} stepDescription
 * @param {string} overallGoal
 * @param {string[]} previousOutputs — outputs of prior steps for context
 */
async function executeStep(
  stepName,
  stepDescription,
  overallGoal,
  previousOutputs,
  onRetry
) {
  const context =
    previousOutputs.length > 0
      ? `\n\nContext from previous steps:\n${previousOutputs
          .map((o, i) => `Step ${i + 1}: ${o}`)
          .join("\n")}`
      : "";

  const prompt = `You are an AI assistant helping complete a productivity task.

Overall goal: "${overallGoal}"
Current step: "${stepName}"
Step description: "${stepDescription}"${context}

Complete this step thoroughly and concisely. Provide the result of performing this step.`;

  return callGemini(prompt, {}, onRetry);
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

module.exports = {
  parseGoalIntoSteps,
  executeStep,
  getCircuitStatus,
  callGemini,
};
