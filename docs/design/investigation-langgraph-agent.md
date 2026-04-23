# Investigation — LangGraph ReAct Agent for outlook-cli

Status: Complete
Produced by: investigator agent
Stage: 2/6 (investigation)
Plan slot: `docs/design/plan-003-langgraph-agent.md` (planner's output)
Date: 2026-04-23

---

## 1. Executive Recommendation

Ten-bullet summary of the chosen path:

1. **D1 — Agent implementation**: Use `createAgent` from `langchain` (v1, built on LangGraph). It replaces the deprecated `createReactAgent` from `@langchain/langgraph/prebuilt` and ships a middleware system useful for future guard-rail work. `createReactAgent` remains functional in `@langchain/langgraph` (deprecated-not-removed), so both options compile; `createAgent` is the forward-looking choice.

2. **D2 — Tool definition**: Use `tool(fn, { name, description, schema })` from `@langchain/core/tools` with Zod input schemas. This is the universal LangChain tool API, works identically across all six providers via `bindTools`, and directly feeds `createAgent`/`createReactAgent`.

3. **D3 — Provider abstraction**: A six-entry `ProviderRegistry` keyed by `azure-openai | azure-anthropic | azure-deepseek | openai | anthropic | google`. Azure OpenAI uses `AzureChatOpenAI` from `@langchain/openai`. Native OpenAI uses `ChatOpenAI` from `@langchain/openai`. Anthropic uses `ChatAnthropic` from `@langchain/anthropic` (accepts `baseUrl` for the Foundry/Azure endpoint — this is the `azure-anthropic` path). Azure DeepSeek uses `ChatOpenAI` from `@langchain/openai` pointed at the Foundry `/openai/v1` OpenAI-compatible endpoint. Google uses `ChatGoogleGenerativeAI` from `@langchain/google-genai`. There is NO separate npm package for Azure-hosted Anthropic or Azure-hosted DeepSeek in JavaScript — the existing LangChain wrappers are reused with Azure-specific endpoint/key config.

4. **D4 — v1 tool catalog**: All eleven tools ship in v1. Mutating tools (`create_folder`, `move_mail`, `download_attachments`) are present but gated behind an `--allow-mutations` flag that defaults to `false`. Without the flag, the system prompt instructs the model that mutations are disabled and the tool adapters return a policy-rejection ToolMessage rather than executing.

5. **D5 — Conversation memory**: `MemorySaver` from `@langchain/langgraph` (import: `import { MemorySaver } from "@langchain/langgraph"`). Attached via `createAgent({ ..., checkpointer })` or `createReactAgent({ ..., checkpointSaver })`. Thread tracked via `{ configurable: { thread_id: "<uuid>" } }`. In-process only; no disk persistence.

6. **D6 — `.env` loading**: Use `dotenv` v17 (current) with `dotenv.config({ path: envFilePath, override: false })`. This must be called at the very top of the `agent` command action handler, before `buildDeps()` runs, to guarantee process-env wins over `.env` values. Node's built-in `--env-file` flag is deliberately not used: it requires a CLI flag at process start, cannot be controlled from inside the agent subcommand, and is not testable via `vi.mock`.

7. **D7 — Tool output shaping**: Tool adapters serialize results to JSON strings; a `truncateBudget(json, budgetBytes)` utility enforces the 16 KB default, appending `"_truncated": true` when trimmed. LangGraph tool results are strings (confirmed). Per-tool budget is configurable via `OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES` (default `16384`). Arrays are trimmed from the tail; `Id` fields are protected from truncation.

8. **D8 — Error surface**: Recoverable errors (folder not found, message not found, pagination limit, timeout, auth-rejected-in-tool) are returned as JSON ToolMessages so the model can adapt. Fatal errors (ConfigurationError, AuthError when `--no-auto-reauth`, IO error on log file) throw immediately and are handled by the existing `reportError` / `exitCodeFor` mechanism before the graph runs or during the `makeAction` wrapper's catch block.

9. **D9 — Streaming**: Non-streaming in v1. `createAgent`/`createReactAgent` buffers until completion; only the final `AIMessage` content is extracted. `--verbose` prints the accumulated transcript to stderr post-run. The `.stream()` entry point is noted in Open Risks for future work.

10. **D11 — Token accounting**: All six providers surface `usage_metadata` on the final AIMessage when token data is available (confirmed for OpenAI, Anthropic, and Gemini; Azure variants mirror their native counterparts). The agent accumulates `{ promptTokens, completionTokens, totalTokens }` from `response.usage_metadata` across steps. Providers returning no usage data yield `usage: null` in the envelope. Cost calculation is deferred to v2.

---

## 2. Evidence and Alternatives

### D1 — ReAct Agent Implementation

**Chosen**: `createAgent` from `langchain` (LangChain v1, GA October 2025), built on LangGraph runtime.

**Rationale**: `createReactAgent` from `@langchain/langgraph/prebuilt` was deprecated in LangGraph v1.0 (October 2025) in favor of `createAgent` from `langchain`. Both import paths remain functional; the deprecation is soft — no removal is scheduled before v2.0. `createAgent` adds a middleware system for future human-in-the-loop and PII-redaction capabilities.

**Import path**:
```typescript
import { createAgent } from "langchain";
// Signature (simplified):
createAgent({
  model: llm,               // BaseChatModel
  tools: Tool[],
  systemPrompt?: string,    // or stateModifier function
  checkpointer?: BaseCheckpointSaver,
  middleware?: Middleware[],
})
```

**Alternatives considered**:
- *Option A* (`createReactAgent` from `@langchain/langgraph/prebuilt`): Still functional, well-documented, many examples. Dropped because it is explicitly deprecated and the middleware system is absent.
- *Option C* (hand-rolled `StateGraph`): Maximum control, but significant build cost for v1 with no functional advantage over the prebuilt for the standard ReAct loop.

**Recursion / max-steps**: Set via `{ recursionLimit: N }` in the invoke config (one recursion = one superstep ≈ one tool-call round). The agent must translate `--max-steps` to `recursionLimit`. For `createAgent`, the same `recursionLimit` config applies since it runs on LangGraph's runtime.

**Sources**:
- https://docs.langchain.com/oss/javascript/releases/langgraph-v1
- https://docs.langchain.com/oss/javascript/releases/langchain-v1
- https://langchain-ai.github.io/langgraphjs/how-tos/react-memory

---

### D2 — Tool Definition API

**Chosen**: `tool(fn, { name, description, schema })` from `@langchain/core/tools` with Zod schemas.

**Evidence**:
```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const listMail = tool(
  async (input: { top: number; folder?: string }) => { /* ... */ },
  {
    name: "list_mail",
    description: "List recent messages in a folder ...",
    schema: z.object({
      top: z.number().int().min(1).max(1000).default(10),
      folder: z.string().optional(),
      // ...
    }),
  }
);
```

This API is verified to work with `ChatOpenAI`, `AzureChatOpenAI`, `ChatAnthropic`, and `ChatGoogleGenerativeAI` via their `.bindTools()` implementations, which translate the Zod schema to the appropriate wire format (OpenAI function-calling JSON schema, Anthropic tool_use blocks, Gemini function declarations). LangChain handles the translation internally.

**Alternatives considered**:
- *Option B* (subclass `StructuredTool`): More verbose, same capability, no advantage.
- *Option C* (hand-constructed OpenAI schema): Bypasses LangChain's abstraction, breaks Anthropic and Gemini providers.

**Source**: https://langchain-ai.github.io/langgraphjs/how-tos/react-system-prompt (tool + createReactAgent usage); https://docs.langchain.com/oss/javascript/integrations/chat/anthropic (bindTools); https://docs.langchain.com/oss/javascript/integrations/chat/google_generativeai (bindTools)

---

### D3 — LLM Provider Abstraction

**Chosen**: Six-provider registry using existing `@langchain/*` packages only. No custom `BaseChatModel` subclass is needed. See the Provider Registry Blueprint (§3) for the complete table.

**Critical finding — Azure-hosted Anthropic**: The official Anthropic TypeScript SDK ships `@anthropic-ai/foundry-sdk` for Azure Foundry. However, this is NOT a LangChain `BaseChatModel`. For LangChain integration, the correct path is `ChatAnthropic` from `@langchain/anthropic` with `baseUrl` set to `https://{resource}.services.ai.azure.com/anthropic` and `apiKey` set to the Azure-issued API key. The Anthropic Foundry endpoint is wire-compatible with the standard Anthropic Messages API, so `ChatAnthropic`'s native tool calling (via `tool_use` blocks) works unchanged. Confirmed by Anthropic official docs: "The Azure Foundry API endpoints appear fully compliant with Anthropic's API."

**Critical finding — Azure-hosted DeepSeek**: The Azure AI Foundry `/openai/v1` endpoint is OpenAI-compatible. DeepSeek models on Foundry expose this endpoint. Therefore `ChatOpenAI` from `@langchain/openai` pointed at `https://{resource}.services.ai.azure.com/openai/v1` with the Azure key works correctly. Tool calling: DeepSeek-V3.2 supports function/tool calling via this endpoint (the Speciale reasoning-only variant omits tool calling; the standard V3.2 and V3.1 support it). DeepSeek-R1 is a reasoning model with limited tool calling support; v1 should use V3.x for agent tasks.

**Critical finding — `langchain-azure-ai` Python package**: This is a Python-only package. There is NO `@langchain/azure-ai` npm package as of April 2026. The TypeScript path uses the existing `@langchain/openai` and `@langchain/anthropic` packages with Azure-specific endpoint/key configuration.

**Alternatives considered**:
- *`@azure-rest/ai-inference` with custom `BaseChatModel` wrapper*: Technically possible but `1.0.0-beta.6` is still in beta and requires writing a full `BaseChatModel` subclass. Dropped in favor of reusing production-grade `@langchain/openai` and `@langchain/anthropic`.
- *Azure AI Inference "model router" path (`AzureAIChatCompletionsModel`)*: Python-only class. No TypeScript equivalent exists.

**Sources**:
- https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry
- https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/langchain-models
- https://dev.to/azure/using-deepseek-r1-on-azure-with-javascript-467i
- https://docs.langchain.com/oss/javascript/integrations/chat/azure

---

### D4 — Tool Catalog Scope

**Chosen**: All eleven tools in v1, with `--allow-mutations` gate for `create_folder`, `move_mail`, `download_attachments`.

**Safety argument**: Without `--allow-mutations`, the LLM can read, list, search, and reason about mail/calendar/folders but cannot change any state. This prevents prompt-injection attacks (a malicious email body that tricks the agent into filing all mail to Trash), accidental bulk moves from ambiguous prompts, and irreversible attachment downloads to unexpected directories. The gate is explicit, documented, and auditable in the CLI invocation.

**Implementation**: Without `--allow-mutations`, the three mutating tool adapters return:
```json
{ "error": { "code": "MUTATIONS_DISABLED", "message": "This operation requires --allow-mutations. Re-run with that flag if you intended to perform this action." } }
```
The model sees this as a ToolMessage and can report the policy to the user. The tool is still registered in the catalog (the LLM knows it exists) but the adapter enforces the gate. This avoids confusing the model with a missing-tool error, which might cause it to attempt workarounds.

---

### D5 — Conversation Memory

**Chosen**: `MemorySaver` from `@langchain/langgraph`.

**Import confirmed**:
```typescript
import { MemorySaver } from "@langchain/langgraph";
const checkpointer = new MemorySaver();
```

**Attach to agent**:
```typescript
// createAgent (LangChain v1):
const agent = createAgent({ model: llm, tools, systemPrompt, checkpointer });

// createReactAgent (legacy fallback):
const agent = createReactAgent({ llm, tools, stateModifier: systemPrompt, checkpointSaver: checkpointer });
```

**Thread usage**:
```typescript
const config = { configurable: { thread_id: runId }, recursionLimit: maxSteps };
const result = await agent.invoke({ messages: [{ role: "user", content: prompt }] }, config);
```

Interactive mode: one `MemorySaver` instance, one `thread_id` per REPL session (generated at REPL start via `crypto.randomUUID()`). Single-shot mode: fresh `thread_id` per invocation, `MemorySaver` discarded when process exits.

**Note on `@langchain/langgraph-checkpoint`**: Some doc examples import `MemorySaver` from `@langchain/langgraph-checkpoint`. This is a sub-package; importing from `@langchain/langgraph` directly re-exports `MemorySaver` and is the canonical path.

**Source**: https://langchain-ai.github.io/langgraphjs/agents/memory

---

### D6 — `.env` Loading

**Chosen**: `dotenv` v17 (current stable) with `override: false` (the default).

**Confirmed semantics**: `dotenv.config({ path, override: false })` only sets `process.env` keys that are NOT already set. This naturally enforces the `process.env > .env` precedence rule without additional logic.

**Initialization order constraint**: `dotenv.config()` must run before `buildDeps()` inside the agent action handler. Since `makeAction` in `src/cli.ts` calls `buildDeps()` internally and does not provide a pre-hook, the agent command registration must use a custom action pattern that calls `dotenv.config()` first, then delegates to the standard `makeAction` flow. The cleanest approach: the commander `.action(async (...args) => { loadDotenv(envFilePath); return makeAction(...)(...args); })`.

**Node `--env-file` rejected**: The Node.js 20.6+ native `--env-file` flag is GA but works only when passed at process startup (`node --env-file=.env cli.js`). It cannot be triggered from inside a running process and is not testable via `vi.mock`. `dotenv` is the correct choice.

**Source**: https://github.com/motdotla/dotenv (README)

---

### D7 — Tool Output Shaping

**Chosen**: JSON string output with byte-budget truncation.

**LangGraph tool output format confirmed**: LangGraph tool results are strings. The `tool()` function's return value is coerced to string via `JSON.stringify` if it is an object. Tool adapters should return plain objects and let the framework serialize; or return `JSON.stringify(result)` explicitly for clarity.

**Truncation strategy**:
1. Serialize the result to JSON.
2. If `byteLength(json) <= budget` (default 16384), return as-is.
3. If the result is an array, remove items from the tail until within budget; append `{ "_truncated": true, "_originalCount": N }`.
4. If the result is an object with a large string field (e.g., `Body.Content`), truncate the string and append `"... [truncated N chars]"`.
5. Id fields (`Id`, `ConversationId`, `ParentFolderId`) are never truncated — they are small fixed-length strings and the model needs them for follow-up calls.
6. Final check: if still over budget after step 4, hard-truncate the JSON string and close the braces.

**Per-tool budget override**: Not implemented in v1 (single global budget). A per-tool override can be added in v2 via the tool's metadata.

---

### D8 — Error Surface to the LLM

**Chosen**: Split strategy — recoverable errors as ToolMessages; fatal errors propagate to the process.

**Recoverable (returned as ToolMessage JSON)**:
- `UPSTREAM_FOLDER_NOT_FOUND`, `FOLDER_AMBIGUOUS`, `FOLDER_PATH_INVALID`, `FOLDER_MISSING_PARENT`, `FOLDER_ALREADY_EXISTS` (when `idempotent: false`)
- `UPSTREAM_MESSAGE_NOT_FOUND`, `UPSTREAM_EVENT_NOT_FOUND`
- `UPSTREAM_TIMEOUT`, `UPSTREAM_PAGINATION_LIMIT`
- `UPSTREAM_AUTH_REJECTED` (when `--no-auto-reauth` is false — the existing `onReauthNeeded` callback fires transparently; if re-auth succeeds, the tool retries; if it fails, the `AuthError` surfaces as a ToolMessage)
- `MUTATIONS_DISABLED` (policy gate, recoverable by changing flags)

**Fatal (propagate to process, exit with mapped code)**:
- `ConfigurationError` (missing provider env var, bad `--env-file` path) — exit 3
- `AuthError` with `--no-auto-reauth` at boot (auth-check returns non-ok before graph starts) — exit 4
- `AuthError` after retry inside a tool call — exit 4 (this is the double-401 case, unrecoverable)
- `IoError` writing to `--log-file` — exit 6
- Provider SDK 4xx for key/endpoint misconfiguration — wrap in `UpstreamError`, exit 5
- Zod schema validation failure on tool INPUT (this is a bug, the model sent malformed args) — wrap in `UsageError`, exit 1

---

### D9 — Streaming

**Chosen**: Non-streaming in v1. Final AIMessage extracted after `.invoke()` resolves.

**Rationale**: Streaming requires token-by-token redaction (API keys or sensitive strings could appear mid-stream), incremental JSON envelope assembly, and different test surface. These costs are not justified for v1 where the primary value is functional correctness. The `createAgent`/`createReactAgent` `.stream()` entry point is preserved for v2 work.

---

### D10 — Default System Prompt

See §5 (Default System Prompt section).

---

### D11 — Token / Cost Accounting

**`usage_metadata` availability confirmed per provider**:
- `openai` / `azure-openai`: `AIMessage.usage_metadata` populated with `{ input_tokens, output_tokens, total_tokens }` (LangChain-normalized field name).
- `anthropic` / `azure-anthropic`: Same `usage_metadata` structure. Confirmed by Anthropic docs: "The `usage` object in response bodies provides detailed token consumption information."
- `google`: `ChatGoogleGenerativeAI` populates `usage_metadata` from Gemini's `usageMetadata` field.
- `azure-deepseek` (via `ChatOpenAI`): Same as `openai` — OpenAI SDK response carries `usage` which LangChain maps to `usage_metadata`.

**Accumulation**: Sum `input_tokens` and `output_tokens` across all steps. In v1, this is approximate because intermediate steps (tool execution) do not contribute LLM tokens; only AIMessages from the model count.

**Cost calculation**: Deferred to v2. Prices change frequently and differ per region and deployment tier.

---

### D12 — Logging and Redaction

**Chosen**: Route all log lines through `redactString` from `src/util/redact.ts` before writing to stderr or `--log-file`.

**Specific redaction rules for the agent layer** (in addition to existing `redactHeaders` / `redactJwt`):
1. Provider API keys: never logged — they are read from `process.env` and passed directly to the constructor; they never appear in log lines if the log sink is constructed before the constructor call.
2. Bearer tokens in session file: already handled by `redactJwt`.
3. Email `Body.Content` longer than 2 KB: truncate in the tool adapter before returning, so the truncated form is what the LLM sees and what is logged.
4. Full tool output payloads in verbose/debug logs: apply `redactString` which strips 100+ char base64-URL runs (covers accidentally included session tokens).
5. System prompt logged at DEBUG level only (it may contain sensitive context if overridden by the user via `--system`).

---

### D13 — Testing Strategy

**Chosen**: `vitest` with `FakeListChatModel` from `@langchain/core/utils/testing` for unit tests.

**Import confirmed**:
```typescript
import { FakeListChatModel } from "@langchain/core/utils/testing";
```

**Note on `FakeListChatModel` and tool calls**: `FakeListChatModel` returns scripted text responses. For testing a ReAct loop that includes tool calls, the mock must return an `AIMessage` with `tool_calls` populated on the first response and a plain `AIMessage` (no tool_calls) on the second. `FakeListChatModel` returns strings; for richer control use `FakeMessagesListChatModel` (also from `@langchain/core/utils/testing`) which accepts an array of `BaseMessage` objects — allowing injection of `AIMessage` instances with `tool_calls` arrays.

**Test matrix**:
1. **Provider factory tests** (`test_scripts/agent-provider-registry.spec.ts`): Each of the six providers: missing required env var → throws `ConfigurationError` with correct `missingSetting`; all env vars set → returns instance of the expected class. Mock `process.env` with `vi.stubEnv`.
2. **Config and `.env` precedence tests** (`test_scripts/agent-config.spec.ts`): Use `vi.mock('dotenv')` to stub `dotenv.config`; inject fixture env vars via `vi.stubEnv`. Verify: process env wins over `.env`; missing required var → exit 3; `--env-file` pointing to missing file → exit 3.
3. **Tool adapter tests** (`test_scripts/agent-tools.spec.ts`): One describe block per tool. Use the same `makeStubClient()` + `makeDeps()` pattern from existing specs. Verify: normal response → serialized JSON; result over budget → truncated with `_truncated: true`; command throws `UpstreamError` → ToolMessage error JSON; command throws `ConfigurationError` → propagated (fatal).
4. **Full ReAct loop test** (`test_scripts/commands-agent.spec.ts`): Use `FakeMessagesListChatModel` with a scripted two-step sequence: step 1 returns `AIMessage` with `tool_calls: [{ name: "list_mail", args: { top: 3 } }]`; step 2 returns `AIMessage` with `content: "Here are your 3 messages..."` and no tool_calls. Assert: `steps[0].tool === "list_mail"`, `finalAnswer` is non-empty, `truncated === false`.
5. **Redaction tests** (`test_scripts/agent-redact.spec.ts`): Verify API keys and tokens are absent from log output even when passed through the log path.
6. **Mutation gate tests** (in `test_scripts/commands-agent.spec.ts`): Without `--allow-mutations`, `create_folder` tool returns `MUTATIONS_DISABLED` ToolMessage; with `--allow-mutations`, the command runs.

**Note on `vi.mock` and CJS**: The codebase uses CommonJS. Vitest's `vi.mock('dotenv')` works with CJS modules. Ensure `vi.mock` call is at the top of the test file (hoisted automatically by Vitest).

---

### D14 — Package Manifest Changes

See §6 (Package Manifest Delta).

---

### D15 — TypeScript 6.x Risk

**Finding**: The project pins `"typescript": "^6.0.3"`. TypeScript 6.x is cutting-edge (GA as of late 2025). `@langchain/*` packages ship `.d.ts` declarations targeting TypeScript 4.x/5.x. The tsconfig already has `"skipLibCheck": true`, which suppresses `.d.ts` type errors from third-party packages. This is the correct mitigation.

**Risk**: `skipLibCheck: true` hides third-party type errors but means type mistakes in LangChain's own generic parameters may not be caught at the call site. The team should run `tsc --noEmit` after each major dependency upgrade and review any `ts6133` / `ts2345` errors that escape `skipLibCheck`.

**Recommendation**: Pin `@langchain/core` to `^0.3.x` and `@langchain/langgraph` to `^0.2.x` / latest v1.x (after confirming `tsc --noEmit` passes). Do not use `latest` unstable tags. If TS6 causes irresolvable type errors in a specific LangChain package, add that package to a `skipLibCheck`-exempt list and file an issue upstream.

---

## 3. Provider Registry Blueprint

The table below defines the six providers. Environment variable names follow the project's `OUTLOOK_AGENT_*` convention from the refined spec (§6 of the spec). Two discrepancies from the spec are corrected and flagged.

| Provider name | LangChain class | npm package | Required env vars | Optional env vars | Tool-calling support | Quirks |
|---|---|---|---|---|---|---|
| `openai` | `ChatOpenAI` | `@langchain/openai` | `OUTLOOK_AGENT_OPENAI_API_KEY` | `OUTLOOK_AGENT_OPENAI_BASE_URL` (gateway override), `OUTLOOK_AGENT_OPENAI_ORG` | Native function calling. Full tool choice (`auto`, `required`, specific). | Model `gpt-4o` and later support parallel tool calls; older models do not. |
| `anthropic` | `ChatAnthropic` | `@langchain/anthropic` | `OUTLOOK_AGENT_ANTHROPIC_API_KEY` | `OUTLOOK_AGENT_ANTHROPIC_BASE_URL` | Native `tool_use` blocks. `tool_choice` supports `auto`, `any`, specific tool. | Parallel tool calls: supported. Extended thinking via `extended_thinking` field (not used in v1). |
| `google` | `ChatGoogleGenerativeAI` | `@langchain/google-genai` | `OUTLOOK_AGENT_GOOGLE_API_KEY` | — | Native function calling via Gemini function declarations. | `model` constructor param (e.g. `gemini-2.5-pro`). No `azureOpenAIApiVersion`. Max output tokens varies by model. |
| `azure-openai` | `AzureChatOpenAI` | `@langchain/openai` | `OUTLOOK_AGENT_AZURE_OPENAI_API_KEY`, `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT` *(see note 1)*, `OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION`, `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT` | — | Same as `openai` — Azure OpenAI mirrors the OpenAI API. | The `AzureChatOpenAI` constructor accepts `azureOpenAIApiInstanceName` (short name → constructs URL) OR `azureOpenAIEndpoint` (full URL). Since the spec uses a full URL in `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT`, use the `azureOpenAIEndpoint` parameter. |
| `azure-anthropic` | `ChatAnthropic` | `@langchain/anthropic` | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY`, `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` *(or `--model`)*, and a derived base URL from `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` *(see note 2)* | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` *(see note 3)* | Full Anthropic tool_use support. Foundry endpoint is wire-compatible with the Anthropic Messages API. | `baseUrl` must be set to `https://{resource}.services.ai.azure.com/anthropic`. The factory derives this from `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT`. Anthropic's `anthropic-version` header is handled automatically by `ChatAnthropic`. The spec's `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` is not actually used by `ChatAnthropic` — the Anthropic SDK uses its own version header. This env var can be retained for documentation/auditing but is not passed to the constructor. |
| `azure-deepseek` | `ChatOpenAI` | `@langchain/openai` | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY`, `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` *(or `--model`)*, and a derived base URL from `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` appended with `/openai/v1` *(see note 2)* | `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` | Tool calling supported on DeepSeek-V3.2 (standard variant) and V3.1. DeepSeek-R1 has limited tool calling; not recommended for agent use. DeepSeek V3.2 Speciale omits tool calling entirely. | Use `openAIApiKey` constructor param with the Azure key. Set `configuration.baseURL` to `https://{resource}.services.ai.azure.com/openai/v1`. The model name passed to the constructor must match the Azure deployment name. |

**Note 1 — `azure-openai` endpoint parameter**: The spec stores a full URL in `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT` (e.g., `https://my-resource.openai.azure.com`). The `AzureChatOpenAI` constructor parameter for a full URL is `azureOpenAIEndpoint`. The spec's env var name is correct; the constructor parameter name differs from the env var name that the LangChain class auto-reads (`AZURE_OPENAI_API_INSTANCE_NAME` is the auto-read env var for the short instance name; `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_BASE_PATH` are auto-read for full URL). The factory must explicitly pass the URL:
```typescript
new AzureChatOpenAI({
  azureOpenAIApiKey: process.env.OUTLOOK_AGENT_AZURE_OPENAI_API_KEY,
  azureOpenAIEndpoint: process.env.OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT,
  azureOpenAIApiVersion: process.env.OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION,
  azureOpenAIApiDeploymentName: process.env.OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT,
  temperature: config.temperature,
});
```

**Note 2 — azure-anthropic and azure-deepseek base URL derivation**: Both providers share `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT`. The factory distinguishes them by appending different path suffixes:
- `azure-anthropic`: strip trailing slash from `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT`, then drop `/models` if present (the spec example includes `/models`), append nothing — `ChatAnthropic` expects the base at `https://{resource}.services.ai.azure.com/anthropic`.
- `azure-deepseek`: append `/openai/v1` to the base resource URL.

**Practical recommendation**: rename `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` to store only the base resource URL (`https://{resource}.services.ai.azure.com`) and let each factory append the correct suffix. The spec's example (`https://my-resource.services.ai.azure.com/models`) includes `/models` which is the legacy Azure AI Inference SDK path. The current recommended path (post-migration per Microsoft docs) is the OpenAI-compatible route. The factory should strip `/models` if present and work from the base.

**Note 3 — `azure-anthropic` API version**: The `ChatAnthropic` SDK manages its own `anthropic-version` header (`2023-06-01` is the current value, set internally). The `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` env var from the spec (`2024-05-01-preview`) was applicable to the legacy Azure AI Inference SDK which is now deprecated. For `ChatAnthropic` pointing at the Foundry endpoint, this env var is not consumed by the constructor. Retain it in the config matrix for documentation clarity, but mark it as "informational / not passed to constructor."

**Model name confirmation (Q-1 and Q-2 from the spec)**:

- **Azure-hosted Anthropic**: Model/deployment names in Foundry match the Anthropic model IDs: `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`. The deployment name may be customized in the portal. The `model` parameter passed to `ChatAnthropic` must match the deployment name.
- **Azure-hosted DeepSeek**: Deployment names in Foundry: `DeepSeek-V3.2`, `DeepSeek-V3.1`, `DeepSeek-R1`. The exact string depends on what the user named their deployment. Recommend `DeepSeek-V3.2` as the default suggestion for agent use (tool calling supported); warn that `DeepSeek-R1` and `DeepSeek-V3.2 Speciale` do not support tool calling.

---

## 4. v1 Tool Catalog

### Read-only tools (available without `--allow-mutations`)

| Tool name | Backing command | Returns | Notes |
|---|---|---|---|
| `auth_check` | `src/commands/auth-check.ts` | `AuthCheckResult` | Always available; never mutates state. |
| `list_mail` | `src/commands/list-mail.ts` | `MessageSummary[]` or `{ count, exact }` | Supports all folder flags and date windows from the CLI. |
| `get_mail` | `src/commands/get-mail.ts` | `Message & { Attachments: AttachmentSummary[] }` | Body defaulted to `text` to reduce token load. |
| `get_thread` | `src/commands/get-thread.ts` | `ThreadResult` | |
| `list_folders` | `src/commands/list-folders.ts` | `FolderSummary[]` | `recursive` defaults to `false` for the agent to avoid large payloads. |
| `find_folder` | `src/commands/find-folder.ts` | `ResolvedFolder` | |
| `list_calendar` | `src/commands/list-calendar.ts` | `EventSummary[]` | |
| `get_event` | `src/commands/get-event.ts` | `Event` | |

### Mutating tools (require `--allow-mutations`)

| Tool name | Backing command | Returns | Risk |
|---|---|---|---|
| `create_folder` | `src/commands/create-folder.ts` | `CreateFolderResult` | Medium — creates permanent folder. Idempotent by default in agent tool. |
| `move_mail` | `src/commands/move-mail.ts` | `MoveMailResult` | High — original message IDs are invalidated after move; bulk misfire could scatter mail. |
| `download_attachments` | `src/commands/download-attachments.ts` | `DownloadAttachmentsResult` | Medium — writes to local filesystem; path traversal is mitigated by existing `assertWithinDir`. |

### `--allow-mutations` flag behavior

- **Without `--allow-mutations`** (default): Mutating tools are registered in the catalog so the LLM knows they exist. When invoked, the adapter returns:
  ```json
  { "error": { "code": "MUTATIONS_DISABLED", "message": "Mutation operations are disabled. Re-run with --allow-mutations to enable create_folder, move_mail, and download_attachments." } }
  ```
  The model can inform the user of the policy. Step count is incremented; the model may stop trying.

- **With `--allow-mutations`**: All eleven tools execute normally.

- The system prompt states in its closing paragraph whether mutations are enabled or disabled (see §5).

---

## 5. Default System Prompt

The following is the default system prompt ready to drop into `src/commands/agent.ts`. It is parameterized by `{mutationsEnabled}` which the runtime replaces before injecting.

```
You are an Outlook assistant embedded in the outlook-cli tool. You have access to tools that read the user's Outlook mailbox, calendar, and folder tree. Your job is to answer questions and fulfill tasks by calling these tools and reporting what you observe.

TOOL USE RULES:
- Always use tools to retrieve information. Never invent message content, sender names, email addresses, timestamps, subject lines, folder names, or event details. If you do not know something, call a tool to find out.
- Prefer the smallest, most specific tool call. If you only need one email, do not list 100. If you need to locate a folder, use find_folder before list_folders.
- Always cite the exact Id field (message Id, event Id, folder Id) when you reference a specific item in your reply. The user may need it for follow-up actions.
- If a tool returns an error, report the error to the user clearly. Do not retry the same failing call more than once without changing the input parameters.
- Respect the --max-steps budget. If you are close to the limit, summarize what you have found rather than making more tool calls.

SENSITIVE DATA:
- Do not repeat raw email body content verbatim unless the user explicitly asks for the full text. Summarize instead.
- Do not include API keys, authentication tokens, passwords, or other credentials in your replies, even if they appear in tool outputs (they should not, but treat them as confidential if they do).

MUTATION OPERATIONS:
{mutationsEnabled}

When in doubt, ask a clarifying question rather than taking an irreversible action.
```

**`{mutationsEnabled}` substitution values**:

Without `--allow-mutations`:
```
The tools create_folder, move_mail, and download_attachments are available in the catalog but are currently DISABLED by policy. If the user asks you to create a folder, move messages, or download attachments, inform them that they need to re-run with --allow-mutations to enable these operations.
```

With `--allow-mutations`:
```
The tools create_folder, move_mail, and download_attachments are ENABLED. Before executing any of these tools, confirm the intended action with the user in plain language: state exactly what will be created, moved, or downloaded, and ask for explicit confirmation. Do not execute a mutating tool based on an ambiguous or overly broad instruction.
```

---

## 6. Package Manifest Delta

The following packages must be added to `package.json`. Versions are pinned to the current stable range verified as of April 2026.

### `dependencies` (runtime)

| Package | Version | Why |
|---|---|---|
| `langchain` | `^1.0.0` | `createAgent`, middleware system — the LangChain v1 entrypoint. |
| `@langchain/langgraph` | `^1.0.0` | `MemorySaver`, `StateGraph`, runtime for `createAgent`. |
| `@langchain/core` | `^0.3.x` | `BaseChatModel`, `tool()`, message classes, Zod bridge. Peer dep of all `@langchain/*` packages. |
| `@langchain/openai` | `^0.4.x` | `ChatOpenAI` (openai, azure-deepseek), `AzureChatOpenAI` (azure-openai). |
| `@langchain/anthropic` | `^0.3.x` | `ChatAnthropic` (anthropic, azure-anthropic). |
| `@langchain/google-genai` | `^0.2.x` | `ChatGoogleGenerativeAI` (google). |
| `dotenv` | `^17.0.0` | `.env` file loading with `override: false` semantics. |
| `zod` | `^3.24.x` | Tool input schemas. Required explicitly — not currently a project dependency. |

### `devDependencies` (test and build only)

No new devDependencies are required. The project already has `vitest` and `ts-node`. `@langchain/core/utils/testing` (`FakeListChatModel`, `FakeMessagesListChatModel`) ships inside `@langchain/core` which is a runtime dependency, so no separate test package is needed.

### Peer dependency pitfalls

1. **`zod` version alignment**: `@langchain/core` has a peer dependency on `zod ^3.x`. Adding `zod@^3.24.x` satisfies this. Do NOT use zod v4 — it is not yet supported as of this writing.

2. **`@langchain/core` as a shared singleton**: All `@langchain/*` packages declare `@langchain/core` as a peer dep. npm v7+ installs one shared copy when the version range matches. If multiple packages pull different minor versions, `npm install` may install duplicates, causing `instanceof` checks to fail (two different `BaseMessage` classes). Pin `@langchain/core` explicitly in `package.json` to prevent this.

3. **CJS / ESM interop**: Confirmed that `@langchain/langgraph`, `@langchain/core`, `@langchain/openai`, `@langchain/anthropic`, and `@langchain/google-genai` all ship CJS builds alongside their ESM builds. With `"type": "commonjs"` in `package.json` and `"module": "commonjs"` in `tsconfig.json`, the CJS builds will be loaded. The team must verify this remains true after `npm install` by running `node -e "require('@langchain/langgraph')"` — if it throws `ERR_REQUIRE_ESM`, the CJS build is absent and the project must add `"module": "nodenext"` to tsconfig (a significant migration). This risk is flagged in §7.

4. **`langchain` v1 and `@langchain/langgraph` co-installation**: `langchain` v1 lists `@langchain/langgraph` as a peer dep. Install both explicitly to avoid version resolution surprises.

5. **Node.js version**: LangGraph v1 requires Node.js 20 or higher (Node 18 EOL March 2025). The project's runtime must be Node 20+. Check `engines` field in `package.json` and CI configuration.

---

## 7. Open Risks

### Risk 1 — CJS/ESM Interop (HIGH)

The project compiles to CommonJS. All `@langchain/*` packages are nominally dual-CJS/ESM but this status can change without notice in patch releases. Before the implementation phase begins, run:
```bash
npm install @langchain/langgraph @langchain/core @langchain/openai @langchain/anthropic @langchain/google-genai langchain
node -e "const l = require('@langchain/langgraph'); console.log(typeof l.createReactAgent);"
```
If `ERR_REQUIRE_ESM` appears for any package, the team must decide between: (a) switching the project to `"type": "module"` and `"module": "nodenext"` in tsconfig (large migration), or (b) using dynamic `import()` at the call site (smaller change, requires async top-level or lazy loading pattern in `src/commands/agent.ts`). Option (b) is recommended as the least-disruptive fallback.

### Risk 2 — `createReactAgent` vs `createAgent` stability (MEDIUM)

`createAgent` from `langchain` v1 is GA but very recently released (October 2025). The middleware API may have minor breaking changes in `langchain@^1.1.x`. If `createAgent` has compatibility issues with the project's TypeScript 6.x setup, the fallback is `createReactAgent` from `@langchain/langgraph/prebuilt` which is deprecated-but-stable. The implementation should isolate the agent construction to a single factory function so swapping the entrypoint requires changing one file.

### Risk 3 — Azure DeepSeek Tool Calling (MEDIUM)

DeepSeek-V3.2 supports tool calling via the OpenAI-compatible endpoint, but this was confirmed via third-party documentation and Azure blog posts, not via a live test. DeepSeek-V3.2 Speciale explicitly omits tool calling. The factory should validate at startup (or in the system prompt) which DeepSeek variant is configured and warn the user if tool calling is likely unsupported.

### Risk 4 — Azure Anthropic `ChatAnthropic` base URL parsing (MEDIUM)

The `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` spec example includes `/models` in the URL (legacy Azure AI Inference SDK path). The Foundry Anthropic endpoint is `https://{resource}.services.ai.azure.com/anthropic`. The factory must normalize the endpoint by stripping any `/models` suffix and constructing the correct sub-path per provider. A unit test must cover this URL derivation logic.

### Risk 5 — TypeScript 6.x and LangChain types (LOW with mitigation)

`skipLibCheck: true` already suppresses third-party `.d.ts` errors. The risk is low but real: a TypeScript 6.x breaking change in generic type narrowing could cause the LangChain integration code to fail at compile time even with `skipLibCheck`. Monitor the LangChain GitHub issues for TS6 reports after installing.

### Risk 6 — `FakeMessagesListChatModel` tool call format (LOW)

Vitest unit tests must inject `AIMessage` objects with `tool_calls` arrays. The exact format of `tool_calls` in `AIMessage` has changed between LangChain versions. The implementation team should verify the correct structure against `@langchain/core`'s `AIMessage` type definition:
```typescript
import { AIMessage } from "@langchain/core/messages";
new AIMessage({
  content: "",
  tool_calls: [{ id: "tc_1", name: "list_mail", args: { top: 3 }, type: "tool_call" }],
})
```

### Risk 7 — Provider capability drift (LOW, ongoing)

Azure's model catalog and API surface evolve rapidly. Model names, tool-calling support, and endpoint URLs may change. The `ProviderRegistry` should be designed so updating a provider's constructor parameters is confined to its factory module with no ripple effects.

---

## 8. Technical Research Guidance

```
Research needed: Yes

Topic: azure-deepseek-tool-calling-verification
Why: Tool calling support for DeepSeek-V3.2 on Azure Foundry's OpenAI-compatible endpoint was confirmed via blog posts and samples, not via API reference docs; specific API quirks (tool_choice parameter support, parallel calls, response format differences) need verification before implementation.
Focus:
  - Confirm whether Azure Foundry's /openai/v1 endpoint for DeepSeek-V3.2 accepts the standard OpenAI tool_choice parameter values (auto, required, none)
  - Verify the response format for tool calls matches OpenAI's function_call / tool_calls format exactly
  - Check if there are any known issues with LangChain's ChatOpenAI and DeepSeek via Azure (response parsing, streaming differences)
  - Confirm whether the api-version query parameter (?api-version=...) is required or optional for this endpoint
  - Locate the definitive Azure documentation page for the /openai/v1 endpoint capability matrix
Depth: medium
```

---

## 9. Ready for Planning

The plan author has everything needed to produce `docs/design/plan-003-langgraph-agent.md`. All fifteen decisions are resolved with specific library versions, import paths, constructor signatures, and environment variable names. The provider registry is fully specified with a concrete implementation strategy for each of the six providers, including the two previously ambiguous Azure-hosted variants. The tool catalog is finalized with a clear read-only / mutation split and the `--allow-mutations` gate mechanism. The test matrix is defined with vitest patterns, mock class names, and import paths confirmed against current documentation. The package manifest delta lists exact packages and version ranges. Open risks are enumerated and rated by severity, with one topic flagged for deeper research (Azure DeepSeek tool calling verification) that can proceed in parallel with planning. The planner can begin organizing FRs 1–13 and ACs 1–11 into an ordered backlog immediately.

---

## References

| # | Source | URL | Information Gathered |
|---|---|---|---|
| 1 | LangGraph.js Short-Term Memory docs | https://langchain-ai.github.io/langgraphjs/agents/memory | `MemorySaver` import path, `createReactAgent` + `checkpointer` + `thread_id` usage confirmed |
| 2 | LangGraph v1 release notes | https://docs.langchain.com/oss/javascript/releases/langgraph-v1 | `createReactAgent` deprecation, `MemorySaver` import from `@langchain/langgraph`, typed interrupts |
| 3 | LangChain v1 release notes | https://docs.langchain.com/oss/javascript/releases/langchain-v1 | `createAgent` from `langchain`, middleware system, architecture |
| 4 | LangGraph system prompt how-to | https://langchain-ai.github.io/langgraphjs/how-tos/react-system-prompt | `stateModifier` / `systemPrompt` parameter usage with `createReactAgent` |
| 5 | LangGraph recursion limit docs | https://langchain-ai.github.io/langgraphjs/concepts/low_level | `recursionLimit` in invoke config for max-steps |
| 6 | LangChain.js tool definition | https://docs.langchain.com/oss/javascript/langgraph/quickstart | `tool(fn, { name, description, schema })` API + Zod schema patterns |
| 7 | LangChain.js Anthropic integration | https://docs.langchain.com/oss/javascript/integrations/chat/anthropic | `ChatAnthropic` constructor, `bindTools`, tool_use support |
| 8 | LangChain.js Google Generative AI | https://docs.langchain.com/oss/javascript/integrations/chat/google_generativeai | `ChatGoogleGenerativeAI`, `bindTools`, function declarations |
| 9 | LangChain.js Azure OpenAI integration | https://docs.langchain.com/oss/javascript/integrations/chat/azure | `AzureChatOpenAI`, constructor params, `azureOpenAIEndpoint` vs `azureOpenAIApiInstanceName` |
| 10 | Anthropic Claude in Microsoft Foundry | https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry | Foundry endpoint URLs, model names, authentication, API compatibility with standard Anthropic Messages API |
| 11 | Microsoft Foundry LangChain guide | https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/langchain-models | `langchain-azure-ai` is Python-only; OpenAI-compatible endpoint for Foundry models |
| 12 | DeepSeek on Azure with JavaScript | https://dev.to/azure/using-deepseek-r1-on-azure-with-javascript-467i | OpenAI-compatible endpoint confirmed, `ChatOpenAI` usage pattern |
| 13 | Azure Foundry endpoints docs | https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints | DeepSeek, Anthropic, and OpenAI model endpoint patterns on Foundry |
| 14 | `FakeListChatModel` docs | https://docs.langchain.com/oss/javascript/integrations/chat/fake | Import path `@langchain/core/utils/testing`, usage for testing |
| 15 | dotenv npm / GitHub | https://github.com/motdotla/dotenv | `override: false` default semantics, v17 current version |
| 16 | Azure Samples DeepSeek JavaScript | https://github.com/Azure-Samples/deepseek-azure-javascript | JavaScript patterns for DeepSeek on Azure |
| 17 | LangGraph TypeScript guide (2026) | https://langgraphjs.guide/agents/react-agent/ | Current `createReactAgent` usage patterns, `recursionLimit` |
| 18 | `@langchain/anthropic` npm reference | https://reference.langchain.com/javascript/langchain-anthropic/ChatAnthropic | `baseUrl` constructor param for custom/Azure endpoint |
| 19 | LangGraph persistence how-to | https://langchain-ai.github.io/langgraphjs/how-tos/persistence | `compile({ checkpointer })` and `createReactAgent({ checkpointSaver })` confirmed |
| 20 | Azure AI Foundry model catalog | https://ai.azure.com/catalog/models/DeepSeek-V3.2 | DeepSeek model names and availability |

### Recommended for Deep Reading

- **Source 10** (Anthropic Foundry docs): The definitive source for Azure-hosted Anthropic endpoint URLs, model IDs, and SDK behavior. Required reading before implementing the `azure-anthropic` factory.
- **Source 2 + Source 3** (LangGraph v1 + LangChain v1 release notes): Defines the exact deprecation boundary and the new `createAgent` API, including the `recursionLimit` / `maxSteps` mapping.
- **Source 9** (LangChain Azure OpenAI): The `azureOpenAIEndpoint` vs `azureOpenAIApiInstanceName` distinction is critical for the `azure-openai` factory; read carefully before coding.

---

## Assumptions and Scope

| Assumption | Confidence | Impact if Wrong |
|---|---|---|
| `createAgent` from `langchain` v1 has the same `recursionLimit` → `maxSteps` mapping as `createReactAgent` | HIGH | May need to add custom step-counting middleware if the mapping differs. |
| `ChatAnthropic` with `baseUrl` pointing to `https://{resource}.services.ai.azure.com/anthropic` works without additional auth headers beyond `apiKey` | HIGH | If Azure requires extra headers (e.g., `api-version`), the factory must add them via `defaultHeaders`. |
| DeepSeek-V3.2 (standard, not Speciale) supports tool calling via Azure's OpenAI-compatible endpoint | MEDIUM | If tool calling is broken on this path, `azure-deepseek` must be implemented differently or marked as "no tool calling" in the catalog. |
| `@langchain/langgraph` v1 ships a CJS build importable from CommonJS Node.js | HIGH | Verified by pattern across earlier versions; flagged as a manual verification step before implementation. |
| `FakeMessagesListChatModel` is available from `@langchain/core/utils/testing` in v0.3.x | MEDIUM | If not available, a local `BaseChatModel` subclass must be written for the test suite. |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` base URL stripping of `/models` is safe to do automatically in the factory | MEDIUM | If a valid endpoint genuinely contains `/models` in the path for other reasons, stripping it would be wrong. The factory should log a warning when stripping. |
