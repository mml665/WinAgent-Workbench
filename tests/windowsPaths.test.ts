import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { isPathInside, normalizeHostPath } from "../src/backend/utils/windowsPaths";

test("normalizeHostPath resolves relative segments", () => {
  const resolved = normalizeHostPath(path.join("fixtures", "..", "fixtures"));
  assert.equal(path.isAbsolute(resolved), true);
});

test("isPathInside accepts the parent itself", () => {
  const parent = path.resolve("tmp workspace");
  assert.equal(isPathInside(parent, parent), true);
});

test("isPathInside rejects sibling prefix tricks", () => {
  const parent = path.resolve("workspace");
  const sibling = path.resolve("workspace-other", "file.txt");
  assert.equal(isPathInside(parent, sibling), false);
});
