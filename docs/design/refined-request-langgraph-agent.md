# Refined Request — LangGraph ReAct Agent for outlook-cli

Status: Refined (ready for investigation)
Owner: request-refiner
Stage: 1/6 (refinement)
Plan slot: `docs/design/plan-003-langgraph-agent.md` (to be produced by the planner).

---

## 1. Request Summary

Build a LangGraph.js-powered ReAct agent on top of the existing `outlook-cli`
tool, exposed as a new `agent` subcommand. The agent must be able to reason
about natural-language requests ("list my 3 most recent unread emails",
"move every newsletter from last week to Inbox/Archive/Newsletters", "what
did Alice email me about Q3 planning?") and fulfil them by calling the
existing outlook-cli operations (list-mail, get-mail, get-thread, folder
ops, calendar ops, attachments) as LangGraph tools. The agent must be
provider-agnostic — the user picks the LLM backend at invocation time from
a registry that covers at least Azure OpenAI, Azure-hosted Anthropic,
Azure-hosted DeepSeek, native OpenAI, native Anthropic, and Google Gemini
— and must load its configuration from both process environment variables
and an optional `.env` file, honoring the project's strict no-fallback
rule for required settings.

---

## 2. In Scope

- A new `agent` subcommand registered in `src/cli.ts`, wired into the
  existing `commander` surface and sharing its global flags
  (`--session-file`, `--profile-dir`, `--tz`, `--json`, `--table`,
  `--quiet`, `--no-auto-reauth`, `--log-file`, `--timeout`,
  `--login-timeout`, `--chrome-channel`).
- A LangGraph.js ReAct agent (v1: `createReactAgent` from
  `@langchain/langgraph/prebuilt`) that accepts a natural-language prompt,
  plans tool calls, executes them, and returns a final answer.
- A minimum-viable tool catalog bound to existing outlook-cli commands
  (see §8). MVP set: `auth_check`, `list_mail`, `get_mail`, `get_thread`,
  `list_folders`, `find_folder`, `create_folder`, `move_mail`,
  `list_calendar`, `get_event`, `download_attachments`.
- A pluggable LLM provider abstraction covering: `azure-openai`,
  `azure-anthropic`, `azure-deepseek`, `openai`, `anthropic`, `google`.
  Adding a seventh provider must require only a new factory entry, not a
  change to the agent loop.
- Configuration loaded from both process env vars and an optional `.env`
  file, with documented precedence (CLI flag > process env > `.env` file;
  no fallback for required values).
- Two invocation modes:
  - **Single-shot**: `outlook-cli agent "<prompt>"` → one ReAct run,
    process exits with the final answer.
  - **Interactive REPL**: `outlook-cli agent --interactive` → readline
    loop, shared thread state (LangGraph `MemorySaver`) across turns,
    `/exit`, `/clear`, `/tools`, `/system <text>` slash commands.
- Honor the existing auth path: before the first tool call the agent runs
  `auth-check`; an expired/missing/rejected session triggers the
  existing `login` flow unless `--no-auto-reauth` is set (in which case
  exit 4).
- Output envelope parity with the rest of the CLI (`--json` by default,
  `--table` or transcript for humans).
- Strict no-fallback rule for all mandatory provider settings — missing
  values raise `CONFIG_MISSING` and exit 3.

---

## 3. Out of Scope

The following are explicitly **not** part of this deliverable:

- Fine-tuning, LoRA, or any model training.
- Retrieval-Augmented Generation (RAG) over the mailbox — no embeddings,
  no vector DB, no long-term memory beyond a single interactive session.
- Multi-agent orchestration (planner + executor + critic). This is a
  single-agent ReAct loop; multi-agent is a future epic.
- A web UI, desktop UI, or server mode. The agent ships as a CLI only.
- Voice / audio / image modalities. Text in, text out.
- Streaming tool output back to the user mid-tool-call. (Streaming the
  **final** AIMessage tokens is permitted but optional for v1.)
- Token cost budgeting / rate limiting beyond `--max-steps`.
- Writing emails / sending replies / creating calendar events — the
  tool catalog is **read-mostly** plus folder/move ops. Send-mail is
  deferred to a future iteration.
- Persisting conversation threads across CLI invocations (no
  thread-store-on-disk). A single interactive session keeps state in
  memory only.
- Auto-learning or prompt self-improvement.
- Integrations with non-Outlook backends (Gmail, IMAP, etc.).

---

## 4. Functional Requirements

### FR-1 — `agent` subcommand CLI surface

The new subcommand must be registered on the existing `commander` program
and support the following options (exact env var names in §6):

| Flag | Type | Default | Env counterpart | Notes |
|---|---|---|---|---|
| `<prompt>` positional | string | — | — | Required unless `-i/--interactive`. |
| `-i, --interactive` | boolean | `false` | — | Launches the REPL. Mutually exclusive with a positional prompt. |
| `--provider <name>` | enum | — (required) | `OUTLOOK_AGENT_PROVIDER` | One of `azure-openai`, `azure-anthropic`, `azure-deepseek`, `openai`, `anthropic`, `google`. |
| `--model <id>` | string | provider-specific required | `OUTLOOK_AGENT_MODEL` | e.g. `gpt-4o`, `claude-3-7-sonnet-latest`, `gemini-2.5-pro`, `DeepSeek-V3.1`. |
| `--max-steps <n>` | integer | `10` | `OUTLOOK_AGENT_MAX_STEPS` | Upper bound on ReAct iterations (tool call + observation pairs). 1..50. |
| `--system <text>` | string | built-in default (§12) | `OUTLOOK_AGENT_SYSTEM_PROMPT` | Inline system prompt override. |
| `--system-file <path>` | path | — | `OUTLOOK_AGENT_SYSTEM_PROMPT_FILE` | Reads system prompt from file (UTF-8). Mutually exclusive with `--system`. |
| `--tools <csv>` | string | full MVP set | `OUTLOOK_AGENT_TOOLS` | Whitelist subset of the catalog by snake_case name. |
| `--temperature <f>` | float | `0` | `OUTLOOK_AGENT_TEMPERATURE` | Forwarded to the provider when supported. |
| `--env-file <path>` | path | `.env` in CWD if present | — (flag-only) | Dotenv file to load. Missing file + flag set → exit 3. Missing file without flag → silently skipped. |
| `--verbose` | boolean | `false` | — | Prints the full tool-call transcript to stderr. |
| `--json` / `--table` | mode | `--json` | — | Inherit from global policy. `--table` renders the final answer + tool-call summary. |
| `--quiet` | boolean | `false` | — | Suppress stderr progress. Error output still goes to stderr. |
| `--no-auto-reauth` | boolean | `false` | — | Inherited; applied to the `auth_check` tool and all API calls. |
| `--log-file <path>` | path | — | — | Inherited; writes debug log with secrets redacted. |

Validation: exactly one of {positional prompt, `-i/--interactive`} must be
set; otherwise exit 2 (`USAGE`).

### FR-2 — `.env` file loading & precedence

- A `.env` file is loaded at startup using `dotenv`. Precedence is
  strictly: **CLI flag > process env > .env file > NO FALLBACK**. Once a
  required value is still unset after all three tiers, `loadAgentConfig`
  throws `ConfigMissingError` and the process exits 3.
- Default search path: `./.env` (CWD). If `--env-file <path>` is given,
  that file is loaded instead; file must exist or exit 3 with
  `CONFIG_ENV_FILE_NOT_FOUND`.
- `.env` values **never overwrite** values already present in
  `process.env`. (This is the standard `dotenv` semantic and the
  precedence rule above.)
- `.env` is additive to the global CLI env vars (`OUTLOOK_CLI_*`) and
  the agent-specific vars (`OUTLOOK_AGENT_*`). Both prefixes may appear.
- The `.env` file must be added to `.gitignore` (see NFR-2).

### FR-3 — Provider registry + selection

- A `ProviderRegistry` exposes a `create(providerName, opts): BaseChatModel`
  factory where `providerName ∈ {azure-openai, azure-anthropic,
  azure-deepseek, openai, anthropic, google}`.
- Each provider factory is self-contained: it reads its own required
  env vars via the shared config loader, validates them, and returns a
  LangChain `BaseChatModel` instance compatible with
  `createReactAgent({ llm, tools })`.
- Unknown provider name → exit 2 (`USAGE`) with the valid list.
- Adding a new provider requires: (a) a new factory module, (b)
  registering the name in the registry, (c) documenting its env vars in
  §6 and CLAUDE.md. No changes to `src/commands/agent.ts` or the ReAct
  graph are allowed.

### FR-4 — Per-provider required env vars

See full matrix in §6. Summary of required names:

- `openai`: `OUTLOOK_AGENT_OPENAI_API_KEY` (required),
  `OUTLOOK_AGENT_OPENAI_BASE_URL` (optional — OpenAI-compatible gateways),
  `OUTLOOK_AGENT_OPENAI_ORG` (optional).
- `anthropic`: `OUTLOOK_AGENT_ANTHROPIC_API_KEY` (required),
  `OUTLOOK_AGENT_ANTHROPIC_BASE_URL` (optional).
- `google`: `OUTLOOK_AGENT_GOOGLE_API_KEY` (required).
- `azure-openai`: `OUTLOOK_AGENT_AZURE_OPENAI_API_KEY` (required),
  `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT` (required, e.g.
  `https://my-resource.openai.azure.com`),
  `OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION` (required, e.g.
  `2024-10-21`),
  `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT` (required — the Azure OpenAI
  deployment name; **`--model` is ignored for this provider**, or
  alternatively used to populate the deployment if the deployment env is
  unset — investigator to pick one; v1 preference: deployment env
  required, `--model` optional cosmetic label).
- `azure-anthropic` (Azure AI Inference endpoint hosting Anthropic
  models): `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` (required, e.g.
  `https://my-resource.services.ai.azure.com/models`),
  `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` (required),
  `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` (required, e.g.
  `2024-05-01-preview`),
  `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` (required — the Azure model
  router id, e.g. `Claude-3-7-Sonnet` or
  `anthropic.claude-3-5-sonnet-20241022-v2:0` depending on Azure's
  current naming — investigator must confirm the exact string surface).
- `azure-deepseek` (same Azure AI Inference endpoint, different model
  router id): `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` (required,
  shared with Azure Anthropic), `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY`
  (required, shared), `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION`
  (required, shared), `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` (required —
  e.g. `DeepSeek-V3.1` or `DeepSeek-R1`; investigator to confirm).

Rationale for sharing the `AZURE_AI_INFERENCE_*` triplet across
Azure-hosted Anthropic and DeepSeek: both ride the Azure AI Inference
("model router") surface, so the endpoint + key + api-version are a
single deployment concern; only the model id differs.

### FR-5 — ReAct loop semantics

- Implementation: LangGraph.js `createReactAgent({ llm, tools,
  checkpointSaver?, messageModifier? })`. Custom graphs are an escape
  hatch for v2 but not needed for v1.
- Tool-calling format: provider-native tool calling (OpenAI function
  calling / Anthropic tool_use / Gemini function calling). LangChain's
  `bindTools` abstraction hides the wire format.
- Termination conditions:
  1. An `AIMessage` arrives with **no** `tool_calls` → that message is
     the final answer.
  2. Step count (tool-call rounds) reaches `--max-steps` → return the
     last AIMessage plus a `truncated: true` flag in the envelope and
     exit 0 (not an error).
  3. Tool error classified as fatal (see §9) → exit with the mapped
     code.
  4. User cancel (SIGINT) in interactive mode → graceful exit 130.
- Per-step (per tool call) timeout: the global `--timeout` is applied
  inside each tool adapter. The LLM call itself is not separately
  capped in v1 beyond the provider SDK default.
- Streaming: the agent may stream intermediate `AIMessageChunk`s to
  stderr when `--verbose` is set; otherwise it buffers until completion.

### FR-6 — Tool catalog

See the full catalog in §8. Each tool is a LangChain `tool(...)` created
from a Zod input schema and an async adapter that calls the existing
`src/commands/*` handlers in-process (not by shelling out). Outputs are
serialized to JSON for the LLM and truncated at a hard byte budget (see
§12 — 16 KB per tool result by default).

### FR-7 — Auth handling

- Before the graph runs, the agent invokes the existing
  `auth-check` helper in-process.
  - `ok` → proceed.
  - `expired` | `missing` | `rejected` →
    - If `--no-auto-reauth` is set → exit 4 (`AUTH_REQUIRED`).
    - Else → invoke the existing `login` flow (NOT `--force`), then
      re-run `auth-check`. A second non-`ok` result → exit 4.
- Inside the ReAct loop every tool adapter reuses the global
  `--no-auto-reauth` flag. If a 401 arrives during a tool call and
  auto-reauth is disabled, the tool surfaces
  `UPSTREAM_AUTH_REJECTED` to the model as an observation; the model
  may decide to stop. (The process does not silently spawn a login mid
  tool call.)

### FR-8 — Output modes

- **`--json` (default)** — emits a single JSON object to stdout:
  ```
  {
    "provider": "<name>",
    "model": "<id>",
    "prompt": "<user prompt, truncated to 512 chars>",
    "finalAnswer": "<string>",
    "steps": [
      {
        "index": 1,
        "tool": "list_mail",
        "input": { ... redacted ... },
        "output": { ... redacted ... },
        "error": null,
        "durationMs": 843
      },
      ...
    ],
    "usage": {
      "promptTokens": 1234,
      "completionTokens": 456,
      "totalTokens": 1690
    } | null,
    "truncated": false,
    "durationMs": 12345
  }
  ```
- **`--table`** — prints the final answer only (wrapped), followed by
  a compact table of tool calls: `#, Tool, Status, DurationMs`.
- **`--verbose`** — adds the full transcript (system prompt, user
  message, each AIMessage + ToolMessage) to **stderr**. stdout remains
  JSON or table as above.

### FR-9 — Logging

- Respect `--quiet` (suppresses stderr progress) and `--log-file`
  (mode 0600, appended). Log records are JSON lines.
- Redaction rules (applied before any sink):
  - API keys, Bearer tokens, cookies, session file contents, and
    anything matching `/(api[-_]?key|authorization|bearer|cookie|x-functions-key)/i`
    in a header or field name → replaced with `"<redacted>"`.
  - Raw email `Body.Content` longer than 2 KB → truncated with a
    suffix `"... [truncated N bytes]"`.
  - Attachment byte content → never logged.

### FR-10 — Exit codes

Reuses the existing taxonomy:

| Code | Meaning | Agent triggers |
|---|---|---|
| 0 | Success | ReAct finished, final answer returned. |
| 2 | Usage error | Unknown `--provider`, mutually-exclusive flags, invalid `--max-steps`, both positional prompt and `-i`, `--system` + `--system-file`. |
| 3 | Configuration error | Missing required env var for the chosen provider; `--env-file` set to a non-existent path; `--system-file` unreadable. |
| 4 | Auth failure | `auth-check` not `ok` and `--no-auto-reauth` set; login flow aborted/timed out. |
| 5 | Upstream API error | Provider SDK 4xx/5xx that is not auth; tool adapter returns an outlook REST 5xx/timeout and the model cannot recover within `--max-steps`; upstream AI Inference endpoint error. |
| 6 | IO error | `--log-file` unwritable; dotenv parse error; `--system-file` write-protected dir. |
| 1 | Unexpected error | Anything else. |
| 130 | SIGINT | Interactive REPL aborted by user. |

### FR-11 — Interactive REPL

- Launched by `--interactive` / `-i`.
- Uses Node's `readline` with prompt `outlook-agent> `.
- A single LangGraph `MemorySaver` instance persists the message
  history across turns for the life of the process; exiting the REPL
  discards it (no disk persistence — see §2 out-of-scope).
- Slash commands (handled locally, never sent to the LLM):
  - `/exit`, `/quit` → exit 0.
  - `/clear` → drop the memory thread and start fresh.
  - `/tools` → list registered tool names + descriptions.
  - `/system <text>` → replace the system prompt for subsequent turns.
  - `/help` → print the command list.
- Ctrl-C in an idle prompt → exit 130. Ctrl-C during a running
  ReAct turn → cancel the current run, keep the REPL alive.

### FR-12 — System prompt override

- Default system prompt (baseline; the implementer may polish
  wording but must preserve intent):

  > You are an assistant embedded in the outlook-cli tool. You have
  > access to tools that read the user's Outlook mailbox, calendar,
  > and folder tree. Prefer the smallest, most specific tool call.
  > Always cite message ids or event ids when you reference a
  > specific item. Never invent message content, sender names, or
  > timestamps — call a tool and observe the result. If a tool
  > returns an error, report it to the user rather than retrying
  > blindly. Respect the user's `--max-steps` budget.

- `--system <text>` and `--system-file <path>` override the default.
  Both present → exit 2.
- The final system prompt is prepended as a `SystemMessage` ahead of
  the user's first `HumanMessage`.

### FR-13 — Max-steps ceiling

- Hard default: `10` ReAct iterations (one "iteration" = one AIMessage
  with tool_calls → tool results back to the model).
- Overridable via `--max-steps` or `OUTLOOK_AGENT_MAX_STEPS`.
- Range validation: integer in `[1, 50]`; out of range → exit 2.
- When the ceiling is hit, the envelope carries `truncated: true` and
  the final answer is the last AIMessage content (which may be
  empty). Exit code is still 0 — this is not an error, just a budget
  event.

---

## 5. Non-Functional Requirements

### NFR-1 — Secret handling
- Provider API keys and Azure AI Inference keys are **only** read from
  `process.env` (optionally populated from `.env`). They are never
  written to the session file, the log file, the JSON output, or
  stderr. The redaction filter in FR-9 applies universally.
- CLI flags **cannot** set API keys (flags appear in `ps` output).
  Attempting `--openai-api-key` or similar is deliberately not
  supported.

### NFR-2 — `.env` must never be committed
- `.gitignore` must include `.env` and `.env.*` (except `.env.example`)
  before this feature lands. A sample `.env.example` with every agent
  env var name and an empty value may be committed.

### NFR-3 — Token / cost observability
- When the provider SDK exposes token usage on the final
  AIMessageChunk (`usage_metadata` or `response_metadata`), the agent
  surfaces it in the JSON envelope's `usage` field (FR-8). Providers
  that do not expose usage yield `usage: null` — no fabrication.

### NFR-4 — Deterministic test mode
- `--temperature 0` is the default.
- Tests use a `MockChatModel` (from `@langchain/core/test_utils` or a
  local double) and a deterministic tool registry — no real network
  I/O in unit tests.
- A `--provider mock` hidden provider may be registered **for tests
  only** (gated behind `NODE_ENV === 'test'`); it must not be
  reachable in production builds.

### NFR-5 — Performance / blocking
- No synchronous blocking I/O on the hot path (config load excluded).
- All tool adapters respect the global `--timeout` (default 30 s).
- Agent boot (config + provider + graph wiring) must complete in
  under 1 s on a cold run excluding network (`auth-check` is the
  first network call).

### NFR-6 — Observability
- `--log-file` emits JSON-lines with one record per: config load,
  provider instantiation, graph build, each tool call
  (pre/post/error), final answer. Records carry a run id
  (`crypto.randomUUID()`).

### NFR-7 — Accessibility / ergonomics
- Default output is human-friendly when stdout is a TTY and
  `--json` / `--table` are not explicitly set (table mode).
  Non-TTY → JSON. (Matches existing CLI convention; investigator
  to confirm other subcommands behave the same.)

### NFR-8 — No prompt-injection escape
- The tool registry is a **closed set**. The agent loop must not
  expose a generic "run shell command" or "call arbitrary URL" tool.
- Tool adapters validate inputs against the Zod schema before
  execution. Schema-invalid calls yield a `ToolMessage` with an
  error to the model (not a process crash, not a silent execution).

---

## 6. Configuration Matrix

All variables listed are new unless marked `(existing)`. Required
variables have no default and raise `CONFIG_MISSING` (exit 3) when
missing.

### 6.1 Agent-level (provider-agnostic)

| Variable | Purpose | Required? | Default | CLI flag | Obtain from |
|---|---|---|---|---|---|
| `OUTLOOK_AGENT_PROVIDER` | Selects the LLM provider | Yes (unless `--provider` given) | — | `--provider` | One of the 6 registered names. |
| `OUTLOOK_AGENT_MODEL` | LLM model id / deployment name alias | Yes (unless `--model` given, or provider-specific override exists) | — | `--model` | Provider console. |
| `OUTLOOK_AGENT_MAX_STEPS` | ReAct iteration ceiling | No | `10` | `--max-steps` | Operator policy. |
| `OUTLOOK_AGENT_TEMPERATURE` | Sampling temperature | No | `0` | `--temperature` | — |
| `OUTLOOK_AGENT_SYSTEM_PROMPT` | Inline system prompt | No | built-in | `--system` | — |
| `OUTLOOK_AGENT_SYSTEM_PROMPT_FILE` | Path to system prompt file | No | — | `--system-file` | — |
| `OUTLOOK_AGENT_TOOLS` | CSV whitelist of tool names | No | full MVP set | `--tools` | — |

### 6.2 Provider — `openai`

| Variable | Purpose | Required? | Default | CLI flag | Obtain from |
|---|---|---|---|---|---|
| `OUTLOOK_AGENT_OPENAI_API_KEY` | Secret key | Yes | NONE — raises CONFIG_MISSING | — | https://platform.openai.com/api-keys |
| `OUTLOOK_AGENT_OPENAI_BASE_URL` | OpenAI-compatible gateway override | No | OpenAI default | — | — |
| `OUTLOOK_AGENT_OPENAI_ORG` | Organization id | No | — | — | OpenAI dashboard |

### 6.3 Provider — `anthropic`

| Variable | Purpose | Required? | Default | CLI flag | Obtain from |
|---|---|---|---|---|---|
| `OUTLOOK_AGENT_ANTHROPIC_API_KEY` | Secret key | Yes | NONE — raises CONFIG_MISSING | — | https://console.anthropic.com/ |
| `OUTLOOK_AGENT_ANTHROPIC_BASE_URL` | Gateway override | No | Anthropic default | — | — |

### 6.4 Provider — `google`

| Variable | Purpose | Required? | Default | CLI flag | Obtain from |
|---|---|---|---|---|---|
| `OUTLOOK_AGENT_GOOGLE_API_KEY` | Gemini API key | Yes | NONE — raises CONFIG_MISSING | — | https://aistudio.google.com/app/apikey |

### 6.5 Provider — `azure-openai`

| Variable | Purpose | Required? | Default | CLI flag | Obtain from |
|---|---|---|---|---|---|
| `OUTLOOK_AGENT_AZURE_OPENAI_API_KEY` | Azure OpenAI key | Yes | NONE — raises CONFIG_MISSING | — | Azure portal → resource → Keys & Endpoint. |
| `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT` | Resource endpoint URL | Yes | NONE — raises CONFIG_MISSING | — | Azure portal → resource → Keys & Endpoint. |
| `OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION` | API version, e.g. `2024-10-21` | Yes | NONE — raises CONFIG_MISSING | — | Azure docs (latest stable). |
| `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT` | Deployment name | Yes | NONE — raises CONFIG_MISSING | — | Azure portal → Deployments. |

### 6.6 Provider — `azure-anthropic` (Azure AI Inference hosting Anthropic)

| Variable | Purpose | Required? | Default | CLI flag | Obtain from |
|---|---|---|---|---|---|
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` | AI Inference endpoint, e.g. `https://my-resource.services.ai.azure.com/models` | Yes | NONE — raises CONFIG_MISSING | — | Azure AI Foundry → project → endpoint. |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` | AI Inference key | Yes | NONE — raises CONFIG_MISSING | — | Azure AI Foundry → project → keys. |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` | e.g. `2024-05-01-preview` | Yes | NONE — raises CONFIG_MISSING | — | Azure AI Inference docs. |
| `OUTLOOK_AGENT_AZURE_ANTHROPIC_MODEL` | Model router id, e.g. `Claude-3-7-Sonnet` | Yes (unless `--model` given) | NONE | `--model` | Azure AI Foundry → Model Catalog. Investigator must confirm exact string. |

### 6.7 Provider — `azure-deepseek` (Azure AI Inference hosting DeepSeek)

| Variable | Purpose | Required? | Default | CLI flag | Obtain from |
|---|---|---|---|---|---|
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_ENDPOINT` | Shared with 6.6 | Yes | NONE — raises CONFIG_MISSING | — | — |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_KEY` | Shared with 6.6 | Yes | NONE — raises CONFIG_MISSING | — | — |
| `OUTLOOK_AGENT_AZURE_AI_INFERENCE_API_VERSION` | Shared with 6.6 | Yes | NONE — raises CONFIG_MISSING | — | — |
| `OUTLOOK_AGENT_AZURE_DEEPSEEK_MODEL` | Model router id, e.g. `DeepSeek-V3.1` | Yes (unless `--model` given) | NONE | `--model` | Azure AI Foundry → Model Catalog. Investigator to confirm. |

### 6.8 Existing (unchanged)

All `OUTLOOK_CLI_*` variables defined in `src/config/config.ts` continue
to apply for auth / session / HTTP plumbing. The agent subcommand
reuses them unchanged.

---

## 7. CLI Surface Spec

**Usage:**

```
outlook-cli agent [prompt]
  [-i|--interactive]
  --provider <name>
  [--model <id>]
  [--max-steps <n>]
  [--temperature <f>]
  [--system <text> | --system-file <path>]
  [--tools <csv>]
  [--env-file <path>]
  [--verbose]
  [--json|--table]
  [--quiet]
  [--no-auto-reauth]
  [--log-file <path>]
  [inherited global flags: --timeout, --login-timeout, --chrome-channel,
   --session-file, --profile-dir, --tz]
```

**Rules:**
- Exactly one of `[prompt]` or `-i/--interactive` must be set.
- `--provider` is required (flag or env).
- `--system` and `--system-file` are mutually exclusive.

**Worked examples, one per provider:**

```bash
# OpenAI native
OUTLOOK_AGENT_OPENAI_API_KEY=sk-... \
outlook-cli agent "List my 5 most recent unread emails" \
  --provider openai --model gpt-4o-mini --table

# Anthropic native
OUTLOOK_AGENT_ANTHROPIC_API_KEY=sk-ant-... \
outlook-cli agent "Summarize the last email from alice@example.com" \
  --provider anthropic --model claude-3-7-sonnet-latest

# Google Gemini
OUTLOOK_AGENT_GOOGLE_API_KEY=... \
outlook-cli agent -i --provider google --model gemini-2.5-pro --verbose

# Azure OpenAI
outlook-cli agent "What meetings do I have next week?" \
  --provider azure-openai --env-file ./.env.azure
# .env.azure contains:
#   OUTLOOK_AGENT_AZURE_OPENAI_API_KEY=...
#   OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT=https://my-res.openai.azure.com
#   OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION=2024-10-21
#   OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT=gpt-4o

# Azure-hosted Anthropic via AI Inference
outlook-cli agent "Move newsletters from last week to Inbox/Newsletters" \
  --provider azure-anthropic --model Claude-3-7-Sonnet --max-steps 20

# Azure-hosted DeepSeek via AI Inference
outlook-cli agent -i --provider azure-deepseek --model DeepSeek-V3.1
```

---

## 8. Tool Catalog (LLM-facing)

Each tool is registered with `tool(fn, { name, description, schema })`
from `@langchain/core/tools`. Names are snake_case. Descriptions are
written for the LLM and must stay under ~240 chars. Input schemas are
Zod; outputs are JSON-serializable objects truncated to 16 KB (§12).

### 8.1 `auth_check`
- **Description**: Verify that the current Outlook session is still valid. Returns the session status without opening a browser. Call this first if another tool returned an auth error.
- **Input schema**: `z.object({})`
- **Output**: `{ status: "ok" | "expired" | "missing" | "rejected", tokenExpiresAt?: string, account?: { upn: string, puid?: string, tenantId?: string } }`
- **Errors surfaced**: none — the command always exits 0; failures are encoded in the `status` field.

### 8.2 `list_mail`
- **Description**: List recent messages in a folder, optionally filtered by a date window. Supports well-known aliases (Inbox, Archive, SentItems...), display-name paths ("Inbox/Projects/Alpha"), or a raw folder id.
- **Input schema**:
  ```
  z.object({
    top: z.number().int().min(1).max(1000).default(10),
    folder: z.string().optional(),
    folderId: z.string().optional(),
    folderParent: z.string().optional(),
    from: z.string().optional(),   // ISO8601 or "now", "now + Nd", "now - Nd"
    to: z.string().optional(),
    select: z.string().optional(), // CSV of OData $select fields
    justCount: z.boolean().default(false)
  }).refine(v => !(v.folder && v.folderId), { message: "folder and folderId are mutually exclusive" })
  ```
- **Output**: `MessageSummary[]` OR `{ count: number, exact: boolean }` when `justCount`.
- **Errors surfaced**: `UPSTREAM_FOLDER_NOT_FOUND`, `FOLDER_AMBIGUOUS`, `FOLDER_PATH_INVALID`, `UPSTREAM_AUTH_REJECTED`, `UPSTREAM_PAGINATION_LIMIT`, `UPSTREAM_TIMEOUT`.

### 8.3 `get_mail`
- **Description**: Retrieve a single email message by id, including its body and attachment metadata.
- **Input schema**:
  ```
  z.object({
    id: z.string().min(1),
    body: z.enum(["html", "text", "none"]).default("text")
  })
  ```
- **Output**: `Message & { Attachments: AttachmentSummary[] }`.
- **Errors surfaced**: `UPSTREAM_MESSAGE_NOT_FOUND`, `UPSTREAM_AUTH_REJECTED`, `UPSTREAM_TIMEOUT`.

### 8.4 `get_thread`
- **Description**: Retrieve every message in the conversation thread that a given message belongs to.
- **Input schema**:
  ```
  z.object({
    id: z.string().min(1),            // message id, or "conv:<rawConvId>"
    body: z.enum(["html", "text", "none"]).default("text"),
    order: z.enum(["asc", "desc"]).default("asc")
  })
  ```
- **Output**: `{ conversationId: string, count: number, messages: MessageSummary[] }`.
- **Errors surfaced**: same as `get_mail`.

### 8.5 `list_folders`
- **Description**: Enumerate mail folders under a parent (well-known alias, path, or id). Supports recursive walk.
- **Input schema**:
  ```
  z.object({
    parent: z.string().default("MsgFolderRoot"),
    top: z.number().int().min(1).max(250).default(100),
    recursive: z.boolean().default(false),
    includeHidden: z.boolean().default(false),
    firstMatch: z.boolean().default(false)
  })
  ```
- **Output**: `FolderSummary[]`.
- **Errors surfaced**: `UPSTREAM_FOLDER_NOT_FOUND`, `FOLDER_AMBIGUOUS`, `UPSTREAM_PAGINATION_LIMIT`, `UPSTREAM_AUTH_REJECTED`.

### 8.6 `find_folder`
- **Description**: Resolve a folder query (well-known alias, display-name path, or `id:<raw>`) to a single folder object.
- **Input schema**:
  ```
  z.object({
    spec: z.string().min(1),
    anchor: z.string().default("MsgFolderRoot"),
    firstMatch: z.boolean().default(false)
  })
  ```
- **Output**: `ResolvedFolder` with `ResolvedVia`.
- **Errors surfaced**: `UPSTREAM_FOLDER_NOT_FOUND`, `FOLDER_AMBIGUOUS`, `FOLDER_PATH_INVALID`.

### 8.7 `create_folder`
- **Description**: Create a folder (optionally a nested path) under an anchor. Idempotent when requested.
- **Input schema**:
  ```
  z.object({
    pathOrName: z.string().min(1),
    parent: z.string().default("MsgFolderRoot"),
    createParents: z.boolean().default(false),
    idempotent: z.boolean().default(true)   // default true for the agent — see §12
  })
  ```
- **Output**: `CreateFolderResult`.
- **Errors surfaced**: `FOLDER_PATH_INVALID`, `FOLDER_MISSING_PARENT`, `FOLDER_ALREADY_EXISTS` (only if `idempotent: false`), `UPSTREAM_AUTH_REJECTED`.

### 8.8 `move_mail`
- **Description**: Move one or more messages to a destination folder. Returns the NEW message ids — the original ids become invalid after move. Always report both sourceId and newId back to the user.
- **Input schema**:
  ```
  z.object({
    messageIds: z.array(z.string().min(1)).min(1).max(50),
    to: z.string().min(1),
    firstMatch: z.boolean().default(false),
    continueOnError: z.boolean().default(true)
  })
  ```
- **Output**: `MoveMailResult`.
- **Errors surfaced**: `UPSTREAM_FOLDER_NOT_FOUND`, `FOLDER_AMBIGUOUS`, `UPSTREAM_MESSAGE_NOT_FOUND`, partial-failure summary.

### 8.9 `list_calendar`
- **Description**: List calendar events between a start and end datetime.
- **Input schema**:
  ```
  z.object({
    from: z.string().default("now"),      // ISO or "now" / "now + Nd"
    to: z.string().default("now + 7d"),
    tz: z.string().optional()
  })
  ```
- **Output**: `EventSummary[]`.
- **Errors surfaced**: `UPSTREAM_AUTH_REJECTED`, `UPSTREAM_TIMEOUT`.

### 8.10 `get_event`
- **Description**: Retrieve a single calendar event by id.
- **Input schema**:
  ```
  z.object({
    id: z.string().min(1),
    body: z.enum(["html", "text", "none"]).default("text")
  })
  ```
- **Output**: `Event` object.
- **Errors surfaced**: `UPSTREAM_EVENT_NOT_FOUND`, `UPSTREAM_AUTH_REJECTED`.

### 8.11 `download_attachments`
- **Description**: Download all file attachments from a given message into a local directory. Returns paths and sizes — the byte content is never returned to the model.
- **Input schema**:
  ```
  z.object({
    messageId: z.string().min(1),
    outDir: z.string().min(1),
    overwrite: z.boolean().default(false),
    includeInline: z.boolean().default(false)
  })
  ```
- **Output**: `{ messageId, outDir, saved: [{id,name,path,size}], skipped: [{id,name,reason}] }`.
- **Errors surfaced**: IO errors (exit 6 at the CLI level, but surfaced as tool error string to the model), `UPSTREAM_MESSAGE_NOT_FOUND`, `UPSTREAM_AUTH_REJECTED`.

**Notes on the catalog:**
- No `send_mail`, no `reply`, no `delete_mail`, no `update_event`, no
  `create_event` in v1 (see §3).
- Every adapter produces human-safe (no binary) JSON output; the 16 KB
  budget is enforced after serialization and a `"_truncated": true`
  flag is appended when trimming was needed.

---

## 9. ReAct Loop Contract

**State carried by the graph** (beyond the built-in `messages` channel):
- `messages: BaseMessage[]` — running transcript (System + Human + AI +
  Tool). Managed by LangGraph.
- `stepCount: number` — incremented on every AIMessage that carries
  `tool_calls`.
- `toolResults: Array<{ index, name, input, output | error, durationMs }>`
  — collected for the JSON envelope; not sent back to the LLM (the
  LLM only sees the standard ToolMessages).
- `usage: { promptTokens, completionTokens, totalTokens } | null` —
  accumulated from `usage_metadata` when the SDK provides it.

**Termination rules (in precedence order):**
1. User cancel (SIGINT) → abort, exit 130 in single-shot; keep REPL
   alive in interactive mode.
2. `stepCount >= maxSteps` → stop after the current AIMessage, set
   `truncated: true`, exit 0.
3. Final `AIMessage` has no `tool_calls` → that is the answer, exit 0.
4. Fatal error (see below) → map to exit code, emit envelope with
   `error` populated and `finalAnswer: null`.

**Error handling (per tool call):**
- **Retriable, surfaced to the model**: `UPSTREAM_TIMEOUT`,
  `UPSTREAM_PAGINATION_LIMIT`, `FOLDER_AMBIGUOUS`,
  `UPSTREAM_FOLDER_NOT_FOUND`, `UPSTREAM_MESSAGE_NOT_FOUND`,
  `UPSTREAM_EVENT_NOT_FOUND`, `FOLDER_PATH_INVALID`,
  `FOLDER_MISSING_PARENT`, `FOLDER_ALREADY_EXISTS` (only when
  `idempotent: false`). Encoded as a `ToolMessage` with
  `{"error": {"code": "...", "message": "..."}}`. The model may
  adjust its plan and try again (counts toward `max-steps`).
- **Fatal, exits the process**: `UPSTREAM_AUTH_REJECTED` with
  `--no-auto-reauth` (exit 4); IO error writing to `--log-file`
  (exit 6); provider SDK 4xx for key/endpoint misconfiguration
  (exit 3); Zod schema violation on tool input (this is a bug,
  exit 1). These never reach the LLM as a retriable observation.
- **Ambiguity / over-step**: hitting `maxSteps` is **not** fatal; it's
  logged and the current answer returned.

**LangGraph specifics:**
- Graph built via `createReactAgent({ llm, tools, checkpointSaver,
  stateModifier })`.
- `checkpointSaver` = `MemorySaver()` (in-process only; interactive
  mode reuses the same `thread_id` across turns, single-shot mode
  gets a fresh one each run).
- `stateModifier` = `{ systemMessage: <resolved system prompt> }`.

---

## 10. Acceptance Criteria

- **AC-1** — Running `outlook-cli agent "list my 3 most recent unread
  emails" --provider openai --model gpt-4o-mini --json` with a valid
  `OUTLOOK_AGENT_OPENAI_API_KEY` and a live session produces a JSON
  envelope whose `steps[]` contains at least one `list_mail` call with
  `top: 3` and whose `finalAnswer` references three message ids.
  *(Maps to FR-1, FR-5, FR-6, FR-8.)*
- **AC-2** — Swapping `--provider openai` for `--provider azure-openai`
  with valid Azure env vars (`OUTLOOK_AGENT_AZURE_OPENAI_API_KEY`,
  `OUTLOOK_AGENT_AZURE_OPENAI_ENDPOINT`,
  `OUTLOOK_AGENT_AZURE_OPENAI_API_VERSION`,
  `OUTLOOK_AGENT_AZURE_OPENAI_DEPLOYMENT`) produces the same behavior
  without any code change. *(Maps to FR-3, FR-4, NFR-8.)*
- **AC-3** — Running with a required env var unset (e.g.
  `--provider openai` and no `OUTLOOK_AGENT_OPENAI_API_KEY` anywhere)
  exits 3 with a `CONFIG_MISSING` error naming the missing variable.
  No default key is substituted. *(Maps to FR-2, FR-4.)*
- **AC-4** — Given a `.env` file setting
  `OUTLOOK_AGENT_OPENAI_API_KEY=file-key` and a process env
  `OUTLOOK_AGENT_OPENAI_API_KEY=process-key`, the agent uses
  `process-key`. Removing the process env then re-running uses
  `file-key`. Removing both re-exits 3. *(Maps to FR-2.)*
- **AC-5** — In `--interactive` mode, two successive turns share
  conversation state: turn 2 can reference "the email from turn 1" and
  the agent's transcript contains both turns' messages.
  *(Maps to FR-11.)*
- **AC-6** — The LLM's tool-call requesting a tool name not in the
  registered catalog (e.g. `delete_mail`) results in a
  schema/registry rejection observed by the model as a ToolMessage
  error, not an execution. *(Maps to FR-6, NFR-8.)*
- **AC-7** — `vitest run` includes passing unit tests for:
  (a) provider factory registry (valid + invalid names),
  (b) .env + process env precedence,
  (c) each tool adapter (mocked outlook REST layer),
  (d) a full ReAct loop with a `MockChatModel` that emits a scripted
  tool call and a final answer,
  (e) the redaction filter in FR-9.
  *(Maps to all FRs + NFR-4.)*
- **AC-8** — `tsc --noEmit` succeeds; `vitest run` is green;
  `CLAUDE.md` has been updated with a new `<agent>` tool block
  following the project's documentation schema. *(Maps to project
  rules.)*
- **AC-9** — Running `--max-steps 2` on a prompt that would require
  three tool calls exits 0 with `truncated: true` in the envelope.
  *(Maps to FR-13.)*
- **AC-10** — `--no-auto-reauth` + expired session exits 4 without
  opening Chrome. *(Maps to FR-7.)*
- **AC-11** — API keys never appear in `--json` output, `--verbose`
  stderr transcript, or `--log-file` contents (assertion: regex scan
  for each key value returns zero matches). *(Maps to NFR-1, FR-9.)*

---

## 11. Dependencies To Add

Candidate npm packages (investigator confirms exact versions at
investigation time — versions here are indicative):

- **`@langchain/langgraph`** (^0.2.x) — ReAct prebuilt, MemorySaver,
  checkpointing. *Confident.*
- **`@langchain/core`** (^0.3.x) — `BaseChatModel`, `tool(...)`,
  message classes, Zod bridge. *Confident.*
- **`@langchain/openai`** (^0.3.x) — OpenAI + Azure OpenAI chat models.
  *Confident — this package covers both.*
- **`@langchain/anthropic`** (^0.3.x) — native Anthropic chat model.
  *Confident.*
- **`@langchain/google-genai`** (^0.1.x) — Gemini chat model.
  *Confident.*
- **Azure-hosted Anthropic + DeepSeek** — *NEEDS INVESTIGATION.* Two
  candidates the investigator must evaluate:
  1. `@azure-rest/ai-inference` (official Azure AI Inference REST
     SDK, TypeScript-first) wrapped in a thin LangChain
     `BaseChatModel` adapter. This is the v1 preferred path.
  2. `@langchain/community`'s `ChatOpenAI`-style wrapper pointed at
     the Azure AI Inference OpenAI-compatible endpoint, if Azure
     exposes OpenAI-compatible wire format for Anthropic/DeepSeek
     model router deployments. Only acceptable if it passes
     tool-calling tests.
  The investigator must pick ONE and document the decision in
  `docs/design/investigation-langgraph-agent.md`.
- **`dotenv`** (^16.x) — `.env` file loading. *Confident.*
- **`zod`** (^3.x) — tool schemas. *Check whether already a
  transitive of the existing codebase; if not, add explicitly.*

No removals anticipated. No native / binary deps.

---

## 12. Decisions Made & Open Questions

### Decisions locked in this refinement (no further input needed)

- **D-1 (ReAct style)**: Use LangGraph.js `createReactAgent` (prebuilt)
  for v1. Custom graph is a v2 escape hatch if we need guard rails
  (e.g. forbidden tool sequences).
- **D-2 (Memory persistence)**: In-process `MemorySaver` only. No
  on-disk thread store in v1. Future work may add a `--thread-id`
  flag backed by SQLite.
- **D-3 (Tool output byte budget)**: Hard cap of **16 KB** per tool
  result (JSON-serialized) before being handed back as a
  `ToolMessage`. Trimming appends `"_truncated": true`. Tunable via
  `OUTLOOK_AGENT_TOOL_OUTPUT_BUDGET_BYTES` (optional, default
  `16384`).
- **D-4 (Default mode)**: `--json` is the default when stdout is not
  a TTY; `--table` is the default when stdout is a TTY (matches
  existing CLI convention). Both can be forced.
- **D-5 (`create_folder` defaults)**: The agent-facing `create_folder`
  tool defaults `idempotent: true` (unlike the CLI where it's opt-in),
  because an LLM retry is more likely to re-create the same folder;
  this keeps the loop deterministic. Documented explicitly.
- **D-6 (Provider `mock`)**: Registered only when
  `NODE_ENV === 'test'`. Not documented in CLAUDE.md for end users.
- **D-7 (Streaming)**: No token streaming in v1. The final answer is
  returned after the run completes. `--verbose` prints intermediate
  messages post-hoc.
- **D-8 (Auth-check on boot)**: The agent calls `auth-check` once
  before the graph starts. The LLM is told in the system prompt that
  the session is already valid; it does not need to call `auth_check`
  unless a later tool fails with auth.

### Questions that genuinely need user / investigator resolution

- **Q-1**: Azure's current, stable name for Azure-hosted Anthropic
  models on the AI Inference endpoint (e.g.
  `Claude-3-7-Sonnet` vs. provider-prefixed vs. deployment name).
  **Who resolves**: investigator, via Azure AI Foundry portal +
  `@azure-rest/ai-inference` SDK docs.
- **Q-2**: Azure's current, stable name for Azure-hosted DeepSeek
  models (e.g. `DeepSeek-V3.1`, `DeepSeek-R1`).
  **Who resolves**: investigator.
- **Q-3**: Does `@langchain/openai`'s `AzureChatOpenAI` already cover
  all five Azure OpenAI auth shapes (API key, AAD token, Managed
  Identity)? v1 scope is API key only; AAD can be deferred.
  **Who resolves**: investigator + user confirmation on scope.
- **Q-4**: Should the interactive REPL support Ctrl-R history
  search? **Default answer: no** — plain readline. Can be added
  later.
- **Q-5**: Does the project already have a Zod dependency
  transitively? **Who resolves**: investigator via
  `npm ls zod`.

---

## 13. Out-of-Repo References

The investigator should consult (and cite in
`docs/design/investigation-langgraph-agent.md`):

- **LangGraph.js**:
  - https://langchain-ai.github.io/langgraphjs/ (top-level docs)
  - https://langchain-ai.github.io/langgraphjs/reference/functions/langgraph_prebuilt.createReactAgent.html
  - https://langchain-ai.github.io/langgraphjs/how-tos/ (MemorySaver, thread_id, tool_calling)
- **LangChain.js providers**:
  - https://js.langchain.com/docs/integrations/chat/openai
  - https://js.langchain.com/docs/integrations/chat/azure
  - https://js.langchain.com/docs/integrations/chat/anthropic
  - https://js.langchain.com/docs/integrations/chat/google_generativeai
- **Azure AI Inference (for azure-anthropic, azure-deepseek)**:
  - https://learn.microsoft.com/azure/ai-foundry/model-inference/overview
  - https://learn.microsoft.com/azure/ai-foundry/model-inference/how-to/inference
  - https://www.npmjs.com/package/@azure-rest/ai-inference
  - https://learn.microsoft.com/azure/ai-foundry/model-catalog (Claude, DeepSeek model ids)
- **LangChain tool calling + Zod**:
  - https://js.langchain.com/docs/how_to/tool_calling/
  - https://js.langchain.com/docs/how_to/custom_tools/
- **dotenv**:
  - https://github.com/motdotla/dotenv#readme (precedence rules)

---

## Ready for investigation

This specification is structured so each downstream phase has a clear
slice: the **investigation** phase (§11, §12 open questions, §13
references) resolves LangGraph.js / Azure AI Inference SDK choices and
confirms provider env var shapes; the **planning** phase
(`plan-003-langgraph-agent.md`) converts FR-1..FR-13 + the tool
catalog into an ordered backlog; the **design** phase appends an
"Agent" section to `docs/design/project-design.md` covering module
layout, provider factory, config loader, and ReAct wiring; the
**implementation** phase executes the plan under the strict
no-fallback rule (FR-2, FR-4, NFR-1); and the **testing** phase
realizes AC-1..AC-11 plus the unit test suite in §10/AC-7, with all
tests living under `test_scripts/`. Every FR and AC in this document
is binary and testable; every required configuration value is
enumerated by name in §6; every forbidden behavior (fallback defaults,
secret logging, committing `.env`, unregistered tool execution) is
stated assertively.
