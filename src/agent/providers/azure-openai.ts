// src/agent/providers/azure-openai.ts
//
// Factory for the `azure-openai` provider (Azure OpenAI Service via
// @langchain/openai's `AzureChatOpenAI`). Normative spec:
// docs/design/project-design.md §5.4.

import { AzureChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';

const ENV_API_KEY = 'OUTLOOK_AGENT_AZURE_OPENAI_API_KEY';
const ENV_ENDPOINT = 'OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT';
const ENV_DEPLOYMENT = 'OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT';
const ENV_API_VERSION = 'OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION';

/**
 * Construct an `AzureChatOpenAI` from the provider-env snapshot.
 *
 * Required: endpoint, api-key, deployment name.
 * Optional: api-version — when unset we rely on the SDK default. Per the
 * project's global no-fallback rule we never fabricate a default value for
 * mandatory settings, but the Azure OpenAI SDK itself ships a sensible
 * default for the api-version query param, so forwarding `undefined`
 * is the documented pass-through behaviour, not a fallback we invent.
 */
export const createAzureOpenaiModel: ProviderFactory = (
  cfg: AgentConfig,
): BaseChatModel => {
  const env = cfg.providerEnv;

  const apiKey = env[ENV_API_KEY];
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigurationError(ENV_API_KEY, [ENV_API_KEY, '.env']);
  }
  const endpoint = env[ENV_ENDPOINT];
  if (endpoint === undefined || endpoint === '') {
    throw new ConfigurationError(ENV_ENDPOINT, [ENV_ENDPOINT, '.env']);
  }
  const deployment = env[ENV_DEPLOYMENT];
  if (deployment === undefined || deployment === '') {
    throw new ConfigurationError(ENV_DEPLOYMENT, [ENV_DEPLOYMENT, '.env']);
  }
  const apiVersion = env[ENV_API_VERSION];

  return new AzureChatOpenAI({
    model: cfg.model,
    temperature: cfg.temperature,
    azureOpenAIApiKey: apiKey,
    azureOpenAIEndpoint: endpoint,
    azureOpenAIApiDeploymentName: deployment,
    ...(apiVersion !== undefined && apiVersion !== ''
      ? { azureOpenAIApiVersion: apiVersion }
      : {}),
  });
};
