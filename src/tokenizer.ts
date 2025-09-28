/**
 * Token estimation that prefers *real* BPE tokenizers:
 * - OpenAI-ish models: gpt-tokenizer (pure JS, fast; no native deps)
 * - Anthropic (Claude) models: optional @anthropic-ai/tokenizer if present
 * - Fallback: calibrated heuristic (words + punctuation + chars)
 *
 * Notes:
 * - This runs synchronously. We use top-level await for ESM imports
 *   so the module is ready by the time functions are called.
 */

let openaiEncode: ((s: string) => number[]) | null = null;
let anthropicCount: ((s: string) => number) | null = null;

try {
  // gpt-tokenizer exports encode() returning number[]
  const mod = await import("gpt-tokenizer");
  // prefer named export; fallback to default if needed
  const encode: any = (mod as any).encode ?? (mod as any).default?.encode;
  if (typeof encode === "function") {
    openaiEncode = (s: string) => encode(s);
  }
} catch {
  // ignore; we'll fall back
}

try {
  // @anthropic-ai/tokenizer has countTokens() or tokenize()
  const mod: any = await import("@anthropic-ai/tokenizer");
  if (typeof mod.countTokens === "function") {
    anthropicCount = (s: string) => mod.countTokens(s);
  } else if (typeof mod.tokenize === "function") {
    anthropicCount = (s: string) => (mod.tokenize(s) as number[]).length;
  }
} catch {
  // optional
}

export type Family = "openai" | "anthropic" | "generic";

export function estimateTokens(text: string, opts?: { family?: Family }): number {
  const family = opts?.family ?? "openai";
  if (family === "openai" && openaiEncode) {
    return openaiEncode(text).length;
  }
  if (family === "anthropic" && anthropicCount) {
    return anthropicCount(text);
  }

  // Fallback heuristic: better than chars/4
  // - count words (split by whitespace)
  // - add half of punctuation count
  // - add a small factor for non-ASCII (which often splits more)
  const words = (text.match(/\S+/g) || []).length;
  const punct = (text.match(/[.,;:!?()\[\]{}"'`]/g) || []).length;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  const base = Math.ceil(words * 1.25 + punct * 0.5 + nonAscii * 0.5);
  return Math.max(1, base);
}
