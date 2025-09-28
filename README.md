# Resumable Working Memory (RWM) MCP Server

RWM gives terminal coding agents (Codex CLI, Claude Code, etc.) a durable working memory. It records
structured state frames—decisions, diffs/snippets, test traces, durable facts—and when you resume a
session it returns a compact bundle of the most relevant context so the model can pick up exactly
where it left off.

The repository contains the TypeScript MCP server, a dynamic launcher that maps memories to the
current project automatically, and lightweight utility types.

---

## Features

- **Automatic per-project storage**: the launcher detects your working directory, reuses
  `rwm.db`/`rwm_artifacts/` if present, or creates them on first run.
- **Structured commits**: `memory_commit` enforces typed records for decisions, artifacts, and
  facts so memories stay verifiable.
- **Token-budgeted resume bundles**: `memory_resume` runs a knapsack over recent tasks/events/facts
  and returns a succinct “Now” card plus pointer IDs.
- **Safe workspace reads**: `memory_span` only serves files inside the configured root using
  `safeJoin`.
- **Optional tokenizer integration**: supports OpenAI and Anthropic token estimators when the
  packages are available, with graceful fallbacks.

---

## Requirements

- Node.js 18+
- npm (or a compatible package manager)

---

## Installation

```bash
# clone the repo
cd /path/to/your/projects
git clone https://github.com/LuciferMornens/RWM-MCP.git
cd rwm-mcp

# install dependencies and build
npm install
npm run build
```

This produces the compiled server at `dist/index.js`.

---

## Configure Codex CLI (once)

Add the launcher to `~/.codex/config.toml`:

```toml
[mcp_servers.rwm]
command = "node"
args = ["/absolute/path/to/rwm-mcp/tools/rwm-launch.mjs"]
```

Now, whenever you run `codex` inside a project:

1. The launcher discovers the current directory.
2. If `rwm.db` and `rwm_artifacts/` exist there, it reuses them; otherwise it creates them.
3. It forwards `--root`, `--db`, `--artifacts`, and the bundle token budget (default `4500`, overridable
   with the `RWM_BUNDLE_TOKENS` env var) to the compiled MCP server.

Memories are therefore scoped automatically to the project you’re in—no profile juggling or config
switching.

### Optional: Claude Code

Claude Code speaks MCP as well. Point its connector to the same launcher script and the behavior is
identical (per-project databases in the repo root).

---

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `memory_resume` | Return a “Now” bundle (objective, active tasks, last decisions/failures) plus pointer IDs within the given token budget. |
| `memory_commit` | Append a state frame containing decisions (`DECISION`, `ASSUMPTION`, `FIX`, `BLOCKER`, `NOTE`), artifacts (`DIFF`, `SNIPPET`, `CONFIG`, `FIXTURE`, `TEST_TRACE`, `LOG`, `OTHER`), and durable facts. |
| `memory_fetch` | Retrieve a record by ID. Artifacts return an `artifact://sha256/...` resource link. |
| `memory_span` | Read a specific file range (start/end line) within the configured root. |
| `memory_search` | Lightweight lookup for task/event/fact IDs matching a query. |
| `memory_checkpoint` | Create a labeled checkpoint for milestones. |

---

## Memory Flow

1. **Resume**: Call `memory_resume` with `session_id` (e.g., `repo@branch`). The bundle planner uses
   token estimates to fit the highest-value items under the configured budget.
2. **Fetch on demand**: Use `memory_fetch`/`memory_span` for any pointer ID you need to inspect.
3. **Commit frequently**: After meaningful steps (edits, tests, decisions) call `memory_commit` with
   structured entries so future sessions retain verifiable context.
4. **Checkpoint before risk**: `memory_checkpoint` creates durable restore points when needed.

Because memories live next to your project (`rwm.db`, `rwm_artifacts/`), the state survives across
Codex/Claude sessions, machine restarts, and even tool upgrades.

---

## Development

```bash
npm run build       # compile TypeScript to dist/
npm run dev         # optional: run with ts-node/esm loader
```

Tests are not included yet; add them under `src/` and wire into `package.json` when needed.

---

## License

MIT
