#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = process.env.PWD ? resolve(process.env.PWD) : process.cwd();
const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const dbPath = join(projectRoot, "rwm.db");
const artifactsDir = join(projectRoot, "rwm_artifacts");

if (!existsSync(artifactsDir)) {
  mkdirSync(artifactsDir, { recursive: true });
}

const bundleTokens = process.env.RWM_BUNDLE_TOKENS ?? "4500";

const child = spawn(
  "node",
  [
    serverPath,
    "--db",
    dbPath,
    "--root",
    projectRoot,
    "--artifacts",
    artifactsDir,
    "--bundleTokens",
    bundleTokens
  ],
  { stdio: "inherit" }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
