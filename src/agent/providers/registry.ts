// src/agent/providers/registry.ts
//
// Provider registry. Maps each `ProviderName` literal to its factory and
// exposes a narrow `getProvider()` that throws `UsageError` on unknown
// names. Adding a provider is a one-line edit here plus a new sibling file.

import { UsageError } from '../../commands/list-mail';
import type { ProviderName } from '../../config/agent-config';
import type { ProviderFactory, ProviderRegistry } from './types';

import { createOpenaiModel } from './openai';
import { createAnthropicModel } from './anthropic';
import { createGoogleModel } from './google';
import { createAzureOpenaiModel } from './azure-openai';
import { createAzureAnthropicModel } from './azure-anthropic';
import { createAzureDeepseekModel } from './azure-deepseek';

/**
 * Frozen registry — exactly six entries, one per supported provider.
 * Lookups are O(1) and new providers cannot be monkey-patched at runtime.
 */
export const PROVIDERS: Readonly<Record<ProviderName, ProviderFactory>> =
  Object.freeze({
    openai: createOpenaiModel,
    anthropic: createAnthropicModel,
    google: createGoogleModel,
    'azure-openai': createAzureOpenaiModel,
    'azure-anthropic': createAzureAnthropicModel,
    'azure-deepseek': createAzureDeepseekModel,
  });

// Also exported under the generic index-signature shape for callers that
// accept arbitrary strings.
export const PROVIDER_REGISTRY: ProviderRegistry = PROVIDERS;

/**
 * Resolve a provider name to its factory. Throws `UsageError` on an
 * unknown name — `loadAgentConfig()` already validates
 * `OUTLOOK_AGENT_PROVIDER` against the `ProviderName` union, so reaching
 * this branch means a programmer bug, not a user-config issue.
 */
export function getProvider(name: ProviderName): ProviderFactory {
  const f = PROVIDERS[name];
  if (f === undefined) {
    throw new UsageError(`Unknown provider: ${String(name)}`);
  }
  return f;
}
