import assert from "node:assert/strict";
import test from "node:test";
import { evals, isAuthorizedEvalRequest } from "./evals.js";

test("orchestrator eval authorization uses an exact bearer token", () => {
  assert.equal(isAuthorizedEvalRequest(undefined, "secret"), false);
  assert.equal(isAuthorizedEvalRequest("Bearer wrong", "secret"), false);
  assert.equal(isAuthorizedEvalRequest("Bearer secret-extra", "secret"), false);
  assert.equal(isAuthorizedEvalRequest("Bearer secret", "secret"), true);
});

test("orchestrator eval route is undiscoverable while disabled", async () => {
  const response = await evals.request("/", { method: "POST" });
  assert.equal(response.status, 404);
});
