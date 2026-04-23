// src/agent/providers/util.ts
//
// Shared helpers for the Azure Foundry provider factories (azure-anthropic,
// azure-deepseek). Both providers read
// `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT`, which is the Foundry resource
// base URL. The factories append a path suffix (`/anthropic` or
// `/openai/v1`) to form the client `baseURL` — so we have to normalize the
// user-supplied value first (trim trailing slashes + strip a legacy
// `/models` segment retained from the older AI Inference SDK URL).
//
// Normative spec: docs/design/project-design.md §5.5 / §5.6.

/**
 * Normalize a Foundry base URL and append a provider-specific suffix.
 *
 * Rules (design §5.5 / §5.6):
 *   1. Trim trailing `/` (one or many).
 *   2. Strip a trailing `/models` segment (case-insensitive) if present.
 *      This segment is retained from the older Azure AI Inference SDK URL
 *      convention; the OpenAI-compatible and Anthropic-compatible paths
 *      are rooted one level above it.
 *   3. Re-trim trailing `/` after the strip (in case the input was
 *      `.../models/`).
 *   4. Append the caller-supplied suffix verbatim — callers supply the
 *      leading `/`.
 *
 * Example:
 *   normalizeFoundryEndpoint('https://x.services.ai.azure.com', '/anthropic')
 *     → 'https://x.services.ai.azure.com/anthropic'
 *   normalizeFoundryEndpoint('https://x.services.ai.azure.com/models/', '/openai/v1')
 *     → 'https://x.services.ai.azure.com/openai/v1'
 */
export function normalizeFoundryEndpoint(
  base: string,
  suffix: '/anthropic' | '/openai/v1',
): string {
  let b = base.trim().replace(/\/+$/, '');
  if (b.toLowerCase().endsWith('/models')) {
    b = b.slice(0, -'/models'.length);
  }
  b = b.replace(/\/+$/, '');
  return b + suffix;
}
