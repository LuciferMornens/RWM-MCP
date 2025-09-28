import type { RWMDB } from "./db.js";
import { estimateTokens } from "./tokenizer.js";

export interface BundleOpts {
  tokenBudget: number; // e.g., 3000
  session_id: string;
  modelFamily?: "openai" | "anthropic" | "generic";
}

export function composeBundle(db: RWMDB, opts: BundleOpts) {
  const { session_id, tokenBudget, modelFamily = "openai" } = opts;

  // Pull candidates via the DB API
  const recentEvents = db.listRecentEvents(session_id, 100);
  const activeTasks  = db.listActiveTasks(session_id, 20);
  const facts        = db.listFacts();

  type Item = { id: string; type: "EVENT" | "TASK" | "FACT"; text: string; tokenCost: number; score: number; meta?: any };
  const items: Item[] = [];

  for (const t of activeTasks) {
    const text = `TASK ${t.id}: ${t.title} [${t.status}]` + (t.accept_criteria ? `\nACCEPT: ${t.accept_criteria}` : "");
    items.push({ id: t.id, type:"TASK", text, tokenCost: estimateTokens(text, { family: modelFamily }), score: 5.0, meta: t });
  }

  for (const e of recentEvents) {
    const text = `${e.kind} ${e.id}: ${e.summary}`;
    const base = (e.kind === "TEST_FAIL" || e.kind === "BLOCKER") ? 4.0 : (e.kind === "DECISION" ? 3.5 : 2.0);
    items.push({ id: e.id, type:"EVENT", text, tokenCost: estimateTokens(text, { family: modelFamily }), score: base, meta: e });
  }

  for (const f of facts) {
    const text = `FACT ${f.key}=${f.value} (${f.scope})`;
    items.push({ id: f.id, type:"FACT", text, tokenCost: estimateTokens(text, { family: modelFamily }), score: 1.5, meta: f });
  }

  // Greedy knapsack by utility density
  const sorted = items.sort((a, b) => (b.score / (b.tokenCost + 1)) - (a.score / (a.tokenCost + 1)));
  let used = 0;
  const picked: Item[] = [];
  for (const it of sorted) {
    if (used + it.tokenCost > tokenBudget) continue;
    picked.push(it);
    used += it.tokenCost;
  }

  const now = {
    objective: activeTasks[0]?.title ?? "No active task",
    active_task_ids: activeTasks.map((t: any) => t.id),
    last_decisions: recentEvents.filter((e: any) => e.kind === "DECISION").slice(0, 5).map((e: any) => e.id),
    last_failures: recentEvents.filter((e: any) => e.kind === "TEST_FAIL").slice(0, 5).map((e: any) => e.id),
  };

  const summaryText =
`NOW:
- Objective: ${now.objective}
- Active: ${now.active_task_ids.join(", ") || "—"}
- Decisions: ${now.last_decisions.join(", ") || "—"}
- Failing tests: ${now.last_failures.join(", ") || "—"}

POINTERS:
${picked.map(p => `• ${p.type} ${p.id}`).join("\n")}`;

  return {
    text: summaryText,
    structured: {
      now,
      pointers: picked.map(p => ({ id: p.id, type: p.type })),
      token_estimate: used,
      budget: tokenBudget
    }
  };
}
