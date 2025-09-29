import initSqlJs, { Database as SQLDatabase, SqlJsStatic } from "sql.js";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DBDeps { dbPath: string; }

export interface RWRecord {
  [k: string]: any;
}

export interface RWMDB {
  path: string;
  save(): Promise<void>;

  // Upserts / inserts
  upsertTask(t: any): Promise<void>;
  insertEvent(e: any): Promise<void>;
  upsertArtifact(a: any): Promise<void>;
  upsertFact(f: any): Promise<void>;
  insertCheckpoint(c: any): Promise<void>;

  // Queries for bundle & tools
  listRecentEvents(session_id: string, limit?: number): RWRecord[];
  listActiveTasks(session_id: string, limit?: number): RWRecord[];
  listFacts(): RWRecord[];
  canonicalizeSessions(base: string, canonical: string): Promise<void>;
  search(session_id: string, q: string, limit?: number): {
    events: RWRecord[]; tasks: RWRecord[]; facts: RWRecord[];
  };

  getArtifactById(id: string): RWRecord | null;
  getEventById(id: string): RWRecord | null;
  getTaskById(id: string): RWRecord | null;
  getFactById(id: string): RWRecord | null;
}

export async function openDB({ dbPath }: DBDeps): Promise<RWMDB> {
  // Locate the wasm binary from node_modules/sql.js/dist/sql-wasm.wasm
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const wasmDir = dirname(wasmPath);

  const SQL: SqlJsStatic = await initSqlJs({
    locateFile: (file: string) => join(wasmDir, file)
  });

  const db = existsSync(dbPath)
    ? new SQL.Database(new Uint8Array(await fs.readFile(dbPath)))
    : new SQL.Database();

  initSchema(db);

  async function save() {
    const data = db.export();
    await fs.writeFile(dbPath, Buffer.from(data));
  }

  /** Helpers with named params: use $name placeholders */
  function bindify(params: Record<string, any> = {}) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(params)) out[`$${k}`] = v;
    return out;
  }
  function run(sql: string, params: Record<string, any> = {}) {
    const stmt = db.prepare(sql);
    stmt.bind(bindify(params));
    // for non-SELECT statements, step() once is enough
    stmt.step();
    stmt.free();
  }
  function all(sql: string, params: Record<string, any> = {}) {
    const stmt = db.prepare(sql);
    stmt.bind(bindify(params));
    const rows: RWRecord[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function get(sql: string, params: Record<string, any> = {}) {
    return all(sql, params)[0] ?? null;
  }

  async function upsertTask(t: any) {
    run(`
      insert into tasks(id, session_id, parent_id, title, status, accept_criteria, created_at, updated_at)
      values($id,$session_id,$parent_id,$title,$status,$accept_criteria,$created_at,$updated_at)
      on conflict(id) do update set
        session_id=excluded.session_id,
        parent_id=excluded.parent_id,
        title=excluded.title,
        status=excluded.status,
        accept_criteria=excluded.accept_criteria,
        updated_at=excluded.updated_at
    `, t);
    await save();
  }

  async function insertEvent(e: any) {
    run(`
      insert into events(id, kind, task_id, session_id, summary, evidence_ids, ts)
      values($id,$kind,$task_id,$session_id,$summary,$evidence_ids,$ts)
    `, e);
    await save();
  }

  async function upsertArtifact(a: any) {
    run(`
      insert into artifacts(id, kind, uri, sha256, size, meta_json, created_at)
      values($id,$kind,$uri,$sha256,$size,$meta_json,$created_at)
      on conflict(id) do update set
        kind=excluded.kind,
        uri=excluded.uri,
        sha256=excluded.sha256,
        size=excluded.size,
        meta_json=excluded.meta_json,
        created_at=excluded.created_at
    `, a);
    await save();
  }

  async function upsertFact(f: any) {
    run(`
      insert into facts(id, key, value, scope)
      values($id,$key,$value,$scope)
      on conflict(id) do update set value=excluded.value, scope=excluded.scope
    `, f);
    await save();
  }

  async function insertCheckpoint(c: any) {
    run(`
      insert into checkpoints(id, session_id, label, ts, bundle_meta)
      values($id,$session_id,$label,$ts,$bundle_meta)
    `, c);
    await save();
  }

  function listRecentEvents(session_id: string, limit = 100) {
    return all(
      `select * from events where session_id=$session_id order by ts desc limit $limit`,
      { session_id, limit }
    );
  }

  function listActiveTasks(session_id: string, limit = 20) {
    return all(
      `select * from tasks where session_id=$session_id and status in ('doing','blocked')
       order by updated_at desc limit $limit`,
      { session_id, limit }
    );
  }

  function listFacts() {
    return all(`select * from facts`);
  }

  async function canonicalizeSessions(base: string, canonical: string) {
    if (!base) return;
    const pattern = `${base}@%`;
    const others = all(
      `select distinct session_id from (
         select session_id from events
         union all
         select session_id from tasks
         union all
         select session_id from checkpoints
       ) where session_id like $pattern and session_id != $canonical`,
      { pattern, canonical }
    );
    if (others.length === 0) return;

    run(
      `update events set session_id=$canonical
       where session_id like $pattern and session_id != $canonical`,
      { canonical, pattern }
    );
    run(
      `update tasks set session_id=$canonical
       where session_id like $pattern and session_id != $canonical`,
      { canonical, pattern }
    );
    run(
      `update checkpoints set session_id=$canonical
       where session_id like $pattern and session_id != $canonical`,
      { canonical, pattern }
    );

    await save();
  }

  function searchQ(session_id: string, q: string, limit = 50) {
    const like = `%${q}%`;
    const events = all(
      `select * from events where session_id=$session_id and (summary like $like or id like $like) limit $limit`,
      { session_id, like, limit }
    );
    const tasks = all(
      `select * from tasks where session_id=$session_id and (title like $like or id like $like) limit $limit`,
      { session_id, like, limit }
    );
    const facts = all(
      `select * from facts where (key like $like or value like $like) limit $limit`,
      { like, limit }
    );
    return { events, tasks, facts };
  }

  function getArtifactById(id: string) { return get(`select * from artifacts where id=$id`, { id }); }
  function getEventById(id: string)   { return get(`select * from events where id=$id`, { id }); }
  function getTaskById(id: string)    { return get(`select * from tasks where id=$id`, { id }); }
  function getFactById(id: string)    { return get(`select * from facts where id=$id`, { id }); }

  return {
    path: dbPath,
    save,

    upsertTask,
    insertEvent,
    upsertArtifact,
    upsertFact,
    insertCheckpoint,

    listRecentEvents,
    listActiveTasks,
    listFacts,
    canonicalizeSessions,
    search: searchQ,

    getArtifactById,
    getEventById,
    getTaskById,
    getFactById
  };
}

function initSchema(db: SQLDatabase) {
  db.exec(`
    create table if not exists tasks(
      id text primary key, session_id text not null, parent_id text,
      title text not null, status text not null,
      accept_criteria text, created_at text not null, updated_at text not null
    );

    create table if not exists edges(
      src_id text not null, dst_id text not null, kind text not null,
      primary key (src_id, dst_id, kind)
    );

    create table if not exists events(
      id text primary key, kind text not null, task_id text, session_id text not null,
      summary text not null, evidence_ids text, ts text not null
    );

    create table if not exists artifacts(
      id text primary key, kind text not null, uri text not null,
      sha256 text not null, size integer not null, meta_json text, created_at text not null
    );

    create table if not exists facts(
      id text primary key, key text not null, value text not null, scope text not null
    );

    create table if not exists checkpoints(
      id text primary key, session_id text not null, label text not null, ts text not null, bundle_meta text
    );

    create index if not exists idx_events_session_ts on events(session_id, ts desc);
    create index if not exists idx_tasks_session on tasks(session_id);
    create index if not exists idx_artifacts_sha on artifacts(sha256);
  `);
}
