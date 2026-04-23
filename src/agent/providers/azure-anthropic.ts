// src/agent/providers/azure-anthropic.ts
//
// Factory for the `azure-anthropic` provider — Anthropic models hosted in
// Microsoft Foundry. We reuse @langchain/anthropic's `ChatAnthropic` but
// point it at the Foundry endpoint via `clientOptions.baseURL`.
// Normative spec: docs/design/project-design.md §5.5.
//
// Env-var contract (design §4 + §5.5):
//   OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY       (shared with azure-deepseek)
//   OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT  (shared with azure-deepseek)
//   OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL        (user-convenience mirror of
//                                               OUTLOOK_AGENT_MODEL; see
//                                               note on cfg.model below)
//
// `cfg.model` is canonical for the model/deployment name. `loadAgentConfig`
// has already resolved it (CLI flag `--model` > `OUTLOOK_AGENT_MODEL`). We
// cross-check: if `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` is also set and
// disagrees with `cfg.model`, throw `UsageError` so the user is forced to
// decide. We never read `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` as an
// alternative source of the model — that env var is purely a
// user-documentation alias for `OUTLOOK_AGENT_MODEL` in practice.

import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import { UsageError } from '../../commands/list-mail';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';
import { normalizeFoundryEndpoint } from './util';

const ENV_ENDPOINT = 'OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT';
const ENV_API_KEY = 'OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY';
const ENV_MODEL = 'OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL';

/**
 * Construct a `ChatAnthropic` pointed at a Foundry baseURL.
 *
 * `cfg.model` is the source of truth for the Foundry deployment id
 * (e.g. `claude-opus-4-7`).
 *
 * Required:
 *   OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY
 *   OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT
 *     e.g. https://<resource>.services.ai.azure.com  (factory appends /anthropic)
 */
export const createAzureAnthropicModel: ProviderFactory = (
  cfg: AgentConfig,
): BaseChatModel => {
  const env = cfg.providerEnv;

  const apiKey = env[ENV_API_KEY];
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigurationError(ENV_API_KEY, [ENV_API_KEY]);
  }

  const endpointRaw = env[ENV_ENDPOINT];
  if (endpointRaw === undefined || endpointRaw === '') {
    throw new ConfigurationError(ENV_ENDPOINT, [ENV_ENDPOINT]);
  }

  // Cross-check OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL against cfg.model. If
  // both are set AND disagree → UsageError; if only the env is set,
  // cfg.model still wins (loadAgentConfig already required
  // OUTLOOK_AGENT_MODEL / --model).
  const envModel = env[ENV_MODEL];
  if (envModel !== undefined && envModel !== '' && envModel !== cfg.model) {
    throw new UsageError(
      `azure-anthropic: cfg.model (${JSON.stringify(cfg.model)}) and ` +
        `${ENV_MODEL} (${JSON.stringify(envModel)}) disagree. ` +
        `Set exactly one, or set them to the same value.`,
    );
  }

  const baseURL = normalizeFoundryEndpoint(endpointRaw, '/anthropic');

  return new ChatAnthropic({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey,
    clientOptions: { baseURL },
  });
};
