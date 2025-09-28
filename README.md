Below is a crisp primer on **Codex CLI** and **Claude Code**, followed by a concrete, model‑agnostic design to *solve* the “context cap” problem for coding agents—without falling back to fragile “summarize the whole session into a blob” or vanilla vector‑RAG. The core idea is to give agents a **resumable, external working memory** that’s *structured, executable, and selectively rehydrated* into the model—so you can end and later resume a session at full fidelity while keeping prompts tiny.

---

## 1) Quick primer: what Codex CLI and Claude Code actually are

**Codex CLI (OpenAI)**

* A local coding agent you run from the terminal. It can read/modify/run code in a chosen directory; open‑source; supports macOS/Linux; Windows via WSL. ([OpenAI Developers][1])
* Official GitHub repo; supports **MCP (Model Context Protocol)** so you can wire in external tools and data sources. Config lives in `~/.codex/config.toml`. ([GitHub][2])
* Current community docs/discussions mention a **~272k token** context operationally referenced by users (with caveats re: caching vs “true” input size). ([GitHub][3])

**Claude Code (Anthropic)**

* An agentic coding tool in your terminal that maps/explains large codebases, writes code, runs tests, and files PRs; integrates with GitHub/GitLab and supports **MCP** connectors. You can pick models (e.g., `opus` or `sonnet`). ([Anthropic][4])
* Opus 4.1 typically runs with **200k tokens** of context; Sonnet 4 now supports **up to 1M tokens** via the API (broadening beyond the 200k baseline). The CLI exposes a `--model` flag. ([Anthropic][5])

**Reality check on “just make the window huge”:** Even million‑token contexts don’t erase all issues: long prompts are expensive, slow, and can still suffer from the *lost‑in‑the‑middle* effect where relevant details get overlooked inside long contexts. Prompt caching helps but is **ephemeral** (minutes‑scale) and won’t rescue a session you resume tomorrow. ([arXiv][6])

---

## 2) Why coding agents derail near the limit

* **Attention dilution / position effects:** LLMs often under‑use info buried deep in long prompts (“lost in the middle”). This is well‑documented and persists across models. ([arXiv][6])
* **Operational limits:** KV/prompt caching reduces cost/latency for repeated prefixes, but caches expire quickly (minutes to ~1 hour) and don’t survive long breaks. ([OpenAI][7])
* **Naive RAG & free‑text summaries:** Vector‑only recall and monolithic summaries degrade over long projects, drift, and are hard to *verify* or *addressably retrieve* with high precision. (Industry/academic commentary increasingly points out RAG’s brittleness vs. structured, tool‑aware approaches.) ([Databricks][8])

---

## 3) The design goal

> **Resume any coding session precisely where it left off—days or weeks later—without stuffing the entire history back into the prompt.**
> The agent should rehydrate only what’s *needed for the next step*, on demand.

---

## 4) Proposed solution: **Resumable Working Memory (RWM)**

*(A model‑agnostic external tool and MCP server you can attach to Codex CLI or Claude Code)*

### 4.1 Overview (what it is)

RWM is a **stateful memory service**—think “git for an agent’s *state of understanding* and *work in flight*.” It persists *structured* state (not just text) and serves **tiny, targeted “rehydration bundles”** to the model when you resume or switch tasks.

**Key principles**

1. **Structure > summary:** Store decisions, goals, constraints, diffs, test signals, and pointers as typed records—not a one‑page prose recap.
2. **Addressability:** Everything gets a **stable ID** and checksum so you can pull *exact* items back (e.g., decision `D:1234`, patch `P:7f3a…`, failing test `T:api-users-42`).
3. **Lazy hydration:** Inject *IDs + ultra‑compact descriptors* first; fetch bodies only when the model asks (via MCP tool calls).
4. **Token budgeter:** A small planner chooses the **next prompt’s** contents via a scoring function (knapsack over N tokens) to maximize “utility for the next action.”

### 4.2 Memory model (what we store)

RWM maintains four **typed memory lanes**:

1. **Canonical Task Graph (CTG)**

   * DAG of *Objectives → Tasks → Subtasks*, with edges to code artifacts (files, functions), tickets, and PRs.
   * Each node has: *goal, constraints, acceptance tests, blockers, status, owner, timestamps*.
   * Think Jira/Trello, but structured for an LLM agent (addressable IDs).

2. **Decision & Assumption Log (DAL)**

   * Append‑only event log of *DECISION*, *ASSUMPTION*, *BLOCKER*, *FIX*, *POSTMORTEM*.
   * Each entry points to evidence artifacts (test output, benchmark, spec section) and carries a short, **schema‑validated** justification field (e.g., “Chose library X due to Y”).
   * (Short, factual fields—*not* chain‑of‑thought transcripts.)

3. **Working‑Set Artifacts (WSA)**

   * The concrete *stuff in flight*:

     * **Diffs** (minimized, unified patches), **snippets** (line‑ranged spans), **config deltas**, and **fixtures**.
     * **Test traces** (failing tests with stack traces), **benchmarks**, **logs**.
   * Stored content‑addressed (hashes) and chunked so the agent can fetch *just* the span it needs (e.g., `file://router.ts#L120-168`).

4. **Environment & Interface Facts (EIF)**

   * Stable facts the agent must never forget: repo layout, service endpoints, auth scopes, `make`/`npm` scripts, non‑obvious conventions, “do‑not‑touch” zones, etc.
   * This replaces sprawling “project summary” walls with a **compact, queryable facts table**.
   * (For Claude Code you might already keep a `CLAUDE.md`; here we normalize it into addressable facts.) ([ClaudeLog][9])

> **Why this beats RAG:** we’re not hoping cosine similarity finds the right chunk. We’re **naming and keying the truth**—decisions, tasks, diffs, tests—so the agent can pull the *exact* items it needs.

### 4.3 The Rehydration Bundle (what goes into the prompt)

On resume (or before any big step), RWM composes a **Bundle** within a token budget (e.g., 2–5k tokens):

* **Now card**: current *objective*, *active task(s)*, *acceptance criteria*, *known blockers*.
* **Pointers**: IDs for the last handful of decisions and artifacts *on the critical path* (not everything).
* **Minimal evidence**: tiny excerpts (e.g., failing test message lines) to ground the next action.
* **Pull‑on‑demand hooks (MCP)**: the agent can call `memory.fetch(id)` or `memory.span(file, L..R)` to load bodies **only if needed**.

The agent sees *just enough* to proceed, with hyperlinks (MCP resource IDs) to fetch specifics as it works.

### 4.4 Selection algorithm (how we fit inside the window)

We rank candidate items by an **Expected Utility score** for the *next step*:

```
U(item) = α·TaskProximity + β·Recency + γ·ChangeImpact + δ·EvidenceWeight − λ·TokenCost
```

* **TaskProximity**: shortest path in CTG from current task to the item’s node.
* **ChangeImpact**: e.g., a diff that touches widely‑imported modules > isolated comments (computed from static import graph).
* **EvidenceWeight**: failing tests and recent rollbacks rank high.
* Solve a simple **knapsack** over the token budget to pick the set that maximizes ∑U. (Greedy with look‑ahead is plenty fast.)

*(This avoids the “lost‑in‑the‑middle” anti‑pattern by aggressively curating what’s in the window and keeping the rest fetchable.)* ([arXiv][6])

### 4.5 Protocol & integration (how agents use it)

Implement RWM as an **MCP server** so both tools can talk to it:

**Core MCP tools**

* `memory.resume(session_id) -> Bundle`
* `memory.commit(events[], artifacts[]) -> ack` *(append to DAL/WSA)*
* `memory.fetch(id) -> {meta, body}`
* `memory.span(uri, L, R) -> code_snippet`
* `memory.search(query, filters) -> ids[]` *(optional, scoped search—not generic RAG)*
* `memory.checkpoint(label) -> checkpoint_id` *(for explicit “save points”)*

**Attach to tools**

* **Claude Code**: add RWM MCP server via the built‑in MCP integration. Use `--model` per your needs (e.g., `opus` vs `sonnet` 1M on API). ([Claude Docs][10])
* **Codex CLI**: enable MCP in `~/.codex/config.toml` and register the RWM server. ([GitHub][2])

### 4.6 What gets *written* as you work (so you can resume later)

After each meaningful turn (commit, test run, migration, incident), the agent **emits a small “State Frame”** (structured JSON) that RWM appends:

```json
{
  "ts": "2025-09-28T14:03:11Z",
  "task": "T-142 Add rate limit to /auth/login",
  "decisions": [{"id":"D-981","type":"DECISION","summary":"Use token-bucket at gateway","evidence":["T-auth-17"]}],
  "artifacts": [
    {"id":"P-7f3a","type":"DIFF","uri":"repo://gateway/rate_limit.go","lines": [40, 112]},
    {"id":"T-auth-17","type":"TEST_FAIL","msg":"expected 429, got 200"}
  ],
  "next_actions": ["fix test stub", "update config default burst=5"]
}
```

These frames are small, additive, and **verifiable** (artifacts have checksums). No giant narrative. No hallucinated history.

### 4.7 Guardrails & reliability

* **Deterministic references**: We prefer *diffs, spans, test IDs* over free‑form paragraphs.
* **Verification hooks**: After rehydration, run **lightweight “memory sanity checks”** (e.g., ask the agent to recite the *objective, acceptance criteria, last failing test, and open blockers*). If it fails, escalate token budget or fetch the missing items.
* **Prompt caching (opportunistic)**: Keep stable parts of the Bundle cacheable within a session to cut cost, but never rely on it across days since caches expire within ~hour. ([OpenAI][7])

---

## 5) Why this works better than RAG‑or‑summary

* **High‑precision recall:** You pull *exact* things you named earlier (decisions, diffs, tests), instead of hoping nearest‑neighbors retrieve the right prose chunk. ([Databricks][8])
* **Lost‑in‑the‑middle resistant:** Bundles are kept **short** and **purpose‑built** for the *next step*. ([arXiv][6])
* **Model‑agnostic & portable:** Works with Codex or Claude Code via MCP, and survives model swaps or upgrades. ([OpenAI GitHub][11])
* **Auditable memory:** Every important choice is an addressable record with links to evidence (tests/logs), so you can reconstruct why something happened—without replaying 200k tokens.

---

## 6) Minimal schema (so you can implement tomorrow)

**Tables (SQLite/Postgres)**

* `tasks(id, parent_id, title, status, accept_criteria, created_at, updated_at)`
* `edges(src_id, dst_id, kind)`  // dependency graph
* `events(id, kind, task_id, summary, evidence_ids[], ts)`
* `artifacts(id, kind, uri, sha256, meta_json, created_at)`
* `facts(id, key, value, scope)`  // environment/interface facts
* `checkpoints(id, session_id, label, ts, bundle_meta)`

**Files**

* Artifact bodies on disk/S3 by `sha256`.
* Optional Git notes for cross‑referencing commits ↔ events.

---

## 7) The resume handshake (end‑to‑end)

1. **User**: `codex` or `claude` in repo root.
2. **Agent (first prompt)**: “Resume `session: s-2025-09-27`.”
3. **RWM**: `memory.resume(s-…)` → returns Bundle (Now card + pointers).
4. **Agent**: Reads Bundle, asks for missing bodies via `memory.fetch(id)` as needed, then acts (edit, run tests, etc.).
5. **Agent**: Emits a **State Frame** to `memory.commit(...)`.
6. **Repeat** until done. Optionally `memory.checkpoint("before-migration")`.

The **bundle** usually weighs in at a few thousand tokens; heavy bodies are lazy‑loaded via MCP only when necessary.

---

## 8) Integration tips for Codex CLI & Claude Code

* **Claude Code**

  * Use the CLI’s `--model` to select **Opus 4.1 (200k)** or **Sonnet 4 (up to 1M via API)** depending on task size and budget. ([Claude Docs][12])
  * Keep a slim `CLAUDE.md` for stable house rules, but migrate “facts” into EIF so they’re addressable and fetchable as key‑value pairs instead of long prose. ([ClaudeLog][9])

* **Codex CLI**

  * Create `~/.codex/config.toml`; add an `mcp_servers` entry for the RWM server. ([GitHub][2])
  * If you’re juggling providers (OpenAI, Azure, Bedrock), store profiles in TOML and let RWM stay constant across them. ([Microsoft Learn][13])
  * To keep project memories isolated without editing `config.toml` per repo, use the dynamic launcher:

    ```toml
    [mcp_servers.rwm]
    command = "node"
    args = ["/Volumes/ExternalSSD/rmw-mcp/tools/rwm-launch.mjs"]
    ```

    The launcher infers the current working directory, ensures `rwm.db` and `rwm_artifacts/` live inside that project, and points the MCP server at them. On an existing project it reuses the files; on a new project it creates them the first time you run Codex there.

---

## 9) Measuring success (so we know it’s working)

* **Resume fidelity:** Within 1–2 turns after resume, can the agent restate *objective, current task, acceptance tests, last failing test, and the last 3 decisions* **without** extra fetches? (Y/N)
* **Token efficiency:** Avg input tokens per turn **before** vs **after** RWM, at equal task difficulty.
* **Error rate:** Fewer “re‑do” edits after long breaks?
* **Time‑to‑PR:** Wall‑clock delta to get back to productive edits after a cold start.
* **Lost‑context incidents:** Number of times the agent asks for “what were we doing again?”

---

## 10) Known limitations & mitigations

* **If you never formalize decisions**, you lose the main benefit. *Mitigation:* enforce micro‑frames (the 20‑second “State Frame” after meaningful actions).
* **Model hallucination about IDs:** The agent may guess `D-123` when it’s `D-132`. *Mitigation:* MCP validates IDs and offers autocomplete (`memory.search`).
* **Giant diffs:** Split into **spans** and fetch line‑ranges; always prefer diffs over full files to minimize prompt size.

---

## 11) Related capabilities you *can* leverage (but don’t rely on)

* **Prompt caching** (OpenAI/Anthropic/Bedrock) to reduce cost on recurring prefixes during an *active* session; don’t count on it for next‑day resumes due to short expiry. ([OpenAI Platform][14])
* **1M‑token contexts (Sonnet 4)** for *importing large references once* (e.g., first onboarding pass), then slice them into EIF/WSA and discard the bulk. ([Anthropic][15])

---

### Bottom line

You don’t need infinite context. You need **addressable, verifiable, and lazily rehydratable state**. RWM gives Codex CLI and Claude Code the same “long‑term memory muscle” via MCP—so a 200k/272k cap stops being a practical limit.

If you’d like, I can sketch a minimal **MCP server interface** (TypeScript or Python) for `memory.resume/fetch/commit` and a tiny SQLite schema you can drop into your repo to pilot this.

[1]: https://developers.openai.com/codex/cli/?utm_source=chatgpt.com "Codex CLI"
[2]: https://github.com/openai/codex?utm_source=chatgpt.com "openai/codex: Lightweight coding agent that runs in your ..."
[3]: https://github.com/openai/codex/discussions/1999?utm_source=chatgpt.com "How large is the context window when Codex is used via a ..."
[4]: https://www.anthropic.com/claude-code?utm_source=chatgpt.com "Claude Code: Deep coding at terminal velocity \ Anthropic"
[5]: https://www.anthropic.com/claude/opus?utm_source=chatgpt.com "Claude Opus 4.1"
[6]: https://arxiv.org/abs/2307.03172?utm_source=chatgpt.com "Lost in the Middle: How Language Models Use Long Contexts"
[7]: https://openai.com/index/api-prompt-caching/?utm_source=chatgpt.com "Prompt Caching in the API"
[8]: https://www.databricks.com/blog/long-context-rag-performance-llms?utm_source=chatgpt.com "Long Context RAG Performance of LLMs"
[9]: https://www.claudelog.com/faqs/what-is-claude-md/?utm_source=chatgpt.com "What is CLAUDE.md in Claude Code"
[10]: https://docs.claude.com/en/docs/claude-code/mcp?utm_source=chatgpt.com "Connect Claude Code to tools via MCP"
[11]: https://openai.github.io/openai-agents-python/mcp/?utm_source=chatgpt.com "Model context protocol (MCP) - OpenAI Agents SDK"
[12]: https://docs.claude.com/en/docs/claude-code/cli-reference "CLI reference - Claude Docs"
[13]: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/codex?utm_source=chatgpt.com "Codex with Azure OpenAI in AI Foundry Models"
[14]: https://platform.openai.com/docs/guides/prompt-caching?utm_source=chatgpt.com "Prompt caching - OpenAI API"
[15]: https://www.anthropic.com/news/1m-context?utm_source=chatgpt.com "Claude Sonnet 4 now supports 1M tokens of context"
