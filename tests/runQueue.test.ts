import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord } from "../src/shared/types";
import { RunQueue } from "../src/backend/services/runQueue";

function run(id: string, agentId = "agent-a"): RunRecord {
  return {
    id,
    workspaceId: "workspace-a",
    agentId,
    title: id,
    prompt: "",
    status: "queued",
    cwd: ".",
    attempt: 1,
    maxRetries: 0,
    timeoutMs: 1000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

test("RunQueue limits same-agent concurrency and supports queued cancel", () => {
  const queue = new RunQueue(2, 1);
  const executed: string[] = [];
  const first = run("run-1");
  const second = run("run-2");
  queue.enqueue({ run: first, execute: () => executed.push(first.id) });
  queue.enqueue({ run: second, execute: () => executed.push(second.id) });
  assert.deepEqual(executed, ["run-1"]);
  assert.equal(queue.cancel("run-2"), true);
  queue.complete(first);
  assert.deepEqual(executed, ["run-1"]);
});
