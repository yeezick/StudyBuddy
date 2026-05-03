# StudyAgent

An AI-powered study partner that lives in your Slack. It quizzes you on your own material using spaced repetition, tracks your mastery over time, and sends you quiz pings throughout the day — all from your phone via Slack's native iOS app, no frontend required.

![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)

---

## What it does

- **On-demand quizzes** via slash commands — scope by module, lesson, or free-form learning objective
- **Spaced repetition** using the SM-2 algorithm — concepts you struggle with resurface sooner, mastery scores adjust automatically
- **Mastery tracking** per concept, persisted in Redis — snapshot on demand or receive a weekly digest every Sunday
- **Scheduled quiz pings** — the bot DMs you quizzes during your configured study window without you having to initiate
- **Study session management** — timed segments with synthesis warnings, active recall prompts, dynamic break detection, and a wrap-up quiz offer
- **Content-agnostic** — works with any subject matter you can describe in a concept library

---

## Architecture

```
Cowork / Claude (desktop, active sessions only)
    ↓  MCP client — calls add_concepts, get_mastery, etc.
StudyAgent Server (Node.js, Railway, always on)
    ├── Slack Bolt SDK — slash commands, button interactions, DM listeners
    ├── MCP Server     — exposes tools for pushing new concepts
    ├── BullMQ         — scheduler for pings, session timers, weekly digest
    └── Anthropic SDK  — question generation, grading, concept matching
    ↓  reads/writes
Upstash Redis
    ├── concepts:{userId}       — your concept library
    ├── mastery:{userId}:{id}   — per-concept SM-2 state
    ├── quiz:{quizId}           — active quiz state
    └── session:{userId}        — active study session state
```

---

## Prerequisites

You will need accounts and credentials for the following services before starting setup:

| Service | What it's used for | Free tier |
|---|---|---|
| [Slack](https://slack.com) | Workspace + app to install the bot into | Yes |
| [Anthropic](https://console.anthropic.com) | Question generation and grading | Pay-as-you-go |
| [Upstash](https://upstash.com) | Serverless Redis for all data storage | Yes (10k req/day) |
| [Railway](https://railway.app) | Hosting the always-on Node.js server | Yes (hobby tier) |

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-username/studyagent.git
cd studyagent
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in each value. Where to find them:

| Variable | Where to get it |
|---|---|
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → Signing Secret |
| `SLACK_APP_TOKEN` | Slack app → Basic Information → App-Level Tokens (create one with `connections:write` scope) |
| `SLACK_USER_ID` | Your Slack profile → copy Member ID |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `UPSTASH_REDIS_REST_URL` | Upstash console → your database → REST API |
| `UPSTASH_REDIS_REST_TOKEN` | Same page as above |
| `REDIS_URL` | Upstash console → your database → ioredis connection string |
| `USER_TIMEZONE` | Your local timezone in tz format, e.g. `America/Chicago` |

### 3. Create your Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Choose **From an app manifest**
3. Paste the contents of `slack-manifest.yaml` from this repo
4. Install the app to your workspace
5. Copy the tokens into your `.env` as described above

The manifest configures all required scopes, slash commands, Socket Mode, and event subscriptions automatically.

### 4. Deploy

**Railway (recommended):**

```bash
# Install Railway CLI
npm install -g @railway/cli

railway login
railway init
railway up
```

Set your environment variables in the Railway dashboard under your project's Variables tab.

**Local development:**

```bash
npm run dev
```

The server will seed your concept library from `concepts-seed.json` on first boot if Redis is empty.

---

## Slash commands

| Command | Arguments | Description |
|---|---|---|
| `/quizinit` | _(none)_ | Quiz on all concepts, mixed scope |
| `/quizinit` | `module "Module 2"` | Quiz scoped to a module |
| `/quizinit` | `lesson "L3"` | Quiz scoped to a lesson |
| `/quizinit` | `"explain RAG failure modes"` | Free-form learning objective |
| `/mastery` | _(none)_ | Mastery snapshot across all modules with due-for-review list |
| `/brief` | _(none)_ | Active session state, next review due, last quiz score |
| `/focus` | `start 3h "Module 2"` | Start a timed study session |
| `/focus` | `end` | End the active session |

---

## Tailoring to your own content

StudyAgent is built around a **concept library** — a JSON array of concepts, each with a name, summary, scope (module/lesson), and tags. The bot uses this library to generate questions, track mastery, and schedule reviews. The library is topic-agnostic: it works equally well for a product management course, a programming language, a certification exam, or any other structured subject.

### Quickstart: use an AI to set up your library

The fastest way to get started with your own material is to run a setup session with an AI assistant (Claude, ChatGPT, etc.). Paste the following prompt, replacing the bracketed sections with your own context:

---

**Setup prompt:**

```
I'm setting up a spaced repetition study bot called StudyAgent. It needs a concept 
library in JSON format to generate quiz questions and track my mastery.

My study material: [describe your course, book, certification, or topic]
My modules/sections: [list the main sections or chapters]

Please help me:
1. Extract 5–10 key concepts per module as a JSON array
2. Format each concept using this exact structure:
   {
     "id": "m1-c01",          // module number + sequential concept number
     "name": "...",            // short concept name (3–6 words)
     "summary": "...",         // 2–3 sentence explanation a quiz can be generated from
     "scope": {
       "course": "...",        // overall course or topic name
       "module": "Module 1",   // module name matching your section headers
       "lesson": "L1: ..."     // lesson name if applicable
     },
     "tags": ["...", "..."]    // 1–3 key themes or frameworks this concept belongs to
   }
3. Give me a complete concepts-seed.json I can drop into the repo

Make the summaries detailed enough that an AI can write 4-option MCQ questions and 
free-response questions from them without needing additional context.
```

---

Once you have your `concepts-seed.json`, replace the one in the repo root and restart the server. On first boot it will seed Redis automatically.

If you want to push new concepts later without restarting the server, connect an MCP client (such as Claude's desktop app with MCP configured) to the `/mcp` endpoint — the `add_concepts` tool merges new concepts into Redis without overwriting existing mastery data.

---

## Roadmap

StudyAgent is currently a single-user MLP. Planned directions include multi-user support, a web UI for reviewing quiz results and mastery history, and a non-technical onboarding path to make setup accessible without requiring code changes. No timelines are set — the project is under active development.

---

## License

MIT
