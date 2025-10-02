import type { RWMDB } from "./db.js";

export interface CheckpointMeta {
  objective: string | null;
  active_tasks: { id: string; title: string; status: string }[];
  recent_events: { id: string; kind: string; summary: string; ts: string }[];
  facts: { id: string; key: string; value: string; scope: string }[];
}

export function buildCheckpointMeta(db: RWMDB, sessionId: string): CheckpointMeta {
  const tasks = db.listActiveTasks(sessionId, 5);
  const events = db.listRecentEvents(sessionId, 5);
  const facts = db.listFacts().slice(0, 5);

  return {
    objective: tasks[0]?.title ?? null,
    active_tasks: tasks.map((t: any) => ({ id: t.id, title: t.title, status: t.status })),
    recent_events: events.map((e: any) => ({ id: e.id, kind: e.kind, summary: e.summary, ts: e.ts })),
    facts: facts.map((f: any) => ({ id: f.id, key: f.key, value: f.value, scope: f.scope }))
  };
}
