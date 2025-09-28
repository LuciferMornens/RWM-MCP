declare module "yargs" {
  export interface Argv {
    parserConfiguration(opts: Record<string, unknown>): Argv;
    option(key: string, opts: Record<string, unknown>): Argv;
    strict(): Argv;
    parse(): Promise<Record<string, unknown>>;
  }

  export default function yargs(args?: readonly string[] | string): Argv;
}

declare module "yargs/helpers" {
  export function hideBin(argv: string[]): string[];
}
