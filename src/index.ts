import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { openDB } from "./db.js";
import { composeBundle } from "./bundle.js";
import { sha256, nowISO, rid } from "./utils.js";
import { safeJoin } from "./security.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import type { Family } from "./tokenizer.js";

interface CLIArgs {
  db: string;
  root: string;
  artifacts: string;
  bundleTokens: number;
  modelFamily: Family;
}

function expectString(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  throw new TypeError(`${name} must be a string`);
}

function expectNumber(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError(`${name} must be a finite number`);
}

function expectFamily(value: unknown): Family {
  const str = expectString(value, "modelFamily");
  if (str === "openai" || str === "anthropic" || str === "generic") {
    return str;
  }
  throw new TypeError("modelFamily must be one of openai, anthropic, or generic");
}

function expectTemplateVar(value: string | string[], name: string): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
    return value[0];
  }
  throw new TypeError(`${name} must resolve to a single string segment`);
}

const parser = yargs(hideBin(process.argv))
  .parserConfiguration({ "duplicate-arguments-array": false })
  .option("db", { type: "string", default: resolve(process.cwd(), "rwm.db") })
  .option("root", { type: "string", default: process.cwd(), describe: "workspace root (read-only)" })
  .option("artifacts", { type: "string", default: resolve(process.cwd(), "artifacts") })
  .option("bundleTokens", { type: "number", default: 3000 })
  .option("modelFamily", { type: "string", default: "openai", describe: "openai|anthropic|generic" })
  .strict();

const parsed = await parser.parse();

const argv: CLIArgs = {
  db: expectString(parsed.db, "db"),
  root: expectString(parsed.root, "root"),
  artifacts: expectString(parsed.artifacts, "artifacts"),
  bundleTokens: expectNumber(parsed.bundleTokens, "bundleTokens"),
  modelFamily: expectFamily(parsed.modelFamily)
};

// DB (SQL.js / WASM)
const db = await openDB({ dbPath: argv.db });

// ensure artifacts dir
if (!existsSync(argv.artifacts)) {
  await mkdir(argv.artifacts, { recursive: true });
}

const server = new McpServer({ name: "rwm", version: "0.1.1" });

/** ----------------------- Resources ----------------------- **/

// Content-addressed artifacts: artifact://sha256/<hash>
server.registerResource(
  "artifact",
  new ResourceTemplate("artifact://sha256/{hash}", { list: undefined }),
  { title: "RWM Artifact", description: "Content-addressed artifact" },
  async (uri, { hash }) => {
    const hashValue = expectTemplateVar(hash, "hash");
    const path = resolve(argv.artifacts, hashValue);
    const buf = await readFile(path);
    return {
      contents: [{
        uri: uri.href,
        ...(isProbablyText(buf) ? { text: buf.toString("utf8"), mimeType: "text/plain" }
                                : { blob: buf.toString("base64"), mimeType: "application/octet-stream" })
      }]
    };
  }
);

// Read-only workspace files: workspace://{relpath}
server.registerResource(
  "workspace-file",
  new ResourceTemplate("workspace://{path}", { list: undefined }),
  { title: "Workspace File", description: "Read-only file under workspace root" },
  async (uri, { path }) => {
    const relPath = expectTemplateVar(path, "path");
    const full = safeJoin(argv.root, relPath);
    const buf = await readFile(full);
    return {
      contents: [{
        uri: uri.href,
        text: buf.toString("utf8"),
        mimeType: "text/plain",
        annotations: { audience: ["assistant", "user"] as const }
      }]
    };
  }
);

/** ----------------------- Tools ----------------------- **/

const artifactKinds = ["DIFF", "SNIPPET", "CONFIG", "FIXTURE", "TEST_TRACE", "LOG", "OTHER"] as const;
const artifactKindEnum = z.enum(artifactKinds);
const factScopes = ["repo", "service", "team", "global"] as const;
const factScopeEnum = z.enum(factScopes);
const taskStatuses = ["todo", "doing", "blocked", "done", "review"] as const;
const taskStatusEnum = z.enum(taskStatuses);

const memoryResumeInput = {
  session_id: z.string(),
  token_budget: z.number().int().positive().max(1_000_000).optional()
} satisfies ZodRawShape;

// memory_resume
server.registerTool("memory_resume",
  {
    title: "Resume a session",
    description: "Return a compact bundle (Now card + pointers) to resume work",
    inputSchema: memoryResumeInput
  },
  async ({ session_id, token_budget }) => {
    const normalizedSessionId = await normalizeSessionId(session_id, argv.root);
    const bundle = composeBundle(db, {
      session_id: normalizedSessionId,
      tokenBudget: token_budget ?? argv.bundleTokens,
      modelFamily: argv.modelFamily
    });
    return {
      content: [{ type: "text", text: bundle.text }],
      structuredContent: { ...bundle.structured, session_id: normalizedSessionId }
    };
  }
);

const memoryCommitInput = {
  session_id: z.string(),
  task: z.string().optional(),
  decisions: z.array(z.object({
    id: z.string().optional(),
    type: z.enum(["DECISION", "ASSUMPTION", "FIX", "BLOCKER", "NOTE"]),
    summary: z.string(),
    evidence: z.array(z.string()).optional()
  })).optional(),
  artifacts: z.array(z.object({
    id: z.string().optional(),
    kind: artifactKindEnum,
    uri: z.string().optional(),
    text: z.string().optional(),
    path: z.string().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    meta: z.any().optional()
  })).optional(),
  facts: z.array(z.object({
    key: z.string(),
    value: z.string(),
    scope: factScopeEnum.optional()
  })).optional()
} satisfies ZodRawShape;

// memory_commit
server.registerTool("memory_commit",
  {
    title: "Commit a State Frame (decisions, artifacts, facts)",
    inputSchema: memoryCommitInput
  },
  async (args) => {
    const ts = nowISO();
    const sessionId = await normalizeSessionId(args.session_id, argv.root);

    // Task upsert (simple "current task")
    if (args.task) {
      const t = {
        id: "T-" + args.task.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0,12),
        session_id: sessionId, parent_id: null, title: args.task,
        status: "doing", accept_criteria: null, created_at: ts, updated_at: ts
      };
      await db.upsertTask(t);
    }

    // Artifacts: write text or spans into content-addressed store
    const artifactIds: string[] = [];
    for (const a of args.artifacts ?? []) {
      let text = a.text;
      if (!text && a.path) {
        const full = safeJoin(argv.root, a.path);
        const fileTxt = (await readFile(full, "utf8")).split("\n");
        const start = a.startLine ?? 1;
        const end   = a.endLine ?? fileTxt.length;
        text = fileTxt.slice(start-1, end).join("\n");
      }
      if (!text && a.uri) {
        text = "";
      }
      const data = Buffer.from(text ?? "", "utf8");
      const hash = sha256(data);
      const outPath = resolve(argv.artifacts, hash);
      if (!existsSync(outPath)) {
        await writeFile(outPath, data);
      }
      const id = a.id ?? ("P-" + hash.slice(0, 8));
      await db.upsertArtifact({
        id, kind: a.kind, uri: `artifact://sha256/${hash}`,
        sha256: hash, size: data.length, meta_json: JSON.stringify(a.meta ?? {}), created_at: ts
      });
      artifactIds.push(id);
    }

    // Decisions/events
    for (const d of args.decisions ?? []) {
      await db.insertEvent({
        id: d.id ?? rid("D"),
        kind: d.type, task_id: null, session_id: sessionId,
        summary: d.summary, evidence_ids: JSON.stringify(d.evidence ?? artifactIds),
        ts
      });
    }

    // Facts
    for (const f of args.facts ?? []) {
      await db.upsertFact({ id: rid("F"), key: f.key, value: f.value, scope: f.scope ?? "repo" });
    }

    return { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true, ts, artifactIds, session_id: sessionId } };
  }
);

const memoryFetchInput = {
  id: z.string()
} satisfies ZodRawShape;

const memoryUpdateInput = {
  target: z.enum(["task", "artifact", "fact"] as const),
  id: z.string(),
  title: z.string().optional(),
  status: taskStatusEnum.optional(),
  accept_criteria: z.string().nullable().optional(),
  text: z.string().optional(),
  meta: z.any().optional(),
  kind: artifactKindEnum.optional(),
  value: z.string().optional(),
  scope: factScopeEnum.optional()
} satisfies ZodRawShape;

// memory_fetch
server.registerTool("memory_fetch",
  {
    title: "Fetch a record by ID",
    inputSchema: memoryFetchInput
  },
  async ({ id }) => {
    const art = db.getArtifactById(id);
    const evt = art ? null : db.getEventById(id);
    const tsk = art || evt ? null : db.getTaskById(id);
    const fct = art || evt || tsk ? null : db.getFactById(id);

    const rec = art ?? evt ?? tsk ?? fct;
    if (!rec) return { content: [{ type: "text", text: `not found: ${id}` }], isError: true };

    if ((rec as any).sha256) {
      // artifact: offer a resource link
      return {
        content: [
          { type: "text", text: `artifact ${rec.id} -> ${rec.uri}` },
          { type: "resource_link", uri: rec.uri, name: rec.id, description: rec.kind, mimeType: "text/plain" }
        ],
        structuredContent: rec
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(rec, null, 2) }], structuredContent: rec };
  }
);

// memory_update
server.registerTool("memory_update",
  {
    title: "Update an existing memory record",
    description: "Adjust task state, overwrite an artifact snippet, or revise a fact",
    inputSchema: memoryUpdateInput
  },
  async (args) => {
    const ts = nowISO();
    const has = (key: keyof typeof args) => Object.prototype.hasOwnProperty.call(args, key);

    if (args.target === "task") {
      if (!has("title") && !has("status") && !has("accept_criteria")) {
        return { content: [{ type: "text", text: "provide title, status, or accept_criteria to update" }], isError: true };
      }
      const existing = db.getTaskById(args.id);
      if (!existing) {
        return { content: [{ type: "text", text: `task not found: ${args.id}` }], isError: true };
      }
      const updated = {
        id: existing.id,
        session_id: existing.session_id,
        parent_id: existing.parent_id,
        title: args.title ?? existing.title,
        status: args.status ?? existing.status,
        accept_criteria: has("accept_criteria") ? args.accept_criteria ?? null : existing.accept_criteria,
        created_at: existing.created_at,
        updated_at: ts
      };
      await db.upsertTask(updated);
      return {
        content: [{ type: "text", text: `updated task ${args.id}` }],
        structuredContent: updated
      };
    }

    if (args.target === "artifact") {
      if (!has("text") && !has("meta") && !has("kind")) {
        return { content: [{ type: "text", text: "provide text, meta, or kind to update" }], isError: true };
      }
      const existing = db.getArtifactById(args.id);
      if (!existing) {
        return { content: [{ type: "text", text: `artifact not found: ${args.id}` }], isError: true };
      }

      const nextMeta = has("meta") ? args.meta ?? {} : (() => {
        try {
          return existing.meta_json ? JSON.parse(existing.meta_json) : {};
        } catch {
          return {};
        }
      })();

      let sha = existing.sha256;
      let size = existing.size;
      let uri = existing.uri;

      if (has("text")) {
        const data = Buffer.from(args.text ?? "", "utf8");
        sha = sha256(data);
        size = data.length;
        uri = `artifact://sha256/${sha}`;
        const blobPath = resolve(argv.artifacts, sha);
        if (!existsSync(blobPath)) {
          await writeFile(blobPath, data);
        }
      }

      const updatedArtifact = {
        id: existing.id,
        kind: args.kind ?? existing.kind,
        uri,
        sha256: sha,
        size,
        meta_json: JSON.stringify(nextMeta ?? {}),
        created_at: existing.created_at ?? ts
      };
      await db.upsertArtifact(updatedArtifact);
      return {
        content: [{ type: "text", text: `updated artifact ${args.id}` }],
        structuredContent: { ...updatedArtifact, meta: nextMeta }
      };
    }

    if (!has("value") && !has("scope")) {
      return { content: [{ type: "text", text: "provide value or scope to update" }], isError: true };
    }
    const existing = db.getFactById(args.id);
    if (!existing) {
      return { content: [{ type: "text", text: `fact not found: ${args.id}` }], isError: true };
    }
    const updatedFact = {
      id: existing.id,
      key: existing.key,
      value: has("value") ? args.value ?? existing.value : existing.value,
      scope: has("scope") ? args.scope ?? existing.scope : existing.scope
    };
    await db.upsertFact(updatedFact);
    return {
      content: [{ type: "text", text: `updated fact ${args.id}` }],
      structuredContent: updatedFact
    };
  }
);

const memorySpanInput = {
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive()
} satisfies ZodRawShape;

// memory_span (workspace read-only)
server.registerTool("memory_span",
  {
    title: "Read a file span from the workspace",
    inputSchema: memorySpanInput
  },
  async ({ path, startLine, endLine }) => {
    const full = safeJoin(argv.root, path);
    const txt = (await readFile(full, "utf8")).split("\n");
    const start = Math.max(1, Math.min(startLine, txt.length));
    const end   = Math.max(start, Math.min(endLine, txt.length));
    const slice = txt.slice(start-1, end).join("\n");
    return {
      content: [
        { type: "text", text: `workspace://${path}#L${start}-L${end}` },
        { type: "text", text: slice }
      ],
      structuredContent: { path, start, end }
    };
  }
);

const memorySearchInput = {
  session_id: z.string(),
  query: z.string(),
  limit: z.number().int().positive().max(200).optional()
} satisfies ZodRawShape;

// memory_search
server.registerTool("memory_search",
  {
    title: "Search tasks/events/facts",
    inputSchema: memorySearchInput
  },
  async ({ session_id, query, limit }) => {
    const normalizedSessionId = await normalizeSessionId(session_id, argv.root);
    const res = db.search(normalizedSessionId, query, limit ?? 50);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res };
  }
);

const memoryCheckpointInput = {
  session_id: z.string(),
  label: z.string()
} satisfies ZodRawShape;

// memory_checkpoint
server.registerTool("memory_checkpoint",
  {
    title: "Create a checkpoint",
    inputSchema: memoryCheckpointInput
  },
  async ({ session_id, label }) => {
    const normalizedSessionId = await normalizeSessionId(session_id, argv.root);
    const id = rid("C");
    await db.insertCheckpoint({ id, session_id: normalizedSessionId, label, ts: nowISO(), bundle_meta: "{}" });
    return { content: [{ type: "text", text: id }], structuredContent: { id, session_id: normalizedSessionId, label } };
  }
);

/** ----------------------- Start server ----------------------- **/

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`RWM MCP up. db=${argv.db} root=${argv.root} artifacts=${argv.artifacts} bundleTokens=${argv.bundleTokens} modelFamily=${argv.modelFamily}`);

function isProbablyText(buf: Buffer) {
  const s = buf.toString("utf8");
  const replacementCount = (s.match(/\uFFFD/g) || []).length;
  return replacementCount < 5;
}
function sanitizeIdPart(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]+/g, "-") || "proj";
}

async function detectGitDescriptor(root: string): Promise<string | null> {
  try {
    const head = await readFile(join(root, ".git/HEAD"), "utf8");
    const refMatch = head.match(/ref: (.+)/);
    if (refMatch) {
      const ref = refMatch[1].trim();
      const branch = ref.split("/").pop();
      return branch ? sanitizeIdPart(branch) : null;
    }
    const hash = head.trim().slice(0, 7);
    return hash ? sanitizeIdPart(hash) : null;
  } catch {
    return null;
  }
}

async function normalizeSessionId(raw: string, root: string): Promise<string> {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  if (trimmed && !lowered.endsWith("@unknown")) {
    return trimmed;
  }
  const base = sanitizeIdPart(basename(root) || "workspace");
  const descriptor = await detectGitDescriptor(root) ?? new Date().toISOString().split("T")[0];
  return `${base}@${sanitizeIdPart(descriptor)}`;
}
