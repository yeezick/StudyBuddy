# StudyBuddy

An AI-powered study partner that lives in your Slack. It quizzes you on your own material using spaced repetition, tracks your mastery over time, and sends you quiz pings throughout the day — all from your phone via Slack's native iOS app, no frontend required.

![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)

---

## What it does

- **On-demand quizzes** via slash commands — scope by module, lesson, or free-form learning objective; the first question shows in seconds while the rest are written in the background
- **Confidence before grading** — every answer is tagged Guess / Medium / Sure
- **Spaced repetition** using FSRS (the scheduler in modern Anki) — concepts you struggle with resurface sooner, mastery scores adjust automatically
- **Mastery tracking** per concept, persisted in Redis — snapshot on demand or receive a weekly digest every Sunday
- **Confident-miss re-checks** — a wrong answer you were sure about comes back as one new question by DM ~10 min after the quiz (max 3 a day)
- **Explain-back** — after each quiz, an optional "in 1–2 sentences, why…?" prompt on your weakest concept, written for that concept (and the question you missed), AI-graded; skips are logged too. The weekly digest adds a calibration line (how often you were right at each confidence level)
- **Scheduled quiz pings** — the bot DMs you quizzes during your configured study window without you having to initiate
- **Study session management** — timed segments with synthesis warnings, active recall prompts, dynamic break detection, and a wrap-up quiz offer
- **Content-agnostic** — works with any subject matter you can describe in a concept library

---

## Architecture

```
Cowork / Claude (desktop, active sessions only)
    ↓  MCP client — calls add_concepts, get_mastery, etc.
StudyBuddy Server (Node.js, Railway, always on)
    ├── Slack Bolt SDK — slash commands, button interactions, DM listeners
    ├── MCP Server     — exposes tools for pushing new concepts
    ├── BullMQ         — scheduler for pings, session timers, weekly digest
    └── Anthropic SDK  — question generation, grading, concept matching
    ↓  reads/writes
Upstash Redis
    ├── concepts:{userId}       — your concept library
    ├── mastery:{userId}:{id}   — per-concept scheduler card (FSRS)
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
git clone https://github.com/yeezick/studybuddy.git
cd studybuddy
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
| `SINGLE_USER_ID` | A short identifier for your Redis keys — e.g. your first name or `user1` |
| `USER_TIMEZONE` | Your local timezone in tz format, e.g. `America/New_York` |
| `MCP_AUTH_TOKEN` | Any long random string (e.g. `openssl rand -hex 32`). MCP clients must send `Authorization: Bearer <token>`. Required when `NODE_ENV=production` — the server won't start without it |
| `ANTHROPIC_MODEL` | Optional. Overrides the default model (`claude-sonnet-4-6`) |
| `STORE_BACKEND` | Optional. `redis` (default) keeps all app data in Upstash. `postgres` keeps records (users, concepts, cards, review log, sessions, history) in Postgres. Quizzes and job queues stay in Redis either way |
| `DATABASE_URL` | Only with `STORE_BACKEND=postgres`: a Postgres connection string (e.g. Neon). Migrations run on boot, or by hand with `npm run db:migrate` |
| `SCHEDULER` | Optional. `fsrs` (default) or `sm2`. `sm2` is the rollback: cards are scheduled with classic SM-2 from the SM-2 state every card keeps under `sm2` |

The bot only answers `SLACK_USER_ID`: commands, button taps and messages from anyone else are silently dropped.

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

Railway health-checks `GET /health`. The server binds its port first and connects Slack and Redis/BullMQ in the background, so `/health` answers right away and reports each dependency's state (`ok`, `starting`, `reconnecting`, `error`). If the scheduler can't reach Redis after its retries (about 3.5 minutes), the process exits with code 1 so Railway's restart policy (`ON_FAILURE`, max 10 in `railway.json`) brings it back.

**Local development** (Node 20+):

```bash
npm run dev
```

**Tests** (offline — no Slack, Redis or Anthropic needed):

```bash
npm test          # unit + boot tests
npm run check     # node --check on every JS file
```

The Postgres store tests are skipped unless `TEST_POSTGRES=1`. They take a **local** throwaway database from the standard `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` variables and refuse any other host. Each run uses its own schema and drops it afterwards. CI runs them against a Postgres service container.

`scripts/test-*.js` are live smoke tests that hit real services with your `.env`.

**Moving from Redis to Postgres.** `scripts/migrate-redis-to-postgres.js` copies the owner's records (concepts, cards, quiz history, the latest session, settings, daily mastery snapshots) from Redis into Postgres. It only reads Redis, so Redis stays as the rollback.

```bash
node scripts/migrate-redis-to-postgres.js --dry-run   # rows per table + records it can't map; writes nothing
node scripts/migrate-redis-to-postgres.js             # applies migrations, then copies (safe to re-run)
node scripts/migrate-redis-to-postgres.js --verify    # compares both through the store; exits 1 on any mismatch
```

Then set `STORE_BACKEND=postgres`. To roll back, unset `STORE_BACKEND` (the app goes back to Redis). Writes made while on Postgres are not copied back. A real run refuses while `STORE_BACKEND=postgres`, because copying Redis over live Postgres data would overwrite newer data. Don't use the bot between the copy and the switch, and run `--verify` again after the switch.

The server will seed your concept library on first boot if Redis is empty — from `SEED_PATH` if set, otherwise the bundled example (see [Using your own material](#using-your-own-material)).

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

StudyBuddy is built around a **concept library** — a JSON array of concepts, each with a name, summary, scope (module/lesson), and tags. The bot uses this library to generate questions, track mastery, and schedule reviews. The library is topic-agnostic: it works equally well for a product management course, a programming language, a certification exam, or any other structured subject.

### Using your own material

The repo ships only an example library, `content/concepts-seed.example.json`, and loads it when `SEED_PATH` is unset. To study your own material, keep your library outside git and point `SEED_PATH` at it:

```bash
# .env
SEED_PATH=private/content/concepts-seed.json   # absolute, or relative to the repo root
```

`private/` is gitignored. If `SEED_PATH` names a file that doesn't exist, the server refuses to boot and says so. Seeding only happens when Redis has no concepts for the user, so to switch libraries on an existing deployment, clear the `concepts:{userId}` key or use the MCP `add_concepts` tool.

The file is a JSON array. Each concept needs an `id`, a `name`, a `summary` detailed enough for quiz generation, a `scope` (used for filtered quizzes), and 1–3 `tags`:

```json
[
  {
    "id": "m1-c01",
    "name": "Example Concept Name",
    "summary": "2–3 sentences explaining the concept in enough detail to write quiz questions from.",
    "scope": { "course": "Your Course", "module": "Module 1", "moduleLabel": "Getting Started", "lesson": "L1: Introduction" },
    "tags": ["framework-or-theme"]
  }
]
```

`scope.moduleLabel` is optional: `/mastery` and the weekly digest show it in place of the module name (set it on any concept in the module). Without it, the module name is shown as-is.

### Quickstart: use an AI to set up your library

The fastest way to build out your concept library is to run a setup session with an AI assistant (Claude, ChatGPT, etc.). Paste the following prompt, replacing the bracketed sections with your own context:

---

**Setup prompt:**

```
I'm setting up a spaced repetition study bot called StudyBuddy. It needs a concept 
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
3. Give me the complete JSON array as a single file

Make the summaries detailed enough that an AI can write 4-option MCQ questions and 
free-response questions from them without needing additional context.
```

---

Save the result outside git (e.g. `private/content/concepts-seed.json`), set `SEED_PATH` to it, and restart the server. On first boot it will seed Redis automatically.

If you want to push new concepts later without restarting the server, connect an MCP client (such as Claude's desktop app with MCP configured) to `/mcp/sse` with the header `Authorization: Bearer <MCP_AUTH_TOKEN>` — the `add_concepts` tool merges new concepts into Redis without overwriting existing mastery data.

To make a running deployment's library match a seed file exactly (add new concepts, update edited ones, remove ones the file no longer has), use the loader script. It talks to the same authenticated MCP endpoint:

```bash
SEED_PATH=private/content/concepts-seed.json \
MCP_URL=https://<your-app>/mcp/sse \
MCP_AUTH_TOKEN=<token> SINGLE_USER_ID=<user> \
node scripts/load-concepts.js --dry-run   # prints the plan, writes nothing; drop --dry-run to apply
```

Mastery is stored per concept id, so it survives an update. Re-running is safe.

---

## Roadmap

StudyBuddy is currently a single-user MLP. Planned directions include multi-user support, a web UI for reviewing quiz results and mastery history, and a non-technical onboarding path to make setup accessible without requiring code changes. No timelines are set — the project is under active development.

---

## License

MIT
