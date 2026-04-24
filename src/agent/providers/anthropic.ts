// src/agent/providers/anthropic.ts
//
// Factory for the `anthropic` provider (native Anthropic Messages API via
// @langchain/anthropic). Normative spec: docs/design/project-design.md §5.2.
//
// Standard env vars (v2.0.0+):
//   ANTHROPIC_API_KEY   — required
//   ANTHROPIC_BASE_URL  — optional (proxy / gateway override)

import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';

const ENV_API_KEY = 'ANTHROPIC_API_KEY';
const ENV_BASE_URL = 'ANTHROPIC_BASE_URL';

/**
 * Construct a `ChatAnthropic` from the provider-env snapshot.
 *
 * Required: ANTHROPIC_API_KEY.
 * Optional: ANTHROPIC_BASE_URL (forwarded to the SDK via
 * `clientOptions.baseURL` — confirmed against @anthropic-ai/sdk 0.x
 * `ClientOptions.baseURL` signature).
 */
export const createAnthropicModel: ProviderFactory = (
  cfg: AgentConfig,
): BaseChatModel => {
  const env = cfg.providerEnv;

  const apiKey = env[ENV_API_KEY];
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigurationError(ENV_API_KEY, [
      ENV_API_KEY,
      '~/.tool-agents/outlook-cli/.env',
      '~/.tool-agents/outlook-cli/config.json',
    ]);
  }

  const baseURL = env[ENV_BASE_URL];
  const clientOptions =
    baseURL !== undefined && baseURL !== '' ? { baseURL } : undefined;

  return new ChatAnthropic({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey,
    ...(clientOptions ? { clientOptions } : {}),
  });
};
