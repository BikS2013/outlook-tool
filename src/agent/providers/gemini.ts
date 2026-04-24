// src/agent/providers/gemini.ts
//
// Factory for the `gemini` provider (Google Gemini via
// @langchain/google-genai). Replaces `google.ts` as of v2.0.0.
// The provider id `google` is still accepted at parse time in
// `agent-config.ts` and normalised to `gemini` before reaching here.
//
// Normative spec: docs/design/project-design.md §5.3.
//
// Standard env var: GOOGLE_API_KEY (also accepts GEMINI_API_KEY as an alias).

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';

const ENV_API_KEY = 'GOOGLE_API_KEY';
const ENV_API_KEY_ALIAS = 'GEMINI_API_KEY';

/**
 * Construct a `ChatGoogleGenerativeAI` from the provider-env snapshot.
 *
 * Required: GOOGLE_API_KEY (or GEMINI_API_KEY as an alias).
 * Do NOT set `maxOutputTokens` — varies by model and we rely on SDK defaults.
 */
export const createGeminiModel: ProviderFactory = (
  cfg: AgentConfig,
): BaseChatModel => {
  const env = cfg.providerEnv;

  // Accept GEMINI_API_KEY as an alias for GOOGLE_API_KEY.
  const apiKey = env[ENV_API_KEY] || env[ENV_API_KEY_ALIAS];
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigurationError(ENV_API_KEY, [
      ENV_API_KEY,
      ENV_API_KEY_ALIAS,
      '.env',
      '~/.tool-agents/outlook-cli/.env',
    ]);
  }

  return new ChatGoogleGenerativeAI({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey,
  });
};
