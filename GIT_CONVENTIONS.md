# GIT_CONVENTIONS.md — StudyAgent Git Workflow
**Last Updated:** 2026-05-02
**Applies to:** Phase A and Phase B builds. Claude Code reads this at every session start.

---

## Branch Structure

| Branch | Purpose |
|---|---|
| `main` | Stable only. Never commit directly. Receives squash merges from passing step branches. |
| `step-N-description` | One branch per build step. Cut from main. Merged back via squash when smoke test passes. |

Phase B will introduce a `qa` branch between step branches and main once multi-user
deployment makes the local/Railway environment gap meaningful. No change to this workflow
required — just an additional merge hop.

---

## Branch Naming

**Phase A — step-scoped:**
```
feature/step-6-quiz-flow
feature/step-7-mastery-command
feature/step-8-brief-command
feature/step-9-scheduler
feature/step-10-study-session
feature/step-11-mcp-server
feature/step-12-hardening
```

**Phase B — semantically scoped (no step prefix):**
```
feature/enable-multi-user-sso
feature/mongodb-migration
feature/mastery-heatmap
feature/exam-engine
feature/session-history-page
```

**Other prefixes:**
```
fix/quiz-confidence-tap-ordering
chore/update-railway-env-vars
```

Always cut the new branch from main after the previous squash commit lands.
Never cut a branch from another feature branch.

---

## Commit Messages

Conventional commits with step scope:

```
feat(step-6): add MCQ delivery and Block Kit buttons
feat(step-6): add confidence tap before answer handling
fix(step-6): handle answer tap before confidence tap
test(step-6): add quiz flow smoke test harness
refactor(step-6): extract grading logic into quizFlow.js
chore(step-6): update .env.example with QUIZ_TIMEOUT_MS
```

**Types:** `feat` `fix` `test` `refactor` `chore` `docs`
**Subject line:** ≤72 characters, imperative mood, no period.
**Commit granularity:** per logical unit — new module, wired integration, passing function.
Not per line, not one giant commit per step.

---

## Step Completion Gate

```
1. All smoke test assertions pass
2. Open PR — title format:
     Phase A: "Step 6: Quiz flow"
     Phase B: "Enable multi-user SSO"
3. Squash merge to main
4. Delete feature branch
5. Cut next branch from main
```

No merge without a passing smoke test. PR is required even on a solo build —
it creates a clean per-step diff and serves as the build log artifact.

---

## Baseline

Steps 1–5 were completed before this convention was established. Current main is
tagged `v0-steps-1-5` as the baseline. Convention applies from Step 6 forward.

---

## What Claude Code Does Automatically

- Writes commit messages from the diff following the format above
- Runs `git commit` and `git push` when instructed
- Can open a PR via `gh pr create` if GitHub CLI is configured

Claude Code does not decide when to commit or merge without being told. Explicit
instructions at step completion: *"smoke tests pass, commit, open PR, squash merge to main."*
