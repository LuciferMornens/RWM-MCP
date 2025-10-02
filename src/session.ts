import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const branchCache = new Map<string, string | null>();

export function sanitizeIdPart(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]+/g, "-") || "proj";
}

function defaultSuffix(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

async function detectGitBranch(root: string): Promise<string | null> {
  if (branchCache.has(root)) {
    return branchCache.get(root) ?? null;
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    const branch = stdout.trim();
    if (!branch) {
      branchCache.set(root, null);
      return null;
    }
    if (branch === "HEAD") {
      const { stdout: commit } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
      const det = commit.trim();
      const fallback = det ? `detached-${det}` : null;
      branchCache.set(root, fallback);
      return fallback;
    }
    const sanitized = branch.replace(/\s+/g, "-");
    branchCache.set(root, sanitized);
    return sanitized;
  } catch {
    branchCache.set(root, null);
    return null;
  }
}

export async function normalizeSessionId(raw: string, root: string): Promise<string> {
  const trimmed = raw.trim();
  const [rawBase, rawSuffix] = trimmed.split("@", 2);

  const rootName = sanitizeIdPart(basename(resolve(root)) || "workspace");
  const baseCandidate = sanitizeIdPart(rawBase || rootName);

  const providedSuffix = rawSuffix ? sanitizeIdPart(rawSuffix) : "";
  let suffix = providedSuffix;
  if (!suffix || suffix === "unknown") {
    const branch = await detectGitBranch(root);
    if (branch) {
      suffix = sanitizeIdPart(branch);
    }
  }

  if (!suffix) {
    suffix = defaultSuffix();
  }

  return `${baseCandidate}@${suffix}`;
}

export function canonicalizeAlias(raw: string, root: string): string {
  const trimmed = raw.trim();
  const [rawBase, rawSuffix] = trimmed.split("@", 2);
  const rootName = sanitizeIdPart(basename(resolve(root)) || "workspace");
  const baseCandidate = sanitizeIdPart(rawBase || rootName);
  const suffix = sanitizeIdPart(rawSuffix ?? "main");
  return `${baseCandidate}@${suffix || "main"}`;
}

export function resetSessionCache() {
  branchCache.clear();
}
