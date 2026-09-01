import assert from "node:assert/strict";
import test from "node:test";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  appendUserTurn,
  BATCH_NUDGE,
  shouldRetryRefusal,
} from "./conversation.js";
import {
  DEFAULT_SYSTEM_PROMPT_VERSION,
  getSystemPrompt,
  guidePromptVersion,
  SYSTEM_PROMPT_V2,
  SYSTEM_PROMPT_V3,
} from "./prompts/system.js";

test("turn instructions stay append-only and clear after the next user message", () => {
  const messages: BetaMessageParam[] = [];
  appendUserTurn(messages, "first");
  const preservedPrefix = structuredClone(messages);

  messages.push({ role: "assistant", content: "response" });
  appendUserTurn(messages, "second", { costGuardMessage: "Stop at the cost guard." });

  assert.deepEqual(messages.slice(0, preservedPrefix.length), preservedPrefix);
  assert.deepEqual(messages.map((message) => message.role), [
    "user",
    "system",
    "assistant",
    "user",
    "system",
  ]);
  assert.equal(messages[1].clear_at, "next_user_message");
  assert.equal(messages[1].content, BATCH_NUDGE);
  assert.equal(messages[4].clear_at, "next_user_message");
  assert.match(String(messages[4].content), /Stop at the cost guard/);
});

test("a refusal is retried once and never beyond the cost guard", () => {
  assert.equal(shouldRetryRefusal(0, 0.2, 3), true);
  assert.equal(shouldRetryRefusal(1, 0.2, 3), false);
  assert.equal(shouldRetryRefusal(0, 3.01, 3), false);
});

test("system prompt v3 is opt-in and gets a separate guide cache key", () => {
  assert.equal(getSystemPrompt(DEFAULT_SYSTEM_PROMPT_VERSION), SYSTEM_PROMPT_V2);
  assert.equal(getSystemPrompt("monterra-system-v3"), SYSTEM_PROMPT_V3);
  assert.equal(guidePromptVersion(DEFAULT_SYSTEM_PROMPT_VERSION, "monterra-style-v2"), "monterra-style-v2");
  assert.equal(
    guidePromptVersion("monterra-system-v3", "monterra-style-v2"),
    "monterra-style-v2+monterra-system-v3",
  );
  assert.throws(() => getSystemPrompt("unknown"), /Unsupported orchestrator prompt version/);
});
