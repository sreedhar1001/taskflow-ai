# TaskFlow AI

> **Replit Internship Challenge submission** — An AI productivity app with a live "How It Works" architecture diagram.

TaskFlow AI takes any plain-language goal, breaks it into steps using Gemini, executes each step, and shows a **live Mermaid diagram** that highlights each node as it runs. Every step's output, duration, and retry count is stored in SQLite and streamed live to the browser via Server-Sent Events.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🤖 **AI Task Decomposition** | Gemini parses any goal into 3–6 ordered subtasks |
| 📡 **Live Diagram** | Mermaid.js flowchart highlights the active step in real time |
| 📊 **Step Timeline** | Each step shows status, duration, attempt count, and AI output |
| 🔁 **Exponential Backoff Retry** | Up to 3 retries with 1s/2s/4s backoff |
| ⚡ **Circuit Breaker** | Opens after 3 consecutive failures; resets after 30s |
| 💾 **Partial Progress Recovery** | Failed steps retry; completed steps are never re-run |
| 🗄️ **SQLite Persistence** | All runs and steps are stored; browse run history in the sidebar |
| 📐 **"How It Works" Panel** | Static architecture diagram + SSE protocol + DB schema explainer |

---

## 🚀 Quick Start

### 1. Clone / upload to Replit

```bash
git clone <your-repo-url>
cd taskflow-ai
```

### 2. Set your Gemini API key

```bash
cp .env.example .env
# Edit .env and set GEMINI_API_KEY=your_key_here
```

Get a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### 3. Install and run

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

---

## 🏗️ Architecture

```
Browser (SSE client)
  │  POST /api/tasks          → Express → SQLite (insert run)
  │  GET  /api/runs/:id/stream ← SSE events ←─────────────────┐
  │                                                            │
  └─────────────────────────────────────────────────────────  │
                                                              │
Express API                                                   │
  ├─ parseGoalIntoSteps() → Gemini (gemini-3.8-flash)        │
  ├─ for each step:                                           │
  │    ├─ executeStep() → Gemini                              │
  │    │    └─ retry with backoff on failure                  │
  │    │         └─ circuit breaker if 3 consecutive fails    │
  │    ├─ UPDATE steps (SQLite)                               │
  │    └─ broadcast step_update event ──────────────────────→ ┘
  └─ UPDATE runs (SQLite)
```

## 🛡️ Failure Recovery Design

1. **Step Retry** — each Gemini call retries up to 3× with exponential backoff (1s, 2s, 4s). The UI shows a "Retrying" badge live.
2. **Circuit Breaker** — after 3 consecutive failures, the circuit opens and blocks AI calls for 30s. The header badge turns red.
3. **Partial Progress** — completed steps are committed to SQLite immediately. Retry only re-runs failed steps.

---

## 📁 File Structure

```
taskflow-ai/
├── server.js          # Express API + SSE broadcaster + run/retry executors
├── db.js              # SQLite schema + typed query helpers
├── gemini.js          # Gemini client + retry + circuit breaker
├── package.json
├── .env.example
├── public/
│   ├── index.html     # App shell + tabs
│   ├── style.css      # Dark theme UI
│   └── app.js         # SSE listener, Mermaid rendering, step cards
└── README.md
```

## 🔌 API Reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/tasks` | Submit a new goal `{ goal: string }` → `{ runId }` |
| `GET` | `/api/runs` | List last 50 runs |
| `GET` | `/api/runs/:id` | Get run + steps |
| `GET` | `/api/runs/:id/stream` | SSE stream of live events |
| `POST` | `/api/runs/:id/retry` | Retry failed steps of a run |
| `GET` | `/api/circuit` | Circuit breaker status |

---

## 🧰 Tech Stack

- **Node.js 20** + **Express** — API server
- **better-sqlite3** — embedded database (no external DB required)
- **@google/genai** — Gemini AI SDK (`gemini-3.8-flash`)
- **Mermaid.js** — live diagram rendering
- **Server-Sent Events** — real-time step updates, no WebSocket needed

---

## 📌 Replit Deployment

1. Upload this folder to a new Replit project (Node.js template)
2. Add `GEMINI_API_KEY` in Replit Secrets
3. Click **Run** — Replit auto-detects the `npm start` script
4. Your app is live at your Replit public URL
