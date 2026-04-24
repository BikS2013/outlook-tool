// src/agent/providers/openai.ts
//
// Factory for the `openai` provider (native OpenAI API via @langchain/openai).
// Normative spec: docs/design/project-design.md §5.1.
//
// Standard env vars (v2.0.0+):
//   OPENAI_API_KEY   — required
//   OPENAI_BASE_URL  — optional (proxy / gateway override)
//   OPENAI_ORG_ID    — optional

import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';

const ENV_API_KEY = 'OPENAI_API_KEY';
const ENV_BASE_URL = 'OPENAI_BASE_URL';
const ENV_ORG = 'OPENAI_ORG_ID';

/**
 * Construct a `ChatOpenAI` from the provider-env snapshot.
 *
 * Required: OPENAI_API_KEY.
 * Optional: OPENAI_BASE_URL, OPENAI_ORG_ID.
 */
export const createOpenaiModel: ProviderFactory = (
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
  const organization = env[ENV_ORG];

  // Only build `configuration` if at least one sub-field is set, so we don't
  // hand the SDK an empty object it might complain about in future versions.
  const configuration: { baseURL?: string; organization?: string } = {};
  if (baseURL !== undefined && baseURL !== '') configuration.baseURL = baseURL;
  if (organization !== undefined && organization !== '') {
    configuration.organization = organization;
  }
  const hasConfig = Object.keys(configuration).length > 0;

  return new ChatOpenAI({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey,
    ...(hasConfig ? { configuration } : {}),
  });
};
