// App Server reports inclusive input counts. Billing categories must be disjoint.
export function extractCodexUsage(tokenUsage) {
  const last = tokenUsage?.last
  if (!last) return null
  const {inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens = 0} = last
  const counts = [inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens]
  if (counts.some(n => !Number.isSafeInteger(n) || n < 0) || cachedInputTokens + cacheWriteInputTokens > inputTokens) return null
  return {runtime:'codex', usageMode:'four_tier', accurate:true,
    inputTokens:inputTokens - cachedInputTokens - cacheWriteInputTokens,
    outputTokens, cacheReadInputTokens:cachedInputTokens, cacheCreationInputTokens:cacheWriteInputTokens}
}
