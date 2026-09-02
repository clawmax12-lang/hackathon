import assert from "node:assert/strict";
import test from "node:test";
import { modelSupportsEffort } from "./env.js";

test("effort capability validation accepts supported aliases and rejects Haiku snapshots", () => {
  assert.equal(modelSupportsEffort("claude-fable-5-1"), true);
  assert.equal(modelSupportsEffort("claude-opus-5"), true);
  assert.equal(modelSupportsEffort("claude-haiku-4-5"), false);
  assert.equal(modelSupportsEffort("claude-haiku-4-5-20251001"), false);
});
