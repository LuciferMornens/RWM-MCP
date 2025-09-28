import { createHash } from "node:crypto";

export function sha256(buf: Buffer | string) {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

export function nowISO() { return new Date().toISOString(); }

export function rid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}