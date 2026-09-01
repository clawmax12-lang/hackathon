import assert from "node:assert/strict";
import test from "node:test";
import { enforceDeliverableOutcome, type ToolContext } from "./tools.js";

function context(state: ToolContext["state"]): ToolContext {
  return {
    scanId: "scan",
    scanImageKey: "image",
    userNote: null,
    pinnedProductId: null,
    state,
  };
}

test("success is rejected until a nonempty deliverable is ready", () => {
  for (const state of [
    { finished: { outcome: "success" as const, message: "ok" } },
    {
      guideId: "guide",
      stepCount: 1,
      finished: { outcome: "success" as const, message: "ok" },
    },
    {
      guideId: "guide",
      stepCount: 0,
      deliverableReady: true,
      finished: { outcome: "success" as const, message: "ok" },
    },
  ]) {
    const ctx = context(state);
    enforceDeliverableOutcome(ctx);
    assert.equal(ctx.state.finished?.outcome, "failed");
  }
});

test("success remains valid for a ready guide with at least one step", () => {
  const ctx = context({
    guideId: "guide",
    stepCount: 1,
    deliverableReady: true,
    finished: { outcome: "success", message: "ok" },
  });
  enforceDeliverableOutcome(ctx);
  assert.deepEqual(ctx.state.finished, { outcome: "success", message: "ok" });
});
