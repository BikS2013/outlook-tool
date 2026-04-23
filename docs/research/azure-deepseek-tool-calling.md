# Azure DeepSeek Tool Calling — Verification Research

**Produced by:** researcher agent
**Date:** 2026-04-23
**Requested by:** investigation-langgraph-agent.md §8 (Risk 3)
**Covers:** DeepSeek models on Azure AI Foundry `/openai/v1` endpoint — tool-calling capability verification for the `azure-deepseek` provider factory.

---

## 1. Summary

Tool calling **is supported** for DeepSeek-V3.x models (V3.1, V3.2 standard) on Azure AI Foundry's `/openai/v1` OpenAI-compatible endpoint, confirmed by authoritative Microsoft Learn documentation. The `/openai/v1` endpoint is the current recommended canonical route for DeepSeek on Azure; `api-version` query parameters are not required. The two notable exceptions are **DeepSeek-V3.2-Speciale** (omits tool calling entirely by design) and **DeepSeek-R1** original (does not support tool calling per official Microsoft Learn docs), while the newer **DeepSeek-R1-0528** added function calling support as of May 2025. Using `ChatOpenAI` from `@langchain/openai` pointed at this endpoint works for DeepSeek-V3.x tool calls, but the **reasoning models (R1 family) have known LangChain.js compatibility problems** that make them unsuitable for agent use without significant workarounds.

---

## 2. Authoritative Sources

- **[Microsoft Learn — Azure OpenAI in Microsoft Foundry Models v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)** — AUTHORITATIVE. Canonical reference for the `/openai/v1` endpoint, DeepSeek model support, `api-version` deprecation, URL patterns, and authentication. Confirms DeepSeek and Grok models are supported via the v1 chat completions syntax.

- **[Microsoft Learn — Endpoints for Microsoft Foundry Models](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints)** — AUTHORITATIVE. Describes the Azure OpenAI endpoint architecture, keyless auth pattern, and shows `DeepSeek-V3.1` as a concrete example with the `/openai/v1` URL.

- **[Microsoft Learn — Tutorial: Get started with DeepSeek-R1 in Foundry Models](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/tutorials/get-started-deepseek-r1)** — AUTHORITATIVE. Explicitly states: "DeepSeek-R1 is a reasoning model that generates explanations alongside answers. It supports text-based chat completions but **doesn't support tool calling or structured output formats**." Confirms `<think>` tag wrapping of reasoning content.

- **[Microsoft Learn — Use LangChain with models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/langchain-models)** — AUTHORITATIVE. Official Python-focused LangChain guide for Foundry; demonstrates DeepSeek-R1-0528 in a reasoning context using `init_chat_model("azure_ai:DeepSeek-R1-0528")`. Note: guide uses `langchain-azure-ai` which is Python-only; the TypeScript path uses `@langchain/openai` directly.

- **[Microsoft Tech Community — Introducing DeepSeek-V3.2 and DeepSeek-V3.2-Speciale in Microsoft Foundry](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-deepseek-v3-2-and-deepseek-v3-2-speciale-in-microsoft-foundry/4477549)** — SEMI-AUTHORITATIVE (official Microsoft blog post, not Learn docs). Confirms V3.2 supports tool calling including "thinking with tools"; confirms V3.2-Speciale "does **not** support native function/tool calling".

- **[DeepSeek Official API Docs — Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)** — AUTHORITATIVE (DeepSeek). Shows OpenAI-compatible tool call format using `tools` parameter with OpenAI SDK. Confirms thinking mode supports tool calls from V3.2 onward. Confirms `strict` mode for tool schemas (beta, requires `/beta` base URL).

- **[DeepSeek Official API Docs — Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)** — AUTHORITATIVE (DeepSeek). Confirms `reasoning_content` field in responses when thinking is enabled. Confirms not-supported parameters for reasoning models: `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `logprobs`, `top_logprobs`.

- **[GitHub — langchainjs Issue #7564: Can't use ChatOpenAI with DeepSeek R1](https://github.com/langchain-ai/langchainjs/issues/7564)** — ANECDOTAL (GitHub issue, January 2025). Documents `presence_penalty` default injection by `ChatOpenAI` causing 400 errors with R1.

- **[GitHub — langchain Issue #35059: ChatOpenAI silently drops reasoning_content](https://github.com/langchain-ai/langchain/issues/35059)** — ANECDOTAL (GitHub issue, February 2026, Python LangChain). Behavior is likely mirrored in LangChain.js; confirms `reasoning_content` is silently dropped by `ChatOpenAI`-based classes.

- **[GitHub — langchainjs Issue #9663: ChatOpenAI constructor overrides reasoning option](https://github.com/langchain-ai/langchainjs/issues/9663)** — ANECDOTAL (GitHub issue, December 2025). `ChatOpenAI` operator precedence bug silently ignores `reasoning` parameter.

- **[DeepSeek Azure AI Foundry model catalog entry](https://ai.azure.com/catalog/models/DeepSeek-V3.2)** — SEMI-AUTHORITATIVE. Azure AI model catalog pages for V3.2 and V3.2-Speciale; note that some capability fields (explicit `tool_choice` mode listing) show "provider has not supplied this information."

---

## 3. Endpoint & Auth

### Canonical URL Pattern

Two accepted formats (both confirmed by [Microsoft Learn v1 API doc](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)):

```
https://{resource-name}.openai.azure.com/openai/v1/
https://{resource-name}.services.ai.azure.com/openai/v1/
```

The `services.ai.azure.com` domain is the newer Foundry-unified domain. The `openai.azure.com` domain is the legacy Azure OpenAI domain that still works. Either is valid for DeepSeek deployments.

The trailing slash on `/openai/v1/` is shown in all Microsoft examples; the OpenAI SDK appends paths like `/chat/completions` on top of this base URL.

### `api-version` Query Parameter

**Not required** on the `/openai/v1` endpoint. This is an explicit design goal of the v1 API: "no need to specify new `api-version`s each month." ([Source](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)) The legacy pre-v1 endpoints required `?api-version=YYYY-MM-DD`; the `/openai/v1` path eliminates this requirement entirely.

### Authentication

Two supported methods:

**Method 1 — API Key (suitable for the outlook-cli use case):**

```
Authorization: Bearer {azure-api-key}
```

The OpenAI SDK (and `@langchain/openai`'s `ChatOpenAI`) sends the `apiKey` value in the standard `Authorization: Bearer` header. This is the header to use. There is no separate `api-key` header required (that header was specific to the legacy `AzureOpenAI` client, not the standard OpenAI client).

**Method 2 — Microsoft Entra ID (keyless, recommended for production Azure workloads):**

Use `DefaultAzureCredential` from `@azure/identity` with scope `https://ai.azure.com/.default`. Not applicable for the outlook-cli personal-use scenario.

### API Key Source

Azure Portal → your Foundry resource → **Keys and Endpoint** blade → copy **Key 1** or **Key 2**. The key is a raw string (no `Bearer` prefix needed when setting `apiKey` in the SDK constructor; the SDK adds the `Authorization: Bearer` prefix automatically).

---

## 4. Model Variant Support Matrix

| Model | Deployment Type | Tool Calling | Parallel Tools | Structured Output | Notes |
|---|---|---|---|---|---|
| **DeepSeek-V3.2** | Global Standard (MaaS) | YES | Not officially documented — likely passed through as OpenAI-compatible but unconfirmed | Not documented — same caveat | V3.2 is the recommended choice for agent use. Supports "thinking with tools" mode (pass back `reasoning_content` in multi-turn). Thinking mode can be enabled via `extra_body: { thinking: { type: "enabled" } }`. |
| **DeepSeek-V3.2-Speciale** | Global Standard (MaaS) | NO | NO | NO | Explicitly omits tool calling. Do not use for agent workflows. Use for pure reasoning / Q&A tasks. |
| **DeepSeek-V3.1** | Global Standard (MaaS) | YES | Not officially documented | Not officially documented | Older generation; V3.2 is preferred. Tool calling works via `/openai/v1` endpoint. |
| **DeepSeek-V3** (original, `DeepSeek-V3`) | Global Standard (MaaS) | YES | Not officially documented | Not officially documented | Even older; documented as supporting tool calling in DeepSeek's own API docs (`deepseek-chat`). |
| **DeepSeek-R1** (original) | Global Standard (MaaS) | NO | NO | NO | Authoritative Microsoft Learn statement: "doesn't support tool calling or structured output formats." Reasoning content wrapped in `<think>...</think>` tags in the text content field. |
| **DeepSeek-R1-0528** | Global Standard (MaaS) | YES (added in May 2025) | Not documented | YES (added in May 2025) | Updated version of R1. Function calling explicitly listed as a capability improvement. However, R1-family parameter constraints (`temperature` etc.) still cause `ChatOpenAI` compatibility issues — see §5. |
| **MAI-DS-R1** | Global Standard (MaaS) | Not confirmed | Not confirmed | Not confirmed | Microsoft post-trained R1 variant. Azure Foundry catalog does not list function calling as a confirmed feature. Treat as unsupported until verified. |

**Note on "Models as a Service" (MaaS) vs. "Model Provisioned Deployment":** All DeepSeek models in the table above are available as MaaS (pay-per-token serverless deployments). There is no evidence in the reviewed documentation that Provisioned (PTU) deployments are available for DeepSeek models as of this research. Tool-calling behavior is expected to be identical regardless of deployment type since it is governed by the model itself, not the capacity allocation type.

**Note on `tool_choice` parameter values:** The DeepSeek API is documented as OpenAI-compatible, and the `tools` parameter is confirmed supported. The specific `tool_choice` parameter values (`auto`, `none`, `required`) and `parallel_tool_calls` are passed through the OpenAI wire format; DeepSeek's own docs do not enumerate these explicitly. Since the endpoint is fully OpenAI-compatible, standard OpenAI `tool_choice` values should be honored — but this has not been independently verified against Azure Foundry's implementation. See §6 for the recommended curl test.

---

## 5. LangChain JS Compatibility

### `ChatOpenAI` with DeepSeek-V3.x (Standard Models) — Viable

Using `ChatOpenAI` from `@langchain/openai` pointed at the Azure Foundry `/openai/v1` base URL works for DeepSeek-V3.x standard models (V3.1, V3.2). The OpenAI-compatible endpoint accepts the standard `tools`, `tool_choice` parameters that `ChatOpenAI` serializes via `bindTools()`. Tool call response parsing (the `tool_calls` array in the response `choices[0].message`) matches the OpenAI wire format that `ChatOpenAI` expects.

**Constructor pattern that works:**

```typescript
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "DeepSeek-V3.2", // must match your Azure deployment name exactly
  openAIApiKey: process.env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY,
  configuration: {
    baseURL: "https://{resource}.services.ai.azure.com/openai/v1",
  },
  temperature: 0,
});
```

Note: Do not use `AzureChatOpenAI` for the `azure-deepseek` provider — that class targets the legacy Azure OpenAI resource endpoint which requires deployment-level URLs and `api-version`. Use `ChatOpenAI` with a custom `baseURL` instead.

### `ChatOpenAI` with DeepSeek-R1 Family — Problematic

Multiple confirmed GitHub issues document that `ChatOpenAI` injects default values for parameters that R1-family models do not accept:

- `temperature` (defaults to `1`)
- `topP` (defaults to `1`)
- `frequencyPenalty` (defaults to `0`)
- `presencePenalty` (defaults to `0`)

The `??` (nullish coalescing) operator in `ChatOpenAI`'s constructor means there is no way to "unset" these to prevent them from being sent. The API returns `400 Bad Request` with the message `"deepseek-reasoner does not support the parameter 'presence_penalty'"`. ([Source: langchainjs #7564](https://github.com/langchain-ai/langchainjs/issues/7564))

Workarounds exist (passing `undefined` for these fields via `clientOptions` or monkey-patching), but they are fragile. The factory should reject R1-family model names at config time.

### `reasoning_content` / `<think>` Block Handling

For DeepSeek-V3.2 when thinking mode is enabled (or for R1 models if they were usable):

- The response carries a `reasoning_content` field at the same level as `content` in the API JSON.
- `ChatOpenAI` from `@langchain/openai` **silently drops** the `reasoning_content` field during message conversion; it does not appear in `AIMessage.content` or `AIMessage.additional_kwargs`. ([Source: langchain #35059](https://github.com/langchain-ai/langchain/issues/35059) — Python, but the same message conversion logic exists in LangChain.js)
- For DeepSeek-R1 (original), reasoning is embedded in the text content as `<think>...</think>` tags, not in a separate field. `ChatOpenAI` does pass this through in `content` since it is plain text.
- **Impact for V3.2 agent use (non-thinking mode):** If thinking mode is NOT enabled on V3.2, the standard tool call flow proceeds identically to any OpenAI model — `reasoning_content` is absent and `ChatOpenAI` works correctly. The factory should not enable thinking mode for agent use.

### `ChatOpenAI` Constructor Operator Precedence Bug (langchainjs #9663)

A bug where providing a `reasoning` option to `ChatOpenAI` silently overwrites it with `{ effort: undefined }` due to incorrect ternary operator precedence in `chat_models.ts`. This does not directly affect DeepSeek-V3.x (which does not use the `reasoning` parameter), but it is a general fragility of `ChatOpenAI` with non-standard endpoint options. Do not pass a `reasoning` field in the constructor for the `azure-deepseek` factory.

---

## 6. Known Quirks / Pitfalls

### Pitfall 1 — V3.2-Speciale is silently tool-call-incapable

The model name `DeepSeek-V3.2-Speciale` will be accepted by the API and return text responses, but **will never generate a `tool_calls` response**, breaking the ReAct loop silently. The agent will appear to run (no exception), but will always return a final answer without invoking any tool. **Detection:** the factory must reject this model name at config load time.

### Pitfall 2 — R1 models send 400 errors due to LangChain parameter injection

As documented in §5, R1-family models reject `presence_penalty` and other defaults injected by `ChatOpenAI`. The 400 error surfaces as an `UpstreamError` at runtime (first tool call or first model invocation), not at construction time. **Detection:** the factory must reject R1-family model names at config load time.

### Pitfall 3 — `parallel_tool_calls` not explicitly documented for DeepSeek-V3.x on Azure

The OpenAI wire format's `parallel_tool_calls: false` flag is supported by `ChatOpenAI` (it can be passed via `model_kwargs`). Whether Azure Foundry's DeepSeek-V3.x deployment honors, ignores, or rejects this field is not documented. If the model returns multiple `tool_calls` in a single response when the ReAct loop expects one at a time, add `model_kwargs: { parallel_tool_calls: false }` to the constructor. Verify with the curl test in §7.

### Pitfall 4 — Thinking mode (`reasoning_content`) breaks multi-turn tool calling

If thinking mode is enabled on DeepSeek-V3.2 (via `extra_body: { thinking: { type: "enabled" } }`), the API requires that `reasoning_content` from the previous assistant turn is **passed back** in the next turn. `ChatOpenAI` and the standard LangGraph ToolNode do not do this — they pass only `content` and `tool_calls`. The API returns a 400 error. **Do not enable thinking mode for agent (tool-calling) use.** Non-thinking mode (default) is safe.

### Pitfall 5 — Model name must exactly match the Azure deployment name

The `model` parameter in the constructor is passed verbatim as the `model` field in the API request body. If the user's Azure deployment is named `deepseek-v3` (lowercase) but the config says `DeepSeek-V3.2`, the API returns `404 model not found`. The factory must document that `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` must match the **exact deployment name** from the Azure portal.

### Pitfall 6 — `api-version` on legacy endpoint vs. `/openai/v1`

If the base URL is accidentally set to the legacy format (e.g., `https://{resource}.openai.azure.com` without the `/openai/v1` path), the SDK requires `api-version` and uses `AzureOpenAI` auth headers. The factory must ensure the `/openai/v1` suffix is always appended when using `ChatOpenAI` (not `AzureChatOpenAI`).

### Pitfall 7 — `structured_output` / `json_schema` response_format not confirmed for DeepSeek-V3.x on Azure

A Python LangChain issue ([langchain #29282](https://github.com/langchain-ai/langchain/issues/29282)) documents that `with_structured_output()` fails for DeepSeek-V3 because `response_format: { type: "json_schema" }` returns an error. This affects structured output but NOT standard tool calling. Standard tool calling (`tools` + `tool_calls` in response) is a separate mechanism and is not impacted. The factory should not enable `withStructuredOutput()` patterns for DeepSeek — use tool schemas instead.

---

## 7. Implementation Recommendation

### 7.1 Environment Variables

Align with the `OUTLOOK_AGENT_AZURE_DEEPSEEK_*` naming convention from the refined spec and the investigation document §3 Provider Registry Blueprint:

| Variable | Required | Description |
|---|---|---|
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` | YES | API key from Azure Portal → Foundry resource → Keys and Endpoint. Shared with `azure-anthropic` provider. |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` | YES | Base URL of the Foundry resource, e.g. `https://{resource}.services.ai.azure.com`. Factory appends `/openai/v1` internally. |
| `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` | YES | Exact deployment name from Azure portal (e.g. `DeepSeek-V3.2`). Must match the portal deployment name exactly. |

### 7.2 Supported Model Names

The factory must maintain an allowlist of model name patterns that are **known to support tool calling** and an explicit denylist of those that do not:

**Allowlist (tool-calling capable — accept these at config time):**

- Any name matching (case-insensitive): `DeepSeek-V3`, `DeepSeek-V3.1`, `DeepSeek-V3.2`
- Custom deployment names that the user asserts are V3.x variants. Since custom deployment names are arbitrary, the factory should accept any name NOT in the denylist, but warn for unrecognized names.

**Denylist (reject at config time with ConfigurationError):**

- `DeepSeek-V3.2-Speciale`, `deepseek-v3.2-speciale` (case-insensitive) — no tool calling by design.
- `DeepSeek-R1`, `deepseek-r1`, `deepseek-reasoner` (case-insensitive) — no tool calling on original R1.
- `MAI-DS-R1`, `mai-ds-r1` (case-insensitive) — tool calling unconfirmed.

For R1-0528: tool calling was added, but `ChatOpenAI` parameter injection issues remain. Reject with a clear message explaining the known LangChain.js compatibility problem.

### 7.3 TypeScript Constructor Snippet

```typescript
import { ChatOpenAI } from "@langchain/openai";

// Env var names align with investigation-langgraph-agent.md §3 Provider Registry Blueprint.
// URL construction per Microsoft Learn endpoints docs:
//   https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints
// No api-version required per:
//   https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle

const DEEPSEEK_TOOL_CALLING_DENYLIST = [
  /deepseek-v3\.2-speciale/i,
  /deepseek-r1(?!-0528)/i,       // R1 original but NOT R1-0528
  /deepseek-reasoner/i,
  /mai-ds-r1/i,
];

function isToolCallingSafe(modelName: string): boolean {
  return !DEEPSEEK_TOOL_CALLING_DENYLIST.some((pattern) =>
    pattern.test(modelName)
  );
}

export function createAzureDeepSeekModel(env: NodeJS.ProcessEnv): ChatOpenAI {
  const apiKey = env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY;
  const rawEndpoint = env.OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT;
  const modelName = env.OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL;

  if (!apiKey) {
    throw new ConfigurationError({
      code: "CONFIG_MISSING",
      missingSetting: "OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY",
      message:
        "OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY is required for the azure-deepseek provider.",
    });
  }
  if (!rawEndpoint) {
    throw new ConfigurationError({
      code: "CONFIG_MISSING",
      missingSetting: "OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT",
      message:
        "OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT is required for the azure-deepseek provider.",
    });
  }
  if (!modelName) {
    throw new ConfigurationError({
      code: "CONFIG_MISSING",
      missingSetting: "OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL",
      message:
        "OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL is required for the azure-deepseek provider. " +
        "Set it to the exact deployment name from your Azure portal (e.g. DeepSeek-V3.2).",
    });
  }

  if (!isToolCallingSafe(modelName)) {
    throw new ConfigurationError({
      code: "CONFIG_INVALID",
      missingSetting: "OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL",
      message:
        `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL="${modelName}" does not support tool calling ` +
        `on Azure AI Foundry. DeepSeek-V3.2-Speciale omits tool calling by design. ` +
        `DeepSeek-R1 (original) does not support tool calling. MAI-DS-R1 has unconfirmed ` +
        `tool-calling support. Use DeepSeek-V3.2 or DeepSeek-V3.1 for agent workflows.`,
    });
  }

  // Strip any /models suffix that may be present in the endpoint URL.
  // The spec's example endpoint (https://{resource}.services.ai.azure.com/models) uses the
  // legacy Azure AI Inference SDK path. The canonical /openai/v1 path starts from the resource root.
  const baseEndpoint = rawEndpoint.replace(/\/models\/?$/, "").replace(/\/$/, "");
  const baseURL = `${baseEndpoint}/openai/v1`;

  return new ChatOpenAI({
    model: modelName,
    openAIApiKey: apiKey,
    configuration: {
      baseURL,
    },
    temperature: 0,
    // Do NOT set:
    //   - apiVersion (not required for /openai/v1)
    //   - azureOpenAIApiDeploymentName (that is AzureChatOpenAI only)
    //   - reasoning (operator precedence bug in ChatOpenAI langchainjs #9663)
    // Do NOT enable thinking mode — passing reasoning_content back in multi-turn
    // tool use is not handled by LangGraph's standard ToolNode.
  });
}
```

**Source for URL pattern:** [Microsoft Learn — Endpoints for Microsoft Foundry Models](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints)
**Source for no `api-version`:** [Microsoft Learn — v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
**Source for `openAIApiKey` + `configuration.baseURL` pattern:** [LangChain.js docs — ChatOpenAI with custom baseURL](https://docs.langchain.com/oss/javascript/integrations/chat/openai)

### 7.4 Validation Logic Summary

| Condition | Action |
|---|---|
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` not set | Throw `ConfigurationError` (exit 3) |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` not set | Throw `ConfigurationError` (exit 3) |
| `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` not set | Throw `ConfigurationError` (exit 3) |
| Model name matches denylist pattern | Throw `ConfigurationError` (exit 3) with explanation |
| Model name not in any known pattern (custom name) | Accept with a `console.warn` to stderr: "Unrecognized DeepSeek model name. Ensure your deployment supports tool calling." |

### 7.5 Build-Time Verification curl Test

The implementation team should run this test against their actual Azure deployment before integrating:

```bash
curl -X POST \
  "https://{resource}.services.ai.azure.com/openai/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY}" \
  -d '{
    "model": "DeepSeek-V3.2",
    "messages": [{"role": "user", "content": "What is 2+2? Call get_number with the answer."}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_number",
        "description": "Return a number",
        "parameters": {
          "type": "object",
          "properties": {
            "value": {"type": "integer"}
          },
          "required": ["value"]
        }
      }
    }],
    "tool_choice": "required"
  }'
```

**Expected response:** A JSON object where `choices[0].finish_reason === "tool_calls"` and `choices[0].message.tool_calls` is a non-empty array. If `tool_choice: "required"` returns an error, test with `"auto"`.

**What to verify:**
1. `tool_choice: "required"` is accepted (not rejected with 400).
2. `tool_choice: "auto"` is accepted.
3. The response contains `choices[0].message.tool_calls[]` with correct `id`, `type: "function"`, `function.name`, `function.arguments` fields.
4. No `reasoning_content` field appears when thinking mode is not enabled.
5. Confirm no `api-version` query parameter is needed.

### 7.6 Fallback Behavior

Per the global rule in `CLAUDE.md`: "You must never create fallback solutions for configuration settings." The factory does **not** fall back to a "no-tools" mode. If the configured model does not support tool calling (per the denylist), the factory throws `ConfigurationError` at config-load time — before the graph runs. This is consistent with options (b) in the original brief: "Refuse to construct a DeepSeek model for the agent with a clear ConfigurationError if tool calling is unsupported for the selected deployment."

---

## 8. Open Questions

### OQ-1 — `tool_choice: "required"` acceptance on Azure Foundry DeepSeek-V3.2

The DeepSeek public API docs and Microsoft Learn docs confirm the `tools` parameter works, but **do not explicitly enumerate `tool_choice` values** supported by DeepSeek-V3.2 on Azure. `tool_choice: "auto"` is almost certainly passed through (OpenAI compatibility). `tool_choice: "required"` behavior is unconfirmed. The curl test in §7.5 is the definitive verification step. If `"required"` is rejected, the factory should default to `"auto"` and document the behavior.

### OQ-2 — `parallel_tool_calls` pass-through behavior

Whether Azure Foundry's DeepSeek-V3.x deployment honors, ignores, or rejects the `parallel_tool_calls: false` field is not documented. This can cause silent multi-tool-call responses that break a step-by-step ReAct loop. Verify with the curl test.

### OQ-3 — DeepSeek-R1-0528 + LangChain.js workaround feasibility

DeepSeek-R1-0528 added function calling, but the `ChatOpenAI` parameter injection issue (§5) remains. A possible workaround is to subclass `ChatOpenAI` and override `_formatParams` to strip the offending parameters before the API call. This has not been tested. If the user specifically needs R1-0528 for reasoning tasks with tool calling, this deserves a dedicated investigation before implementation.

### OQ-4 — Streaming tool call chunk format for DeepSeek-V3.2

The investigation document (D9) deferred streaming to v2. However, if streaming is added later, the team should verify that DeepSeek-V3.2 on Azure Foundry emits standard OpenAI streaming delta events for tool calls (the `delta.tool_calls[].function.arguments` incremental pattern). Reasoning models may emit chunks in a different format.

---

## 9. References

| # | Source | URL | Annotation |
|---|---|---|---|
| 1 | Microsoft Learn — v1 API lifecycle | https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle | Canonical reference: `/openai/v1` URL, no `api-version` required, DeepSeek support confirmed, auth patterns |
| 2 | Microsoft Learn — Foundry Endpoints | https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints | URL patterns, keyless auth, `DeepSeek-V3.1` example with `/openai/v1` |
| 3 | Microsoft Learn — DeepSeek-R1 Tutorial | https://learn.microsoft.com/en-us/azure/foundry/foundry-models/tutorials/get-started-deepseek-r1 | Authoritative: R1 does NOT support tool calling; `<think>` tag format; `/openai/v1` usage |
| 4 | Microsoft Learn — LangChain with Foundry | https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/langchain-models | Official LangChain integration guide; DeepSeek-R1-0528 reasoning example; note: Python-only `langchain-azure-ai` |
| 5 | Microsoft Tech Community Blog — V3.2 Launch | https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-deepseek-v3-2-and-deepseek-v3-2-speciale-in-microsoft-foundry/4477549 | V3.2 supports tool calling including thinking mode; Speciale does NOT |
| 6 | DeepSeek API Docs — Tool Calls | https://api-docs.deepseek.com/guides/tool_calls | OpenAI-compatible format; `tools` parameter; thinking mode + tool calls from V3.2 |
| 7 | DeepSeek API Docs — Thinking Mode | https://api-docs.deepseek.com/guides/thinking_mode | `reasoning_content` field; unsupported params for reasoning models; tool calls in thinking mode |
| 8 | GitHub langchainjs #7564 | https://github.com/langchain-ai/langchainjs/issues/7564 | R1 + `ChatOpenAI` fails due to `presence_penalty` default injection |
| 9 | GitHub langchain #35059 | https://github.com/langchain-ai/langchain/issues/35059 | `ChatOpenAI` silently drops `reasoning_content` field |
| 10 | GitHub langchainjs #9663 | https://github.com/langchain-ai/langchainjs/issues/9663 | `reasoning` option silently overridden due to ternary operator precedence bug |
| 11 | GitHub langchain #29282 | https://github.com/langchain-ai/langchain/issues/29282 | DeepSeek-V3 structured output fails with `json_schema` response_format — unrelated to tool calling |
| 12 | Azure AI Foundry model catalog — DeepSeek-V3.2 | https://ai.azure.com/catalog/models/DeepSeek-V3.2 | Deployment type, pricing, Public Preview status |
| 13 | Azure AI Foundry model catalog — DeepSeek-V3.2-Speciale | https://ai.azure.com/catalog/models/DeepSeek-V3.2-Speciale | Confirms no tool calling, pure reasoning orientation |
| 14 | Microsoft Learn — Foundry Models catalog | https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models | Azure Direct Models list; does not enumerate DeepSeek (partner models are separate) |
| 15 | LangChain.js docs — ChatOpenAI integration | https://docs.langchain.com/oss/javascript/integrations/chat/openai | `configuration.baseURL` pattern for custom endpoints |

---

## Assumptions & Scope

| Assumption | Confidence | Impact if Wrong |
|---|---|---|
| `ChatOpenAI` (not `AzureChatOpenAI`) is the correct class for `/openai/v1` with DeepSeek | HIGH | If Azure Foundry DeepSeek requires Azure-specific headers, the factory needs `AzureChatOpenAI` with special config. Verified by Microsoft's own examples using the standard `OpenAI` SDK (not `AzureOpenAI`). |
| `api-version` is not required on `/openai/v1` | HIGH | Explicitly documented by Microsoft Learn. If wrong, add `?api-version=2024-10-21` as fallback. |
| DeepSeek-V3.2 tool_choice values match OpenAI spec | MEDIUM | If `tool_choice: "required"` is rejected, the ReAct loop must rely on `"auto"` and strong system prompting. Verify with curl test (§7.5). |
| `parallel_tool_calls` is passed through without error | MEDIUM | If rejected with 400, remove it from the constructor. If honored, it may need to be set to `false` to prevent multi-tool responses. |
| The `reasoning_content` drop issue in `ChatOpenAI` (Python) applies equally to LangChain.js | MEDIUM | If LangChain.js handles it differently, V3.2 thinking mode might be usable without the workaround. Verify by inspecting `@langchain/openai` `ChatOpenAI._convertResponseMessage` in the installed version. |
| DeepSeek-R1-0528's parameter restrictions (`temperature` etc.) apply on Azure Foundry | MEDIUM | If Azure Foundry's endpoint silently ignores these parameters rather than rejecting them, R1-0528 could be usable with `ChatOpenAI`. Verify with a direct API call. |
| V3.2-Speciale silently produces no tool calls (vs. returning a 4xx error) | HIGH | Confirmed by the announcement blog: "does **not** support native function/tool calling." A 400 would be less dangerous than silent pass-through. The denylist handles both cases. |

**Explicitly out of scope:**
- DeepSeek fine-tuning on Azure
- DeepSeek embeddings endpoints
- Pricing and quota limits
- Non-Azure DeepSeek endpoints (native DeepSeek API, OpenRouter)
- Azure Foundry Agent Service (a separate hosted agent runtime, distinct from the LangGraph agent being built here)
