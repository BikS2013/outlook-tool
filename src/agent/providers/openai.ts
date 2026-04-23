// src/agent/providers/openai.ts
//
// Factory for the `openai` provider (native OpenAI API via @langchain/openai).
// Normative spec: docs/design/project-design.md §5.1.

import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';

const ENV_API_KEY = 'OUTLOOK_AGENT_OPENAI_API_KEY';
const ENV_BASE_URL = 'OUTLOOK_AGENT_OPENAI_BASE_URL';
const ENV_ORG = 'OUTLOOK_AGENT_OPENAI_ORG';

/**
 * Construct a `ChatOpenAI` from the provider-env snapshot.
 *
 * Required: OUTLOOK_AGENT_OPENAI_API_KEY.
 * Optional: OUTLOOK_AGENT_OPENAI_BASE_URL, OUTLOOK_AGENT_OPENAI_ORG.
 */
export const createOpenaiModel: ProviderFactory = (
  cfg: AgentConfig,
): BaseChatModel => {
  const env = cfg.providerEnv;

  const apiKey = env[ENV_API_KEY];
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigurationError(ENV_API_KEY, [ENV_API_KEY, '.env']);
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
