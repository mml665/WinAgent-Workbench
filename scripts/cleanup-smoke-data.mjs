import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbPath = path.resolve(process.cwd(), "data", "winagent.sqlite");
const db = new DatabaseSync(dbPath);

db.exec("PRAGMA foreign_keys = ON");

const smokeRunIds = db
  .prepare(
    `SELECT id
     FROM runs
     WHERE title IN ('Windows smoke', 'Retry smoke')
        OR prompt IN ('Print WINAGENT_SMOKE_OK', 'fail')
        OR retrieval_query LIKE '%WINAGENT_LONG_MEMORY_OK%'`
  )
  .all()
  .map((row) => row.id);

const smokeWorkspaceIds = db
  .prepare(`SELECT id FROM workspaces WHERE root_path LIKE '%\\.tmp\\space path' OR root_path LIKE '%\\.tmp\\中文路径'`)
  .all()
  .map((row) => row.id);

db.exec("BEGIN");
try {
  for (const runId of smokeRunIds) {
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
  }
  db.prepare(
    `DELETE FROM workspace_memories
     WHERE content LIKE '%WINAGENT_LONG_MEMORY_OK%'
        OR content LIKE 'COMPLETED run: Windows smoke%'
        OR content LIKE 'FAILED run: Retry smoke%'`
  ).run();
  db.prepare(
    `DELETE FROM mcp_servers
     WHERE name = 'Smoke MCP'
        OR args_json LIKE '%tools/mock-mcp-server.mjs%'`
  ).run();
  db.prepare(
    `DELETE FROM agents
     WHERE name IN ('PowerShell Demo Agent', 'Smoke PowerShell Agent', 'Fail once smoke')
        OR args_json LIKE '%WINAGENT_DONE%'
        OR args_json LIKE '%retry smoke failure%'`
  ).run();
  for (const workspaceId of smokeWorkspaceIds) {
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(
  `[cleanup] removed smoke/mock data from ${dbPath}: runs=${smokeRunIds.length}, workspaces=${smokeWorkspaceIds.length}`
);
