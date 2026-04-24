// src/agent/providers/local-openai.ts
//
// Factory for the `local-openai` provider — OpenAI wire-compatible local
// endpoints (LightLLM, OLLaMA via /v1, MLX-LM, LLaMA.CPP llama-server,
// vLLM, etc.). We reuse `ChatOpenAI` with a custom `baseURL`.
//
// Standard env var resolution (in order):
//   1. OPENAI_BASE_URL        — standard OpenAI env var (also used by openai provider)
//   2. LOCAL_OPENAI_BASE_URL  — dedicated local-only override
//   3. OLLAMA_HOST            — mapped as `http://${OLLAMA_HOST}/v1`
//
// OPENAI_API_KEY is optional — many local servers accept any non-empty
// string. When missing, the factory uses the sentinel `"not-needed"` so
// the SDK does not reject the config (this is documented as a project-level
// exception for local-openai only).
//
// Normative spec: standard_conventions §6 (local-openai row).

import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { ConfigurationError } from '../../config/errors';
import type { AgentConfig } from '../../config/agent-config';
import type { ProviderFactory } from './types';

const ENV_BASE_URL = 'OPENAI_BASE_URL';
const ENV_LOCAL_BASE_URL = 'LOCAL_OPENAI_BASE_URL';
const ENV_OLLAMA_HOST = 'OLLAMA_HOST';
const ENV_API_KEY = 'OPENAI_API_KEY';

/**
 * Resolve the baseURL for the local OpenAI-compatible endpoint.
 *
 * Checks (in order):
 *   OPENAI_BASE_URL → LOCAL_OPENAI_BASE_URL → http://${OLLAMA_HOST}/v1
 *
 * Returns `undefined` if none are set (the factory will then throw).
 */
function resolveBaseUrl(env: Readonly<Record<string, string>>): string | undefined {
  const direct = env[ENV_BASE_URL];
  if (direct !== undefined && direct !== '') return direct;

  const local = env[ENV_LOCAL_BASE_URL];
  if (local !== undefined && local !== '') return local;

  const ollamaHost = env[ENV_OLLAMA_HOST];
  if (ollamaHost !== undefined && ollamaHost !== '') {
    // Normalize: if the host already contains a scheme, use as-is + /v1.
    // Otherwise prefix with http://.
    const base = ollamaHost.includes('://')
      ? ollamaHost.replace(/\/+$/, '')
      : `http://${ollamaHost}`;
    return `${base}/v1`;
  }

  return undefined;
}

/**
 * Construct a `ChatOpenAI` pointed at a local OpenAI-compatible endpoint.
 *
 * Required: at least one of OPENAI_BASE_URL / LOCAL_OPENAI_BASE_URL /
 *   OLLAMA_HOST must be set.
 * Optional: OPENAI_API_KEY — defaults to `"not-needed"` when absent,
 *   because most local servers do not enforce authentication.
 *
 * Wraps connect errors in an `UpstreamError` with the resolved baseURL so
 * the user can see where the agent tried to connect (done at the graph
 * layer, not here — the factory itself is synchronous).
 */
export const createLocalOpenaiModel: ProviderFactory = (
  cfg: AgentConfig,
): BaseChatModel => {
  const env = cfg.providerEnv;

  const baseURL = resolveBaseUrl(env);
  if (baseURL === undefined) {
    throw new ConfigurationError(ENV_BASE_URL, [
      `--base-url`,
      ENV_BASE_URL,
      ENV_LOCAL_BASE_URL,
      `${ENV_OLLAMA_HOST} (maps to http://<host>/v1)`,
      '~/.tool-agents/outlook-cli/.env',
      '~/.tool-agents/outlook-cli/config.json',
    ]);
  }

  // Many local servers accept any non-empty API key, including the sentinel.
  // We never invent a value for real providers, but for local-openai this is
  // explicitly documented as a project-level default exception.
  const apiKey = (env[ENV_API_KEY] !== undefined && env[ENV_API_KEY] !== '')
    ? env[ENV_API_KEY]
    : 'not-needed';

  return new ChatOpenAI({
    model: cfg.model,
    temperature: cfg.temperature,
    apiKey,
    configuration: { baseURL },
  });
};
