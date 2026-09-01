import assert from "node:assert/strict";
import test from "node:test";
import { estimateAnthropicCostUsd } from "./pricing.js";

const usage = {
  input_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  output_tokens: 1_000_000,
};

test("prices Opus 5 and Fable 5.1 usage at their model-specific rates", () => {
  assert.equal(estimateAnthropicCostUsd("claude-opus-5", usage), 36.75);
  assert.equal(estimateAnthropicCostUsd("claude-fable-5-1", usage), 72.75);
});

test("unknown models use conservative pricing", () => {
  assert.equal(estimateAnthropicCostUsd("claude-future", usage), 73.5);
});
