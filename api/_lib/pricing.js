// Anthropic pricing constants for the admin cost/usage panel. Numbers are
// per 1M tokens, in USD, as published at https://www.anthropic.com/pricing
// (sampled January 2026). Cache reads are roughly 10% of normal input price
// per Anthropic's prompt-caching docs.
//
// These are estimates: Anthropic charges per actual token in USD; we report
// estimated spend so the admin has a trend signal without waiting for the
// monthly bill. For exact figures, refer to the Anthropic console.

const PRICING = {
  // Sonnet 4.6 — used for plan / script / scan
  "claude-sonnet-4-6": {
    input:      3.00 / 1_000_000,
    output:    15.00 / 1_000_000,
    cacheRead:  0.30 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,  // ~25% premium on cache writes
  },
  // Haiku 4.5 — used for caption / caption_remix
  "claude-haiku-4-5-20251001": {
    input:      1.00 / 1_000_000,
    output:     5.00 / 1_000_000,
    cacheRead:  0.10 / 1_000_000,
    cacheWrite: 1.25 / 1_000_000,
  },
};

const FALLBACK = PRICING["claude-sonnet-4-6"];

export function estimateCostUSD({ model, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0 }) {
  const p = PRICING[model] || FALLBACK;
  const cost
    = (input_tokens       * p.input)
    + (output_tokens      * p.output)
    + (cache_read_tokens  * p.cacheRead)
    + (cache_write_tokens * p.cacheWrite);
  // Round to 6 decimals — matches the numeric(10,6) column shape.
  return Math.round(cost * 1e6) / 1e6;
}

export { PRICING };
