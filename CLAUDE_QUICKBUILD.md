# StudyAgent — Quick Build Spec
# Slack + Cowork MLP

## Context

This is the tactical build brief for the StudyAgent MLP. It is scoped exclusively to the
Slack bot + MCP server sprint. The long-term strategic spec lives in CLAUDE.md — do not
conflate the two. Do not build anything in CLAUDE.md that is not listed here.

**Also read at session start:** `GIT_CONVENTIONS.md` — branch naming, commit format,
squash merge gate, and PR rules for every build step.

The goal: a fully functional AI study partner accessible from the native iOS Slack app,
running 24/7, with no React frontend required. The React UI is Phase 3 and is explicitly
out of scope for this build.

---

## What This Build Delivers

- On-demand quizzes via Slack slash commands (scope-based and free-form prompt)
- Random scheduled quiz pings (spaced retrieval, fires without user initiation)
- Study session management (timers, segment recalls, dynamic breaks, wrap-up)
- Mastery tracking per concept using SM-2, persisted in Upstash Redis
- Weekly mastery digest every Sunday
- `/mastery` on-demand snapshot
- Cowork as the content authoring client — pushes new concepts via MCP tools
- All quiz results graded inline in Slack with explanations

---

## Architecture

```
Cowork (desktop, active sessions only)
    ↓  MCP client — calls add_concepts, get_mastery, etc.
MCP + Slack Bot Server (Node.js, Railway, always on)
    ├── Slack Bolt SDK — handles all inbound Slack events
    ├── MCP Server — exposes tools for Cowork
    ├── BullMQ — scheduler for pings, session timers, weekly digest
    └── Anthropic SDK — question generation, grading, scope inference
    ↓  reads/writes
Upstash Redis
    ├── concepts:{userId}         — concept library (JSON array)
    ├── mastery:{userId}:{id}     — per-concept SM-2 state
    ├── session:{userId}          — active study session state
    ├── quiz:{quizId}             — active quiz state
    └── history:{userId}          — last 30 assessment summaries
```

No MongoDB in this build. No Clerk. No React. Redis is the only datastore.
Single user (Erick) for this sprint — no multi-user auth required.

---

## Handoff Protocol — Claude Code ↔ Cowork

This project uses a decoupled workflow. Erick drives Claude Code directly to build,
and Cowork maintains specs, decisions, and tracking. The two agents do not call each
other — they communicate through `AGENT_HANDOFF.md` at the project root.

### When Claude Code writes the handoff

When Erick types `wrap up` in a Claude Code session, Claude Code must:

1. Open `AGENT_HANDOFF.md` at the project root
2. Overwrite the **Working Sections** (everything between the "Working Sections" header
   and the "Completion Log" header) with the current session's summary:
   - Session Metadata — date, build steps touched, smoke test status
   - Completed Work — specific files, features, behaviors changed
   - Decisions Made — anything that should land in decisions.md, formatted as a short
     proposal Cowork can convert into a DEC entry
   - Spec Deviations — anywhere the build diverged from CLAUDE_QUICKBUILD.md and why
   - Blockers — open issues for Erick or Cowork to resolve
   - Suggested File Updates — recommendations for which Cowork files should change
3. Set the file's `Status:` field to `AWAITING_COWORK`
4. Update the `Last Updated:` and `Last Session:` fields with today's date
5. Do NOT touch the Completion Log section — that is Cowork's append-only history
6. Notify Erick: *"Handoff written to AGENT_HANDOFF.md. Run `sync from claude code` in your Cowork session to reconcile."*

### What Claude Code does NOT do

- Does not edit `CLAUDE_QUICKBUILD.md`, `decisions.md`, `TRACKER.md`, or `COWORK_CONTEXT.md`
  directly. Claude Code suggests changes in the handoff; Cowork makes them.
- Does not append to the Completion Log section of `AGENT_HANDOFF.md` — that is owned
  by Cowork.
- Does not call Cowork or attempt to trigger a sync. Erick triggers the sync manually.

### When Claude Code reads the handoff

At the start of every Claude Code session, read `AGENT_HANDOFF.md` and check the
`Status:` field:

- If `IDLE` or `COMPLETED`: proceed normally with the requested work.
- If `AWAITING_COWORK`: Cowork has not yet reconciled the last handoff. Notify Erick:
  *"Last handoff is still AWAITING_COWORK. Run `sync from claude code` in Cowork before
  starting new work to avoid losing context."* Then wait for confirmation before
  proceeding.

---

## Tech Stack

### Frontend
- React (Vite)
- React Router v6
- TanStack Query — server state, caching
- Zustand — lightweight client state (active session, UI state)
- Tailwind CSS
- Shadcn/ui — component primitives
- React Dropzone — file upload UI
- Recharts — mastery heatmap and progress charts
- Deployed on: Vercel (free tier)

### Backend
- Node.js + Express — REST API server
- Mongoose — MongoDB ODM
- BullMQ + Redis — job queue for scheduled Slack pings (use Upstash Redis free tier)
- Slack Bolt SDK — Slack app event handling, interactive components, slash commands
- Multer — file upload middleware
- pdf-parse — PDF text extraction
- Anthropic SDK (Node) — all AI calls use `claude-sonnet-4-6`
- Clerk — auth (free tier, supports OAuth, JWT, multi-user)
- Deployed on: Railway (free tier)

### Database
- MongoDB Atlas (free tier, M0 cluster)

### External Services
- Anthropic API
- Slack API (Bolt SDK, OAuth 2.0 for multi-workspace)
- Clerk (auth)
- Upstash Redis (BullMQ job queue for Slack scheduler)

---

## Repository Structure

```
studyagent/
├── CLAUDE_QUICKBUILD.md         ← this file
├── CLAUDE.md                    ← long-term strategic spec, reference only
├── AGENT_HANDOFF.md             ← Claude Code ↔ Cowork handoff channel
├── concepts-seed.json           ← pre-extracted concept library
├── .env.example
├── package.json
├── railway.json                 ← Railway deploy config
├── scripts/
│   ├── test-ai.js               ← AI services harness (22 assertions)
│   ├── test-sm2.js              ← SM-2 + mastery harness (41 assertions)
│   └── test-dm.js               ← DM push-message smoke test
└── src/
    ├── index.js                 ← Express server, mounts Bolt + MCP
    ├── redis.js                 ← Upstash Redis client (singleton)
    ├── ai/
    │   ├── anthropic.js         ← Anthropic singleton + callJSON() helper
    │   ├── questionGen.js       ← generate quiz questions from concepts
    │   ├── grading.js           ← evaluate free-text answers
    │   └── conceptMatch.js      ← free-form prompt → concept IDs
    ├── slack/
    │   ├── app.js               ← Bolt app instance (Socket Mode)
    │   ├── commands.js          ← slash command handlers
    │   ├── dm.js                ← getDMChannel() for unsolicited bot DMs
    │   ├── quizFlow.js          ← quiz delivery, button handling, grading
    │   ├── sessionFlow.js       ← study session orchestration
    │   └── masteryFlow.js       ← /mastery and weekly digest formatting
    ├── mcp/
    │   └── server.js            ← MCP server exposing Cowork tools
    ├── scheduler/
    │   └── jobs.js              ← BullMQ job definitions and handlers
    └── lib/
        ├── env.js               ← dotenv loader with override:true (local dev sandbox)
        ├── sm2.js               ← SM-2 algorithm, pure functions, no Redis
        ├── mastery.js           ← mastery Redis CRUD (getMastery, setMastery, applyQuestionResult)
        └── concepts.js          ← concept CRUD against Redis
```

---

## Data Structures (Redis)

All data is JSON serialized. No ODM — raw JSON.stringify / JSON.parse throughout.

### Concept object
```javascript
{
  id: "m1-c01",                  // stable ID, set at ingestion
  name: "LLMs as Prediction Engines",
  summary: "2-3 sentence explanation...",
  scope: {
    course: "Maven AI PM",
    module: "Module 1",
    lesson: "L1: Introduction"
  },
  tags: ["IPO Framework", "8 LLM Constraints"]
}
```

### Mastery object (key: `mastery:erick:{conceptId}`)
```javascript
{
  conceptId: "m1-c01",
  score: 0.45,                   // 0.0–1.0
  easeFactor: 2.5,               // SM-2 default
  interval: 6,                   // days until next review
  repetitions: 3,
  nextReviewAt: "2026-05-07T09:00:00Z",
  lastReviewedAt: "2026-05-01T14:22:00Z"
}
```

### Quiz state (key: `quiz:{quizId}`)
```javascript
{
  quizId: "uuid",
  userId: "erick",
  trigger: "on_demand",          // "on_demand" | "scheduled_ping" | "session_warmup"
                                 // | "session_wrap" | "segment_end"
  input: {
    mode: "scope",               // "scope" | "free_form_prompt" | "both"
    scope: { module: "Module 2" },
    freeFormPrompt: null
  },
  questions: [
    {
      id: "q1",
      conceptId: "m2-c11",
      type: "mcq",               // "mcq" | "short_answer" | "explain" | "scenario"
      prompt: "...",
      options: ["A. ...", "B. ...", "C. ...", "D. ..."],
      correctAnswer: "B",
      explanation: "...",
      userAnswer: null,
      isCorrect: null,
      confidenceRating: null,    // 1–3
      pointsEarned: null
    }
  ],
  currentQuestionIndex: 0,
  status: "in_progress",         // "in_progress" | "completed" | "abandoned"
  score: null,
  slackChannelId: "D...",        // Slack DM channel for this quiz
  slackUserId: "U...",
  createdAt: "...",
  completedAt: null
}
```

### Session state (key: `session:erick`)
```javascript
{
  sessionId: "uuid",
  topic: "Module 2 — AI Foundations",
  startingContext: "Resuming mid-lesson 2.3...",
  plannedDuration: 180,          // minutes
  segmentDuration: 45,
  breakDuration: 10,
  status: "active",              // "active" | "on_break" | "completed" | "abandoned"
  currentSegmentIndex: 0,
  currentSegmentStart: "...",    // ISO string
  currentSegmentElapsed: 0,      // seconds accumulated before any pause
  segments: [
    {
      startedAt: "...",
      endedAt: null,
      activeRecallNote: null,
      useCaseNote: null,
      noteSkipped: false,
      breaks: []
    }
  ],
  warmupQuizId: null,
  wrapQuizId: null,
  slackChannelId: "D...",
  slackUserId: "U...",
  startedAt: "...",
  completedAt: null
}
```

### Assessment summary (appended to `history:erick` list, capped at 30)
```javascript
{
  quizId: "uuid",
  trigger: "scheduled_ping",
  scope: { module: "Module 2" },
  score: 78,
  conceptIds: ["m2-c11", "m2-c14"],
  completedAt: "..."
}
```

---

## Seed Data

The concept library for Modules 1 and 2 is pre-seeded in `concepts-seed.json` at the
repo root. On first boot, if `concepts:erick` does not exist in Redis, the server
loads this file and writes it. Do not regenerate concepts on every boot — check first.

```javascript
// src/lib/concepts.js — seed on first boot
async function seedIfEmpty(userId) {
  const existing = await redis.get(`concepts:${userId}`);
  if (!existing) {
    const seed = JSON.parse(fs.readFileSync(path.resolve(new URL('.', import.meta.url).pathname, '../concepts-seed.json'), 'utf8'));
    // path.resolve from import.meta.url ensures the path works regardless of CWD on Railway
    await redis.set(`concepts:${userId}`, JSON.stringify(seed));
    console.log(`Seeded ${seed.length} concepts for ${userId}`);
  }
}
```

---

## Slack Commands

Register all of these as slash commands in the Slack app manifest.

```
/quizinit
  No args       → quiz on all concepts, mixed scope
  /quizinit module "Module 2"
  /quizinit lesson "L3"
  /quizinit "explain RAG failure modes"     → free-form prompt mode

/focus start [duration] "[topic]"
  Example: /focus start 3h "Module 2"
/focus end

/mastery
  On-demand mastery snapshot

/brief
  Active session state + next review due + last quiz score
  (Note: /status rejected by Slack platform — collides with built-in user availability command)
```

---

## Slack Quiz Flow (`src/slack/quizFlow.js`)

**MCQ delivery:**
- Bot posts question text + 4 Block Kit button elements (A / B / C / D)
- Before buttons: one set of confidence buttons [Low] [Medium] [High]
  → user taps confidence first, then answer button
  → if user taps answer before confidence, prompt for confidence before processing
- On answer tap: `block_actions` received, buttons disabled, graded reply posted inline
- Next question posted as new message (never threaded)

**Non-MCQ delivery (short_answer, explain, scenario):**
- Bot posts question as plain message with: "Reply to this message with your answer"
- Bolt `message` listener activated, scoped to `{ userId, channelId }`
- Listener captures next DM message as answer, immediately deregisters
- Answer sent to grading service; grade result is held pending confidence tap
- Bot posts confidence prompt [Low] [Medium] [High] before revealing grade (DEC-009, DEC-025)
- On confidence tap: SM-2 quality score computed, feedback + grade posted, next question follows

**On quiz completion:**
- Mark quiz completed in Redis
- Run SM-2 updates for all tested concepts
- Post score summary:
  ```
  ✅ Quiz complete — {score}/100  ({correct}/{total} correct)

  Strongest: {top concept name}
  Needs work: {weakest concept name}

  Full results: [link — will 404 until Phase 3 web UI is live]
  ```

**Constraints:**
- Max 10 questions per Slack quiz
- Default type distribution for on-demand: 60% MCQ, 20% short_answer, 20% explain
- Scheduled pings and session warm-ups: 100% MCQ (speed)
- Exams are out of scope for this build

---

## Study Session Flow (`src/slack/sessionFlow.js`)

**Segment design:**
Default segment is 45 minutes. The final 5 minutes are designated synthesis time.
The bot sends a synthesis warning at 40 minutes, then the active recall prompt at 45 minutes.
This is a cognitive transition cue, not a countdown. The bot language reflects this distinction.

**`/study start 3h "Module 2"`:**
1. Check for existing active session — if found, ask to end it first
2. Ask: *"Where are you picking up?"* → store reply as `startingContext`
3. Pull last 3 assessment summaries from `history:erick`
4. Post previous session recap (scores, weak concepts)
5. Generate 5-question MCQ warm-up (trigger: `session_warmup`) on previous weak concepts
   or `startingContext`-adjacent concepts
6. After warm-up: post session plan with segment schedule
7. Write session state to `session:erick`
8. Create BullMQ jobs (see Scheduler section)

**At 40-minute mark (synthesis warning job fires):**
```
Bot DM:
🧠 5 minutes left in this segment.

Start synthesizing — wrap up what you've been working through.
I'll ask you to write it out in 5 minutes.
```

**At 45-minute mark (recall prompt job fires):**
```
Bot DM:
⏱️ Segment complete.

Before your break, reply with:
1. The most important concept from this segment
2. How it works in one sentence
3. One question you still have
```
Store reply as `segment.activeRecallNote`. Create scheduled break job.
Bot: *"Logged. Break timer: {breakDuration} minutes."*

**Dynamic break detection:**
Bolt `message` listener active throughout session. Pattern match on:
- "break", "stepping away", "brb", "pause" (case-insensitive)
- Any message matching `/\b(\d+)\s*(min|minute)/i`

On detection:
1. Parse duration (default to `session.breakDuration` if no number)
2. Record `currentSegmentElapsed`
3. Set status to `"on_break"`
4. Suspend active segment BullMQ jobs
5. Create one-time break job keyed `break:{sessionId}:{segmentIndex}`
6. Bot: *"Got it — break timer set for {N} minutes."*

On break timer fire:
Bot: *"Break's up. Reply anything when you're ready."*

On return (any DM while status is `"on_break"`):
1. Resume from `currentSegmentElapsed` — time does not reset
2. Reinstate suspended jobs with adjusted delays
3. Set status to `"active"`
4. Bot: *"Welcome back — {remaining} minutes left in this segment."*

**At session end:**
```
Bot DM:
🎓 Session complete.

Before you close out — reply with one concept from tonight
and how you'd apply it at work or in something you're building.
```
Store as `segment.useCaseNote`. Post session summary. Offer wrap-up quiz:
```
[Quiz Now]  [Tomorrow Morning]  [Skip]
```
- Quiz Now → 5-question MCQ, trigger: `session_wrap`
- Tomorrow Morning → BullMQ job at 08:30 next morning
- Skip → close session, clean up jobs

---

## Mastery Flow (`src/slack/masteryFlow.js`)

**`/mastery` format:**
```
📊 Mastery Snapshot — Maven AI PM

Module 1 — The Paradigm Shift   ████████░░  78%  (14 concepts)
Module 2 — The Product Stack     █████░░░░░  48%  (25 concepts)

Due for review today:
• LLMs as Prediction Engines
• RAG Failure Modes
• Precision vs. Recall Trade-off

/quiz to drill weak concepts now.
```

Bar: 10 chars, one █ per 10%. Round to nearest 10.

**Weekly Sunday digest (BullMQ cron, Sunday at configured time):**
Same format, adds weekly delta per module:
```
Module 2 — The Product Stack   █████░░░░░  52%  (+18% this week)
```
Plus weekly summary line:
```
This week: {n} quizzes · {n} concepts tested · {n}-day streak
```

Weekly delta requires a mastery snapshot written daily. Add a lightweight
daily BullMQ job (midnight) that writes `mastery-snapshot:{userId}:{date}`
to Redis with per-module averages. Weekly digest reads snapshot from 7 days ago.

---

## MCP Server (`src/mcp/server.js`)

Exposed as an MCP server that Cowork connects to as a client. Cowork uses this
to push new concepts when processing a new module PDF.

Transport: SSE (Server-Sent Events) — Cowork connects over HTTP, server is always on.
Mount at `/mcp` on the Express server.

### Tools

```javascript
add_concepts({ userId, concepts })
// Merges new concept array into existing concepts:userId in Redis.
// Deduplicates by concept.id. Returns count of added concepts.
// Called by Cowork after processing a new module PDF.

get_concepts({ userId, module?, lesson? })
// Returns all concepts for userId, optionally filtered by scope.
// Called by Cowork for review, editing, or context.

get_mastery({ userId, module? })
// Returns mastery objects for all concepts, optionally filtered.
// Called by Cowork to surface weak areas during a study session prep.

update_concept({ userId, conceptId, updates })
// Patch a single concept (name, summary, tags, scope).
// Called by Cowork to correct AI extraction errors.

delete_concept({ userId, conceptId })
// Remove a concept from the library.
// Called by Cowork when a concept is duplicate or incorrect.

get_history({ userId, limit? })
// Returns last N assessment summaries from history:userId.
// Default limit 10. Called by Cowork for session prep context.
```

All tools validate that userId matches the configured single-user ID for
this build. Multi-user auth is Phase 4.

---

## Scheduler (`src/scheduler/jobs.js`)

BullMQ connected to Upstash Redis via ioredis.

### Job key patterns (all idempotent — upsert, never duplicate)
```
slack-ping:erick              — random quiz ping (repeating, within window)
session-synth:{sessionId}:{n} — synthesis warning at 40 min
session-recall:{sessionId}:{n}— recall prompt at 45 min
session-end:{sessionId}       — session end job
break:{sessionId}:{n}         — one-time break timer
session-wrap-morning:erick    — deferred wrap-up quiz (tomorrow morning)
weekly-digest:erick           — Sunday digest (cron)
daily-snapshot:erick          — midnight mastery snapshot (cron)
```

### Default schedule (configurable via Redis key `settings:erick`)
```javascript
{
  pingEnabled: true,
  pingWindowStart: "09:00",     // user's local time
  pingWindowEnd: "18:00",
  pingDaysOfWeek: [1,2,3,4,5], // Mon–Fri
  pingFrequencyPerDay: 2,
  morningQuizTime: "08:30",
  weeklyDigestDay: 0,           // Sunday
  weeklyDigestTime: "19:00",
  timezone: "America/Chicago"
}
```

### Random ping logic
On each ping job execution:
1. Check if current time is within window — if not, reschedule for next valid time
2. Fetch concepts due for review (`nextReviewAt <= now`) — cap at 3 injected overdue
3. If fewer than 5 due concepts, fill with random concepts from library
4. Generate 3-question MCQ quiz (trigger: `scheduled_ping`)
5. Deliver to user's DM
6. Schedule next ping at random time within remaining window today,
   or first window tomorrow if past window

---

## AI Services

### Question Generation (`src/ai/questionGen.js`)

```javascript
// Input: concepts array, count, type distribution, freeFormPrompt (optional)
// Output: questions array ready for quiz state

const SYSTEM = `You are an expert assessment designer trained in retrieval practice
and elaborative interrogation. Generate questions that test deep understanding, not
surface recall. Apply interleaving — never place consecutive questions on the same concept.
Return ONLY a JSON array. No preamble, no markdown fences.`;

const USER = `Generate {count} questions.
Type distribution: {distribution}
{freeFormPrompt ? 'Directional focus: "' + freeFormPrompt + '"' : ''}

Concepts:
{JSON.stringify(concepts)}

Each question object:
{
  "conceptId": "concept id",
  "type": "mcq" | "short_answer" | "explain" | "scenario",
  "prompt": "question text",
  "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
  "correctAnswer": "correct answer or key points",
  "explanation": "why correct; why wrong answers fail",
  "difficulty": "recall" | "understanding" | "application"
}

Rules:
- MCQ distractors must be plausible
- Short answer: one definitive answer
- Explain: explain to a non-technical stakeholder
- Scenario: realistic PM context
- Explanation must be detailed enough to teach, not just confirm`;
```

Parse defensively. On JSON parse failure: retry once with added instruction.

### Grading (`src/ai/grading.js`)

MCQ: deterministic string match against `correctAnswer`. No AI call.

Free-text:
```javascript
const SYSTEM = `You are a strict but fair grader. Be generous with partial credit
when the student demonstrates understanding despite imprecise phrasing.
Return ONLY JSON. No preamble.`;

const USER = `Question: {prompt}
Expected: {correctAnswer}
Student answer: {userAnswer}

Return: { "isCorrect": bool, "score": 0.0-1.0, "feedback": "..." }`;
```

### Concept Match (`src/ai/conceptMatch.js`)

Used for free-form prompt quiz input.

```javascript
const SYSTEM = `Given a learning objective and concept list, return the IDs of the
most relevant concepts. Return ONLY a JSON array of ID strings. No preamble.`;

const USER = `Objective: "{freeFormPrompt}"

Concepts (id | name | summary):
{concepts.map(c => c.id + ' | ' + c.name + ' | ' + c.summary).join('\n')}

Return 5–10 concept IDs: ["id1", "id2", ...]`;
```

---

## SM-2 Algorithm (`src/lib/sm2.js`)

```javascript
function updateMastery(mastery, qualityScore) {
  // qualityScore 0–5: 0-2 failed, 3 correct/hard, 4 correct/hesitant, 5 correct/confident
  let { easeFactor, interval, repetitions } = mastery;

  if (qualityScore < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
  }

  // EF always updated regardless of pass/fail — failures decrease EF so hard concepts
  // get shorter review intervals and show lower mastery on visualizations
  easeFactor = Math.max(
    1.3,
    easeFactor + 0.1 - (5 - qualityScore) * (0.08 + (5 - qualityScore) * 0.02)
  );

  const nextReviewAt = new Date();
  nextReviewAt.setDate(nextReviewAt.getDate() + interval);

  return {
    ...mastery,
    easeFactor,
    interval,
    repetitions,
    score: Math.min(1.0, repetitions * 0.15),
    nextReviewAt: nextReviewAt.toISOString(),
    lastReviewedAt: new Date().toISOString()
  };
}

// Quality score mapping:
// MCQ wrong → 1
// MCQ correct, confidence 1 (Low) → 3
// MCQ correct, confidence 2 (Medium) → 4
// MCQ correct, confidence 3 (High) → 5
// Free-response: Math.floor(aiScore * 5), minus 1 if confidence === 1
```

---

## Environment Variables

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...      # for Socket Mode if not using HTTP
SLACK_USER_ID=U...             # Erick's Slack user ID — single user target

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Redis (Upstash)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
REDIS_URL=rediss://...          # ioredis connection string for BullMQ

# MCP
MCP_PORT=3001                   # port for SSE MCP endpoint

# App
PORT=3000
NODE_ENV=production
SINGLE_USER_ID=erick            # user ID for all Redis keys in single-user build
USER_TIMEZONE=America/Chicago
```

---

## Conventions

- Redis is the only datastore — no MongoDB, no filesystem in production
- All AI calls route through `src/ai/` only — no ad-hoc Anthropic calls elsewhere
- All prompts return JSON — parse defensively, retry once on failure
- BullMQ jobs are idempotent — always upsert by key, never create duplicates
- BullMQ session jobs cleaned up on session complete or abandon
- Bolt DM listeners scoped to `{ userId, channelId }` — never global
- Listeners deregistered immediately after expected reply is captured
- Confidence rating always collected before answer reveal
- Interleaving enforced at generation — consecutive questions must not share a concept
- Concepts seeded from `concepts-seed.json` on first boot only — check before writing
- `client/` directory does not exist in this build — do not create it
- MCP, MongoDB, Clerk, React are out of scope — do not introduce them
- At session start, read `AGENT_HANDOFF.md` and check Status — block on `AWAITING_COWORK`
- At end of meaningful sessions or when Erick types `wrap up`, write the handoff
  per the protocol above

---

## Build Sequence

Build in this exact order. Smoke test each step before proceeding.

1. **Scaffold** — Express server, Redis client, env config, Railway deploy, health check route
2. **Concept seeding** — load `concepts-seed.json` into Redis on first boot, `get_concepts` util
3. **AI services** — `questionGen.js`, `grading.js`, `conceptMatch.js` with test harness
4. **SM-2** — `sm2.js`, mastery read/write against Redis
5. **Slack app** — Bolt setup, slash command routing, event subscriptions, DM channel resolution
6. **Quiz flow** — MCQ delivery with buttons + confidence, non-MCQ reply-based, grading inline,
   completion summary, mastery updates
7. **`/mastery` command** — Unicode bar visualization, due-for-review list
8. **`/brief` command** — active session state, next review, last score (renamed from `/status` — DEC-018)
9. **Scheduler** — BullMQ setup, random ping job, weekly digest cron, daily snapshot cron
10. **Study session flow** — `/study start`, segment timers, synthesis warning, recall prompt,
    dynamic break detection, session end, wrap-up quiz offer
11. **MCP server** — SSE transport, all 6 tools, mount at `/mcp`
12. **Hardening** — edge cases, error handling, job cleanup on abandon, listener deregistration

---

## Out of Scope for This Build

- React frontend / web UI of any kind
- MongoDB
- Clerk auth
- Multi-user support
- Exam engine (all-questions-visible, timed)
- Web file upload
- Handwritten note OCR
- Full per-question results page
- Mastery heatmap visualization
