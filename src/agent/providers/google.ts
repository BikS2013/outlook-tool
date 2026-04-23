// src/agent/providers/google.ts
//
// Factory for the `google` provider (Google Gemini via
// @langchain/google-genai). Normative spec: docs/design/project-design.md §5.3.

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';

const ENV_API_KEY = 'OUTLOOK_AGENT_GOOGLE_API_KEY';

/**
 * Construct a `ChatGoogleGenerativeAI` from the provider-env snapshot.
 *
 * Required: OUTLOOK_AGENT_GOOGLE_API_KEY.
 * Do NOT set `maxOutputTokens` — varies by model and we rely on SDK defaults.
 */
export const createGoogleModel: ProviderFactory = (
  cfg: AgentConfig,
): BaseChatModel => {
  const env = cfg.providerEnv;

  const apiKey = env[ENV_API_KEY];
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigurationError(ENV_API_KEY, [ENV_API_KEY, '.env']);
  }

  return new ChatGoogleGenerativeAI({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey,
  });
};
