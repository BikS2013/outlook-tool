// src/agent/providers/azure-deepseek.ts
//
// Factory for the `azure-deepseek` provider — DeepSeek models hosted in
// Microsoft Foundry on the OpenAI-compatible `/openai/v1` path. We use
// `ChatOpenAI` (NOT `AzureChatOpenAI`) because Foundry's /openai/v1 endpoint
// is OpenAI wire-compatible and does NOT want an `api-version` query param
// (AzureChatOpenAI would inject one). Normative spec:
// docs/design/project-design.md §5.6 plus the model-variant deep-dive in
// docs/research/azure-deepseek-tool-calling.md §7.
//
// Standard env vars (v2.0.0+):
//   AZURE_AI_INFERENCE_KEY       — required (shared with azure-anthropic)
//   AZURE_AI_INFERENCE_ENDPOINT  — required (shared with azure-anthropic)
//   AZURE_DEEPSEEK_MODEL         — optional (user-convenience mirror of
//                                  OUTLOOK_AGENT_MODEL; see note below)
//
// `cfg.model` is canonical for the deployment name. `loadAgentConfig` has
// already resolved it (CLI flag `--model` > `OUTLOOK_AGENT_MODEL`). We
// cross-check: if `AZURE_DEEPSEEK_MODEL` is also set and disagrees with
// `cfg.model`, throw `UsageError` so the user is forced to decide. We never
// read `AZURE_DEEPSEEK_MODEL` as an alternative source of the model — that
// env var is purely a user-documentation alias for `OUTLOOK_AGENT_MODEL` in
// practice.
//
// Note: `azure-deepseek` is a project-extension provider; it is NOT part of
// the canonical 6-slot standard set defined in standard_conventions. The
// standard 6 are: openai, anthropic, gemini, azure-openai, azure-anthropic,
// local-openai.

import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import { UsageError } from '../../commands/list-mail';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';
import { normalizeFoundryEndpoint } from './util';

const ENV_ENDPOINT = 'AZURE_AI_INFERENCE_ENDPOINT';
const ENV_API_KEY = 'AZURE_AI_INFERENCE_KEY';
const ENV_MODEL = 'AZURE_DEEPSEEK_MODEL';

/**
 * Tool-calling denylist (research §7 "Implementation Recommendation"). Each
 * pattern is matched case-insensitively against the effective model name
 * via `RegExp.test(...)`. Any match rejects the config at load time.
 *
 * Per research §7.2:
 *   - DeepSeek-V3.2-Speciale       — no tool calling (by design).
 *   - DeepSeek-R1 (original)       — no tool calling; exclude R1-0528.
 *   - deepseek-reasoner            — same model, different alias.
 *   - MAI-DS-R1                    — unconfirmed.
 *   - DeepSeek-R1-0528             — tool calling added upstream, but
 *                                    ChatOpenAI parameter injection
 *                                    (temperature/top_p/...) is rejected by
 *                                    the Foundry API for this variant.
 */
const DEEPSEEK_TOOL_CALLING_DENYLIST: readonly RegExp[] = [
  /deepseek-v3\.2-speciale/i,
  /deepseek-r1(?!-0528)/i, // R1 original but NOT R1-0528
  /deepseek-reasoner/i,
  /mai-ds-r1/i,
  /deepseek-r1-0528/i, // rejected per research §7 (ChatOpenAI incompat)
];

const DENYLIST_DETAIL =
  'is not supported on Azure Foundry for tool-calling. ' +
  'Denylist: R1 family (R1, R1-0528, deepseek-reasoner, MAI-DS-R1) and ' +
  'V3.2-Speciale. Use DeepSeek-V3, DeepSeek-V3.1, or DeepSeek-V3.2.';

/**
 * Validate the effective deployment/model id against the research-backed
 * denylist. Throws `ConfigurationError` with `missingSetting:
 * AZURE_DEEPSEEK_MODEL` and a descriptive `detail` when the variant is
 * known-broken.
 */
function assertDeepseekVariantSupported(modelName: string): void {
  for (const pattern of DEEPSEEK_TOOL_CALLING_DENYLIST) {
    if (pattern.test(modelName)) {
      throw new ConfigurationError(
        'AZURE_DEEPSEEK_MODEL',
        ['--model', 'OUTLOOK_AGENT_MODEL'],
        `${modelName} ${DENYLIST_DETAIL}`,
      );
    }
  }
}

/**
 * Construct a `ChatOpenAI` pointed at the Foundry /openai/v1 baseURL.
 *
 * Required: endpoint, api-key.
 * Deployment name: `cfg.model` (top-level `--model` / `OUTLOOK_AGENT_MODEL`)
 * is the source of truth. `AZURE_DEEPSEEK_MODEL` may also be set; if both
 * are set AND disagree → UsageError.
 */
export const createAzureDeepseekModel: ProviderFactory = (
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

  const endpointRaw = env[ENV_ENDPOINT];
  if (endpointRaw === undefined || endpointRaw === '') {
    throw new ConfigurationError(ENV_ENDPOINT, [
      ENV_ENDPOINT,
      '~/.tool-agents/outlook-cli/.env',
      '~/.tool-agents/outlook-cli/config.json',
    ]);
  }

  const envModel = env[ENV_MODEL];
  if (envModel !== undefined && envModel !== '' && envModel !== cfg.model) {
    throw new UsageError(
      `azure-deepseek: cfg.model (${JSON.stringify(cfg.model)}) and ` +
        `${ENV_MODEL} (${JSON.stringify(envModel)}) disagree. ` +
        `Set exactly one, or set them to the same value.`,
    );
  }

  assertDeepseekVariantSupported(cfg.model);

  const baseURL = normalizeFoundryEndpoint(endpointRaw, '/openai/v1');

  // NOTE: ChatOpenAI (not AzureChatOpenAI). Foundry's /openai/v1 path is an
  // OpenAI-compatible endpoint and does NOT accept an `api-version` query
  // string — AzureChatOpenAI would inject one, breaking the request.
  return new ChatOpenAI({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey,
    configuration: { baseURL },
  });
};
