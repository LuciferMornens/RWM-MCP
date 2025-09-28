declare module "sql.js" {
  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export interface Statement {
    bind(params?: Record<string, unknown>): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  export interface Database {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    export(): Uint8Array;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
