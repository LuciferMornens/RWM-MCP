import { resolve } from "node:path";
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

import type { RWMDB } from "./db.js";
import type { StateFrameInput } from "./types.js";
import { safeJoin } from "./security.js";
import { factIdFor, rid, sha256 } from "./utils.js";

export interface CommitContext {
  db: RWMDB;
  root: string;
  artifactsDir: string;
}

export interface CommitOutcome {
  artifactIds: string[];
}

interface PreparedArtifact {
  record: {
    id: string;
    kind: string;
    uri: string;
    sha256: string;
    size: number;
    meta_json: string;
    created_at: string;
  };
  id: string;
}

export async function handleMemoryCommit(
  ctx: CommitContext,
  args: StateFrameInput,
  ts: string
): Promise<CommitOutcome> {
  const artifactIds: string[] = [];
  let currentTaskId: string | null = null;

  if (args.task) {
    const taskId = buildTaskId(args.task);
    currentTaskId = taskId;
    await ctx.db.upsertTask({
      id: taskId,
      session_id: args.session_id,
      parent_id: null,
      title: args.task,
      status: "doing",
      accept_criteria: null,
      created_at: ts,
      updated_at: ts
    });
  }

  for (const artifact of args.artifacts ?? []) {
    const prepared = await prepareArtifact(ctx, artifact, ts);
    await ctx.db.upsertArtifact(prepared.record);
    artifactIds.push(prepared.id);
  }

  for (const decision of args.decisions ?? []) {
    await ctx.db.insertEvent({
      id: decision.id ?? rid("D"),
      kind: decision.type,
      task_id: decision.task_id ?? currentTaskId,
      session_id: args.session_id,
      summary: decision.summary,
      evidence_ids: JSON.stringify(decision.evidence ?? artifactIds),
      ts
    });
  }

  for (const fact of args.facts ?? []) {
    const scope = fact.scope ?? "repo";
    const factId = factIdFor(fact.key, scope);
    await ctx.db.upsertFact({ id: factId, key: fact.key, value: fact.value, scope });
  }

  await pruneArtifactDirectory(ctx);

  return { artifactIds };
}

function buildTaskId(task: string): string {
  return "T-" + task.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 12);
}

async function prepareArtifact(
  ctx: CommitContext,
  artifact: NonNullable<StateFrameInput["artifacts"]>[number],
  ts: string
): Promise<PreparedArtifact> {
  const meta = artifact.meta ? { ...artifact.meta } : {};
  let text = artifact.text;

  if (!text && artifact.path) {
    const full = safeJoin(ctx.root, artifact.path);
    const fileTxt = (await readFile(full, "utf8")).split("\n");
    const start = artifact.startLine ?? 1;
    const end = artifact.endLine ?? fileTxt.length;
    text = fileTxt.slice(start - 1, end).join("\n");
    Object.assign(meta, { path: artifact.path, startLine: start, endLine: end });
    if (!meta.origin) {
      meta.origin = { type: "workspace", recordedAt: ts };
    }
  }

  if (text !== undefined) {
    const data = Buffer.from(text, "utf8");
    const hash = sha256(data);
    const outPath = resolve(ctx.artifactsDir, hash);
    if (!existsSync(outPath)) {
      await writeFile(outPath, data);
    }
    const id = artifact.id ?? `P-${hash.slice(0, 8)}`;
    if (!meta.origin) {
      meta.origin = { type: "text", recordedAt: ts };
    }
    return {
      id,
      record: {
        id,
        kind: artifact.kind,
        uri: `artifact://sha256/${hash}`,
        sha256: hash,
        size: data.length,
        meta_json: JSON.stringify(meta ?? {}),
        created_at: ts
      }
    };
  }

  if (artifact.uri) {
    const pointerHash = sha256(artifact.uri);
    const id = artifact.id ?? `P-${pointerHash.slice(0, 8)}`;
    if (!Object.prototype.hasOwnProperty.call(meta, "pointer")) {
      meta.pointer = true;
    }
    if (!meta.origin) {
      const originType = artifact.uri.startsWith("workspace://") ? "workspace-uri" : "uri";
      meta.origin = { type: originType, recordedAt: ts };
    }
    return {
      id,
      record: {
        id,
        kind: artifact.kind,
        uri: artifact.uri,
        sha256: pointerHash,
        size: 0,
        meta_json: JSON.stringify(meta ?? {}),
        created_at: ts
      }
    };
  }

  // Fallback: empty text artifact to maintain compatibility
  const data = Buffer.from("", "utf8");
  const hash = sha256(data);
  const outPath = resolve(ctx.artifactsDir, hash);
  if (!existsSync(outPath)) {
    await writeFile(outPath, data);
  }
  const id = artifact.id ?? `P-${hash.slice(0, 8)}`;
  if (!meta.origin) {
    meta.origin = { type: "empty", recordedAt: ts };
  }
  return {
    id,
    record: {
      id,
      kind: artifact.kind,
      uri: `artifact://sha256/${hash}`,
      sha256: hash,
      size: 0,
      meta_json: JSON.stringify(meta ?? {}),
      created_at: ts
    }
  };
}

export { prepareArtifact };

export async function pruneArtifactDirectory(ctx: CommitContext) {
  let entries: string[];
  try {
    entries = await readdir(ctx.artifactsDir);
  } catch {
    return;
  }
  const known = new Set(ctx.db.listArtifactHashes?.() ?? []);
  for (const name of entries) {
    if (!known.has(name)) {
      const full = resolve(ctx.artifactsDir, name);
      try {
        await unlink(full);
      } catch {
        // ignore failures; pruning is best-effort
      }
    }
  }
}
