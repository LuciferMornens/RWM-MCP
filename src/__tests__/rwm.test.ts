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
import { handleMemoryCommit } from "../stateframe.js";
import type { StateFrameInput } from "../types.js";
import { factIdFor, sha256 } from "../utils.js";
import { normalizeSessionId, canonicalizeAlias, resetSessionCache } from "../session.js";
import { composeBundle } from "../bundle.js";

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
});
