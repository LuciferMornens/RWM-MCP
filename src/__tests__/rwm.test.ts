import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { openDB } from "../db.js";
import type { RWMDB } from "../db.js";
import { handleMemoryCommit, pruneArtifactDirectory } from "../stateframe.js";
import type { StateFrameInput } from "../types.js";
import { factIdFor, sha256, rid } from "../utils.js";
import { normalizeSessionId, canonicalizeAlias, resetSessionCache } from "../session.js";
import { composeBundle } from "../bundle.js";
import { buildCheckpointMeta } from "../checkpoint.js";

const execFileAsync = promisify(execFile);

test("memory_commit deduplicates facts and preserves pointer URIs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rwm-test-"));
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const dbPath = join(dir, "rwm.db");
  const db = await openDB({ dbPath });

  const sessionId = "proj@test";
  const ts = new Date().toISOString();

  const pointerUri = "workspace://README.md";

  const baseInput: StateFrameInput = {
    session_id: sessionId,
    artifacts: [{ kind: "SNIPPET", uri: pointerUri }],
    facts: [{ key: "build", value: "npm run build", scope: "repo" }]
  };

  const outcome1 = await handleMemoryCommit(
    { db, root: dir, artifactsDir },
    baseInput,
    ts
  );

  const factId = factIdFor("build", "repo");
  let facts = db.listFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, factId);
  assert.equal(facts[0].value, "npm run build");

  const pointerId = outcome1.artifactIds[0];
  const artifactRecord = db.getArtifactById(pointerId);
  assert.ok(artifactRecord);
  assert.equal(artifactRecord?.uri, pointerUri);
  assert.equal(artifactRecord?.size, 0);
  const pointerHash = sha256(pointerUri);
  assert.equal(artifactRecord?.sha256, pointerHash);
  assert.equal(existsSync(join(artifactsDir, pointerHash)), false);
  const pointerMeta = artifactRecord?.meta_json ? JSON.parse(artifactRecord.meta_json) : {};
  assert.equal(pointerMeta.pointer, true);
  assert.equal(pointerMeta.origin.type, "workspace-uri");
  assert.ok(pointerMeta.origin.recordedAt);

  // Update fact value; ensure no duplication
  await handleMemoryCommit(
    { db, root: dir, artifactsDir },
    {
      session_id: sessionId,
      facts: [{ key: "build", value: "pnpm build", scope: "repo" }]
    },
    ts
  );

  facts = db.listFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].value, "pnpm build");
});

test("session normalization prefers git branch suffix", async () => {
  resetSessionCache();
  const dir = await mkdtemp(join(tmpdir(), "rwm-git-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });
  await execFileAsync("git", ["checkout", "-b", "feature/session"], { cwd: dir });

  const normalized = await normalizeSessionId("", dir);
  assert.match(normalized, /@feature-session$/);

  const override = await normalizeSessionId("proj@unknown", dir);
  assert.equal(override, "proj@feature-session");

  const alias = canonicalizeAlias("proj@unknown", dir);
  assert.equal(alias, "proj@unknown");
});

test("composeBundle always includes recent decisions and failures", () => {
  const now = new Date().toISOString();
  const fakeDb: Partial<RWMDB> = {
    listRecentEvents: () => [
      { id: "D-1", kind: "DECISION", summary: "picked approach", ts: now },
      { id: "F-1", kind: "TEST_FAIL", summary: "unit failed", ts: now },
      { id: "N-1", kind: "NOTE", summary: "misc", ts: now }
    ],
    listActiveTasks: () => [],
    listFacts: () => []
  };

  const bundle = composeBundle(fakeDb as RWMDB, {
    session_id: "proj@branch",
    tokenBudget: 100,
    modelFamily: "openai"
  });

  const pointerIds = bundle.structured.pointers.map((p: any) => p.id);
  assert(pointerIds.includes("D-1"));
  assert(pointerIds.includes("F-1"));
  assert(bundle.metrics.length >= pointerIds.length);
});

test("memory_commit links events to current task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rwm-task-"));
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const db = await openDB({ dbPath: join(dir, "rwm.db") });
  const ts = new Date().toISOString();

  await handleMemoryCommit(
    { db, root: dir, artifactsDir },
    {
      session_id: "proj@branch",
      task: "Implement feature",
      decisions: [{ type: "DECISION", summary: "Chose approach" }]
    },
    ts
  );

  const events = db.listRecentEvents("proj@branch", 5);
  assert.equal(events.length, 1);
  assert(events[0].task_id);
  const expectedTaskId = "T-" + "Implement feature".toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 12);
  assert.equal(events[0].task_id, expectedTaskId);
});

test("artifact metadata captures origin information", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rwm-origin-"));
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const db = await openDB({ dbPath: join(dir, "rwm.db") });
  const ts = new Date().toISOString();

  const outcome = await handleMemoryCommit(
    { db, root: dir, artifactsDir },
    {
      session_id: "proj@branch",
      artifacts: [{ kind: "SNIPPET", text: "console.log('hi')" }]
    },
    ts
  );

  const stored = db.getArtifactById(outcome.artifactIds[0]);
  assert(stored);
  const meta = stored.meta_json ? JSON.parse(stored.meta_json) : {};
  assert.equal(meta.origin.type, "text");
  assert.ok(meta.origin.recordedAt);
});

test("pruneArtifactDirectory removes orphaned files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rwm-prune-"));
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const db = await openDB({ dbPath: join(dir, "rwm.db") });

  const orphanPath = join(artifactsDir, "orphan" + Date.now());
  await writeFile(orphanPath, "junk");

  await pruneArtifactDirectory({ db, root: dir, artifactsDir });

  assert.equal(existsSync(orphanPath), false);
});

test("checkpoint meta summarizes session state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rwm-ckpt-"));
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const db = await openDB({ dbPath: join(dir, "rwm.db") });
  const session = "proj@branch";
  const ts = new Date().toISOString();

  await handleMemoryCommit(
    { db, root: dir, artifactsDir },
    {
      session_id: session,
      task: "Prep release",
      decisions: [{ type: "DECISION", summary: "Pick checklist" }],
      facts: [{ key: "build", value: "npm run build" }]
    },
    ts
  );

  const meta = buildCheckpointMeta(db, session);
  assert.equal(meta.objective, "Prep release");
  assert(meta.active_tasks.length >= 1);
  assert(meta.recent_events.some((e) => e.kind === "DECISION"));
  assert(meta.facts.some((f) => f.key === "build"));
});

test("token metrics can be recorded from bundle output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rwm-metrics-"));
  const artifactsDir = join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const db = await openDB({ dbPath: join(dir, "rwm.db") });
  const session = "proj@branch";
  const ts = new Date().toISOString();

  await handleMemoryCommit(
    { db, root: dir, artifactsDir },
    {
      session_id: session,
      task: "Write tests",
      decisions: [{ type: "DECISION", summary: "Add coverage" }]
    },
    ts
  );

  const bundle = composeBundle(db, { session_id: session, tokenBudget: 200, modelFamily: "openai" });
  assert(bundle.metrics.length > 0);

  for (const metric of bundle.metrics) {
    await db.upsertTokenMetric({
      id: rid("M"),
      session_id: session,
      pointer_id: metric.pointer_id,
      token_cost: metric.token_cost,
      budget: bundle.structured.budget,
      created_at: new Date().toISOString()
    });
  }

  const metrics = db.listTokenMetrics(session, 10);
  assert(metrics.length >= bundle.metrics.length);
});
