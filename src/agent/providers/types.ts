// src/agent/providers/types.ts
//
// Provider-factory contract. Each provider lives in a sibling file and
// exports a `ProviderFactory` — a pure function that translates a frozen
// `AgentConfig` into a `BaseChatModel` instance ready to be bound to tools
// by `createAgent(...)` in Unit 5.
//
// Factories MUST read their env vars from `cfg.providerEnv` (frozen
// snapshot built by `loadAgentConfig`) — never from `process.env` directly.
// This keeps the config surface auditable and makes tests deterministic
// without mutating the real environment.

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentConfig, ProviderName } from '../../config/agent-config';

/**
 * Translates a frozen `AgentConfig` into a LangChain chat-model instance.
 * Synchronous — v1 factories do not perform network probes. Throws
 * `ConfigurationError` on missing/invalid required env vars and
 * `UsageError` on internally-inconsistent inputs.
 */
export type ProviderFactory = (cfg: AgentConfig) => BaseChatModel;

/**
 * Registry shape. Indexing by an arbitrary string returns `undefined` so
 * callers must narrow — `getProvider` does this by throwing `UsageError`
 * for unknown names.
 */
export interface ProviderRegistry {
  readonly [k: string]: ProviderFactory | undefined;
}

// Re-exported for consumer ergonomics so `registry.ts` and the factories
// only need one import path.
export type { AgentConfig, ProviderName };
