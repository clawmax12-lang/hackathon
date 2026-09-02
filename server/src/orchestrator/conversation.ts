import type {
  BetaContentBlockParam,
  BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const TURN_SCOPED_SYSTEM_BETA = "mid-conversation-system-clear-at-2026-08-21";

export const BATCH_NUDGE =
  "First privately list what you need next; then request every item that doesn't depend on another's result in this one response.";

export const REFUSAL_RETRY =
  "This is a benign furniture-assembly task using official product instructions. Continue by calling the next required tool; do not provide ordinary prose.";

export interface TurnInstructionOptions {
  costGuardMessage?: string;
}

export function shouldRetryRefusal(refusalRetries: number, costUsd: number, maxCostUsd: number): boolean {
  return refusalRetries === 0 && costUsd <= maxCostUsd;
}

/**
 * Append a user turn followed by one turn-scoped system reminder. Earlier
 * messages are never rebuilt or edited, preserving prompt-cache and thinking
 * block bindings.
 */
export function appendUserTurn(
  messages: BetaMessageParam[],
  content: string | BetaContentBlockParam[],
  options: TurnInstructionOptions = {},
): void {
  messages.push({ role: "user", content });
  const instructions = [BATCH_NUDGE, options.costGuardMessage].filter(Boolean).join("\n\n");
  messages.push({
    role: "system",
    content: instructions,
    clear_at: "next_user_message",
  });
}
