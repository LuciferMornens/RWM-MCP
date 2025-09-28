import initSqlJs from "sql.js";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
export async function openDB({ dbPath }) {
    // Locate the wasm binary from node_modules/sql.js/dist/sql-wasm.wasm
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const wasmDir = dirname(wasmPath);
    const SQL = await initSqlJs({
        locateFile: (file) => join(wasmDir, file)
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
    function bindify(params = {}) {
        const out = {};
        for (const [k, v] of Object.entries(params))
            out[`$${k}`] = v;
        return out;
    }
    function run(sql, params = {}) {
        const stmt = db.prepare(sql);
        stmt.bind(bindify(params));
        // for non-SELECT statements, step() once is enough
        stmt.step();
        stmt.free();
    }
    function all(sql, params = {}) {
        const stmt = db.prepare(sql);
        stmt.bind(bindify(params));
        const rows = [];
        while (stmt.step())
            rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
    }
    function get(sql, params = {}) {
        return all(sql, params)[0] ?? null;
    }
    async function upsertTask(t) {
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
    async function insertEvent(e) {
        run(`
      insert into events(id, kind, task_id, session_id, summary, evidence_ids, ts)
      values($id,$kind,$task_id,$session_id,$summary,$evidence_ids,$ts)
    `, e);
        await save();
    }
    async function upsertArtifact(a) {
        run(`
      insert into artifacts(id, kind, uri, sha256, size, meta_json, created_at)
      values($id,$kind,$uri,$sha256,$size,$meta_json,$created_at)
      on conflict(id) do update set kind=excluded.kind, uri=excluded.uri, meta_json=excluded.meta_json
    `, a);
        await save();
    }
    async function upsertFact(f) {
        run(`
      insert into facts(id, key, value, scope)
      values($id,$key,$value,$scope)
      on conflict(id) do update set value=excluded.value, scope=excluded.scope
    `, f);
        await save();
    }
    async function insertCheckpoint(c) {
        run(`
      insert into checkpoints(id, session_id, label, ts, bundle_meta)
      values($id,$session_id,$label,$ts,$bundle_meta)
    `, c);
        await save();
    }
    function listRecentEvents(session_id, limit = 100) {
        return all(`select * from events where session_id=$session_id order by ts desc limit $limit`, { session_id, limit });
    }
    function listActiveTasks(session_id, limit = 20) {
        return all(`select * from tasks where session_id=$session_id and status in ('doing','blocked')
       order by updated_at desc limit $limit`, { session_id, limit });
    }
    function listFacts() {
        return all(`select * from facts`);
    }
    function searchQ(session_id, q, limit = 50) {
        const like = `%${q}%`;
        const events = all(`select * from events where session_id=$session_id and (summary like $like or id like $like) limit $limit`, { session_id, like, limit });
        const tasks = all(`select * from tasks where session_id=$session_id and (title like $like or id like $like) limit $limit`, { session_id, like, limit });
        const facts = all(`select * from facts where (key like $like or value like $like) limit $limit`, { like, limit });
        return { events, tasks, facts };
    }
    function getArtifactById(id) { return get(`select * from artifacts where id=$id`, { id }); }
    function getEventById(id) { return get(`select * from events where id=$id`, { id }); }
    function getTaskById(id) { return get(`select * from tasks where id=$id`, { id }); }
    function getFactById(id) { return get(`select * from facts where id=$id`, { id }); }
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
        search: searchQ,
        getArtifactById,
        getEventById,
        getTaskById,
        getFactById
    };
}
function initSchema(db) {
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
