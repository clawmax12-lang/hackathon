export interface AnthropicUsageForPricing {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface TokenPrices {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

const USD_PER_MILLION: Array<{ prefix: string; prices: TokenPrices }> = [
  {
    prefix: "claude-fable-5-1",
    prices: { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 },
  },
  {
    prefix: "claude-opus-5",
    prices: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  },
  {
    prefix: "claude-sonnet-5",
    prices: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  },
  {
    prefix: "claude-haiku-4-5",
    prices: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  },
];

// Unknown future models use the highest current standard rates so a cost guard
// fails conservatively rather than undercounting.
const CONSERVATIVE_FALLBACK: TokenPrices = {
  input: 10,
  cacheWrite: 12.5,
  cacheRead: 1,
  output: 50,
};

export function estimateAnthropicCostUsd(model: string, usage: AnthropicUsageForPricing): number {
  const prices =
    USD_PER_MILLION.find((entry) => model.startsWith(entry.prefix))?.prices ??
    CONSERVATIVE_FALLBACK;
  return (
    (usage.input_tokens * prices.input +
      (usage.cache_creation_input_tokens ?? 0) * prices.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * prices.cacheRead +
      usage.output_tokens * prices.output) /
    1_000_000
  );
}
