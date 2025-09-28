declare module "@anthropic-ai/tokenizer" {
  export function countTokens(text: string): number;
  export function tokenize(text: string): number[];
}
