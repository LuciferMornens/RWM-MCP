# AGENTS.md — Resumable Working Memory (RWM) for Codex CLI

> **Purpose**  
> Coding sessions often exceed the model’s context window. This project uses an external **Resumable Working Memory (RWM)** service (exposed via **MCP**) so Codex can **resume exactly where it left off** without re‑injecting long histories. RWM stores structured, addressable state (tasks, decisions, artifacts/snippets, and durable facts) and serves a **small rehydration bundle** on demand.

---

## How to operate the RWM MCP (agent rules)

**Always resume first**  
Call the MCP tool **`memory_resume`** with a stable `session_id` and a modest `token_budget` (≈ 2–5k). Use the Now‑card to restate the **objective, active tasks, last decisions, and any failing tests**. Fetch bodies *only if needed*.

**Work in small, verifiable steps**  
After each meaningful change (edit, test run, migration), call **`memory_commit`** to append a micro‑frame:
- `decisions`: brief, factual (`type`, `summary`, `evidence` IDs). The `type` **must** be one of `DECISION`, `ASSUMPTION`, `FIX`, `BLOCKER`, or `NOTE`. Use these labels even for code updates or test outcomes, and reference artifacts via their IDs in `evidence`.  
- `artifacts`: **real diffs or file spans** with line content, plus short test traces. Prefer staged Git diffs (`git diff --cached`) when available so the snippet matches the repo exactly; otherwise generate faithful patch text manually. Set `kind` using the uppercase enums `DIFF`, `SNIPPET`, `CONFIG`, `FIXTURE`, `TEST_TRACE`, `LOG`, or `OTHER`. Avoid prose summaries without code.  
- `facts`: durable project rules (build/test commands, repo conventions).

- When the change is complete and tests pass, stage the files and create a concise commit (`git commit -am "<summary>"`) before moving on. Keep commits scoped to one logical improvement.
- If you must correct a stored task, artifact excerpt, or fact, call **`memory_update`** with the record ID (e.g., `T-…`, `P-…`, `F-…`) and supply only the fields that changed.

**Fetch precisely, not broadly**  
- Use **`memory_fetch(id)`** for a record by ID (artifacts return a resource link).  
- Use **`memory_span(path, startLine, endLine)`** to read *exact* code ranges from the workspace (read‑only).  
- Avoid re‑injecting large, redundant context into prompts.

**Checkpoint before risk**  
For large refactors, releases, or schema changes, create a save point with **`memory_checkpoint(label)`**.

**If information seems missing**  
Increase the `token_budget` on the next **`memory_resume`**, or fetch specific bodies by ID. Do **not** dump long histories; keep the bundle lean.

**Safety & hygiene**  
- Do **not** store secrets or credentials in memory.  
- Keep entries factual; avoid long narratives.  
- Prefer deterministic identifiers and spans (e.g., `P-7f3a`, `router.ts#L120-168`).

**If the RWM MCP is unavailable**  
Proceed with minimal context, clearly state that RWM was not found, and request that it be enabled. Continue work conservatively.

---

## MCP tools exposed by RWM (reference)

- **`memory_resume(session_id, token_budget)`** → returns a compact **Now‑card** + **pointers** (IDs) for relevant tasks, decisions, failures, and facts.  
- **`memory_commit({...})`** → appends micro‑frames: decisions, artifacts (diffs/spans/test traces), facts.  
- **`memory_update({...})`** → updates an existing task (title/status/acceptance), artifact snippet/metadata, or fact by ID.  
- **`memory_fetch(id)`** → returns a record by ID (artifacts as `artifact://sha256/<hash>` resource links).  
- **`memory_span(path, startLine, endLine)`** → returns a read‑only file span from the current workspace.  
- **`memory_search(session_id, query)`** → finds IDs for tasks/events/facts.  
- **`memory_checkpoint(label)`** → creates a named restore point.

---

## Required programmatic checks

You **must** run programmatic checks described here before finishing a task:
1. **Memory sanity check**: After `memory_resume`, restate verbally the *objective, active tasks, last 3 decisions, and last failing test IDs*. If you cannot, fetch the missing records and try again.  
2. **Repository hygiene**: Ensure `git status` is clean before finishing.  
3. **Tests (if present)**: Detect and run the project’s test command (e.g., `pnpm test`, `npm test`, `yarn test`, or `pytest -q`). If a test suite exists, it **must** pass unless the user instructs otherwise.

---

## Session conventions

- **`session_id`**: derive from repo and branch (e.g., `<repo>@<branch>`). Run `git rev-parse --abbrev-ref HEAD` to discover the branch; if Git is unavailable, fall back to `<repo>@<YYYY-MM-DD>`—never leave it as `@unknown`.  
- **Bundles**: keep under a few thousand tokens; fetch heavy bodies lazily.  
- **Consistency**: after each critical step, `memory_commit` a micro‑frame so sessions are fully resumable later.

---

## Scope & precedence

- This file applies to the **entire repository subtree** where it resides.  
- If a **more deeply nested `AGENTS.md`** exists, **the nested file takes precedence** for files in its subtree.  
- Direct user instructions always override anything in `AGENTS.md`.

---

## Quick examples (for the agent)

- **Cold resume**  
  1. `memory_resume({ "session_id": "<repo>@<branch>", "token_budget": 3000 })`  
  2. If needed: `memory_fetch("D-981")` or `memory_span("gateway/rate_limit.go", 40, 112)`  
  3. After changes/tests: `memory_commit({ ... })`

- **Record a failure**  
  `memory_commit({ decisions:[{ "type":"BLOCKER", "summary":"login returns 200 not 429", "evidence":["A-login-trace"] }], artifacts:[{ "id":"A-login-trace", "kind":"TEST_TRACE", "text":"python -m pytest\n1 failed: expected 429, got 200" }] })`

- **Tidy a task status**  
  `memory_update({ "target":"task", "id":"T-login-cleanup", "status":"done" })`

- **Checkpoint before migration**  
  `memory_checkpoint({ "session_id":"<repo>@<branch>", "label":"before-db-migration" })`

---
