import assert from "node:assert/strict";
import test from "node:test";
import { isRunTerminal } from "../src/shared/events";

test("isRunTerminal identifies terminal states", () => {
  assert.equal(isRunTerminal("completed"), true);
  assert.equal(isRunTerminal("failed"), true);
  assert.equal(isRunTerminal("cancelled"), true);
  assert.equal(isRunTerminal("queued"), false);
  assert.equal(isRunTerminal("running"), false);
});
