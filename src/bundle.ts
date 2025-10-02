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
  const nowTime = Date.now();

  type Item = { id: string; type: "EVENT" | "TASK" | "FACT"; text: string; tokenCost: number; score: number; meta?: any };
  const items: Item[] = [];

  for (const t of activeTasks) {
    const text = `TASK ${t.id}: ${t.title} [${t.status}]` + (t.accept_criteria ? `\nACCEPT: ${t.accept_criteria}` : "");
    const updated = t.updated_at ? Date.parse(t.updated_at) : nowTime;
    const ageHours = Math.max(0, (nowTime - updated) / (1000 * 60 * 60));
    const recencyBoost = Math.max(0, 3 - ageHours * 0.5);
    items.push({
      id: t.id,
      type: "TASK",
      text,
      tokenCost: estimateTokens(text, { family: modelFamily }),
      score: 5.0 + recencyBoost,
      meta: t
    });
  }

  for (const e of recentEvents) {
    const text = `${e.kind} ${e.id}: ${e.summary}`;
    const base = (e.kind === "TEST_FAIL" || e.kind === "BLOCKER") ? 4.0 : (e.kind === "DECISION" ? 3.5 : 2.0);
    const ts = e.ts ? Date.parse(e.ts) : nowTime;
    const ageHours = Math.max(0, (nowTime - ts) / (1000 * 60 * 60));
    const recencyBoost = Math.max(0, 4 - ageHours);
    items.push({
      id: e.id,
      type: "EVENT",
      text,
      tokenCost: estimateTokens(text, { family: modelFamily }),
      score: base + recencyBoost,
      meta: e
    });
  }

  for (const f of facts) {
    const text = `FACT ${f.key}=${f.value} (${f.scope})`;
    items.push({ id: f.id, type:"FACT", text, tokenCost: estimateTokens(text, { family: modelFamily }), score: 1.5, meta: f });
  }

  // Greedy knapsack by utility density
  const sorted = items.slice().sort((a, b) => (b.score / (b.tokenCost + 1)) - (a.score / (a.tokenCost + 1)));
  const decisionIds = new Set(
    recentEvents.filter((e: any) => e.kind === "DECISION").slice(0, 3).map((e: any) => e.id)
  );
  const failureIds = new Set(
    recentEvents.filter((e: any) => e.kind === "TEST_FAIL" || e.kind === "BLOCKER").slice(0, 3).map((e: any) => e.id)
  );

  const mandatoryIds = new Set<string>([...decisionIds, ...failureIds]);
  const picked: Item[] = [];
  let used = 0;

  const addItem = (it: Item) => {
    if (picked.find((p) => p.id === it.id)) return;
    if (it.tokenCost > 0 && used + it.tokenCost > tokenBudget) return;
    picked.push(it);
    used += it.tokenCost;
  };

  const mandatoryItems = items
    .filter((it) => mandatoryIds.has(it.id))
    .sort((a, b) => {
      const tsA = a.meta?.ts ? Date.parse(a.meta.ts) : 0;
      const tsB = b.meta?.ts ? Date.parse(b.meta.ts) : 0;
      return tsB - tsA;
    });

  for (const it of mandatoryItems) {
    addItem(it);
  }

  for (const it of sorted) {
    addItem(it);
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
